import { DeliverdTimeoutError } from "../errors.js";
import { durationMs, type Duration } from "../duration.js";
import type { FieldChange } from "../types.js";
import { DEFAULT_TOOL_EXPIRY, defaultDescription, refusalReason, structuredInput, type ToolApprovalOptions } from "./shared.js";

/**
 * Claude Managed Agents, hosted by Anthropic or self-hosted: a person answers
 * the tool calls a permission policy holds for confirmation.
 *
 * Give the agent a toolset with `permission_policy: { type: "always_ask" }`
 * (MCP toolsets ask by default) and the session pauses on each such call with
 * `session.status_idle`, `stop_reason.type: "requires_action"`. These answer
 * the pause with a person's decision, as `user.tool_confirmation` events:
 *
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { Deliverd } from "@deliverd/sdk";
 * import { watchManagedAgentSessions } from "@deliverd/sdk/adapters";
 *
 * // Self-hosted: ANTHROPIC_BASE_URL is your server, ANTHROPIC_API_KEY its key.
 * const client = new Anthropic();
 * await watchManagedAgentSessions(client, {
 *   deliverd: new Deliverd(),
 *   approvers: ["platform-team"],
 * });
 * ```
 *
 * A self-hosted server sends no webhooks, so something has to look. The
 * watcher polls for idle sessions and answers the ones waiting on a
 * confirmation; `followManagedAgentSession` follows one session's stream; and
 * `answerManagedAgentConfirmations` does one pass over one session, for a loop
 * you own. Each call is one request in Deliverd keyed by its event id
 * (`managed-agents:<id>`), so a second pass finds the request it already made
 * rather than asking twice.
 *
 * - **Approved**, the call runs.
 * - **Declined**, it does not, and the person's reason reaches the model as
 *   the `deny_message`.
 * - **Approved only with changes**, it is declined: a confirmation is a yes or
 *   a no and cannot carry corrected input. The model is told the approved
 *   values, so it can call again with them.
 * - **Undecided** before `timeout`, nothing is sent. The session waits
 *   indefinitely, so a later pass picks the same request up.
 *
 * Only calls the server marked `evaluated_permission: "ask"` are answered.
 * A call `auto` already ran or denied, a worker-run tool on a self-hosted
 * environment and a custom tool (your own code, where `deliverd.approve()`
 * belongs) are left alone.
 *
 * Shapes follow `client.beta.sessions` in `@anthropic-ai/sdk` 1.8 (beta
 * header `managed-agents-2026-04-01`), which self-hosted servers serve too.
 * Nothing is imported from it.
 */

/** The events this reads. Every other event passes through untouched. */
export interface ManagedAgentsEvent {
  id: string;
  type: string;
  /** `agent.tool_use` and `agent.mcp_tool_use`: the tool. */
  name?: string;
  input?: Record<string, unknown>;
  /** `agent.mcp_tool_use`: the server that offers the tool. */
  mcp_server_name?: string;
  /** `"ask"` on a call that is waiting for a confirmation. */
  evaluated_permission?: string;
  /** `session.status_idle`: why it stopped. */
  stop_reason?: { type: string; event_ids?: string[] } | null;
}

/** What a stream carries: the events above, and `event_start` / `event_delta` frames with no id. */
export type ManagedAgentsStreamEvent = Omit<ManagedAgentsEvent, "id"> & { id?: string };

export interface ManagedAgentsToolConfirmation {
  type: "user.tool_confirmation";
  tool_use_id: string;
  result: "allow" | "deny";
  deny_message?: string;
}

/** The part of `new Anthropic()` these use. */
export interface ManagedAgentsClient {
  beta: {
    sessions: {
      list(params?: { statuses?: Array<"rescheduling" | "running" | "idle" | "terminated">; agent_id?: string }): AsyncIterable<{
        id: string;
      }>;
      events: {
        list(sessionId: string, params?: { order?: "asc" | "desc"; types?: Array<"session.status_idle" | "agent.tool_use" | "agent.mcp_tool_use"> }): AsyncIterable<ManagedAgentsEvent>;
        send(sessionId: string, params: { events: ManagedAgentsToolConfirmation[] }): PromiseLike<unknown>;
        stream(sessionId: string): PromiseLike<AsyncIterable<ManagedAgentsStreamEvent>>;
      };
    };
  };
}

export interface ManagedAgentsApprovalOptions extends ToolApprovalOptions {
  /**
   * Stop waiting on a person after this and leave the call for a later pass.
   * The session waits indefinitely, so nothing is refused for being slow.
   */
  timeout?: Duration;
  /** Cancels the wait. */
  signal?: AbortSignal;
}

/** What one pass over a session came to. */
export interface ManagedAgentsResolution {
  /** The confirmations sent, in the order the calls were asked about. */
  sent: ManagedAgentsToolConfirmation[];
  /** Event ids nobody decided before `timeout`. Still open in Deliverd and in the session. */
  pending: string[];
  /** Why each declined call was declined, by event id. */
  reasons: Record<string, string>;
}

const PREFIX = "managed-agents:";
const TOOL_USE: Array<"agent.tool_use" | "agent.mcp_tool_use"> = ["agent.tool_use", "agent.mcp_tool_use"];

/** The event ids the session is blocked on, from its latest idle event; none when it is not. */
async function blockingIds(client: ManagedAgentsClient, sessionId: string): Promise<string[]> {
  for await (const event of client.beta.sessions.events.list(sessionId, { order: "desc", types: ["session.status_idle"] })) {
    return event.stop_reason?.type === "requires_action" ? [...(event.stop_reason.event_ids ?? [])] : [];
  }
  return [];
}

/** The tool-use events behind those ids, newest first, stopping once all are found. */
async function toolUses(client: ManagedAgentsClient, sessionId: string, ids: string[]): Promise<ManagedAgentsEvent[]> {
  const wanted = new Set(ids);
  const found = new Map<string, ManagedAgentsEvent>();
  for await (const event of client.beta.sessions.events.list(sessionId, { order: "desc", types: TOOL_USE })) {
    if (wanted.has(event.id)) found.set(event.id, event);
    if (found.size === wanted.size) break;
  }
  return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

function changedReason(tool: string, changes: FieldChange[]): string {
  const parts = changes.map((c) => `${c.field} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`);
  return `A person approved ${tool} only with changes: ${parts.join("; ")}. It was not run as proposed. If it is still needed, call it again with those values.`;
}

function toolLabel(event: ManagedAgentsEvent): string {
  const name = event.name ?? "a tool";
  return event.mcp_server_name ? `${name} on ${event.mcp_server_name}` : name;
}

type Answer = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "pending" };

async function decideCall(event: ManagedAgentsEvent, sessionId: string, options: ManagedAgentsApprovalOptions): Promise<Answer> {
  const tool = event.name ?? "a tool";
  const input = event.input ?? {};
  if (options.when && !(await options.when(tool, input))) return { kind: "allow" };
  const described = (options.describe ?? defaultDescription)(toolLabel(event), input);
  const structured = structuredInput(input);
  try {
    const decision = await options.deliverd.approve({
      ...described,
      approvers: options.approvers,
      externalId: PREFIX + event.id,
      flowId: options.flowId,
      metadata: {
        ...options.metadata,
        tool,
        session: sessionId,
        ...(event.mcp_server_name ? { mcp_server: event.mcp_server_name } : {}),
      },
      ...(structured ? { input: structured } : {}),
      expiresIn: options.expiresIn ?? DEFAULT_TOOL_EXPIRY,
      timeout: options.timeout,
      signal: options.signal,
    });
    if (decision.approved) {
      return decision.changes?.length ? { kind: "deny", reason: changedReason(tool, decision.changes) } : { kind: "allow" };
    }
    return { kind: "deny", reason: refusalReason(tool, decision) };
  } catch (err) {
    if (err instanceof DeliverdTimeoutError) return { kind: "pending" };
    throw err;
  }
}

/**
 * One pass over one session: if it is waiting on confirmations, ask a person
 * about each and send the answers that came back.
 */
export async function answerManagedAgentConfirmations(
  client: ManagedAgentsClient,
  sessionId: string,
  options: ManagedAgentsApprovalOptions,
  /** The ids from a `requires_action` you already hold, to skip looking them up. */
  eventIds?: string[]
): Promise<ManagedAgentsResolution> {
  const resolution: ManagedAgentsResolution = { sent: [], pending: [], reasons: {} };
  const ids = eventIds ?? (await blockingIds(client, sessionId));
  if (ids.length === 0) return resolution;
  const calls = (await toolUses(client, sessionId, ids)).filter((e) => e.evaluated_permission === "ask");
  const answers = await Promise.all(calls.map((event) => decideCall(event, sessionId, options)));
  calls.forEach((event, i) => {
    const answer = answers[i]!;
    if (answer.kind === "pending") {
      resolution.pending.push(event.id);
    } else if (answer.kind === "allow") {
      resolution.sent.push({ type: "user.tool_confirmation", tool_use_id: event.id, result: "allow" });
    } else {
      resolution.reasons[event.id] = answer.reason;
      resolution.sent.push({ type: "user.tool_confirmation", tool_use_id: event.id, result: "deny", deny_message: answer.reason });
    }
  });
  if (resolution.sent.length > 0) await client.beta.sessions.events.send(sessionId, { events: resolution.sent });
  return resolution;
}

/**
 * Follow one session's stream, answering each confirmation it pauses on,
 * until its turn ends, it stops for another reason, or it terminates.
 * Open it before you send the message that starts the turn: a stream carries
 * only what happens after it opens.
 */
export async function followManagedAgentSession(
  client: ManagedAgentsClient,
  sessionId: string,
  options: ManagedAgentsApprovalOptions & {
    /** Every event, for printing the agent's messages as they arrive. */
    onEvent?: (event: ManagedAgentsStreamEvent) => void;
  }
): Promise<void> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  for await (const event of stream) {
    options.onEvent?.(event);
    if (event.type === "session.status_terminated") return;
    if (event.type !== "session.status_idle") continue;
    if (event.stop_reason?.type !== "requires_action") return;
    await answerManagedAgentConfirmations(client, sessionId, options, event.stop_reason.event_ids ?? []);
  }
}

/**
 * Keep answering, for every idle session the key can see (or one agent's,
 * with `agentId`), until `signal` aborts. For a self-hosted server, which
 * sends no webhooks; it works the same against Anthropic's API.
 *
 * Each pass waits on a person for at most `timeout` per call (default ten
 * seconds), so one slow decision does not hold up another session. An
 * undecided call is picked up again next pass, from the same request.
 */
export async function watchManagedAgentSessions(
  client: ManagedAgentsClient,
  options: ManagedAgentsApprovalOptions & {
    agentId?: string;
    /** Time between passes. Default five seconds. */
    interval?: Duration;
    /** A session that could not be answered this pass; the watcher carries on. */
    onError?: (error: unknown, sessionId: string) => void;
  }
): Promise<void> {
  const interval = options.interval === undefined ? 5_000 : durationMs(options.interval);
  const perPass: ManagedAgentsApprovalOptions = { ...options, timeout: options.timeout ?? "10s" };
  while (!options.signal?.aborted) {
    const idle: string[] = [];
    for await (const session of client.beta.sessions.list({
      statuses: ["idle"],
      ...(options.agentId ? { agent_id: options.agentId } : {}),
    })) {
      idle.push(session.id);
    }
    await Promise.all(
      idle.map(async (id) => {
        try {
          await answerManagedAgentConfirmations(client, id, perPass);
        } catch (err) {
          if (options.signal?.aborted) return;
          if (options.onError) options.onError(err, id);
          else throw err;
        }
      })
    );
    await sleep(interval, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
