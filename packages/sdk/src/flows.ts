import { listOrCollect, type PageOf } from "./paging.js";
import type { HttpClient } from "./http.js";
import type { CreateFlowInput, EvidencePack, FlowData, ListFlowsInput } from "./types.js";
/*
 * Type-only, and therefore erased: `index.ts` imports this file at runtime,
 * and a value import back would be a cycle. What the handle needs from the
 * client is its three primitives with their real signatures, so that
 * `flow.approve({…})` is checked exactly as `deliverd.approve({…})` is.
 */
import type {
  ApproveOptions,
  CollectOptions,
  Decision,
  ReviewOptions,
  ReviewOutcome,
} from "./index.js";
import type { CollectedAnswers } from "./types.js";

/**
 * A flow: the thread that ties one job's approvals, reviews, collections and
 * publishes together.
 *
 * The reason it exists in this SDK rather than only in the API is the handle
 * below. An agent doing a multi-step job would otherwise carry a `flowId`
 * through every call and pass it by hand each time — which works right up
 * until one call is written without it, and that step is then missing from
 * the history with nothing to say so. `flow.approve()` cannot forget.
 *
 * It groups and nothing else. Nothing waits on a flow; nothing is blocked by
 * one; there are no steps to declare up front. Do the work in the order you
 * want it done and name the flow as you go.
 */

/** The three primitives a flow can start on your behalf, with their real signatures. */
export interface FlowPrimitives {
  approve(options: ApproveOptions): Promise<Decision>;
  review(options: ReviewOptions): Promise<ReviewOutcome>;
  collect(options: CollectOptions): Promise<CollectedAnswers>;
}

export class Flow {
  constructor(
    private readonly http: HttpClient,
    private data: FlowData,
    private readonly client: FlowPrimitives
  ) {}

  get id(): string { return this.data.id; }
  get status(): FlowData["status"] { return this.data.status; }
  /** The timeline page a person can open. */
  get url(): string { return this.data.url; }
  get title(): string { return this.data.title; }
  get members(): FlowData["members"] { return this.data.members; }
  get timeline(): NonNullable<FlowData["timeline"]> { return this.data.timeline ?? []; }
  get memberCount(): number { return this.data.memberCount; }
  get openCount(): number { return this.data.openCount; }

  get open(): boolean { return this.data.status === "open"; }
  get complete(): boolean { return this.data.status === "complete"; }
  get cancelled(): boolean { return this.data.status === "cancelled"; }

  /**
   * Nothing in it is waiting on anybody *at this moment*.
   *
   * Not a claim that the job is finished — you may be about to add the next
   * step, and an empty flow is never settled. Branch on it to decide whether
   * to move on; call `complete()` to say the work is over.
   */
  get allSettled(): boolean { return this.data.allSettled; }

  toJSON(): FlowData { return this.data; }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<FlowData>({
      method: "GET",
      path: `/flows/${this.data.id}`,
      signal,
    });
    return this;
  }

  /**
   * Ask permission, inside this flow. Exactly `deliverd.approve()` with the
   * flow already named — which is the point: a `flowId` passed by hand at
   * four call sites is one that gets left off the fifth.
   */
  approve(options: Omit<ApproveOptions, "flowId">): Promise<Decision> {
    return this.client.approve({ ...options, flowId: this.data.id });
  }

  /** Ask for judgement, inside this flow. */
  review(options: Omit<ReviewOptions, "flowId">): Promise<ReviewOutcome> {
    return this.client.review({ ...options, flowId: this.data.id });
  }

  /** Ask for facts, inside this flow. */
  collect(options: Omit<CollectOptions, "flowId">): Promise<CollectedAnswers> {
    return this.client.collect({ ...options, flowId: this.data.id });
  }

  /**
   * The whole record of this flow: every step with who was asked and what they
   * said, and the timeline across all of it.
   *
   * What to hand over when somebody asks you to show your working. Needs every
   * read scope, because it contains everything.
   */
  evidence(signal?: AbortSignal): Promise<EvidencePack> {
    return this.http.request<EvidencePack>({
      method: "GET",
      path: `/flows/${this.data.id}/evidence`,
      signal,
    });
  }

  /**
   * Say the work is done. It stops taking new members from here.
   *
   * Named `close()` rather than `complete()` so it does not collide with the
   * `complete` getter above, which every other primitive in this SDK also
   * has; `flow.complete` asks, `flow.close()` decides.
   *
   * Allowed with steps still outstanding, and how many is recorded — a flow
   * that could not be closed until every reviewer replied would be one that
   * stayed open for ever.
   */
  async close(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<FlowData>({
      method: "POST",
      path: `/flows/${this.data.id}/complete`,
      signal,
    });
    return this;
  }

  /** Call it off. The flow and its members stay as evidence; nothing inside is cancelled. */
  async cancel(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<FlowData>({
      method: "POST",
      path: `/flows/${this.data.id}/cancel`,
      signal,
    });
    return this;
  }
}

export class Flows {
  constructor(
    private readonly http: HttpClient,
    private readonly client: FlowPrimitives
  ) {}

  async create(input: CreateFlowInput, signal?: AbortSignal): Promise<Flow> {
    const data = await this.http.request<FlowData>({
      method: "POST",
      path: "/flows",
      body: input,
      signal,
    });
    return new Flow(this.http, data, this.client);
  }

  async get(id: string, signal?: AbortSignal): Promise<Flow> {
    const data = await this.http.request<FlowData>({
      method: "GET",
      path: `/flows/${id}`,
      signal,
    });
    return new Flow(this.http, data, this.client);
  }

  /**
   * The organisation's flows, newest first.
   *
   * With no `limit` this is every one of them: the API says where each page
   * stopped and this follows the cursor to the end. With a `limit` it is one
   * page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListFlowsInput = {}, signal?: AbortSignal): Promise<Flow[]> {
    return listOrCollect(input, async (q: { limit?: number; cursor?: string }) => {
      const page = await this.listPage({ ...input, ...q }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: ListFlowsInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<Flow>> {
    const { flows, nextCursor } = await this.http.request<{
      flows: FlowData[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/flows",
      query: { status: input.status, externalId: input.externalId, limit: input.limit, cursor: input.cursor },
      signal,
    });
    return { items: flows.map((f) => new Flow(this.http, f, this.client)), nextCursor };
  }

  /** The same job as before, when there was one — so a restart extends it rather than starting a second. */
  async findByExternalId(externalId: string, signal?: AbortSignal): Promise<Flow | null> {
    const found = await this.list({ externalId, limit: 1 }, signal);
    return found[0] ?? null;
  }

  /**
   * The flow for this reference, started if it does not exist yet.
   *
   * What a restartable agent actually wants: one line that is correct on the
   * first run and on the fourth. Without it the caller writes the lookup, the
   * branch and the create by hand, and a crash between the lookup and the
   * create leaves two flows for one job.
   */
  async resume(input: CreateFlowInput & { externalId: string }, signal?: AbortSignal): Promise<Flow> {
    const existing = await this.findByExternalId(input.externalId, signal);
    if (existing && existing.open) return existing;
    return this.create(input, signal);
  }
}
