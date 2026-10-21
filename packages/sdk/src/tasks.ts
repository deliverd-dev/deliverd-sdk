import { listOrCollect, type PageOf } from "./paging.js";
import type { HttpClient } from "./http.js";
import type {
  AddFindingInput,
  AppliedSideTask,
  ApplySideTaskInput,
  CancelTaskInput,
  CompleteTaskInput,
  ControlApprovalInput,
  ControlApprovalResult,
  CreateSideTaskInput,
  CreateTaskInput,
  DecisionApproval,
  Governance,
  GovernanceGateCheck,
  GovernancePack,
  GovernanceProfileInput,
  LinkTasksInput,
  ListTasksInput,
  ReassessmentResult,
  RequestDecisionApprovalInput,
  SubmitEvidenceInput,
  TaskContext,
  TaskData,
  TaskFinding,
  TaskGraph,
  TaskLinkResult,
  UpdateGovernanceProfileInput,
  UpdateTaskInput,
} from "./types.js";

/**
 * Task Graph: what the work is for, kept apart from the conversation doing it.
 *
 * An agent deep in a debugging session forgets the objective it started
 * from, because the objective is a paragraph thousands of tokens back. A task
 * keeps it somewhere the agent can ask for: `task.context()` returns the
 * objective first, always, then where this task stands, what is settled, and
 * one paragraph to say back to itself.
 *
 * A problem that would take over the thread is branched into a side task with
 * the facts it needs (not the transcript), completed with a structured
 * result, and applied back to the parent — which is how the main thread gets
 * the answer without the hour it took.
 *
 * Nothing here asks a person anything by itself. A decision is recorded as a
 * suggestion, and `requestDecisionApproval()` is how one is put to somebody.
 *
 * A governed task (Compliance Mode, Business and Enterprise) also has
 * controls, evidence and a gate: `submitEvidence()` records what a run
 * measured, a tool's own report, or an experiment pulled from the
 * organisation's Langfuse, LangSmith, Braintrust or Weave, and `checkGovernanceGate()` says whether
 * the work may proceed. Thresholds are a person's to set; an agent's key is
 * refused, so whatever submits the results does not decide what passes.
 */

const enc = encodeURIComponent;

export class Task {
  constructor(
    private readonly http: HttpClient,
    private data: TaskData
  ) {}

  get id(): string { return this.data.id; }
  get kind(): TaskData["kind"] { return this.data.kind; }
  get status(): TaskData["status"] { return this.data.status; }
  /** The page a person can open. */
  get url(): string { return this.data.url; }
  get title(): string { return this.data.title; }
  /** What the work is for: the objective's purpose, or a side task's goal. */
  get objective(): string { return this.data.objective; }
  get state(): TaskData["state"] { return this.data.state; }
  get version(): number { return this.data.version; }
  get rootTaskId(): string { return this.data.rootTaskId; }
  get parentTaskId(): string | null { return this.data.parentTaskId; }
  get result(): TaskData["result"] { return this.data.result; }
  get outcome(): TaskData["outcome"] { return this.data.outcome; }
  /** Present on a single read; empty otherwise. */
  get findings(): NonNullable<TaskData["findings"]> { return this.data.findings ?? []; }
  /** Present on a single read; empty otherwise. */
  get children(): NonNullable<TaskData["children"]> { return this.data.children ?? []; }
  /** True when `create()` returned an open objective you had already started under the same `externalId`. */
  get resumed(): boolean { return this.data.resumed === true; }

  get isSideTask(): boolean { return this.data.kind !== "objective"; }
  /** Neither completed nor cancelled. */
  get active(): boolean { return this.data.status !== "completed" && this.data.status !== "cancelled"; }
  get completed(): boolean { return this.data.status === "completed"; }
  get cancelled(): boolean { return this.data.status === "cancelled"; }

  toJSON(): TaskData { return this.data; }

  async refresh(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<TaskData>({ method: "GET", path: `/tasks/${enc(this.data.id)}`, signal });
    return this;
  }

  /** What to read instead of the history. Call it whenever you have lost the thread. */
  context(signal?: AbortSignal): Promise<TaskContext> {
    return this.http.request<TaskContext>({ method: "GET", path: `/tasks/${enc(this.data.id)}/context`, signal });
  }

  /** The whole tree this task belongs to, from its objective down. */
  graph(signal?: AbortSignal): Promise<TaskGraph> {
    return this.http.request<TaskGraph>({ method: "GET", path: `/tasks/${enc(this.data.id)}/graph`, signal });
  }

  /** Change the title, status or working state. */
  async update(input: UpdateTaskInput, signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<TaskData>({
      method: "PATCH",
      path: `/tasks/${enc(this.data.id)}`,
      body: input,
      signal,
    });
    return this;
  }

  /** Branch a problem out of this task so it does not take over the thread. */
  async createSideTask(input: CreateSideTaskInput, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/side-tasks`,
      body: input,
      signal,
    });
    return new Task(this.http, data);
  }

  /** Record what was tested, seen or concluded. A decision is recorded as a suggestion. */
  addFinding(input: AddFindingInput, signal?: AbortSignal): Promise<TaskFinding> {
    return this.http.request<TaskFinding>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/findings`,
      body: input,
      signal,
    });
  }

  /** Put a suggested decision on this task to a person. */
  requestDecisionApproval(
    findingId: string,
    input: RequestDecisionApprovalInput = {},
    signal?: AbortSignal
  ): Promise<DecisionApproval> {
    return this.http.request<DecisionApproval>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/findings/${enc(findingId)}/approval`,
      body: input,
      signal,
    });
  }

  /** Finish it with a structured result. A side task's result then waits to be applied. */
  async complete(input: CompleteTaskInput, signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<TaskData>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/complete`,
      body: input,
      signal,
    });
    return this;
  }

  /**
   * Carry this finished side task's result into its parent — or record that it
   * was kept for reference, or discarded. Returns the parent's fresh context,
   * which is what to read next.
   */
  async apply(input: ApplySideTaskInput = {}, signal?: AbortSignal): Promise<AppliedSideTask> {
    const out = await this.http.request<AppliedSideTask>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/apply`,
      body: input,
      signal,
    });
    this.data = out.sideTask;
    return out;
  }

  /** Open a completed task again. Its result is kept in `previousResults`. */
  async reopen(signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<TaskData>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/reopen`,
      body: {},
      signal,
    });
    return this;
  }

  /** Call it off. It stays in the tree as a record of what was tried. */
  async cancel(input: CancelTaskInput = {}, signal?: AbortSignal): Promise<this> {
    this.data = await this.http.request<TaskData>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/cancel`,
      body: input,
      signal,
    });
    return this;
  }

  /** Relate this task to another: it depends on, blocks, supersedes… */
  link(input: LinkTasksInput, signal?: AbortSignal): Promise<TaskLinkResult> {
    return this.http.request<TaskLinkResult>({
      method: "POST",
      path: `/tasks/${enc(this.data.id)}/links`,
      body: input,
      signal,
    });
  }

  /** Its governance: controls, their thresholds and scores, evidence, readiness and the gate. */
  governance(signal?: AbortSignal): Promise<Governance> {
    return new Tasks(this.http).governance(this.data.id, signal);
  }

  /** Record evidence for the controls it speaks to: a link, what a run measured, or a tool's own report. */
  submitEvidence(input: SubmitEvidenceInput, signal?: AbortSignal): Promise<Governance> {
    return new Tasks(this.http).submitEvidence(this.data.id, input, signal);
  }

  /** Whether the governed work may proceed. Ask before deploying, sending or acting on the result. */
  checkGovernanceGate(options: { action?: string } = {}, signal?: AbortSignal): Promise<GovernanceGateCheck> {
    return new Tasks(this.http).checkGovernanceGate(this.data.id, options, signal);
  }

  /** Govern it (Compliance Mode). Already governed, it answers with the governance it has. */
  govern(profile: GovernanceProfileInput = {}, signal?: AbortSignal): Promise<Governance> {
    return new Tasks(this.http).govern(this.data.id, profile, signal);
  }

  /** Change its governance profile. An agent may raise risk or add facts; only a person lowers or clears them. */
  updateGovernanceProfile(input: UpdateGovernanceProfileInput, signal?: AbortSignal): Promise<Governance> {
    return new Tasks(this.http).updateGovernanceProfile(this.data.id, input, signal);
  }

  /** Put an approval control to a person through the organisation's approval process. */
  requestControlApproval(control: string, input: ControlApprovalInput = {}, signal?: AbortSignal): Promise<ControlApprovalResult> {
    return new Tasks(this.http).requestControlApproval(this.data.id, control, input, signal);
  }

  /** Ask for it to be reassessed (Enterprise). The governance gate stays closed until a person completes it. */
  triggerReassessment(reason: string, signal?: AbortSignal): Promise<ReassessmentResult> {
    return new Tasks(this.http).triggerReassessment(this.data.id, reason, signal);
  }

  /** Its evidence pack, with a digest. It assists audit; it does not certify compliance. */
  evidencePack(signal?: AbortSignal): Promise<GovernancePack> {
    return new Tasks(this.http).evidencePack(this.data.id, signal);
  }
}

export class Tasks {
  constructor(private readonly http: HttpClient) {}

  /**
   * Start an objective. With an `externalId`, an open objective you already
   * started under it comes back instead (`task.resumed`), so a restarted
   * agent picks its goal up rather than starting a second.
   */
  async create(input: CreateTaskInput, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "POST", path: "/tasks", body: input, signal });
    return new Task(this.http, data);
  }

  /** A task with its path, children, findings and links. */
  async get(id: string, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "GET", path: `/tasks/${enc(id)}`, signal });
    return new Task(this.http, data);
  }

  /**
   * Objectives, most recently active first. Side tasks are reached through
   * the objective they belong to.
   *
   * With no `limit` this is every one of them; with a `limit` it is one page,
   * and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListTasksInput = {}, signal?: AbortSignal): Promise<Task[]> {
    return listOrCollect(input, async (q: { limit?: number; cursor?: string }) => {
      const page = await this.listPage({ ...input, ...q }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(input: ListTasksInput = {}, signal?: AbortSignal): Promise<PageOf<Task>> {
    const { tasks, nextCursor } = await this.http.request<{ tasks: TaskData[]; nextCursor: string | null }>({
      method: "GET",
      path: "/tasks",
      query: {
        status: input.status,
        externalId: input.externalId,
        q: input.q,
        limit: input.limit,
        cursor: input.cursor,
      },
      signal,
    });
    return { items: tasks.map((t) => new Task(this.http, t)), nextCursor };
  }

  context(id: string, signal?: AbortSignal): Promise<TaskContext> {
    return this.http.request<TaskContext>({ method: "GET", path: `/tasks/${enc(id)}/context`, signal });
  }

  graph(id: string, signal?: AbortSignal): Promise<TaskGraph> {
    return this.http.request<TaskGraph>({ method: "GET", path: `/tasks/${enc(id)}/graph`, signal });
  }

  async update(id: string, input: UpdateTaskInput, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "PATCH", path: `/tasks/${enc(id)}`, body: input, signal });
    return new Task(this.http, data);
  }

  async createSideTask(parentId: string, input: CreateSideTaskInput, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({
      method: "POST",
      path: `/tasks/${enc(parentId)}/side-tasks`,
      body: input,
      signal,
    });
    return new Task(this.http, data);
  }

  addFinding(id: string, input: AddFindingInput, signal?: AbortSignal): Promise<TaskFinding> {
    return this.http.request<TaskFinding>({ method: "POST", path: `/tasks/${enc(id)}/findings`, body: input, signal });
  }

  requestDecisionApproval(
    id: string,
    findingId: string,
    input: RequestDecisionApprovalInput = {},
    signal?: AbortSignal
  ): Promise<DecisionApproval> {
    return this.http.request<DecisionApproval>({
      method: "POST",
      path: `/tasks/${enc(id)}/findings/${enc(findingId)}/approval`,
      body: input,
      signal,
    });
  }

  async complete(id: string, input: CompleteTaskInput, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "POST", path: `/tasks/${enc(id)}/complete`, body: input, signal });
    return new Task(this.http, data);
  }

  apply(id: string, input: ApplySideTaskInput = {}, signal?: AbortSignal): Promise<AppliedSideTask> {
    return this.http.request<AppliedSideTask>({ method: "POST", path: `/tasks/${enc(id)}/apply`, body: input, signal });
  }

  async reopen(id: string, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "POST", path: `/tasks/${enc(id)}/reopen`, body: {}, signal });
    return new Task(this.http, data);
  }

  async cancel(id: string, input: CancelTaskInput = {}, signal?: AbortSignal): Promise<Task> {
    const data = await this.http.request<TaskData>({ method: "POST", path: `/tasks/${enc(id)}/cancel`, body: input, signal });
    return new Task(this.http, data);
  }

  link(id: string, input: LinkTasksInput, signal?: AbortSignal): Promise<TaskLinkResult> {
    return this.http.request<TaskLinkResult>({ method: "POST", path: `/tasks/${enc(id)}/links`, body: input, signal });
  }

  /** A governed task's governance: controls, their thresholds and scores, evidence, readiness and the gate. */
  governance(id: string, signal?: AbortSignal): Promise<Governance> {
    return this.http.request<Governance>({ method: "GET", path: `/tasks/${enc(id)}/governance`, signal });
  }

  /**
   * Record evidence for a governed task and the controls it speaks to. For an
   * eval or red-team run, send what it measured as `results`, or the tool's
   * own `report` and let the server read it. A control with thresholds is met
   * only when its newest scored evidence meets them. Called on a side task,
   * it belongs to the objective and remembers where it came from.
   */
  submitEvidence(id: string, input: SubmitEvidenceInput, signal?: AbortSignal): Promise<Governance> {
    return this.http.request<Governance>({ method: "POST", path: `/tasks/${enc(id)}/governance/evidence`, body: input, signal });
  }

  /**
   * Whether governed work may proceed: `allowed`, what is missing, what else
   * blocks it, and the `scores` of each control with thresholds. With
   * `action` (Enterprise), also whether this agent may take that kind of action.
   */
  checkGovernanceGate(id: string, options: { action?: string } = {}, signal?: AbortSignal): Promise<GovernanceGateCheck> {
    return this.http.request<GovernanceGateCheck>({
      method: "GET",
      path: `/tasks/${enc(id)}/governance/gate`,
      query: { action: options.action },
      signal,
    });
  }

  /**
   * Govern an objective (Compliance Mode, Business and Enterprise): the AI
   * system, purpose, owners, risk, data and oversight, as far as they are
   * known. Idempotent: an objective already governed answers with its
   * governance. A side task's id answers for its objective.
   */
  govern(id: string, profile: GovernanceProfileInput = {}, signal?: AbortSignal): Promise<Governance> {
    return this.http.request<Governance>({ method: "POST", path: `/tasks/${enc(id)}/governance`, body: profile, signal });
  }

  /**
   * Change a governed task's profile. An agent may raise risk or add facts;
   * only a person lowers or clears them. With `expectedVersion`, refused if
   * somebody wrote in between.
   */
  updateGovernanceProfile(id: string, input: UpdateGovernanceProfileInput, signal?: AbortSignal): Promise<Governance> {
    return this.http.request<Governance>({ method: "PATCH", path: `/tasks/${enc(id)}/governance`, body: input, signal });
  }

  /**
   * Put an approval control (a compliance or deployment approval) to a person
   * through the organisation's approval process. The control is satisfied
   * when that approval is approved. Needs `approvals:write`.
   */
  requestControlApproval(
    id: string,
    control: string,
    input: ControlApprovalInput = {},
    signal?: AbortSignal
  ): Promise<ControlApprovalResult> {
    return this.http.request<ControlApprovalResult>({
      method: "POST",
      path: `/tasks/${enc(id)}/governance/controls/${enc(control)}/approval`,
      body: input,
      signal,
    });
  }

  /** Ask for a governed task to be reassessed (Enterprise). Its governance gate stays closed until a person completes it. */
  triggerReassessment(id: string, reason: string, signal?: AbortSignal): Promise<ReassessmentResult> {
    return this.http.request<ReassessmentResult>({
      method: "POST",
      path: `/tasks/${enc(id)}/governance/reassessments`,
      body: { reason },
      signal,
    });
  }

  /**
   * A governed task's evidence pack: profile, controls, evidence, task graph,
   * decisions, approvals and the audit timeline, with a digest. It assists
   * audit; it does not certify compliance. Every export is audited.
   */
  evidencePack(id: string, signal?: AbortSignal): Promise<GovernancePack> {
    return this.http.request<GovernancePack>({ method: "GET", path: `/tasks/${enc(id)}/governance/pack`, signal });
  }
}
