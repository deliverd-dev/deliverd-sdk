"""Compliance Mode across the organisation (Business and Enterprise).

The register of AI systems, what an agent may do on its own, AI incidents and
their DORA reports, the frameworks and how they map onto controls, the ICT
third-party register, and the organisation's governance in counts. A governed
task's own governance is on ``deliverd.tasks``.

::

    decision = deliverd.governance.check_authority("send")
    if decision.mode == "denied":
        return

An agent may raise a risk or add facts; only a person lowers them, waives a
control or resolves an incident. Every answer records governance and certifies
nothing.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import quote

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, list_or_collect
from .types import AiIncident, AiIncidentDetail, AiSystem, AiSystemDetail, AuthorityDecision, DraftedIncidentReport, ModelChangeResult

__all__ = ["AiGovernance", "AiSystems", "Incidents"]


def _enc(value: str) -> str:
    return quote(value, safe="")


class AiSystems:
    """``deliverd.governance.ai_systems``: the register of AI systems."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, status: Optional[str] = None) -> List[AiSystem]:
        """The register, or only its ``active`` or ``retired`` systems."""
        payload = self._http.request("GET", "/ai-systems", query={"status": status})
        return [AiSystem.from_wire(row) for row in payload.get("aiSystems", [])]

    def get(self, system_id: str) -> AiSystemDetail:
        """One system, and the governed tasks that name it."""
        return AiSystemDetail.from_wire(self._http.request("GET", "/ai-systems/{}".format(_enc(system_id))))

    def register(
        self,
        name: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_version: Optional[str] = None,
        prompt_hash: Optional[str] = None,
        guardrails_hash: Optional[str] = None,
        purpose: Optional[str] = None,
        business_owner: Optional[str] = None,
        technical_owner: Optional[str] = None,
        environment: Optional[str] = None,
        risk: Optional[str] = None,
        oversight: Optional[str] = None,
        data_classification: Optional[str] = None,
        personal_data: Optional[bool] = None,
        customer_facing: Optional[bool] = None,
        ict_arrangement_id: Optional[str] = None,
    ) -> AiSystem:
        """Add a system to the register. Digests of its prompt and guardrails, never the text."""
        body = body_from(
            {
                "name": name,
                "provider": provider,
                "model": model,
                "model_version": model_version,
                "prompt_hash": prompt_hash,
                "guardrails_hash": guardrails_hash,
                "purpose": purpose,
                "business_owner": business_owner,
                "technical_owner": technical_owner,
                "environment": environment,
                "risk": risk,
                "oversight": oversight,
                "data_classification": data_classification,
                "personal_data": personal_data,
                "customer_facing": customer_facing,
                "ict_arrangement_id": ict_arrangement_id,
            }
        )
        return AiSystem.from_wire(self._http.request("POST", "/ai-systems", body=body))

    def update(self, system_id: str, **changes: Any) -> AiSystem:
        """Change a system's record: any field ``register`` takes, and ``status``.

        An agent may raise a system's risk but not lower it, and may not retire it.
        """
        return AiSystem.from_wire(
            self._http.request("PATCH", "/ai-systems/{}".format(_enc(system_id)), body=body_from(changes))
        )

    def record_model_change(
        self,
        system_id: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_version: Optional[str] = None,
        prompt_hash: Optional[str] = None,
        guardrails_hash: Optional[str] = None,
        note: Optional[str] = None,
    ) -> ModelChangeResult:
        """Record a new provider, model, version, prompt or guardrails (Enterprise).

        Every governed task using the system is reassessed, and evidence of the
        old release stops counting. Name at least one of the five.
        """
        body = body_from(
            {
                "provider": provider,
                "model": model,
                "model_version": model_version,
                "prompt_hash": prompt_hash,
                "guardrails_hash": guardrails_hash,
                "note": note,
            }
        )
        return ModelChangeResult.from_wire(
            self._http.request("POST", "/ai-systems/{}/model-change".format(_enc(system_id)), body=body)
        )


class Incidents:
    """``deliverd.governance.incidents``: AI incidents and their DORA reports.

    A high or critical incident closes its task's governance gate until a
    person resolves it in Deliverd. Classifying it, and submitting a report to
    the authority, are a person's too.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def report(
        self,
        title: str,
        severity: str,
        task_id: Optional[str] = None,
        ai_system_id: Optional[str] = None,
        description: Optional[str] = None,
        detected_at: Optional[str] = None,
    ) -> AiIncident:
        """Report an incident against a governed task, an AI system, or both.

        ``detected_at`` is when the organisation became aware of it, if earlier
        than now: DORA's clocks start there.
        """
        body = body_from(
            {
                "task_id": task_id,
                "ai_system_id": ai_system_id,
                "title": title,
                "description": description,
                "severity": severity,
                "detected_at": detected_at,
            }
        )
        return AiIncident.from_wire(self._http.request("POST", "/governance/incidents", body=body))

    def get(self, incident_id: str) -> AiIncidentDetail:
        """One incident: its DORA classification, its reports and their sign-off, and which report is due next."""
        return AiIncidentDetail.from_wire(
            self._http.request("GET", "/governance/incidents/{}".format(_enc(incident_id)))
        )

    def list(
        self,
        status: Optional[str] = None,
        ai_system_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[AiIncident]:
        """Newest first. With no ``limit`` this is every incident; with one, a page of that size."""
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(
                status=status, ai_system_id=ai_system_id, limit=page_limit, cursor=page_cursor
            ),
        )

    def list_page(
        self,
        status: Optional[str] = None,
        ai_system_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> "Page[AiIncident]":
        payload = self._http.request(
            "GET",
            "/governance/incidents",
            query={"status": status, "aiSystemId": ai_system_id, "limit": limit, "cursor": cursor},
        )
        return Page([AiIncident.from_wire(row) for row in payload.get("items", [])], payload.get("nextCursor"))

    def draft_report(
        self,
        incident_id: str,
        kind: str,
        content: str,
        fields: Optional[Dict[str, Any]] = None,
        approvers: Optional[Sequence[str]] = None,
    ) -> DraftedIncidentReport:
        """Draft a DORA report on a major incident and put it to a person to sign off.

        ``kind`` is ``initial``, ``intermediate``, ``final`` or
        ``reclassification``, in that order. ``fields`` are sent as given, with
        the API's own names (``memberStates``, ``rootCause``…). Needs
        ``approvals:write`` as well as ``tasks:write``.
        """
        body = body_from(
            {
                "kind": kind,
                "content": content,
                "fields": fields,
                "approvers": list(approvers) if approvers is not None else None,
            },
            passthrough=("fields",),
        )
        return DraftedIncidentReport.from_wire(
            self._http.request("POST", "/governance/incidents/{}/reports".format(_enc(incident_id)), body=body)
        )


class AiGovernance:
    """``deliverd.governance``: Compliance Mode across the organisation.

    The read-only views — the framework catalogue and mapping, the ICT
    register, the summary — come back as the API's own dicts, with its field
    names, because each is a report to read rather than an object to act on.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self.ai_systems = AiSystems(http)
        self.incidents = Incidents(http)

    def check_authority(self, action: str, agent_id: Optional[str] = None) -> AuthorityDecision:
        """May this agent take this kind of action on its own (``allowed``), only with approval, or not at all?

        ``action`` is one of ``read``, ``analyse``, ``recommend``, ``draft``,
        ``modify``, ``execute``, ``publish``, ``deploy``, ``send``, ``delete``,
        ``financial_action`` and ``customer_decision``. By the organisation's
        policy and the agent's own, which can only be stricter (Enterprise).
        Reads; records nothing.
        """
        body = body_from({"action": action, "agent_id": agent_id})
        return AuthorityDecision.from_wire(self._http.request("POST", "/governance/authority/evaluate", body=body))

    def frameworks(self) -> Dict[str, Any]:
        """The frameworks the organisation can see: the built-in packs and its own, and which are applied."""
        return self._http.request("GET", "/governance/frameworks")

    def framework_mapping(self, task_id: Optional[str] = None, framework: Optional[str] = None) -> Dict[str, Any]:
        """How requirements map onto controls and, with ``task_id``, how far that task's controls cover each.

        A mapping, never a compliance verdict.
        """
        return self._http.request(
            "GET", "/governance/frameworks/mapping", query={"taskId": task_id, "framework": framework}
        )

    def create_custom_framework(
        self,
        key: str,
        version: str,
        name: str,
        requirements: Sequence[Dict[str, Any]],
        summary: Optional[str] = None,
        jurisdictions: Optional[Sequence[str]] = None,
        effective_from: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Draft the organisation's own framework (Enterprise).

        ``key`` starts ``custom_``. Each requirement is a dict of ``ref``,
        ``title``, ``controls`` and optionally ``applies_when``. A draft adds
        nothing until a person publishes and applies it.
        """
        body = body_from(
            {
                "key": key,
                "version": version,
                "name": name,
                "summary": summary,
                "jurisdictions": list(jurisdictions) if jurisdictions is not None else None,
                "effective_from": effective_from,
                "requirements": [dict(r) for r in requirements],
            }
        )
        return self._http.request("POST", "/governance/frameworks", body=body)

    def ict_register(self) -> Dict[str, Any]:
        """The ICT third-party register: providers, contracts, the AI systems under each, gaps and concentration."""
        return self._http.request("GET", "/governance/ict-register")

    def summary(
        self,
        ai_system_id: Optional[str] = None,
        risk: Optional[str] = None,
        owner: Optional[str] = None,
        provider: Optional[str] = None,
        data_classification: Optional[str] = None,
        jurisdiction: Optional[str] = None,
        framework: Optional[str] = None,
    ) -> Dict[str, Any]:
        """The organisation's AI governance in counts, optionally narrowed. Never a compliance percentage."""
        return self._http.request(
            "GET",
            "/governance/summary",
            query={
                "aiSystemId": ai_system_id,
                "risk": risk,
                "owner": owner,
                "provider": provider,
                "dataClassification": data_classification,
                "jurisdiction": jurisdiction,
                "framework": framework,
            },
        )
