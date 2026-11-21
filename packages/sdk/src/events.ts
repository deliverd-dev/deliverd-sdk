import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import type { HttpClient } from "./http.js";

/**
 * Be told, instead of asking.
 *
 * Deliverd speaks MCP Events (io.modelcontextprotocol/events, SEP-3415): an
 * approval decided, a gate settled, a review landed, a screening held for a
 * person, an agent drifting. MCP clients reach them on /api/mcp/v2; this
 * module reaches the same log over REST, for code that is not an MCP client.
 *
 * ```ts
 * const approval = await deliverd.approvals.create({ title: "Refund £1,240", approvers: ["finance"] });
 * const decided = await deliverd.events.waitForDecision({ approvalId: approval.id });
 * if (decided.status === "approved") await refund();
 * ```
 *
 * Nothing here changes `approval.wait()` or `gate.wait()`: they poll the
 * request as they always have. This is the opt-in alternative that reads one
 * cursor instead, and it falls back to reading the request itself when the
 * server it is pointed at has no events (an older self-hosted copy).
 */

export type EventName =
  | "approval.decided"
  | "approval.question"
  | "approval.requested"
  | "gate.decided"
  | "gate.denied"
  | "review.settled"
  | "collection.completed"
  | "task.updated"
  | "screen.held"
  | "drift.detected"
  | "risk_indicator.breached"
  | "context.changed";

export interface EventArguments {
  /** Only this approval, gate, review, collection, task or agent (whichever the event is about). */
  id?: string;
  externalId?: string;
  agentId?: string;
}

export interface EventDefinition {
  name: EventName | string;
  title: string;
  description: string;
  delivery: ("poll" | "push" | "webhook")[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export interface EventOccurrence<D = Record<string, unknown>> {
  eventId: string;
  name: string;
  timestamp: string;
  data: D;
  cursor: string | null;
}

export interface PollResult<D = Record<string, unknown>> {
  events: EventOccurrence<D>[];
  /** Send this back next time. */
  cursor: string;
  /** Events may have been missed: the cursor was older than the seven days kept. */
  truncated: boolean;
  /** Poll again at once. */
  hasMore: boolean;
  /** How long to wait before the next poll. */
  nextPollMs: number;
}

export interface PollInput {
  name: EventName | string;
  arguments?: EventArguments;
  /** `null` (or omitted) starts from now. */
  cursor?: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface WatchOptions {
  /** Start here instead of now, to resume where a previous run stopped. */
  cursor?: string | null;
  signal?: AbortSignal;
  /** Called with each cursor as it advances, to persist it. */
  onCursor?: (cursor: string) => void;
  /** Never poll faster than this. Default 1000 ms, as SEP-3415 asks. */
  minPollMs?: number;
}

export interface Decided {
  /** approved, rejected, changes_requested, expired (and for a gate: cancelled, revoked). */
  status: string;
  /** For a gate: whether the action may now be performed. */
  canExecute?: boolean;
  /** The event's payload, or the request as read back when the server had no events. */
  data: Record<string, unknown>;
  /** "event" when an MCP Event told us; "read" when we fell back to reading the request. */
  via: "event" | "read";
}

const SETTLED = new Set(["approved", "rejected", "changes_requested", "expired", "cancelled", "revoked", "denied", "allowed", "used"]);

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DeliverdError(0, "aborted", "The wait was aborted."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DeliverdError(0, "aborted", "The wait was aborted."));
      },
      { once: true }
    );
  });

export class Events {
  constructor(private readonly http: HttpClient) {}

  /** The events this key's scopes can hear. */
  async list(signal?: AbortSignal): Promise<EventDefinition[]> {
    const res = await this.http.request<{ events: EventDefinition[] }>({ method: "GET", path: "/events", signal });
    return res.events;
  }

  /** One poll: what happened since `cursor`. */
  async poll<D = Record<string, unknown>>(input: PollInput, signal?: AbortSignal): Promise<PollResult<D>> {
    return this.http.request<PollResult<D>>({
      method: "POST",
      path: "/events/poll",
      body: { ...input, cursor: input.cursor ?? null },
      signal,
    });
  }

  /**
   * Every matching event, as it happens, until the signal aborts.
   *
   * ```ts
   * for await (const event of deliverd.events.watch("gate.denied")) page(event.data);
   * ```
   */
  async *watch<D = Record<string, unknown>>(
    name: EventName | string,
    args: EventArguments = {},
    options: WatchOptions = {}
  ): AsyncGenerator<EventOccurrence<D>> {
    let cursor = options.cursor ?? null;
    const floor = Math.max(0, options.minPollMs ?? 1000);
    for (;;) {
      const page = await this.poll<D>({ name, arguments: args, cursor }, options.signal);
      cursor = page.cursor;
      options.onCursor?.(cursor);
      for (const event of page.events) yield event;
      if (!page.hasMore) await pause(Math.max(floor, page.nextPollMs), options.signal);
    }
  }

  /**
   * Wait for one approval or gate to settle, told by an event.
   *
   * Starts the cursor before reading the request once, so a decision that
   * lands in between is caught either way. Falls back to polling the request
   * when the server has no events endpoint (404), so it works against any
   * Deliverd.
   */
  async waitForDecision(
    target: { approvalId: string } | { gateId: string },
    options: { timeout?: number; signal?: AbortSignal; minPollMs?: number } = {}
  ): Promise<Decided> {
    const isGate = "gateId" in target;
    const id = isGate ? target.gateId : target.approvalId;
    const name = isGate ? "gate.decided" : "approval.decided";
    const readPath = isGate ? `/gates/${encodeURIComponent(id)}` : `/approvals/${encodeURIComponent(id)}`;
    const deadline = options.timeout !== undefined ? Date.now() + options.timeout : Infinity;
    const floor = Math.max(0, options.minPollMs ?? 1000);

    const read = async (): Promise<Decided | null> => {
      const data = await this.http.request<Record<string, unknown>>({ method: "GET", path: readPath, signal: options.signal });
      const status = String(data.status ?? "");
      if (!SETTLED.has(status) && !(isGate && data.canExecute === true)) return null;
      return { status, ...(isGate ? { canExecute: data.canExecute === true } : {}), data, via: "read" };
    };

    let cursor: string | null = null;
    let events = true;
    try {
      cursor = (await this.poll({ name, arguments: { id }, cursor: null }, options.signal)).cursor;
    } catch (err) {
      if (!(err instanceof DeliverdError) || err.status !== 404) throw err;
      events = false;
    }

    // Already settled before we started listening.
    const first = await read();
    if (first) return first;

    let pollMs = 2000;
    for (;;) {
      if (Date.now() >= deadline) throw new DeliverdTimeoutError(`No decision on ${id} within the timeout.`);
      if (events) {
        const page = await this.poll({ name, arguments: { id }, cursor }, options.signal);
        cursor = page.cursor;
        const hit = page.events[0];
        if (hit) {
          const data = hit.data as Record<string, unknown>;
          return {
            status: String(data.status),
            ...(isGate ? { canExecute: data.canExecute === true } : {}),
            data,
            via: "event",
          };
        }
        if (page.truncated) {
          const settled = await read();
          if (settled) return settled;
        }
        pollMs = page.hasMore ? 0 : page.nextPollMs;
      } else {
        const settled = await read();
        if (settled) return settled;
        pollMs = Math.min(15_000, Math.round(pollMs * 1.5));
      }
      await pause(Math.max(floor, Math.min(pollMs, deadline - Date.now())), options.signal);
    }
  }
}
