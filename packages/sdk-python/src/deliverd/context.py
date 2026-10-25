"""Context: what your agents know, and how the job gets done.

Knowledge is the organisation's, not any one agent's: an agent proposes an
entry, a person confirms it in Deliverd, and every agent after that reads it,
through this SDK, the MCP tools, or an AGENTS.md exported from it. The export
is Markdown and imports back, so none of it is locked to a tool.

A playbook is a written-down job: steps, each with the rule that applies before
it acts (a gate, an approval, a review). Running one starts an objective with a
side task per step. A person puts a playbook in force; an agent's key can draft
one and run one, never publish it, and never confirm knowledge.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .types import (
    ContextGiven,
    ImportedKnowledge,
    KnowledgeDetail,
    KnowledgeEntryData,
    KnowledgeSearchResult,
    PlaybookData,
    PlaybookDetail,
    PlaybookSummary,
    ProposedKnowledge,
    StartedPlaybook,
)

__all__ = ["Knowledge", "Playbooks"]


def _q(part: str) -> str:
    return urllib.parse.quote(part, safe="")


def _draft_body(
    title: str,
    purpose: str,
    steps: Sequence[Dict[str, Any]],
    inputs: Optional[Sequence[Dict[str, Any]]],
    knowledge_ids: Optional[Sequence[str]],
    workspace_id: Optional[str],
    note: Optional[str],
) -> Dict[str, Any]:
    # Steps and inputs are sent as given: their keys are the API's own (``knowledgeIds``).
    return body_from(
        {
            "title": title,
            "purpose": purpose,
            "steps": list(steps),
            "inputs": list(inputs) if inputs is not None else None,
            "knowledge_ids": list(knowledge_ids) if knowledge_ids is not None else None,
            "workspace_id": workspace_id,
            "note": note,
        },
        passthrough=("steps", "inputs"),
    )


class Knowledge:
    """``deliverd.knowledge``: proposed by agents, confirmed by people, exported to anywhere."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def search(
        self,
        q: Optional[str] = None,
        kind: Optional[str] = None,
        status: Optional[str] = None,
        workspace_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> KnowledgeSearchResult:
        """Ranked by relevance to ``q``; confirmed entries unless ``status`` says otherwise."""
        payload = self._http.request(
            "GET",
            "/knowledge",
            query={"q": q, "kind": kind, "status": status, "workspaceId": workspace_id, "flowId": flow_id, "limit": limit},
        )
        return KnowledgeSearchResult.from_wire(payload)

    def get(self, entry_id: str) -> KnowledgeDetail:
        """One entry, with the versions before and after it."""
        return KnowledgeDetail.from_wire(self._http.request("GET", "/knowledge/" + _q(entry_id)))

    def propose(
        self,
        kind: str,
        title: str,
        body: str,
        tags: Optional[Sequence[str]] = None,
        workspace_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        supersedes_id: Optional[str] = None,
        source_url: Optional[str] = None,
        source_label: Optional[str] = None,
        external_id: Optional[str] = None,
    ) -> ProposedKnowledge:
        """Propose an entry. It is a proposal until a person confirms it; a secret is refused."""
        payload = body_from(
            {
                "kind": kind,
                "title": title,
                "body": body,
                "tags": list(tags) if tags is not None else None,
                "workspace_id": workspace_id,
                "flow_id": flow_id,
                "supersedes_id": supersedes_id,
                "source_url": source_url,
                "source_label": source_label,
                "external_id": external_id,
            }
        )
        return ProposedKnowledge.from_wire(self._http.request("POST", "/knowledge", body=payload))

    def edit(
        self,
        entry_id: str,
        kind: Optional[str] = None,
        title: Optional[str] = None,
        body: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> KnowledgeEntryData:
        """Change a proposal you made. A confirmed entry is changed by proposing a revision (``supersedes_id``)."""
        payload = body_from({"kind": kind, "title": title, "body": body, "tags": list(tags) if tags is not None else None})
        return KnowledgeEntryData.from_wire(self._http.request("PATCH", "/knowledge/" + _q(entry_id), body=payload))

    def promote_finding(
        self,
        task_id: str,
        finding_id: str,
        kind: Optional[str] = None,
        title: Optional[str] = None,
        body: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> ProposedKnowledge:
        """Propose a task's finding as knowledge, keeping where it came from."""
        payload = body_from({"kind": kind, "title": title, "body": body, "tags": list(tags) if tags is not None else None})
        path = "/tasks/{}/findings/{}/knowledge".format(_q(task_id), _q(finding_id))
        return ProposedKnowledge.from_wire(self._http.request("POST", path, body=payload))

    def import_markdown(self, markdown: str, workspace_id: Optional[str] = None, source: Optional[str] = None) -> ImportedKnowledge:
        """Bring in a Deliverd export or a notes file such as AGENTS.md. Each heading becomes a proposed entry.

        ``knowledge.import()`` in TypeScript; ``import`` is a keyword here.
        """
        payload = body_from({"markdown": markdown, "workspace_id": workspace_id, "source": source})
        return ImportedKnowledge.from_wire(self._http.request("POST", "/knowledge/import", body=payload))

    def export_markdown(self, status: Optional[str] = None, workspace_id: Optional[str] = None) -> str:
        """Everything you may see, as Markdown that imports back."""
        return self._http.request(
            "GET", "/knowledge/export", query={"format": "markdown", "status": status, "workspaceId": workspace_id}, text=True
        )

    def export_json(self, status: Optional[str] = None, workspace_id: Optional[str] = None) -> Dict[str, Any]:
        """The same, as the API's JSON: ``format``, ``version``, ``organisation``, ``exportedAt``, ``entries``."""
        return self._http.request("GET", "/knowledge/export", query={"format": "json", "status": status, "workspaceId": workspace_id})

    def agents_md(self, workspace_id: Optional[str] = None) -> str:
        """An AGENTS.md of the confirmed knowledge and the playbooks in force, for a tool that reads files."""
        return self._http.request("GET", "/knowledge/agents-md", query={"workspaceId": workspace_id}, text=True)

    def given(self, task_id: str) -> List[ContextGiven]:
        """What a task and its side tasks were given, newest first: the record behind "what did it know?"."""
        payload = self._http.request("GET", "/tasks/{}/context-given".format(_q(task_id)))
        return [ContextGiven.from_wire(g) for g in payload.get("given", [])]


class Playbooks:
    """``deliverd.playbooks``: jobs written down as steps, each with the rule that applies before it acts."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self) -> List[PlaybookSummary]:
        """One row per playbook: its newest version, and the version in force."""
        payload = self._http.request("GET", "/playbooks")
        return [PlaybookSummary.from_wire(p) for p in payload.get("playbooks", [])]

    def get(self, playbook_id: str) -> PlaybookDetail:
        return PlaybookDetail.from_wire(self._http.request("GET", "/playbooks/" + _q(playbook_id)))

    def draft(
        self,
        title: str,
        purpose: str,
        steps: Sequence[Dict[str, Any]],
        inputs: Optional[Sequence[Dict[str, Any]]] = None,
        knowledge_ids: Optional[Sequence[str]] = None,
        workspace_id: Optional[str] = None,
        note: Optional[str] = None,
    ) -> PlaybookData:
        """Draft a new playbook. Nobody runs a draft until a person puts it in force.

        Each step is a dict with the API's keys: ``title``, ``instruction``, and
        optionally ``key``, ``rule`` (``none`` | ``gate`` | ``approval`` | ``review``),
        ``action`` for a gate, and ``knowledgeIds``.
        """
        payload = _draft_body(title, purpose, steps, inputs, knowledge_ids, workspace_id, note)
        return PlaybookData.from_wire(self._http.request("POST", "/playbooks", body=payload))

    def draft_version(
        self,
        playbook_id: str,
        title: str,
        purpose: str,
        steps: Sequence[Dict[str, Any]],
        inputs: Optional[Sequence[Dict[str, Any]]] = None,
        knowledge_ids: Optional[Sequence[str]] = None,
        workspace_id: Optional[str] = None,
        note: Optional[str] = None,
    ) -> PlaybookData:
        """Draft the next version; the one in force keeps running until this one replaces it."""
        payload = _draft_body(title, purpose, steps, inputs, knowledge_ids, workspace_id, note)
        return PlaybookData.from_wire(self._http.request("POST", "/playbooks/{}/versions".format(_q(playbook_id)), body=payload))

    def update_draft(
        self,
        playbook_id: str,
        title: str,
        purpose: str,
        steps: Sequence[Dict[str, Any]],
        inputs: Optional[Sequence[Dict[str, Any]]] = None,
        knowledge_ids: Optional[Sequence[str]] = None,
        workspace_id: Optional[str] = None,
        note: Optional[str] = None,
    ) -> PlaybookData:
        """Change a draft that has not been put to anybody."""
        payload = _draft_body(title, purpose, steps, inputs, knowledge_ids, workspace_id, note)
        return PlaybookData.from_wire(self._http.request("PATCH", "/playbooks/" + _q(playbook_id), body=payload))

    def request_approval(self, playbook_id: str, approvers: Optional[Sequence[str]] = None, note: Optional[str] = None) -> PlaybookData:
        """Put a draft to people as a Deliverd approval. Approved, it goes in force. Needs ``approvals:write`` and ``tasks:write``."""
        payload = body_from({"approvers": list(approvers) if approvers is not None else None, "note": note})
        return PlaybookData.from_wire(self._http.request("POST", "/playbooks/{}/approval".format(_q(playbook_id)), body=payload))

    def start(
        self,
        playbook_id: str,
        inputs: Optional[Dict[str, str]] = None,
        title: Optional[str] = None,
        workspace_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        external_id: Optional[str] = None,
        session_url: Optional[str] = None,
    ) -> StartedPlaybook:
        """Run the version in force: an objective, and a side task per step."""
        payload = body_from(
            {
                "inputs": dict(inputs) if inputs is not None else None,
                "title": title,
                "workspace_id": workspace_id,
                "flow_id": flow_id,
                "external_id": external_id,
                "session_url": session_url,
            },
            passthrough=("inputs",),
        )
        return StartedPlaybook.from_wire(self._http.request("POST", "/playbooks/{}/start".format(_q(playbook_id)), body=payload))
