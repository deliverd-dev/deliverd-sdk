import { askAboutCall, type ToolApprovalOptions } from "./shared.js";

/**
 * Meta's Muse Spark, on the Meta Model API: a person approves the function
 * calls a response asks for, and only the approved ones run.
 *
 * Muse Spark has no approval hook of its own. A response lists the calls the
 * model wants made and your loop makes them, so the loop is where a person
 * comes in. Hand the calls to Deliverd with the function that runs them:
 *
 * ```ts
 * import OpenAI from "openai";
 * import { Deliverd } from "@deliverd/sdk";
 * import { runMuseFunctionCalls } from "@deliverd/sdk/adapters";
 *
 * const muse = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
 * let resp = await muse.responses.create({ model: "muse-spark-1.1", input, tools });
 * const results = await runMuseFunctionCalls(resp.output, runTool, {
 *   deliverd: new Deliverd(),
 *   when: (tool) => tool === "refund",
 *   approvers: ["finance"],
 * });
 * resp = await muse.responses.create({ model: "muse-spark-1.1", input: results, tools, previous_response_id: resp.id });
 * ```
 *
 * `runMuseFunctionCalls` reads the Responses API's `function_call` items and
 * returns its `function_call_output` items; `runMuseToolCalls` reads a Chat
 * Completions message's `tool_calls` and returns `role: "tool"` messages.
 * A declined call is not run: its result is a sentence telling the model a
 * person said no, and why, so the model changes course instead of the run
 * crashing. Both shapes are the OpenAI-compatible ones Meta's Model API
 * serves, so they work for any endpoint that speaks them.
 */

export interface MuseToolApprovalOptions extends ToolApprovalOptions {
  /**
   * Fields of a call's arguments the approver may correct before approving,
   * per tool: `editable: (tool) => tool === "refund" ? ["amount"] : []`. The
   * call then runs with what they approved rather than what the model asked.
   */
  editable?: (toolName: string, input: Record<string, unknown>) => string[];
}

/** Runs one call: the tool's name and its parsed arguments. A string result is passed on as it is; anything else as JSON. */
export type MuseToolRunner = (toolName: string, input: unknown) => unknown | Promise<unknown>;

/** A Responses API output item asking for a function call. */
export interface MuseFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** What goes back as the next request's `input`, one per call. */
export interface MuseFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/** A Chat Completions tool call, from `choices[0].message.tool_calls`. */
export interface MuseToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** The `role: "tool"` message answering one tool call. */
export interface MuseToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Ask about, and run, every `function_call` in a Responses API output. Other items are ignored. */
export async function runMuseFunctionCalls(
  output: readonly { type?: string }[],
  run: MuseToolRunner,
  options: MuseToolApprovalOptions
): Promise<MuseFunctionCallOutput[]> {
  const results: MuseFunctionCallOutput[] = [];
  for (const item of output) {
    if (item.type !== "function_call") continue;
    const call = item as MuseFunctionCall;
    results.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: await approveAndRun(call.name, call.arguments, call.call_id, run, options),
    });
  }
  return results;
}

/** Ask about, and run, every tool call on a Chat Completions message. */
export async function runMuseToolCalls(
  message: { tool_calls?: readonly MuseToolCall[] | null },
  run: MuseToolRunner,
  options: MuseToolApprovalOptions
): Promise<MuseToolMessage[]> {
  const results: MuseToolMessage[] = [];
  for (const call of message.tool_calls ?? []) {
    results.push({
      role: "tool",
      tool_call_id: call.id,
      content: await approveAndRun(call.function.name, call.function.arguments, call.id, run, options),
    });
  }
  return results;
}

async function approveAndRun(
  toolName: string,
  rawArguments: string,
  callId: string,
  run: MuseToolRunner,
  options: MuseToolApprovalOptions
): Promise<string> {
  const input = parseArguments(rawArguments);
  if (!options.when || (await options.when(toolName, input))) {
    const editable =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? options.editable?.(toolName, input as Record<string, unknown>)
        : undefined;
    // The call id makes the ask idempotent: a loop that is retried, or a
    // process restarted mid-wait, finds the request it already made.
    const outcome = await askAboutCall(toolName, input, `muse-spark:${callId}`, options, undefined, editable);
    if (!outcome.allowed) return outcome.reason;
    // What was approved runs, which is the proposal unless a person corrected it.
    return render(await run(toolName, outcome.input ?? input));
  }
  return render(await run(toolName, input));
}

function render(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result ?? null);
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
