import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import type { HttpClient } from "./http.js";
import type {
  CreateGateInput,
  ExecutionReceipt,
  GateAgentRef,
  GateData,
  GateDecision,
  RecordExecutionInput,
} from "./types.js";

/**
 * Ask before you act.
 *
 * The other primitives in this package are an agent asking a person to look at
 * work it has already done. This one asks first, and the answer comes from
 * policy the developer does not own — which is the point: what needs a human is
 * an organisation's decision, not a line in the agent's code.
 *
 * ```ts
 * const decision = await deliverd.gate({
 *   action: "finance.refund",
 *   externalId: `refund:${order.id}`,
 *   input: { customer_id: order.customerId, amount: 1240, currency: "GBP" },
 * });
 * if (!decision.allowed) return;
 * await stripe.refunds.create(decision.input);
 * ```
 *
 * **Use `decision.input`, not your own object.** It is what the action's schema
 * validated and what an approver actually saw. Passing the original is right
 * until the day somebody edits a value before approving, and then it is a
 * silent bug that spends an approval for £1200 on a refund of £1240.
 *
 * **Scoped permissions.** Name what the act is about and where it lands, and an
 * approval covers exactly that — the version you asked about, the destination
 * you named — then report what you did:
 *
 * ```ts
 * const gate = await deliverd.gates.check({
 *   actionId: "report.publish",
 *   externalId: `weekly-portfolio:${week}`,
 *   input: { title: "Weekly Portfolio Report" },
 *   classification: "confidential",
 *   destination: { type: "workspace", id: "executive" },
 *   artifact: { reportId, versionId },
 * });
 * await gate.wait();
 * if (gate.canExecute) {
 *   await publish(report);
 *   await gate.recordExecution({ artifactSha256: gate.scope.artifact?.sha256 ?? undefined });
 * }
 * ```
 *
 * `canExecute` is your organisation's authorisation, nothing more: the platform
 * your agent runs on may still require its user's confirmation, or refuse.
 */

/** How long between polls while waiting on a person. */
const POLL_SCHEDULE = [250, 750, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export interface GateWaitOptions {
  /** Give up after this many milliseconds. Without one, waits indefinitely. */
  timeout?: number;
  signal?: AbortSignal;
  /** Called on every poll, for a progress line. */
  onPoll?: (gate: GateData) => void;
  pollIntervals?: readonly number[];
}

export interface GateOptions extends GateWaitOptions {
  /** The registered action: `finance.refund`. */
  action: string;
  input: Record<string, unknown>;
  externalId: string;
  environment?: string;
  reason?: string;
  flowId?: string;
  /**
   * Whether to block when policy sends it to a person. Default true.
   *
   * False returns the pending decision immediately, which is what you want
   * inside a request handler that must not hold a connection open for an hour.
   * `deliverd.gates.create()` is the same thing said more plainly.
   */
  wait?: boolean;
}

/**
 * A decision, and what you can do with it.
 *
 * The data is a snapshot; `wait()` and `refresh()` replace it in place, so a
 * handle held across a wait reads the settled decision rather than the pending
 * one you created.
 */
export class Gate {
  constructor(
    private readonly http: HttpClient,
    private data: GateData
  ) {}

  get id(): string { return this.data.id; }
  get status(): GateData["status"] { return this.data.status; }
  /**
   * The one to branch on. True when a rule permitted it **or** a person agreed
   * to it; false for denied, rejected, expired, cancelled and while pending.
   * An expiry is not permission — nobody said yes.
   */
  get allowed(): boolean { return this.data.allowed; }
  /** Still waiting on a person. */
  get pending(): boolean { return this.data.status === "pending"; }
  /** Refused by a rule, as against rejected by a person. */
  get denied(): boolean { return this.data.status === "denied"; }
  /** What to execute with: the input as the action's schema validated it. */
  get input(): Record<string, unknown> { return this.data.input; }
  /** Why, in the words of whoever wrote the rule. */
  get reason(): string | null { return this.data.reason; }
  /** The rule that decided, by name. Null when nothing matched it. */
  get rule(): string | null { return this.data.rule; }
  /** Where a person decides, when one was asked. */
  get approvalUrl(): string | null { return this.data.approvalUrl; }
  get approvalId(): string | null { return this.data.approvalId; }
  /** True when this call read back a decision already made under your id. */
  get reused(): boolean { return this.data.reused; }
  /**
   * Whether you may act on it **now**: authorised, inside its window, with a
   * use left, not revoked. Branch on this rather than `allowed`, which says it
   * was authorised at some point. The organisation's authorisation only.
   */
  get canExecute(): boolean { return this.data.canExecute; }
  /** What policy said: ALLOW, APPROVAL_REQUIRED, REVIEW_REQUIRED or DENY. */
  get decision(): GateData["decision"] { return this.data.decision; }
  /** Why it cannot be executed, when it cannot. */
  get blockedBecause(): string | null { return this.data.blockedBecause; }
  /** What the permission covers: destination, artifact and its hash, classification. */
  get scope(): GateData["scope"] { return this.data.scope; }
  /** How long it lasts and how many uses are left. */
  get authorisation(): GateData["authorisation"] { return this.data.authorisation; }
  /** A person sent it back. Revise and ask again with `supersedesGateId: gate.id`. */
  get changesRequested(): boolean { return this.data.status === "changes_requested"; }

  /**
   * Report what you did with the permission. Spends a use. A different
   * artifact hash is refused as `approval_invalidated`; a different
   * destination as `destination_mismatch`.
   */
  async recordExecution(input: RecordExecutionInput = {}, signal?: AbortSignal): Promise<ExecutionReceipt> {
    const { receipt, gate } = await recordExecution(this.http, this.data.id, input, signal);
    this.data = gate;
    return receipt;
  }

  /** Withdraw it: the request if a person has not answered, the permission if unused. */
  async cancel(note?: string, agent?: GateAgentRef, signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<GateData>({
      method: "POST",
      path: `/gates/${this.data.id}/cancel`,
      body: { note, agent },
      signal,
    });
    return this;
  }

  /** Everything the API returned, if you want a field the getters do not name. */
  toJSON(): GateData { return this.data; }

  /** The answer, flattened — what `gate()` hands back. */
  toDecision(): GateDecision {
    return {
      allowed: this.data.allowed,
      status: this.data.status,
      reason: this.data.reason,
      rule: this.data.rule,
      input: this.data.input,
      changes: this.data.changes ?? [],
      id: this.data.id,
      approvalUrl: this.data.approvalUrl,
      gate: this,
    };
  }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<GateData>({
      method: "GET",
      path: `/gates/${this.data.id}`,
      signal,
    });
    return this;
  }

  /**
   * Block until a person decides, then return.
   *
   * Resolves on every settled state — it does not throw on a refusal, because
   * a no is an answer and `if (gate.allowed)` is the line that should follow.
   * It throws only when the wait itself failed: a timeout, an abort, or the
   * API being unreachable.
   *
   * Returns immediately when policy already settled it, which is the common
   * case: most gated calls are allowed or denied by a rule and never reach a
   * person at all.
   */
  async wait(options: GateWaitOptions = {}): Promise<this> {
    const deadline = options.timeout !== undefined ? Date.now() + options.timeout : undefined;
    let poll = 0;

    if (!this.pending) return this;

    for (;;) {
      if (options.signal?.aborted) {
        throw new DeliverdError(0, "aborted", "The wait was aborted.", undefined, {
          cause: options.signal.reason,
        });
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new DeliverdTimeoutError(
          `Nobody decided the ${this.data.rule ? `"${this.data.rule}" ` : ""}gate on ` +
            // The action id, not an input field that happened to be called `action`.
            `"${this.data.actionId || this.id}" within the timeout. ` +
            (this.data.approvalUrl
              ? `It is still open at ${this.data.approvalUrl}.`
              : "It is still open.")
        );
      }

      const delay = pollDelay(poll++, options.pollIntervals ?? POLL_SCHEDULE);
      const remaining = deadline === undefined ? delay : Math.min(delay, deadline - Date.now());
      await sleep(Math.max(0, remaining), options.signal);

      await this.refresh(options.signal);
      options.onPoll?.(this.data);

      if (!this.pending) return this;
    }
  }
}

/** ±25% jitter, so a fleet of agents does not poll in lockstep. */
function pollDelay(attempt: number, schedule: readonly number[]): number {
  const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 30_000;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DeliverdError(0, "aborted", "The wait was aborted."));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeliverdError(0, "aborted", "The wait was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function recordExecution(
  http: HttpClient,
  id: string,
  input: RecordExecutionInput,
  signal?: AbortSignal
): Promise<{ receipt: ExecutionReceipt; gate: GateData }> {
  return http.request<{ receipt: ExecutionReceipt; gate: GateData }>({
    method: "POST",
    path: `/gates/${id}/execution`,
    body: { phase: "completed", ...input },
    signal,
  });
}

export class Gates {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ask whether you may act, and return at once — the same call as `create`,
   * named for what it does. Policy answers; `canExecute` is the field to branch
   * on, now or after `wait()`.
   */
  async check(input: CreateGateInput, signal?: AbortSignal): Promise<Gate> {
    return this.create(input, signal);
  }

  /** Report what you did with a gate's permission. See `Gate.recordExecution`. */
  async recordExecution(
    id: string,
    input: RecordExecutionInput = {},
    signal?: AbortSignal
  ): Promise<{ receipt: ExecutionReceipt; gate: Gate }> {
    const { receipt, gate } = await recordExecution(this.http, id, input, signal);
    return { receipt, gate: new Gate(this.http, gate) };
  }

  /** Withdraw a request, or an unused permission. */
  async cancel(id: string, note?: string, agent?: GateAgentRef, signal?: AbortSignal): Promise<Gate> {
    const data = await this.http.request<GateData>({
      method: "POST",
      path: `/gates/${id}/cancel`,
      body: { note, agent },
      signal,
    });
    return new Gate(this.http, data);
  }

  /**
   * Have Deliverd make the staged report version the gate authorised live.
   * The receipt is `verified`: Deliverd carried it out.
   */
  async release(
    id: string,
    agent?: GateAgentRef,
    signal?: AbortSignal
  ): Promise<{ receipt: ExecutionReceipt; gate: Gate; url: string }> {
    const released = await this.http.request<{ receipt: ExecutionReceipt; gate: GateData; url: string }>({
      method: "POST",
      path: `/gates/${id}/release`,
      body: { agent },
      signal,
    });
    return { ...released, gate: new Gate(this.http, released.gate) };
  }

  /** The gate's evidence pack, as JSON. */
  async evidence(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>({ method: "GET", path: `/gates/${id}/evidence`, signal });
  }

  /**
   * Raise a decision and return straight away, even if it went to a person.
   *
   * The non-blocking half of `gate()`. Use it when the work resumes on a
   * webhook or a later poll rather than inside this call.
   */
  async create(input: CreateGateInput, signal?: AbortSignal): Promise<Gate> {
    const data = await this.http.request<GateData>({
      method: "POST",
      path: "/gates",
      body: input,
      /*
       * The caller's own id, as the HTTP idempotency key too.
       *
       * The server enforces reuse against `gate_requests.external_id`, so this
       * is belt and braces rather than the mechanism — but it means a retry
       * inside the transport layer and a retry by the caller's own code are the
       * same key, instead of one guarding the request and the other the
       * decision.
       */
      idempotencyKey: input.externalId,
      signal,
    });
    return new Gate(this.http, data);
  }

  /** One decision by its id. */
  async get(id: string, signal?: AbortSignal): Promise<Gate> {
    const data = await this.http.request<GateData>({
      method: "GET",
      path: `/gates/${id}`,
      signal,
    });
    return new Gate(this.http, data);
  }
}
