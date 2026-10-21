import type { HttpClient } from "./http.js";
import { listOrCollect, type PageOf } from "./paging.js";
import type {
  AiIncident,
  AiIncidentDetail,
  AiSystem,
  AiSystemDetail,
  AuthorityDecision,
  CheckAuthorityInput,
  CreateCustomFrameworkInput,
  CustomFramework,
  DraftedIncidentReport,
  DraftIncidentReportInput,
  FrameworkCatalogue,
  FrameworkMapping,
  FrameworkMappingInput,
  GovernanceSummary,
  GovernanceSummaryInput,
  IctRegister,
  ListIncidentsInput,
  ModelChangeInput,
  ModelChangeResult,
  RegisterAiSystemInput,
  ReportIncidentInput,
  UpdateAiSystemInput,
} from "./types.js";

const enc = encodeURIComponent;

/**
 * The organisation's register of AI systems. A governed task names one by
 * `aiSystemId` instead of describing it again, and a change of model is
 * recorded here so every task using it is reassessed.
 */
export class AiSystems {
  constructor(private readonly http: HttpClient) {}

  /** The register, active and retired, or only one of them. */
  async list(input: { status?: AiSystem["status"] } = {}, signal?: AbortSignal): Promise<AiSystem[]> {
    const { aiSystems } = await this.http.request<{ aiSystems: AiSystem[] }>({
      method: "GET",
      path: "/ai-systems",
      query: { status: input.status },
      signal,
    });
    return aiSystems;
  }

  /** One system, and the governed tasks that name it. */
  get(id: string, signal?: AbortSignal): Promise<AiSystemDetail> {
    return this.http.request<AiSystemDetail>({ method: "GET", path: `/ai-systems/${enc(id)}`, signal });
  }

  /** Add a system to the register. Digests of its prompt and guardrails, never the text. */
  register(input: RegisterAiSystemInput, signal?: AbortSignal): Promise<AiSystem> {
    return this.http.request<AiSystem>({ method: "POST", path: "/ai-systems", body: input, signal });
  }

  /** Change a system's record. An agent may raise its risk but not lower it, and may not retire it. */
  update(id: string, input: UpdateAiSystemInput, signal?: AbortSignal): Promise<AiSystem> {
    return this.http.request<AiSystem>({ method: "PATCH", path: `/ai-systems/${enc(id)}`, body: input, signal });
  }

  /**
   * Record a new provider, model, version, prompt or guardrails (Enterprise).
   * Every governed task using the system is reassessed, and evidence of the
   * old release stops counting.
   */
  recordModelChange(id: string, input: ModelChangeInput, signal?: AbortSignal): Promise<ModelChangeResult> {
    return this.http.request<ModelChangeResult>({
      method: "POST",
      path: `/ai-systems/${enc(id)}/model-change`,
      body: input,
      signal,
    });
  }
}

/**
 * AI incidents, and the DORA reports on the major ones. A high or critical
 * incident closes its task's governance gate until a person resolves it in
 * Deliverd; classifying it, and submitting a report, are a person's too.
 */
export class Incidents {
  constructor(private readonly http: HttpClient) {}

  /** Report an incident against a governed task, an AI system, or both. */
  report(input: ReportIncidentInput, signal?: AbortSignal): Promise<AiIncident> {
    return this.http.request<AiIncident>({ method: "POST", path: "/governance/incidents", body: input, signal });
  }

  /** One incident: its DORA classification, its reports and their sign-off, and which report is due next. */
  get(id: string, signal?: AbortSignal): Promise<AiIncidentDetail> {
    return this.http.request<AiIncidentDetail>({ method: "GET", path: `/governance/incidents/${enc(id)}`, signal });
  }

  /**
   * Newest first. With no `limit` this is every incident; with a `limit` it is
   * one page of that size, and `listPage` hands back the cursor to continue from.
   */
  async list(input: ListIncidentsInput = {}, signal?: AbortSignal): Promise<AiIncident[]> {
    return listOrCollect(input, (q) => this.listPage({ ...input, ...q }, signal));
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  listPage(input: ListIncidentsInput = {}, signal?: AbortSignal): Promise<PageOf<AiIncident>> {
    return this.http.request<PageOf<AiIncident>>({
      method: "GET",
      path: "/governance/incidents",
      query: { status: input.status, aiSystemId: input.aiSystemId, limit: input.limit, cursor: input.cursor },
      signal,
    });
  }

  /**
   * Draft a DORA report on a major incident and put it to a person to sign
   * off. Reports follow in order: initial, intermediate, final. Needs
   * `approvals:write` as well as `tasks:write`.
   */
  draftReport(id: string, input: DraftIncidentReportInput, signal?: AbortSignal): Promise<DraftedIncidentReport> {
    return this.http.request<DraftedIncidentReport>({
      method: "POST",
      path: `/governance/incidents/${enc(id)}/reports`,
      body: input,
      signal,
    });
  }
}

/**
 * Compliance Mode across the organisation (Business and Enterprise): the AI
 * system register, incidents, what an agent may do, the frameworks and the
 * ICT register. A governed task's own governance is on `deliverd.tasks`.
 *
 * ```ts
 * const { mode } = await deliverd.governance.checkAuthority({ action: "send" });
 * if (mode === "denied") return;
 * ```
 *
 * Every answer records governance and certifies nothing.
 */
export class AiGovernance {
  readonly aiSystems: AiSystems;
  readonly incidents: Incidents;

  constructor(private readonly http: HttpClient) {
    this.aiSystems = new AiSystems(http);
    this.incidents = new Incidents(http);
  }

  /**
   * May this agent take this kind of action: on its own (`allowed`), only
   * with a person's approval (`approval`), or not at all (`denied`)? By the
   * organisation's policy and the agent's own, which can only be stricter
   * (Enterprise). Reads; records nothing.
   */
  checkAuthority(input: CheckAuthorityInput, signal?: AbortSignal): Promise<AuthorityDecision> {
    return this.http.request<AuthorityDecision>({
      method: "POST",
      path: "/governance/authority/evaluate",
      body: input,
      signal,
    });
  }

  /** The frameworks the organisation can see: the built-in packs and its own, and which are applied. */
  frameworks(signal?: AbortSignal): Promise<FrameworkCatalogue> {
    return this.http.request<FrameworkCatalogue>({ method: "GET", path: "/governance/frameworks", signal });
  }

  /**
   * How framework requirements map onto the common controls and, with
   * `taskId`, how far that task's controls cover each one. A mapping, never
   * a compliance verdict.
   */
  frameworkMapping(input: FrameworkMappingInput = {}, signal?: AbortSignal): Promise<FrameworkMapping> {
    return this.http.request<FrameworkMapping>({
      method: "GET",
      path: "/governance/frameworks/mapping",
      query: { taskId: input.taskId, framework: input.framework },
      signal,
    });
  }

  /** Draft the organisation's own framework (Enterprise). It adds nothing until a person publishes and applies it. */
  createCustomFramework(input: CreateCustomFrameworkInput, signal?: AbortSignal): Promise<CustomFramework> {
    return this.http.request<CustomFramework>({ method: "POST", path: "/governance/frameworks", body: input, signal });
  }

  /** The ICT third-party register: providers, contracts, the AI systems under each, gaps and concentration. */
  ictRegister(signal?: AbortSignal): Promise<IctRegister> {
    return this.http.request<IctRegister>({ method: "GET", path: "/governance/ict-register", signal });
  }

  /** The organisation's AI governance in counts, optionally narrowed. Never a compliance percentage. */
  summary(input: GovernanceSummaryInput = {}, signal?: AbortSignal): Promise<GovernanceSummary> {
    return this.http.request<GovernanceSummary>({
      method: "GET",
      path: "/governance/summary",
      query: { ...input },
      signal,
    });
  }
}
