import type { HttpClient } from "./http.js";
import type {
  ContextGiven,
  DraftPlaybookInput,
  EditKnowledgeInput,
  ExportKnowledgeInput,
  ImportedKnowledge,
  ImportKnowledgeInput,
  KnowledgeDetail,
  KnowledgeEntryData,
  KnowledgeExport,
  KnowledgeSearchResult,
  PlaybookData,
  PlaybookDetail,
  PlaybookSummary,
  PromoteFindingInput,
  ProposedKnowledge,
  ProposeKnowledgeInput,
  RequestPlaybookApprovalInput,
  SearchKnowledgeInput,
  StartedPlaybook,
  StartPlaybookInput,
} from "./types.js";

/**
 * Context: what your agents know, and how the job gets done.
 *
 * Knowledge is the organisation's, not any one agent's: an agent proposes an
 * entry, a person confirms it in Deliverd, and every agent after that reads
 * it, through this SDK, the MCP tools, or an AGENTS.md exported from it. The
 * export is Markdown and imports back, so none of it is locked to a tool.
 *
 * A playbook is a written-down job: steps, each with the rule that applies
 * before it acts (a gate, an approval, a review). Running one starts an
 * objective with a side task per step. A person puts a playbook in force; an
 * agent's key can draft one and run one, never publish it, and never confirm
 * knowledge.
 */

const enc = encodeURIComponent;

export class Knowledge {
  constructor(private readonly http: HttpClient) {}

  /** Ranked by relevance to `q`; confirmed entries unless `status` says otherwise. */
  search(input: SearchKnowledgeInput = {}, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.http.request<KnowledgeSearchResult>({
      method: "GET",
      path: "/knowledge",
      query: { q: input.q, kind: input.kind, status: input.status, workspaceId: input.workspaceId, flowId: input.flowId, limit: input.limit },
      signal,
    });
  }

  /** One entry, with the versions before and after it. */
  get(id: string, signal?: AbortSignal): Promise<KnowledgeDetail> {
    return this.http.request<KnowledgeDetail>({ method: "GET", path: `/knowledge/${enc(id)}`, signal });
  }

  /** Propose an entry. It is a proposal until a person confirms it. */
  propose(input: ProposeKnowledgeInput, signal?: AbortSignal): Promise<ProposedKnowledge> {
    return this.http.request<ProposedKnowledge>({ method: "POST", path: "/knowledge", body: input, signal });
  }

  /** Change a proposal you made. A confirmed entry is changed by proposing a revision (`supersedesId`). */
  edit(id: string, input: EditKnowledgeInput, signal?: AbortSignal): Promise<KnowledgeEntryData> {
    return this.http.request<KnowledgeEntryData>({ method: "PATCH", path: `/knowledge/${enc(id)}`, body: input, signal });
  }

  /** Propose a task's finding as knowledge, keeping where it came from. */
  promoteFinding(taskId: string, findingId: string, input: PromoteFindingInput = {}, signal?: AbortSignal): Promise<ProposedKnowledge> {
    return this.http.request<ProposedKnowledge>({
      method: "POST",
      path: `/tasks/${enc(taskId)}/findings/${enc(findingId)}/knowledge`,
      body: input,
      signal,
    });
  }

  /** Bring in a Deliverd export or a notes file such as AGENTS.md. Each heading becomes a proposed entry. */
  import(input: ImportKnowledgeInput, signal?: AbortSignal): Promise<ImportedKnowledge> {
    return this.http.request<ImportedKnowledge>({ method: "POST", path: "/knowledge/import", body: input, signal });
  }

  /** Everything you may see, as Markdown that imports back. */
  exportMarkdown(input: ExportKnowledgeInput = {}, signal?: AbortSignal): Promise<string> {
    return this.http.request<string>({
      method: "GET",
      path: "/knowledge/export",
      query: { format: "markdown", status: input.status, workspaceId: input.workspaceId },
      responseType: "text",
      signal,
    });
  }

  /** The same, as JSON. */
  exportJson(input: ExportKnowledgeInput = {}, signal?: AbortSignal): Promise<KnowledgeExport> {
    return this.http.request<KnowledgeExport>({
      method: "GET",
      path: "/knowledge/export",
      query: { format: "json", status: input.status, workspaceId: input.workspaceId },
      signal,
    });
  }

  /** An AGENTS.md of the confirmed knowledge and the playbooks in force, for a tool that reads files. */
  agentsMd(options: { workspaceId?: string } = {}, signal?: AbortSignal): Promise<string> {
    return this.http.request<string>({
      method: "GET",
      path: "/knowledge/agents-md",
      query: { workspaceId: options.workspaceId },
      responseType: "text",
      signal,
    });
  }

  /** What a task and its side tasks were given, newest first: the record behind "what did it know?". */
  async given(taskId: string, signal?: AbortSignal): Promise<ContextGiven[]> {
    const out = await this.http.request<{ given: ContextGiven[] }>({ method: "GET", path: `/tasks/${enc(taskId)}/context-given`, signal });
    return out.given;
  }
}

export class Playbooks {
  constructor(private readonly http: HttpClient) {}

  /** One row per playbook: its newest version, and the version in force. */
  async list(signal?: AbortSignal): Promise<PlaybookSummary[]> {
    const out = await this.http.request<{ playbooks: PlaybookSummary[] }>({ method: "GET", path: "/playbooks", signal });
    return out.playbooks;
  }

  get(id: string, signal?: AbortSignal): Promise<PlaybookDetail> {
    return this.http.request<PlaybookDetail>({ method: "GET", path: `/playbooks/${enc(id)}`, signal });
  }

  /** Draft a new playbook. Nobody runs a draft until a person puts it in force. */
  draft(input: DraftPlaybookInput, signal?: AbortSignal): Promise<PlaybookData> {
    return this.http.request<PlaybookData>({ method: "POST", path: "/playbooks", body: input, signal });
  }

  /** Draft the next version of a playbook; the version in force keeps running until this one replaces it. */
  draftVersion(id: string, input: DraftPlaybookInput, signal?: AbortSignal): Promise<PlaybookData> {
    return this.http.request<PlaybookData>({ method: "POST", path: `/playbooks/${enc(id)}/versions`, body: input, signal });
  }

  /** Change a draft that has not been put to anybody. */
  updateDraft(id: string, input: DraftPlaybookInput, signal?: AbortSignal): Promise<PlaybookData> {
    return this.http.request<PlaybookData>({ method: "PATCH", path: `/playbooks/${enc(id)}`, body: input, signal });
  }

  /** Put a draft to people as a Deliverd approval. Approved, it goes in force. Needs `approvals:write` and `tasks:write`. */
  requestApproval(id: string, input: RequestPlaybookApprovalInput = {}, signal?: AbortSignal): Promise<PlaybookData> {
    return this.http.request<PlaybookData>({ method: "POST", path: `/playbooks/${enc(id)}/approval`, body: input, signal });
  }

  /** Run the version in force: an objective, and a side task per step. */
  start(id: string, input: StartPlaybookInput = {}, signal?: AbortSignal): Promise<StartedPlaybook> {
    return this.http.request<StartedPlaybook>({ method: "POST", path: `/playbooks/${enc(id)}/start`, body: input, signal });
  }
}
