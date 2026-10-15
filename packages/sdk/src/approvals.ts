import { listOrCollect, type PageOf } from "./paging.js";
import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { durationMs, type Duration } from "./duration.js";
import type {
  ApprovalData,
  ApprovalQuestion,
  CreateApprovalInput,
  Decision,
  FieldChange,
  ListApprovalsInput,
  CreateDecisionSessionInput,
  DecisionSession,
} from "./types.js";

/**
 * Ask a person before you act.
 *
 * The point of this module is one line — `await approval.wait()` — and
 * everything in it exists to make that line safe to write in a real agent:
 * polling that backs off instead of hammering, a question from the approver
 * answered without leaving the wait, and an end that is guaranteed by the
 * request's own expiry rather than by hope.
 */

/**
 * How often to ask, as the wait gets longer. Milliseconds.
 *
 * The first one is deliberately quick. Most approvals take minutes, but the
 * ones that take two seconds are the ones somebody is watching — a demo, a
 * deploy with the approver stood next to you — and a client whose first look
 * is two seconds away makes an instant decision feel like a slow one. One
 * cheap early request buys that, and against a limit of 120 a minute it costs
 * nothing. After a few polls the schedule is somebody's afternoon, not a
 * progress bar.
 */
export const POLL_SCHEDULE = [250, 750, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const POLL_CEILING = 60_000;

/** Development mode: the approver is imaginary and instant, so keep up. */
export const FAST_POLL_SCHEDULE = [10, 25, 50, 100] as const;

function pollDelay(poll: number, schedule: readonly number[]): number {
  const base = schedule[Math.min(poll, schedule.length - 1)] ?? POLL_CEILING;
  // Jitter, so a hundred agents started by the same cron do not arrive together.
  return base * 0.75 + Math.random() * base * 0.5;
}

export interface WaitOptions {
  /**
   * Called when the approver asks the requester something. Return the answer
   * and the wait posts it and carries on; return `null` to leave it for a
   * person. Without this a question simply sits there — the approver is
   * waiting on you, and nothing will move until it is answered or they decide
   * anyway.
   */
  onQuestion?: (question: ApprovalQuestion, approval: ApprovalData) => Promise<string | null> | string | null;
  /** Called after every poll, for a progress line in a CLI. */
  onPoll?: (approval: ApprovalData) => void;
  /**
   * Give up after this many milliseconds and throw `DeliverdTimeoutError`.
   * Omitted, the wait ends when the request does — which, for a request with
   * no `expiresAt`, may be never. Set one or the other.
   */
  timeout?: number;
  signal?: AbortSignal;
  /**
   * How long between polls, as the wait lengthens. Rarely worth changing —
   * development mode uses it to keep up with an approver who is instant.
   */
  pollIntervals?: readonly number[];
}

/**
 * A request, and what you can do with it.
 *
 * The data is a snapshot; `wait()` and `refresh()` replace it in place, so a
 * handle held across a wait reads the settled request rather than the one you
 * created.
 */
export class Approval {
  constructor(
    private readonly http: HttpClient,
    private data: ApprovalData
  ) {}

  /**
   * The secret this request's callbacks are signed with, when you gave a
   * `callbackUrl`. Only on the handle `create()` returned — the API hands it
   * over once and never again — so keep it with whatever will receive the
   * callback, and check each one with
   * `deliverd.webhooks.constructCallback(callbackSecret, rawBody, signature)`.
   */
  callbackSecret: string | null = null;

  get id(): string { return this.data.id; }
  get status(): ApprovalData["status"] { return this.data.status; }
  /** The page the approver decides on. Put it in your own UI or logs. */
  get url(): string { return this.data.url; }
  get title(): string { return this.data.title; }
  /** Their reason, when they gave one. */
  get note(): string | null { return this.data.note; }
  /** Who decided, as a name rather than an id. */
  get decidedBy(): string | null { return this.data.decidedBy; }
  get decidedById(): string | null { return this.data.decidedById; }
  get decidedAt(): string | null { return this.data.decidedAt; }
  /** What you proposed to run with. */
  get input(): Record<string, unknown> | null { return this.data.input ?? null; }
  /** What to run with once approved, with any corrections. Null until then. */
  get approvedInput(): Record<string, unknown> | null { return this.data.approvedInput ?? null; }
  /** What the approver changed. */
  get changes(): FieldChange[] { return this.data.changes ?? []; }
  get questions(): ApprovalQuestion[] { return this.data.questions; }
  /** Questions the approver is still waiting on you to answer. */
  get openQuestions(): ApprovalQuestion[] { return this.data.questions.filter((q) => !q.answer); }

  /** The one to branch on. False for rejected, expired and cancelled alike. */
  get approved(): boolean { return this.data.status === "approved"; }
  get rejected(): boolean { return this.data.status === "rejected"; }
  get expired(): boolean { return this.data.status === "expired"; }
  get cancelled(): boolean { return this.data.status === "cancelled"; }
  get pending(): boolean { return this.data.status === "pending"; }

  /** Everything the API returned, if you want a field the getters do not name. */
  toJSON(): ApprovalData { return this.data; }

  /**
   * The answer, flattened — what `approve()` hands back.
   *
   * `approved` is a boolean so `if (decision.approved)` reads as the sentence
   * it is; `status` is the narrowing union for a switch. Both, because people
   * write both and neither should be the wrong one.
   */
  toDecision(): Decision {
    const status = this.data.status === "pending" ? "expired" : this.data.status;
    return {
      approved: this.data.status === "approved",
      status,
      note: this.data.note,
      decidedBy: this.data.decidedBy,
      decidedById: this.data.decidedById,
      decidedAt: this.data.decidedAt,
      id: this.data.id,
      url: this.data.url,
      input: this.data.status === "approved" ? (this.data.approvedInput ?? this.data.input) : null,
      changes: this.data.changes ?? [],
      approval: this,
    } as Decision;
  }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<ApprovalData>({
      method: "GET",
      path: `/approvals/${this.data.id}`,
      signal,
    });
    return this;
  }

  /** Answer a question the approver asked. Only the requester may. */
  async answer(questionId: string, answer: string, signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<ApprovalData>({
      method: "POST",
      path: `/approvals/${this.data.id}/answers`,
      body: { questionId, answer },
      signal,
    });
    return this;
  }

  /** Withdraw it. The row stays as evidence of what was asked and dropped. */
  async cancel(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<ApprovalData>({
      method: "POST",
      path: `/approvals/${this.data.id}/cancel`,
      signal,
    });
    return this;
  }

  /**
   * Block until a person decides, then return.
   *
   * Resolves on approved, rejected, expired and cancelled — it does not throw
   * on a no, because a refusal is an answer and `if (approval.approved)` is
   * the line that should follow. It throws only when the wait itself failed:
   * a timeout, an abort, or the API being unreachable.
   */
  async wait(options: WaitOptions = {}): Promise<this> {
    const deadline = options.timeout !== undefined ? Date.now() + options.timeout : undefined;
    let poll = 0;

    // Already settled, or answered between create and wait.
    if (!this.pending) return this;

    for (;;) {
      if (options.signal?.aborted) {
        throw new DeliverdError(0, "aborted", "The wait was aborted.", undefined, {
          cause: options.signal.reason,
        });
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        /*
         * Say which of the two happened. An approver who asked a question and
         * got no answer has not ignored the request — they are waiting on you,
         * and "nobody decided in time" sends you to look at the wrong end of
         * it. Found by running the quickstart's own instruction to set
         * DELIVERD_DEV_OUTCOME=question, which produced exactly that message.
         */
        const unanswered = this.data.questions?.find((q) => !q.answer);
        throw new DeliverdTimeoutError(
          unanswered
            ? `An approver asked a question about "${this.data.title}" and nothing answered it: ` +
              `"${unanswered.question}". Pass an onQuestion handler, or answer it at ${this.data.url}.`
            : `Nobody decided "${this.data.title}" within the timeout. It is still open at ${this.data.url}.`
        );
      }

      const delay = pollDelay(poll++, options.pollIntervals ?? POLL_SCHEDULE);
      const remaining = deadline === undefined ? delay : Math.min(delay, deadline - Date.now());
      await wait(Math.max(0, remaining), options.signal);

      await this.refresh(options.signal);
      options.onPoll?.(this.data);

      if (options.onQuestion) {
        for (const question of this.openQuestions) {
          const answer = await options.onQuestion(question, this.data);
          if (typeof answer === "string" && answer.trim()) {
            await this.answer(question.id, answer, options.signal);
          }
        }
      }

      if (!this.pending) return this;
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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

export class Approvals {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ask. Returns as soon as the request is filed — the approvers are being
   * told while this resolves — so call `wait()` next, or keep the id and poll
   * later.
   */
  async create(input: CreateApprovalInput, signal?: AbortSignal): Promise<Approval> {
    const data = await this.http.request<ApprovalData>({
      method: "POST",
      path: "/approvals",
      body: input,
      signal,
    });
    const created = new Approval(this.http, data);
    created.callbackSecret = (data as ApprovalData & { callbackSecret?: string }).callbackSecret ?? null;
    return created;
  }

  async get(id: string, signal?: AbortSignal): Promise<Approval> {
    const data = await this.http.request<ApprovalData>({
      method: "GET",
      path: `/approvals/${id}`,
      signal,
    });
    return new Approval(this.http, data);
  }

  /**
   * The organisation's approvals, newest first.
   *
   * With no `limit` this is every one of them: the API says where each page
   * stopped and this follows the cursor to the end. With a `limit` it is one
   * page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListApprovalsInput = {}, signal?: AbortSignal): Promise<Approval[]> {
    return listOrCollect(input, async (q: { limit?: number; cursor?: string }) => {
      const page = await this.listPage({ ...input, ...q }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: ListApprovalsInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<Approval>> {
    const { approvals, nextCursor } = await this.http.request<{
      approvals: ApprovalData[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/approvals",
      query: {
        status: input.status,
        externalId: input.externalId,
        approver: input.approver,
        limit: input.limit,
        cursor: input.cursor,
      },
      signal,
    });
    return { items: approvals.map((r) => new Approval(this.http, r)), nextCursor };
  }

  /**
   * Ask and wait, for the common case where there is nothing to do in
   * between. `const { approved } = await deliverd.approvals.request({…})`.
   */
  async request(
    input: CreateApprovalInput,
    options: WaitOptions = {}
  ): Promise<Approval> {
    const approval = await this.create(input, options.signal);
    return approval.wait(options);
  }

  /**
   * The same request as before, when there was one.
   *
   * Best effort, and worth being exact about what that means: it looks for a
   * request with this `externalId` and returns it rather than filing a second.
   * That makes an agent safe to restart — a crash between "asked" and
   * "recorded that I asked" does not produce two notifications for one
   * decision. Two *concurrent* calls can still both find nothing and both
   * create; real idempotency needs a key the server enforces, and that is
   * server work, not something a client can promise.
   */
  async findByExternalId(externalId: string, signal?: AbortSignal): Promise<Approval | null> {
    const found = await this.list({ externalId, limit: 1 }, signal);
    return found[0] ?? null;
  }

  /**
   * A page on which one approver decides this request, inside your product.
   *
   * Keep `url` or `clientSecret` for the person in front of you: they are
   * returned once. Neither decides anything — the approver signs in, or
   * confirms a code sent to their own address, before they can.
   */
  async createSession(
    approvalId: string,
    input: CreateDecisionSessionInput,
    signal?: AbortSignal
  ): Promise<DecisionSession> {
    return this.http.request<DecisionSession>({
      method: "POST",
      path: `/approvals/${approvalId}/sessions`,
      body: input,
      signal,
    });
  }
}

/** Decision sessions, after they are made: where they stand, and ending one early. */
export class DecisionSessions {
  constructor(private readonly http: HttpClient) {}

  async get(id: string, signal?: AbortSignal): Promise<DecisionSession> {
    return this.http.request<DecisionSession>({ method: "GET", path: `/decision-sessions/${id}`, signal });
  }

  /** End it now. A decision already made through it stays made. */
  async expire(id: string, signal?: AbortSignal): Promise<DecisionSession> {
    return this.http.request<DecisionSession>({ method: "POST", path: `/decision-sessions/${id}/expire`, signal });
  }
}
