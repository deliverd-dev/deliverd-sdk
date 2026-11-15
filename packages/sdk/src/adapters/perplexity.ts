import { approveAndRun, type MuseToolApprovalOptions, type MuseToolRunner } from "./muse-spark.js";
import { askAboutCall } from "./shared.js";

/**
 * Perplexity's Agent API: a person decides the tool calls a run asks to make.
 *
 * The Agent API (`POST https://api.perplexity.ai/v1/agent`, also served at
 * `/v1/responses` for the OpenAI SDK) runs the agent loop itself: search,
 * fetch, any model through one key, remote MCP servers and the connectors a
 * Project administrator set up. It stops for a person in two places, and this
 * answers both:
 *
 * - **MCP servers and connectors with `require_approval`.** The call does not
 *   run; the response's `output` carries an `mcp_approval_request` instead,
 *   and the next request answers it with an `mcp_approval_response`. Perplexity
 *   runs MCP and connector calls without asking unless `require_approval` is
 *   set, unlike OpenAI's default, so set it on every server that can change
 *   something.
 * - **Your own functions.** A `function_call` in `output` is a call your code
 *   makes, so your code is where a person comes in: only approved calls run,
 *   and a declined one answers the model with the person's reason.
 *
 * ```ts
 * import Perplexity from "@perplexity-ai/perplexity_ai";
 * import { Deliverd } from "@deliverd/sdk";
 * import { runPerplexityWithDeliverd } from "@deliverd/sdk/adapters";
 *
 * const response = await runPerplexityWithDeliverd(new Perplexity(), {
 *   model: "openai/gpt-5.6-sol",
 *   input: "Close the stale issues in our tracker",
 *   tools: [{ type: "connector", id: "connector_linear", server_label: "linear", require_approval: "always" }],
 * }, { deliverd: new Deliverd(), approvers: ["platform-team"] });
 * ```
 *
 * Every call is keyed by its id (`perplexity:<id>`), so a retried round, or a
 * process restarted mid-wait, finds the request it already made. Shapes are
 * from Perplexity's Agent API reference (MCP tool, connectors, custom
 * functions); nothing from `@perplexity-ai/perplexity_ai` is imported.
 */

const PREFIX = "perplexity:";

/** An MCP or connector call waiting for an answer. It has not run. */
export interface PerplexityApprovalRequest {
  type: "mcp_approval_request";
  id: string;
  name: string;
  /** JSON-encoded on the wire. */
  arguments?: string;
  server_label?: string;
  /** Set when the call came from a connector set up in the API Console. */
  connector_id?: string | null;
}

/** The answer to one `mcp_approval_request`, sent as an `input` item of the next request. */
export interface PerplexityApprovalResponse {
  type: "mcp_approval_response";
  approval_request_id: string;
  approve: boolean;
  /** Read by the model when a call was declined. */
  reason?: string;
}

export interface PerplexityApprovalOptions extends MuseToolApprovalOptions {
  /** Put the person's reason on a declined answer, where the model reads it. Default true. */
  sendReason?: boolean;
}

export interface PerplexityApprovals {
  /** One answer per request, in the order they were asked: the next request's `input`. */
  responses: PerplexityApprovalResponse[];
  /** Why each declined call was declined, by request id, for your logs. */
  reasons: Record<string, string>;
}

/**
 * Ask about every `mcp_approval_request` in a response's `output`, and build
 * the answers. A call `when` does not select is approved without asking.
 * Other items are ignored.
 */
export async function answerPerplexityApprovals(
  output: readonly { type?: string }[] | null | undefined,
  options: PerplexityApprovalOptions
): Promise<PerplexityApprovals> {
  const result: PerplexityApprovals = { responses: [], reasons: {} };
  for (const request of approvalRequests(output)) {
    const input = parseArguments(request.arguments);
    let approve = true;
    let reason: string | undefined;
    if (!options.when || (await options.when(request.name, input))) {
      const outcome = await askAboutCall(request.name, input, `${PREFIX}${request.id}`, {
        ...options,
        metadata: {
          ...options.metadata,
          ...(request.server_label ? { server: request.server_label } : {}),
          ...(request.connector_id ? { connector: request.connector_id } : {}),
        },
      });
      approve = outcome.allowed;
      if (!outcome.allowed) reason = outcome.reason;
    }
    const answer: PerplexityApprovalResponse = { type: "mcp_approval_response", approval_request_id: request.id, approve };
    if (reason) {
      result.reasons[request.id] = reason;
      if (options.sendReason !== false) answer.reason = reason;
    }
    result.responses.push(answer);
  }
  return result;
}

/** A function call the model asked for in an Agent API response. */
export interface PerplexityFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** The result of one function call, sent as an `input` item of the next request. */
export interface PerplexityFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/**
 * Ask about, and run, every `function_call` in a response's `output`. Only
 * approved calls run; a declined one's output tells the model a person said
 * no, and why. Every call gets an output, because the run cannot continue
 * without one.
 */
export async function runPerplexityFunctionCalls(
  output: readonly { type?: string }[] | null | undefined,
  run: MuseToolRunner,
  options: PerplexityApprovalOptions
): Promise<PerplexityFunctionCallOutput[]> {
  const results: PerplexityFunctionCallOutput[] = [];
  for (const item of output ?? []) {
    if (item.type !== "function_call") continue;
    const call = item as PerplexityFunctionCall;
    results.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: await approveAndRun(call.name, call.arguments, call.call_id, run, options, PREFIX),
    });
  }
  return results;
}

/** Perplexity's client, or the OpenAI SDK pointed at `https://api.perplexity.ai/v1`. */
export interface PerplexityClient {
  responses: { create(params: Record<string, unknown>): Promise<PerplexityResponse> | PromiseLike<PerplexityResponse> };
}

/** The parts of an Agent API response this reads. */
export interface PerplexityResponse {
  id: string;
  status?: string;
  output?: { type?: string }[] | null;
}

export interface PerplexityRunOptions extends PerplexityApprovalOptions {
  /** Makes your own function calls. Without it, a response asking for one is returned to you as it is. */
  run?: MuseToolRunner;
  /**
   * Resend the conversation in `input` instead of chaining with
   * `previous_response_id`. For accounts under zero data retention, which
   * cannot use `previous_response_id`; each response's output, and the
   * answers, are sent back unchanged.
   */
  replay?: boolean;
  /** Stop after this many rounds of answers. Default 10. */
  maxRounds?: number;
}

/**
 * Create a response, and keep answering its approval requests and running its
 * function calls until it asks for nothing more.
 *
 * Each follow-up carries everything in `params` (`model`, `tools`,
 * `instructions`) except `input`, which becomes the answers and outputs, with
 * the last response's id as `previous_response_id`; or, with `replay`, the
 * whole conversation so far. The `tools` array goes unchanged, as Perplexity
 * requires. Non-streaming, foreground responses only.
 */
export async function runPerplexityWithDeliverd(
  client: PerplexityClient,
  params: Record<string, unknown>,
  options: PerplexityRunOptions
): Promise<PerplexityResponse> {
  const { input: firstInput, previous_response_id: _chain, ...carried } = params;
  void _chain;
  let response = await client.responses.create(params);
  let history: unknown[] = toItems(firstInput);
  const maxRounds = options.maxRounds ?? 10;
  for (let round = 0; ; round++) {
    const output = response.output ?? [];
    const asking = approvalRequests(output).length > 0;
    const calling = !!options.run && output.some((item) => item.type === "function_call");
    if (!asking && !calling) return response;
    if (round >= maxRounds) {
      throw new Error(`The run was still asking for decisions after ${maxRounds} rounds. Raise maxRounds if that is expected.`);
    }
    const { responses } = await answerPerplexityApprovals(output, options);
    const results = options.run ? await runPerplexityFunctionCalls(output, options.run, options) : [];
    const answers = [...responses, ...results];
    if (options.replay) {
      history = [...history, ...output, ...answers];
      response = await client.responses.create({ ...carried, input: history });
    } else {
      response = await client.responses.create({ ...carried, input: answers, previous_response_id: response.id });
    }
  }
}

function approvalRequests(output: readonly { type?: string }[] | null | undefined): PerplexityApprovalRequest[] {
  return (output ?? []).filter(
    (item): item is PerplexityApprovalRequest => item.type === "mcp_approval_request" && !!(item as PerplexityApprovalRequest).id
  );
}

function toItems(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  return Array.isArray(input) ? [...input] : [input];
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
