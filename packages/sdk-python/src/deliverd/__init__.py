"""Deliverd: you build the action, Deliverd handles the human.

::

    from deliverd import deliverd

    decision = deliverd.approve(title="Deploy to production")
    if decision.approved:
        deploy()

That is the whole integration. What it stands in for: an approval page, the
emails and the reminders, identity and single sign-on, who is allowed to decide,
a table to keep it in, an audit trail, and the dashboard somebody uses to do it.
None of that is yours to build.

With no arguments the key comes from ``DELIVERD_API_KEY``. Before you have one,
``Deliverd(mode="development")`` runs the same code with an imaginary approver.

**Calls block.** ``approve()`` returns when a person has decided, which is the
shape an agent tool wants: the function that asks is the function that answers.

Inside ``asyncio``, ``deliverd.aio.AsyncDeliverd`` has the same names and the
same arguments. Every call there runs this one on a worker thread — real
concurrency, one thread per call in flight, and no native async transport,
because this package has no dependencies and the standard library has no async
HTTP client. That trade is argued in full in ``aio.py`` and in the README
rather than left for somebody to find out from a profiler.
"""

from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional, Sequence

from ._http import DEFAULT_BASE_URL, HttpClient, Transport
from .approvals import FAST_POLL_SCHEDULE, POLL_SCHEDULE, Approval, Approvals, DecisionSessions
from .gates import Gate, Gates
from .governance import AiGovernance, AiSystems, Incidents
from .collections import Collection, Collections
from .comments import Comments
from .dev import DevelopmentOptions, development_transport
from .flows import Flow, Flows
from .duration import Duration, duration_seconds
from .errors import DeliverdError, DeliverdTimeoutError
from .paging import Page
from .reports import Reports
from .reviews import Review, Reviews
from .schedules import Schedules
from .tasks import Task, Tasks
from .webhook_endpoints import WebhookEndpoints
from .screen import Screened, request_body as _screen_body, settle as _screen_settle
from .data_screen import DetectedSpan, ScreenTerm, redact, restore, screen_text, summarise
from .types import (
    APPROVAL_RISKS,
    APPROVAL_STATUSES,
    COLLECTION_STATUSES,
    EVIDENCE_STEP_KINDS,
    FLOW_MEMBER_KINDS,
    FLOW_STATUSES,
    GATE_OUTCOMES,
    GATE_STATUSES,
    QUESTION_KINDS,
    REVIEW_STATUSES,
    TASK_KINDS,
    TASK_STATUSES,
    SETTABLE_TASK_STATUSES,
    TASK_OUTCOMES,
    FINDING_KINDS,
    DECISION_STATUSES,
    TASK_LINK_KINDS,
    WEBHOOK_EVENTS,
    WEBHOOK_FORMATS,
    AnswerValue,
    ApprovalData,
    ApprovalFactor,
    ApprovalLink,
    ApprovalQuestion,
    CollectedAnswers,
    CollectionData,
    CollectionQuestion,
    CollectionReply,
    CommentMessage,
    CommentThread,
    Decision,
    EvidenceEvent,
    EvidenceOutcome,
    EvidencePack,
    EvidenceStep,
    FlowData,
    FlowEvent,
    FlowMember,
    GateData,
    GateDecision,
    InlineFile,
    OpenThread,
    PublishResult,
    ScreenData,
    Question,
    ReportData,
    ReviewData,
    ReviewerRef,
    ScheduleSummary,
    ReviewOutcome,
    ReviewVerdict,
    WebhookEvent,
    CallbackEnvelope,
    TaskState,
    TaskSnapshot,
    TaskResult,
    TaskResultFinding,
    TaskResultDecision,
    SideTaskCounts,
    TaskPathEntry,
    TaskLink,
    TaskNode,
    TaskFinding,
    TaskData,
    TaskContext,
    TaskContextTask,
    TaskContextDecisions,
    TaskContextFinding,
    TaskContextReport,
    TaskContextSideTasks,
    ActiveSideTask,
    AwaitingSideTask,
    CompletedSideTask,
    TaskGraph,
    AppliedSideTask,
    DecisionApproval,
    TaskLinkResult,
    EvidenceResult,
    EvidenceRelease,
    EvidenceRun,
    ThresholdRule,
    ControlThresholds,
    ControlScores,
    GovernanceControlSource,
    GovernanceControl,
    GovernanceEvidence,
    GovernanceReadiness,
    GovernanceBlocker,
    GovernanceGate,
    GovernanceGateScore,
    GovernanceGateCheck,
    GovernanceFramework,
    Governance,
    AiSystem,
    AiSystemDetail,
    Reassessment,
    ModelChangeResult,
    ReassessmentResult,
    ControlApprovalResult,
    AuthorityDecision,
    AiIncident,
    IncidentReport,
    ReportingStep,
    ReportingSchedule,
    AiIncidentDetail,
    DraftedIncidentReport,
    WebhookEndpoint,
    CreatedWebhookEndpoint,
    WebhookTestResult,
)
from .decision_token import (
    DecisionTokenResult,
    DecisionTokens,
    canonical_json,
    decision_input_hash,
    verify_decision_token,
)
from .webhooks import (
    DELIVERY_HEADER,
    EVENT_HEADER,
    SIGNATURE_HEADER,
    TOLERANCE_SECONDS,
    Webhooks,
    construct_event,
    construct_callback,
    verify_signature,
)

__version__ = "0.19.2"

#: How long a request waits for a person before it expires, unless you say.
DEFAULT_EXPIRY: Duration = "24h"

#: In development the approver is imaginary and instant, so a wait still running
#: after a moment is a path that will never settle. Ending it quickly turns that
#: into a message; leaving it turns it into a hung test suite.
DEVELOPMENT_TIMEOUT = 2.0

__all__ = [
    "Deliverd",
    "deliverd",
    "DecisionTokens",
    "DecisionTokenResult",
    "verify_decision_token",
    "decision_input_hash",
    "canonical_json",
    "Screened",
    "ScreenTerm",
    "DetectedSpan",
    "screen_text",
    "redact",
    "restore",
    "summarise",
    "Decision",
    "GateDecision",
    "ReviewOutcome",
    "CollectedAnswers",
    "Approval",
    "Approvals",
    "Gate",
    "Gates",
    "Review",
    "Reviews",
    "Collection",
    "Collections",
    "Flow",
    "Flows",
    "Task",
    "Tasks",
    "AiGovernance",
    "AiSystems",
    "Incidents",
    "Comments",
    "Schedules",
    "Reports",
    "Webhooks",
    "WebhookEndpoints",
    "Page",
    "DeliverdError",
    "DeliverdTimeoutError",
    "DevelopmentOptions",
    "Duration",
    "duration_seconds",
    "Question",
    "ApprovalFactor",
    "ApprovalLink",
    "InlineFile",
    "ApprovalData",
    "ApprovalQuestion",
    "GateData",
    "ReviewData",
    "ReviewerRef",
    "ReviewVerdict",
    "CollectionData",
    "CollectionQuestion",
    "CollectionReply",
    "ReportData",
    "PublishResult",
    "FlowData",
    "FlowMember",
    "FlowEvent",
    "CommentThread",
    "CommentMessage",
    "OpenThread",
    "ScheduleSummary",
    "EvidencePack",
    "EvidenceStep",
    "EvidenceOutcome",
    "EvidenceEvent",
    "WebhookEvent",
    "CallbackEnvelope",
    "TaskState",
    "TaskSnapshot",
    "TaskResult",
    "TaskResultFinding",
    "TaskResultDecision",
    "SideTaskCounts",
    "TaskPathEntry",
    "TaskLink",
    "TaskNode",
    "TaskFinding",
    "TaskData",
    "TaskContext",
    "TaskContextTask",
    "TaskContextDecisions",
    "TaskContextFinding",
    "TaskContextReport",
    "TaskContextSideTasks",
    "ActiveSideTask",
    "AwaitingSideTask",
    "CompletedSideTask",
    "TaskGraph",
    "AppliedSideTask",
    "DecisionApproval",
    "TaskLinkResult",
    "EvidenceResult",
    "EvidenceRelease",
    "EvidenceRun",
    "ThresholdRule",
    "ControlThresholds",
    "ControlScores",
    "GovernanceControlSource",
    "GovernanceControl",
    "GovernanceEvidence",
    "GovernanceReadiness",
    "GovernanceBlocker",
    "GovernanceGate",
    "GovernanceGateScore",
    "GovernanceGateCheck",
    "GovernanceFramework",
    "Governance",
    "AiSystem",
    "AiSystemDetail",
    "Reassessment",
    "ModelChangeResult",
    "ReassessmentResult",
    "ControlApprovalResult",
    "AuthorityDecision",
    "AiIncident",
    "IncidentReport",
    "ReportingStep",
    "ReportingSchedule",
    "AiIncidentDetail",
    "DraftedIncidentReport",
    "WebhookEndpoint",
    "CreatedWebhookEndpoint",
    "WebhookTestResult",
    "verify_signature",
    "construct_event",
    "construct_callback",
    "SIGNATURE_HEADER",
    "EVENT_HEADER",
    "DELIVERY_HEADER",
    "TOLERANCE_SECONDS",
    "WEBHOOK_EVENTS",
    "WEBHOOK_FORMATS",
    "APPROVAL_STATUSES",
    "APPROVAL_RISKS",
    "REVIEW_STATUSES",
    "COLLECTION_STATUSES",
    "QUESTION_KINDS",
    "GATE_STATUSES",
    "GATE_OUTCOMES",
    "FLOW_STATUSES",
    "FLOW_MEMBER_KINDS",
    "EVIDENCE_STEP_KINDS",
    "TASK_KINDS",
    "TASK_STATUSES",
    "SETTABLE_TASK_STATUSES",
    "TASK_OUTCOMES",
    "FINDING_KINDS",
    "DECISION_STATUSES",
    "TASK_LINK_KINDS",
    "AnswerValue",
    "DEFAULT_BASE_URL",
    "DEFAULT_EXPIRY",
    "__version__",
]


def _expiry(expires_at: Optional[str], expires_in: Optional[Duration]) -> str:
    """When the request gives up, as an ISO instant.

    Always one or the other, never neither: a request with no expiry is a wait
    that may never end, and the one promise this SDK makes about ``wait()`` is
    that it does.
    """
    if expires_at is not None:
        return expires_at
    seconds = duration_seconds(expires_in if expires_in is not None else DEFAULT_EXPIRY)
    when = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return when.isoformat().replace("+00:00", "Z")


class Deliverd:
    """The client. One per process is plenty; it holds no connection."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        mode: Optional[str] = None,
        max_retries: int = 3,
        timeout: float = 30.0,
        transport: Optional[Transport] = None,
        development: Optional[DevelopmentOptions] = None,
    ) -> None:
        resolved_mode = mode or (
            "development" if os.environ.get("DELIVERD_MODE") == "development" else "live"
        )
        #: Whether an imaginary approver is deciding these.
        self.development = resolved_mode == "development"

        self.http = HttpClient(
            # A key is not needed when nothing leaves the machine.
            api_key=api_key
            or os.environ.get("DELIVERD_API_KEY")
            or ("dlv_development" if self.development else ""),
            base_url=base_url or os.environ.get("DELIVERD_BASE_URL"),
            max_retries=max_retries,
            timeout=timeout,
            transport=(
                development_transport(development)
                if self.development and transport is None
                else transport
            ),
        )

        self.approvals = Approvals(self.http)
        #: Pages on which an approver decides inside your product; ``approvals.create_session`` makes one.
        self.decision_sessions = DecisionSessions(self.http)
        self.gates = Gates(self.http)
        self.reviews = Reviews(self.http)
        self.collections = Collections(self.http)
        self.reports = Reports(self.http)
        self.comments = Comments(self.http)
        self.schedules = Schedules(self.http)
        # The handle takes the client, so `flow.approve()` is the same call as
        # `deliverd.approve()` with the flow filled in rather than a second
        # implementation that can drift from it.
        self.flows = Flows(self.http, self)
        self.tasks = Tasks(self.http, self)
        self.webhooks = Webhooks()
        self.webhook_endpoints = WebhookEndpoints(self.http)
        self.governance = AiGovernance(self.http)
        #: Check a gate's signed yes where the action happens, before it happens.
        self.decision_tokens = DecisionTokens(self.http.base_url)

    # ── the four verbs ─────────────────────────────────────────────────────

    def approve(
        self,
        title: str,
        description: Optional[str] = None,
        risk: Optional[str] = None,
        factors: Optional[Sequence[Any]] = None,
        links: Optional[Sequence[Any]] = None,
        approvers: Optional[Sequence[str]] = None,
        report_id: Optional[str] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        input: Optional[Dict[str, Any]] = None,
        editable_fields: Optional[Sequence[str]] = None,
        expires_in: Optional[Duration] = None,
        expires_at: Optional[str] = None,
        on_question: Optional[Any] = None,
        on_poll: Optional[Any] = None,
        timeout: Optional[Duration] = None,
        cancel: Optional[threading.Event] = None,
        reuse: bool = True,
        idempotency_key: Optional[str] = None,
    ) -> Decision:
        """Ask a person, and wait for the answer.

        Returns when they decide — **including when they say no**, because a
        refusal is an answer and ``if decision.approved:`` is the line that
        follows. It raises only when the wait itself failed: a timeout, a
        cancellation, or an API that could not be reached.

        Requests expire after a day unless you say otherwise, so a wait always
        ends.
        """
        if external_id and reuse:
            existing = self.approvals.find_by_external_id(external_id)
            if existing is not None:
                return existing.wait(**self._wait_args(on_question, on_poll, timeout, cancel)).to_decision()

        approval = self.approvals.create(
            title=title,
            description=description,
            risk=risk,
            factors=factors,
            links=links,
            report_id=report_id,
            approvers=approvers,
            expires_at=_expiry(expires_at, expires_in),
            external_id=external_id,
            flow_id=flow_id,
            agent=agent,
            model=model,
            metadata=metadata,
            callback_url=callback_url,
            input=input,
            editable_fields=editable_fields,
            idempotency_key=idempotency_key,
        )
        return approval.wait(**self._wait_args(on_question, on_poll, timeout, cancel)).to_decision()

    def gate(
        self,
        action: str,
        input: Dict[str, Any],
        external_id: str,
        environment: Optional[str] = None,
        reason: Optional[str] = None,
        flow_id: Optional[str] = None,
        on_poll: Optional[Any] = None,
        timeout: Optional[Duration] = None,
        cancel: Optional[threading.Event] = None,
        wait: bool = True,
    ) -> GateDecision:
        """Ask whether to act, and wait if a person has to decide.

        The other primitives ask a person to look at work already done. This one
        asks first, and the answer comes from **policy the developer does not
        own** — what needs a human is an organisation's decision, not a line in
        your code. Most calls never reach a person, because a rule settles them.

            decision = deliverd.gate(
                action="finance.refund",
                external_id=f"refund:{order.id}",
                input={"customer_id": order.customer_id, "amount": 1240, "currency": "GBP"},
            )
            if not decision.allowed:
                return
            stripe.Refund.create(**decision.input)

        **Execute with ``decision.input``**, not the dict you passed: it is what
        the action's schema validated and what an approver actually saw.

        It does not raise on a refusal — a no is an answer, and
        ``if decision.allowed:`` is the line that follows. It raises when the
        action is not registered, when the input does not match its schema, or
        when the wait itself failed.

        ``wait=False`` returns a pending decision immediately; ``deliverd.gates``
        is the same thing with the handle exposed.
        """
        gate = self.gates.create(
            action_id=action,
            input=input,
            external_id=external_id,
            environment=environment,
            reason=reason,
            flow_id=flow_id,
        )
        # No wait when the caller said not to, and none when there is nothing to
        # wait for — a rule that allowed or denied it has already answered, which
        # is the common case and must not cost a poll.
        if not wait or not gate.pending:
            return gate.to_decision()
        # `_wait_args` omits `on_question` when it is None, which is what a gate
        # wants: there is no question to answer on one. A gate's wait takes no
        # such handler, so passing one would be a TypeError rather than a no-op.
        return gate.wait(**self._wait_args(None, on_poll, timeout, cancel)).to_decision()

    def confirm(self, title: str, **kwargs: Any) -> bool:
        """A yes or no on something small: same mechanism, lower ceremony.

        Low risk and an hour to answer, because that is what "are you sure?"
        means — if it deserves a day and a paragraph of evidence, it deserves
        :meth:`approve`.
        """
        kwargs.setdefault("risk", "low")
        kwargs.setdefault("expires_in", "1h")
        return self.approve(title=title, **kwargs).approved

    def review(
        self,
        title: str,
        reviewers: Sequence[str],
        instructions: Optional[str] = None,
        report_id: Optional[str] = None,
        version_id: Optional[str] = None,
        required_approvals: Optional[int] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        expires_in: Optional[Duration] = None,
        expires_at: Optional[str] = None,
        on_poll: Optional[Any] = None,
        timeout: Optional[Duration] = None,
        cancel: Optional[threading.Event] = None,
        reuse: bool = True,
        idempotency_key: Optional[str] = None,
    ) -> ReviewOutcome:
        """Ask people to read what you made, and wait for their answer.

        Returns on changes requested as well as approval, because that is an
        answer — usually the more useful one.
        """
        if external_id and reuse:
            existing = self.reviews.find_by_external_id(external_id)
            if existing is not None:
                return existing.wait(**self._wait_args(None, on_poll, timeout, cancel)).to_outcome()

        review = self.reviews.create(
            title=title,
            reviewers=reviewers,
            instructions=instructions,
            report_id=report_id,
            version_id=version_id,
            required_approvals=required_approvals,
            expires_at=_expiry(expires_at, expires_in),
            external_id=external_id,
            flow_id=flow_id,
            agent=agent,
            model=model,
            metadata=metadata,
            callback_url=callback_url,
            idempotency_key=idempotency_key,
        )
        return review.wait(**self._wait_args(None, on_poll, timeout, cancel)).to_outcome()

    def collect(
        self,
        title: str,
        questions: Sequence[Any],
        respondents: Sequence[str],
        instructions: Optional[str] = None,
        required_responses: Optional[int] = None,
        report_id: Optional[str] = None,
        due_at: Optional[str] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        expires_in: Optional[Duration] = None,
        expires_at: Optional[str] = None,
        on_poll: Optional[Any] = None,
        timeout: Optional[Duration] = None,
        cancel: Optional[threading.Event] = None,
        reuse: bool = True,
        idempotency_key: Optional[str] = None,
    ) -> CollectedAnswers:
        """Ask people for what you do not have, and wait for it.

        ``answers`` is keyed by the question you asked. Check ``complete``
        before you use it: a request that expired has whatever arrived and no
        more, and the thing you do without the figure is usually not the thing
        you do with it.
        """
        if external_id and reuse:
            existing = self.collections.find_by_external_id(external_id)
            if existing is not None:
                return existing.wait(**self._wait_args(None, on_poll, timeout, cancel)).to_collected()

        collection = self.collections.create(
            title=title,
            questions=questions,
            respondents=respondents,
            instructions=instructions,
            required_responses=required_responses,
            report_id=report_id,
            due_at=due_at,
            expires_at=_expiry(expires_at, expires_in),
            external_id=external_id,
            flow_id=flow_id,
            agent=agent,
            model=model,
            metadata=metadata,
            callback_url=callback_url,
            idempotency_key=idempotency_key,
        )
        return collection.wait(**self._wait_args(None, on_poll, timeout, cancel)).to_collected()

    def screen(
        self,
        text: str,
        ai_system_id: Optional[str] = None,
        purpose: Optional[str] = None,
        external_id: Optional[str] = None,
        terms: Optional[Sequence[Any]] = None,
        wait: bool = True,
        timeout: Optional[Duration] = None,
        cancel: Optional[threading.Event] = None,
        detectors: Optional[Sequence[Callable[[str], Sequence[Any]]]] = None,
        spans: Optional[Sequence[Any]] = None,
    ) -> Screened:
        """Check text before it goes to an AI model, and wait if a person has to decide.

        The detectors run here, so the text never leaves your machine: Deliverd
        is told only what was found, by kind, and answers from what your AI
        register approves that model to receive.

            screened = deliverd.screen(prompt, ai_system_id=CLAIMS_MODEL)
            if not screened.allowed:
                return screened.reasons
            answer = model.generate(screened.text)
            return screened.restore(answer)

        ``allow`` sends it as it is; ``redact`` gives ``screened.text`` with the
        findings replaced by placeholders, and ``restore()`` puts them back in
        the answer; ``ask`` puts it to a person and waits; ``deny`` sends
        nothing. ``terms`` are your own words not to send — clients, code
        names — as strings, dicts or :class:`ScreenTerm`. A net, not a
        guarantee: names in particular are not reliably found, unless you pass
        ``detectors``: callables from the text to spans, such as the Hugging
        Face or Presidio adapters in ``deliverd-screen``. They run here too,
        and only their counts are sent.
        """
        body, findings = _screen_body(text, terms, ai_system_id, purpose, external_id, detectors, spans)
        data = ScreenData.from_wire(self.http.request("POST", "/screen", body=body))
        settled = _screen_settle(data, text, findings)
        if settled is not None:
            return settled
        if data.approval is None or not wait:
            return Screened(data, None, False, {})
        approval = self.approvals.get(data.approval.id).wait(**self._wait_args(None, None, timeout, cancel))
        if approval.approved:
            return Screened(data, text, True, {}, approval)
        return Screened(data, None, False, {}, approval)

    def publish(self, **kwargs: Any) -> PublishResult:
        """Publish HTML to a secure URL. The other half of the product, one call in."""
        return self.reports.publish(**kwargs)

    # ── internals ──────────────────────────────────────────────────────────

    def _wait_args(
        self,
        on_question: Optional[Any],
        on_poll: Optional[Any],
        timeout: Optional[Duration],
        cancel: Optional[threading.Event],
    ) -> Dict[str, Any]:
        args: Dict[str, Any] = {"on_poll": on_poll, "cancel": cancel}
        if on_question is not None:
            args["on_question"] = on_question
        args["timeout"] = (
            duration_seconds(timeout)
            if timeout is not None
            else (DEVELOPMENT_TIMEOUT if self.development else None)
        )
        if self.development:
            args["poll_intervals"] = FAST_POLL_SCHEDULE
        return args


class _Lazy:
    """A client that builds itself the first time you touch it.

    So the shortest integration has no setup line at all::

        from deliverd import deliverd
        deliverd.approve(title="Deploy production")

    Lazy rather than eager: a module that raised at import time because an
    environment variable was missing would take a whole process down for a call
    nobody made yet.
    """

    def __init__(self) -> None:
        self._client: Optional[Deliverd] = None
        self._lock = threading.Lock()

    def _resolve(self) -> Deliverd:
        if self._client is None:
            with self._lock:
                if self._client is None:
                    self._client = Deliverd()
        return self._client

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<deliverd (unbuilt)>" if self._client is None else repr(self._client)


#: The module-level client, built from the environment on first use.
deliverd: Any = _Lazy()
