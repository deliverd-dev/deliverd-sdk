import { listOrCollect, type PageOf } from "./paging.js";
import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { POLL_SCHEDULE } from "./approvals.js";
import type {
  AnswerValue,
  CollectedAnswers,
  CollectionData,
  CreateCollectionInput,
  ListCollectionsInput,
} from "./types.js";

/**
 * Ask people for what you do not have.
 *
 * The third of the three, and the one that goes the other way. `approve()`
 * asks permission, `review()` asks judgement, and this asks for a fact: a
 * figure, a date, a choice between options, the sentence only they can write.
 */

export interface CollectWaitOptions {
  /** Called after every poll, for a progress line in a CLI. */
  onPoll?: (collection: CollectionData) => void;
  /**
   * Give up after this many milliseconds and throw `DeliverdTimeoutError`.
   * Omitted, the wait ends when the request does — which, with no `expiresAt`,
   * may be never. Set one or the other.
   */
  timeout?: number;
  signal?: AbortSignal;
  pollIntervals?: readonly number[];
}

function pollDelay(poll: number, schedule: readonly number[]): number {
  const base = schedule[Math.min(poll, schedule.length - 1)] ?? 60_000;
  return base * 0.75 + Math.random() * base * 0.5;
}

/** A request for answers, and what you can do with it. */
export class Collection {
  constructor(
    private readonly http: HttpClient,
    private data: CollectionData
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
  get status(): CollectionData["status"] { return this.data.status; }
  /** The page the people you asked will fill in. */
  get url(): string { return this.data.url; }
  get title(): string { return this.data.title; }
  get responses(): CollectionData["responses"] { return this.data.responses; }
  get submittedCount(): number { return this.data.submittedCount; }
  get askedCount(): number { return this.data.askedCount; }

  /** The one to branch on. False for expired and cancelled. */
  get complete(): boolean { return this.data.status === "complete"; }
  get expired(): boolean { return this.data.status === "expired"; }
  get cancelled(): boolean { return this.data.status === "cancelled"; }
  get pending(): boolean { return this.data.status === "pending"; }

  toJSON(): CollectionData { return this.data; }

  /**
   * The first submitted answer to each question, keyed by its prompt.
   *
   * The shape most callers want, because most callers asked one person for
   * three facts. When several people answered the same question, later
   * replies do not overwrite the first — use `responses` when you need all of
   * them, and note that this returns the earliest submission rather than a
   * merge, since silently blending two people's answers would be worse than
   * making you choose.
   */
  get answers(): Record<string, AnswerValue> {
    const out: Record<string, AnswerValue> = {};
    for (const reply of this.data.responses) {
      if (reply.status !== "submitted") continue;
      for (const answer of reply.answers) {
        if (!(answer.question in out)) out[answer.question] = answer.value;
      }
    }
    return out;
  }

  toCollected(): CollectedAnswers {
    const status = this.data.status === "pending" ? "expired" : this.data.status;
    return {
      complete: this.data.status === "complete",
      status,
      responses: this.data.responses.filter((r) => r.status === "submitted"),
      answers: this.answers,
      id: this.data.id,
      url: this.data.url,
      collection: this.data,
    } as CollectedAnswers;
  }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<CollectionData>({
      method: "GET",
      path: `/collections/${this.data.id}`,
      signal,
    });
    return this;
  }

  /** Withdraw it. The row stays as evidence of what was asked and dropped. */
  async cancel(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<CollectionData>({
      method: "POST",
      path: `/collections/${this.data.id}/cancel`,
      signal,
    });
    return this;
  }

  /**
   * Block until enough people have answered, then return.
   *
   * Resolves on every ending, including expiry — which is an answer of a
   * kind, and one you must handle rather than treat as an error, because the
   * thing you do without the figure is usually different from the thing you
   * do with it.
   */
  async wait(options: CollectWaitOptions = {}): Promise<this> {
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
          `Nobody finished answering "${this.data.title}" within the timeout. It is still open at ${this.data.url}.`
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

export class Collections {
  constructor(private readonly http: HttpClient) {}

  /** Ask. Returns as soon as the request is filed; call `wait()` next. */
  async create(input: CreateCollectionInput, signal?: AbortSignal): Promise<Collection> {
    const data = await this.http.request<CollectionData>({
      method: "POST",
      path: "/collections",
      body: input,
      signal,
    });
    const created = new Collection(this.http, data);
    created.callbackSecret = (data as CollectionData & { callbackSecret?: string }).callbackSecret ?? null;
    return created;
  }

  async get(id: string, signal?: AbortSignal): Promise<Collection> {
    const data = await this.http.request<CollectionData>({
      method: "GET",
      path: `/collections/${id}`,
      signal,
    });
    return new Collection(this.http, data);
  }

  /**
   * The organisation's collections, newest first.
   *
   * With no `limit` this is every one of them: the API says where each page
   * stopped and this follows the cursor to the end. With a `limit` it is one
   * page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListCollectionsInput = {}, signal?: AbortSignal): Promise<Collection[]> {
    return listOrCollect(input, async (q: { limit?: number; cursor?: string }) => {
      const page = await this.listPage({ ...input, ...q }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: ListCollectionsInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<Collection>> {
    const { collections, nextCursor } = await this.http.request<{
      collections: CollectionData[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/collections",
      query: { status: input.status, externalId: input.externalId, limit: input.limit, cursor: input.cursor },
      signal,
    });
    return { items: collections.map((r) => new Collection(this.http, r)), nextCursor };
  }

  /** Ask and wait, for the common case where there is nothing to do between. */
  async request(
    input: CreateCollectionInput,
    options: CollectWaitOptions = {}
  ): Promise<Collection> {
    const collection = await this.create(input, options.signal);
    return collection.wait(options);
  }

  /** The same request as before, when there was one — so a restart does not ask twice. */
  async findByExternalId(externalId: string, signal?: AbortSignal): Promise<Collection | null> {
    const found = await this.list({ externalId, limit: 1 }, signal);
    return found[0] ?? null;
  }
}
