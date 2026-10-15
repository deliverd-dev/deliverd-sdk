import { listOrCollect, type PageOf } from "./paging.js";
import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { POLL_SCHEDULE } from "./approvals.js";
import type {
  CreateReviewInput,
  ListReviewsInput,
  ReviewData,
  ReviewOutcome,
} from "./types.js";

/**
 * Ask people to read what you made and say whether it is right.
 *
 * The sibling of approvals, and the difference is worth keeping straight: an
 * approval asks permission for something that has not happened, a review asks
 * judgement on something that has. The waiting is the same shape, so the
 * polling is shared.
 */

export interface ReviewWaitOptions {
  /** Called after every poll, for a progress line in a CLI. */
  onPoll?: (review: ReviewData) => void;
  /**
   * Give up after this many milliseconds and throw `DeliverdTimeoutError`.
   * Omitted, the wait ends when the review does — which, for a review with no
   * `expiresAt`, may be never. Set one or the other.
   */
  timeout?: number;
  signal?: AbortSignal;
  /** How long between polls, as the wait lengthens. Rarely worth changing. */
  pollIntervals?: readonly number[];
}

function pollDelay(poll: number, schedule: readonly number[]): number {
  const base = schedule[Math.min(poll, schedule.length - 1)] ?? 60_000;
  // Jitter, so a hundred agents started by the same cron do not arrive together.
  return base * 0.75 + Math.random() * base * 0.5;
}

/** A review, and what you can do with it. */
export class Review {
  constructor(
    private readonly http: HttpClient,
    private data: ReviewData
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
  get status(): ReviewData["status"] { return this.data.status; }
  /** The page the reviewer reads and decides on. */
  get url(): string { return this.data.url; }
  get title(): string { return this.data.title; }
  get verdicts(): ReviewData["verdicts"] { return this.data.verdicts; }
  /** How many comment threads the reviewers opened while reading. */
  get threadCount(): number { return this.data.threadCount; }

  /** The one to branch on. False for changes requested, expired and cancelled. */
  get approved(): boolean { return this.data.status === "approved"; }
  get changesRequested(): boolean { return this.data.status === "changes_requested"; }
  get expired(): boolean { return this.data.status === "expired"; }
  get cancelled(): boolean { return this.data.status === "cancelled"; }
  get pending(): boolean { return this.data.status === "pending"; }

  /** Everything the API returned, if you want a field the getters do not name. */
  toJSON(): ReviewData { return this.data; }

  toOutcome(): ReviewOutcome {
    const status = this.data.status === "pending" ? "expired" : this.data.status;
    return {
      approved: this.data.status === "approved",
      status,
      verdicts: this.data.verdicts,
      threadCount: this.data.threadCount,
      id: this.data.id,
      url: this.data.url,
      review: this.data,
    } as ReviewOutcome;
  }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<ReviewData>({
      method: "GET",
      path: `/reviews/${this.data.id}`,
      signal,
    });
    return this;
  }

  /** Withdraw it. The row stays as evidence of what was asked and dropped. */
  async cancel(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<ReviewData>({
      method: "POST",
      path: `/reviews/${this.data.id}/cancel`,
      signal,
    });
    return this;
  }

  /**
   * Block until the reviewers settle it, then return.
   *
   * Resolves on every ending, including changes requested — that is an answer
   * and the most useful one, because it comes with the threads that say what
   * to change. It throws only when the wait itself failed: a timeout, an
   * abort, or an API that could not be reached.
   */
  async wait(options: ReviewWaitOptions = {}): Promise<this> {
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
          `Nobody finished reviewing "${this.data.title}" within the timeout. It is still open at ${this.data.url}.`
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

export class Reviews {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ask. Returns as soon as the request is filed — the reviewers are being
   * told while this resolves — so call `wait()` next, or keep the id and poll
   * later.
   */
  async create(input: CreateReviewInput, signal?: AbortSignal): Promise<Review> {
    const data = await this.http.request<ReviewData>({
      method: "POST",
      path: "/reviews",
      body: input,
      signal,
    });
    const created = new Review(this.http, data);
    created.callbackSecret = (data as ReviewData & { callbackSecret?: string }).callbackSecret ?? null;
    return created;
  }

  async get(id: string, signal?: AbortSignal): Promise<Review> {
    const data = await this.http.request<ReviewData>({
      method: "GET",
      path: `/reviews/${id}`,
      signal,
    });
    return new Review(this.http, data);
  }

  /**
   * The organisation's reviews, newest first.
   *
   * With no `limit` this is every one of them: the API says where each page
   * stopped and this follows the cursor to the end. With a `limit` it is one
   * page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListReviewsInput = {}, signal?: AbortSignal): Promise<Review[]> {
    return listOrCollect(input, async (q: { limit?: number; cursor?: string }) => {
      const page = await this.listPage({ ...input, ...q }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: ListReviewsInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<Review>> {
    const { reviews, nextCursor } = await this.http.request<{
      reviews: ReviewData[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/reviews",
      query: { status: input.status, externalId: input.externalId, reportId: input.reportId, limit: input.limit, cursor: input.cursor },
      signal,
    });
    return { items: reviews.map((r) => new Review(this.http, r)), nextCursor };
  }

  /** Ask and wait, for the common case where there is nothing to do between. */
  async request(input: CreateReviewInput, options: ReviewWaitOptions = {}): Promise<Review> {
    const review = await this.create(input, options.signal);
    return review.wait(options);
  }

  /**
   * The same request as before, when there was one — so restarting a crashed
   * agent does not ask the same people twice. The caveat is the one
   * `approvals.findByExternalId` carries: two concurrent calls can still both
   * find nothing and both create.
   */
  async findByExternalId(externalId: string, signal?: AbortSignal): Promise<Review | null> {
    const found = await this.list({ externalId, limit: 1 }, signal);
    return found[0] ?? null;
  }
}
