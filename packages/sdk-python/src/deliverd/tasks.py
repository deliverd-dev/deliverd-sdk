"""Task Graph: what the work is for, kept apart from the conversation doing it.

An agent deep in a debugging session forgets the objective it started from,
because the objective is a paragraph thousands of tokens back. A task keeps it
somewhere the agent can ask for: ``task.context()`` returns the objective
first, always, then where this task stands, what is settled, and one paragraph
to say back to itself.

A problem that would take over the thread is branched into a side task with
the facts it needs (not the transcript), completed with a structured result,
and applied back to the parent — which is how the main thread gets the answer
without the hour it took.

Nothing here asks a person anything by itself. A decision is recorded as a
suggestion, and :meth:`Task.request_decision_approval` is how one is put to
somebody.

A governed task (Compliance Mode, Business and Enterprise) also has controls,
evidence and a gate: :meth:`Tasks.submit_evidence` records what a run measured,
or a tool's own report, and :meth:`Tasks.check_governance_gate` says whether the
work may proceed. Thresholds are a person's to set; an agent's key is refused,
so whatever submits the results does not decide what passes.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, list_or_collect
from .types import (
    AppliedSideTask,
    ControlApprovalResult,
    DecisionApproval,
    Governance,
    GovernanceGateCheck,
    ReassessmentResult,
    TaskContext,
    TaskData,
    TaskFinding,
    TaskGraph,
    TaskLinkResult,
)

__all__ = ["Task", "Tasks"]


def _path(task_id: str, *rest: str) -> str:
    return "/tasks/" + "/".join(urllib.parse.quote(part, safe="") for part in (task_id,) + rest)


class Task:
    """A task — an objective or a side task — and what you can do with it."""

    def __init__(self, http: HttpClient, data: TaskData) -> None:
        self._http = http
        self._data = data

    @property
    def data(self) -> TaskData:
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def kind(self) -> str:
        return self._data.kind

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def url(self) -> str:
        """The page a person can open."""
        return self._data.url

    @property
    def title(self) -> str:
        return self._data.title

    @property
    def objective(self) -> str:
        """What the work is for: the objective's purpose, or a side task's goal."""
        return self._data.objective

    @property
    def version(self) -> int:
        return self._data.version

    @property
    def findings(self) -> List[TaskFinding]:
        """Present on a single read; empty otherwise."""
        return self._data.findings or []

    @property
    def resumed(self) -> bool:
        """True when ``create()`` returned an open objective you had already started."""
        return bool(self._data.resumed)

    @property
    def is_side_task(self) -> bool:
        return self._data.kind != "objective"

    @property
    def active(self) -> bool:
        """Neither completed nor cancelled."""
        return self._data.status not in ("completed", "cancelled")

    @property
    def completed(self) -> bool:
        return self._data.status == "completed"

    @property
    def cancelled(self) -> bool:
        return self._data.status == "cancelled"

    def refresh(self) -> "Task":
        self._data = TaskData.from_wire(self._http.request("GET", _path(self._data.id)))
        return self

    def context(self) -> TaskContext:
        """What to read instead of the history. Call it whenever you have lost the thread."""
        return TaskContext.from_wire(self._http.request("GET", _path(self._data.id, "context")))

    def graph(self) -> TaskGraph:
        """The whole tree this task belongs to, from its objective down."""
        return TaskGraph.from_wire(self._http.request("GET", _path(self._data.id, "graph")))

    def update(self, **kwargs: Any) -> "Task":
        """Change the title, status or working state. Takes what :meth:`Tasks.update` takes."""
        self._data = Tasks(self._http).update(self._data.id, **kwargs).data
        return self

    def create_side_task(self, title: str, goal: str, **kwargs: Any) -> "Task":
        """Branch a problem out of this task so it does not take over the thread."""
        return Tasks(self._http).create_side_task(self._data.id, title=title, goal=goal, **kwargs)

    def add_finding(self, kind: str, title: str, **kwargs: Any) -> TaskFinding:
        """Record what was tested, seen or concluded. A decision is a suggestion."""
        return Tasks(self._http).add_finding(self._data.id, kind=kind, title=title, **kwargs)

    def request_decision_approval(self, finding_id: str, **kwargs: Any) -> DecisionApproval:
        """Put a suggested decision on this task to a person."""
        return Tasks(self._http).request_decision_approval(self._data.id, finding_id, **kwargs)

    def complete(self, summary: str, **kwargs: Any) -> "Task":
        """Finish it with a structured result. A side task's then waits to be applied."""
        self._data = Tasks(self._http).complete(self._data.id, summary=summary, **kwargs).data
        return self

    def apply(self, outcome: Optional[str] = None) -> AppliedSideTask:
        """Carry this finished side task's result into its parent.

        Or record that it was ``kept`` for reference, or ``discarded``. Returns
        the parent's fresh context, which is what to read next.
        """
        out = Tasks(self._http).apply(self._data.id, outcome=outcome)
        self._data = out.side_task
        return out

    def reopen(self) -> "Task":
        """Open a completed task again. Its result is kept in ``previous_results``."""
        self._data = Tasks(self._http).reopen(self._data.id).data
        return self

    def cancel(self, reason: Optional[str] = None) -> "Task":
        """Call it off. It stays in the tree as a record of what was tried."""
        self._data = Tasks(self._http).cancel(self._data.id, reason=reason).data
        return self

    def link(self, target_task_id: str, kind: str) -> TaskLinkResult:
        """Relate this task to another: it depends on, blocks, supersedes…"""
        return Tasks(self._http).link(self._data.id, target_task_id=target_task_id, kind=kind)

    def governance(self) -> Governance:
        """Its governance: controls, their thresholds and scores, evidence, readiness and the gate."""
        return Tasks(self._http).governance(self._data.id)

    def submit_evidence(self, type: str, title: str, **kwargs: Any) -> Governance:
        """Record evidence for the controls it speaks to. Takes what :meth:`Tasks.submit_evidence` takes."""
        return Tasks(self._http).submit_evidence(self._data.id, type=type, title=title, **kwargs)

    def check_governance_gate(self, action: Optional[str] = None) -> GovernanceGateCheck:
        """Whether the governed work may proceed. Ask before deploying, sending or acting on the result."""
        return Tasks(self._http).check_governance_gate(self._data.id, action=action)

    def govern(self, **profile: Any) -> Governance:
        """Govern it (Compliance Mode). Takes what :meth:`Tasks.govern` takes."""
        return Tasks(self._http).govern(self._data.id, **profile)

    def update_governance_profile(self, **changes: Any) -> Governance:
        """Change its governance profile. Takes what :meth:`Tasks.update_governance_profile` takes."""
        return Tasks(self._http).update_governance_profile(self._data.id, **changes)

    def request_control_approval(
        self,
        control: str,
        approvers: Optional[Sequence[str]] = None,
        note: Optional[str] = None,
        expires_at: Optional[str] = None,
    ) -> ControlApprovalResult:
        """Put an approval control to a person through the organisation's approval process."""
        return Tasks(self._http).request_control_approval(
            self._data.id, control, approvers=approvers, note=note, expires_at=expires_at
        )

    def trigger_reassessment(self, reason: str) -> ReassessmentResult:
        """Ask for it to be reassessed (Enterprise). The gate stays closed until a person completes it."""
        return Tasks(self._http).trigger_reassessment(self._data.id, reason)

    def evidence_pack(self) -> Dict[str, Any]:
        """Its evidence pack, with a digest. It assists audit; it does not certify compliance."""
        return Tasks(self._http).evidence_pack(self._data.id)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<Task {} {} {}>".format(self._data.id, self._data.kind, self._data.status)


class Tasks:
    """The ``/tasks`` half of the API, as objects."""

    def __init__(self, http: HttpClient, client: Any = None) -> None:
        self._http = http
        # Taken for the same constructor shape as `Flows`; a task starts
        # nothing on the client's behalf, so it is not used.
        self._client = client

    def _task(self, payload: Any) -> Task:
        return Task(self._http, TaskData.from_wire(payload))

    def create(
        self,
        title: str,
        objective: str,
        workspace_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        external_id: Optional[str] = None,
        session_url: Optional[str] = None,
        state: Optional[Dict[str, Any]] = None,
        governance: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Task:
        """Start an objective.

        ``governance`` governs it from the start (Compliance Mode, Business and
        Enterprise): the AI system, purpose, owners, risk, data and oversight,
        as a dict with the API's field names.

        With an ``external_id``, an open objective you already started under it
        comes back instead (``task.resumed``), so a restarted agent picks its
        goal up rather than starting a second.
        """
        body = body_from(
            {
                "title": title,
                "objective": objective,
                "workspace_id": workspace_id,
                "flow_id": flow_id,
                "external_id": external_id,
                "session_url": session_url,
                "state": state,
                "governance": governance,
            }
        )
        return self._task(
            self._http.request("POST", "/tasks", body=body, idempotency_key=idempotency_key)
        )

    def get(self, task_id: str) -> Task:
        """A task with its path, children, findings and links."""
        return self._task(self._http.request("GET", _path(task_id)))

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[Task]:
        """Objectives, most recently active first.

        Side tasks are reached through the objective they belong to. ``status``
        takes ``active`` for anything not completed or cancelled. With no
        ``limit`` this is every one of them; with a ``limit`` it is one page.
        """
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(
                status=status, external_id=external_id, q=q, limit=page_limit, cursor=page_cursor
            ),
        )

    def list_page(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> "Page[Task]":
        payload = self._http.request(
            "GET",
            "/tasks",
            query={
                "status": status,
                "externalId": external_id,
                "q": q,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return Page([self._task(row) for row in payload.get("tasks", [])], payload.get("nextCursor"))

    def context(self, task_id: str) -> TaskContext:
        return TaskContext.from_wire(self._http.request("GET", _path(task_id, "context")))

    def graph(self, task_id: str) -> TaskGraph:
        return TaskGraph.from_wire(self._http.request("GET", _path(task_id, "graph")))

    def update(
        self,
        task_id: str,
        title: Optional[str] = None,
        objective: Optional[str] = None,
        status: Optional[str] = None,
        session_url: Optional[str] = None,
        state: Optional[Dict[str, Any]] = None,
        expected_version: Optional[int] = None,
    ) -> Task:
        """Change a task. ``objective`` is refused to an agent: only a person
        changes what the work is for. ``expected_version`` refuses the update if
        somebody wrote in between."""
        body = body_from(
            {
                "title": title,
                "objective": objective,
                "status": status,
                "session_url": session_url,
                "state": state,
                "expected_version": expected_version,
            }
        )
        return self._task(self._http.request("PATCH", _path(task_id), body=body))

    def create_side_task(
        self,
        parent_id: str,
        title: str,
        goal: str,
        kind: Optional[str] = None,
        relevant_context: Optional[Sequence[str]] = None,
        known_constraints: Optional[Sequence[str]] = None,
        resolves_question: Optional[str] = None,
        origin: Optional[str] = None,
        session_url: Optional[str] = None,
    ) -> Task:
        """Branch a side task out of ``parent_id``."""
        body = body_from(
            {
                "title": title,
                "goal": goal,
                "kind": kind,
                "relevant_context": list(relevant_context) if relevant_context is not None else None,
                "known_constraints": list(known_constraints) if known_constraints is not None else None,
                "resolves_question": resolves_question,
                "origin": origin,
                "session_url": session_url,
            }
        )
        return self._task(self._http.request("POST", _path(parent_id, "side-tasks"), body=body))

    def add_finding(
        self,
        task_id: str,
        kind: str,
        title: str,
        body: Optional[str] = None,
        evidence: Optional[Sequence[str]] = None,
    ) -> TaskFinding:
        payload = body_from(
            {
                "kind": kind,
                "title": title,
                "body": body,
                "evidence": list(evidence) if evidence is not None else None,
            }
        )
        return TaskFinding.from_wire(
            self._http.request("POST", _path(task_id, "findings"), body=payload)
        )

    def request_decision_approval(
        self,
        task_id: str,
        finding_id: str,
        approvers: Optional[Sequence[str]] = None,
        note: Optional[str] = None,
        expires_at: Optional[str] = None,
    ) -> DecisionApproval:
        """Put a suggested decision to a person. Needs ``approvals:write`` too."""
        body = body_from(
            {
                "approvers": list(approvers) if approvers is not None else None,
                "note": note,
                "expires_at": expires_at,
            }
        )
        return DecisionApproval.from_wire(
            self._http.request("POST", _path(task_id, "findings", finding_id, "approval"), body=body)
        )

    def complete(
        self,
        task_id: str,
        summary: str,
        findings: Optional[Sequence[Dict[str, Any]]] = None,
        decisions: Optional[Sequence[Dict[str, Any]]] = None,
        recommendations: Optional[Sequence[str]] = None,
        unresolved_questions: Optional[Sequence[str]] = None,
        parent_impact: Optional[str] = None,
        suggested_next_action: Optional[str] = None,
    ) -> Task:
        """Finish a task with a structured result.

        ``findings`` are ``{"title", "description", "evidence"?}`` and
        ``decisions`` ``{"title", "rationale"?}``; decisions reach the parent as
        suggestions.
        """
        body = body_from(
            {
                "summary": summary,
                "findings": list(findings) if findings is not None else None,
                "decisions": list(decisions) if decisions is not None else None,
                "recommendations": list(recommendations) if recommendations is not None else None,
                "unresolved_questions": (
                    list(unresolved_questions) if unresolved_questions is not None else None
                ),
                "parent_impact": parent_impact,
                "suggested_next_action": suggested_next_action,
            }
        )
        return self._task(self._http.request("POST", _path(task_id, "complete"), body=body))

    def apply(self, task_id: str, outcome: Optional[str] = None) -> AppliedSideTask:
        """``applied`` (the default) carries the result into the parent;
        ``kept`` records it as reference; ``discarded`` records it was not used."""
        return AppliedSideTask.from_wire(
            self._http.request("POST", _path(task_id, "apply"), body=body_from({"outcome": outcome}))
        )

    def reopen(self, task_id: str) -> Task:
        return self._task(self._http.request("POST", _path(task_id, "reopen"), body={}))

    def cancel(self, task_id: str, reason: Optional[str] = None) -> Task:
        return self._task(
            self._http.request("POST", _path(task_id, "cancel"), body=body_from({"reason": reason}))
        )

    def link(self, task_id: str, target_task_id: str, kind: str) -> TaskLinkResult:
        """``kind``: depends_on, blocks, related_to, supersedes or resulted_in."""
        body = body_from({"target_task_id": target_task_id, "kind": kind})
        return TaskLinkResult.from_wire(
            self._http.request("POST", _path(task_id, "links"), body=body)
        )

    def governance(self, task_id: str) -> Governance:
        """A governed task's governance: controls, their thresholds and scores, evidence, readiness and the gate."""
        return Governance.from_wire(self._http.request("GET", _path(task_id, "governance")))

    def submit_evidence(
        self,
        task_id: str,
        type: str,
        title: str,
        description: Optional[str] = None,
        url: Optional[str] = None,
        controls: Optional[Sequence[str]] = None,
        finding_id: Optional[str] = None,
        results: Optional[Sequence[Dict[str, Any]]] = None,
        run: Optional[Dict[str, Any]] = None,
        report: Optional[Dict[str, Any]] = None,
        pull: Optional[Dict[str, Any]] = None,
        release: Optional[Dict[str, Any]] = None,
    ) -> Governance:
        """Record evidence for a governed task and the controls it speaks to.

        For an eval or red-team run, send what it measured as ``results`` —
        dicts of ``metric``, ``value`` and, where the tool gives them,
        ``passed``, ``severity``, ``category``, ``dataset`` and ``url`` — or the
        tool's own ``report`` as ``{"format": "promptfoo", "content": text}``
        (``promptfoo``, ``inspect``, ``garak``, ``weave``, ``braintrust``,
        ``junit`` or ``deliverd``), which the server reads. Or ``pull`` it from
        the organisation's connected Langfuse, LangSmith, Braintrust or Weave
        — ``{"source": "langfuse", "experiment": "credit-memo-v12"}``, or
        ``"source": "langsmith"``, ``"braintrust"`` or ``"weave"`` (whose
        ``experiment`` is the evaluation's name), with ``experiment_id`` or
        ``since`` if needed — read with the organisation's key, which you
        never hold.

        ``release`` names the release the results tested — any of ``provider``,
        ``model``, ``model_version``, ``prompt_hash`` and ``guardrails_hash``,
        digests rather than text, as ``deliverd governance release`` records
        them. Evidence of another release than the AI system now runs does not
        count, so an old prompt's results cannot open the gate for a new one.

        A control with thresholds is met only when its newest scored evidence
        meets them. Called on a side task, it belongs to the objective.
        """
        body = body_from(
            {
                "type": type,
                "title": title,
                "description": description,
                "url": url,
                "controls": list(controls) if controls is not None else None,
                "finding_id": finding_id,
                "results": list(results) if results is not None else None,
                "run": run,
                "report": report,
                "pull": pull,
                "release": release,
            }
        )
        return Governance.from_wire(self._http.request("POST", _path(task_id, "governance", "evidence"), body=body))

    def check_governance_gate(self, task_id: str, action: Optional[str] = None) -> GovernanceGateCheck:
        """Whether governed work may proceed.

        ``allowed``, what is missing, what else blocks it, and the ``scores`` of
        each control with thresholds. With ``action`` (Enterprise), also whether
        this agent may take that kind of action.
        """
        return GovernanceGateCheck.from_wire(
            self._http.request("GET", _path(task_id, "governance", "gate"), query={"action": action})
        )

    def govern(self, task_id: str, **profile: Any) -> Governance:
        """Govern an objective (Compliance Mode, Business and Enterprise).

        Takes the profile as far as it is known, each optional: ``ai_system_id``,
        ``purpose``, ``business_owner``, ``technical_owner``, ``risk``,
        ``data_classification``, ``personal_data``, ``sensitive_data``,
        ``customer_facing``, ``production_use``, ``critical_function``,
        ``autonomy``, ``decision_impact``, ``oversight`` and ``jurisdictions``.
        Idempotent: an objective already governed answers with its governance.
        A side task's id answers for its objective.
        """
        return Governance.from_wire(
            self._http.request("POST", _path(task_id, "governance"), body=body_from(profile))
        )

    def update_governance_profile(self, task_id: str, **changes: Any) -> Governance:
        """Change a governed task's profile: any field :meth:`govern` takes, and ``expected_version``.

        An agent may raise risk or add facts; only a person lowers or clears
        them. With ``expected_version``, refused if somebody wrote in between.
        """
        return Governance.from_wire(
            self._http.request("PATCH", _path(task_id, "governance"), body=body_from(changes))
        )

    def request_control_approval(
        self,
        task_id: str,
        control: str,
        approvers: Optional[Sequence[str]] = None,
        note: Optional[str] = None,
        expires_at: Optional[str] = None,
    ) -> ControlApprovalResult:
        """Put an approval control (a compliance or deployment approval) to a person.

        Through the organisation's approval process; the control is satisfied
        when that approval is approved. ``approvers`` defaults to the
        organisation's administrators. Needs ``approvals:write``.
        """
        body = body_from(
            {
                "approvers": list(approvers) if approvers is not None else None,
                "note": note,
                "expires_at": expires_at,
            }
        )
        return ControlApprovalResult.from_wire(
            self._http.request("POST", _path(task_id, "governance", "controls", control, "approval"), body=body)
        )

    def trigger_reassessment(self, task_id: str, reason: str) -> ReassessmentResult:
        """Ask for a governed task to be reassessed (Enterprise).

        Its governance gate stays closed until a person completes the
        reassessment in Deliverd.
        """
        return ReassessmentResult.from_wire(
            self._http.request("POST", _path(task_id, "governance", "reassessments"), body={"reason": reason})
        )

    def evidence_pack(self, task_id: str) -> Dict[str, Any]:
        """A governed task's evidence pack, as the API's own dict.

        Profile, controls, evidence, task graph, decisions, approvals and the
        audit timeline, with a digest. It assists audit; it does not certify
        compliance. Every export is audited.
        """
        return self._http.request("GET", _path(task_id, "governance", "pack"))
