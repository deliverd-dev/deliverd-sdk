"""The API's objects, by hand.

Not generated from the server's schemas on purpose: this package is published
to PyPI and must not drag the monorepo's internals with it. The cost of that is
drift, so ``apps/web/src/lib/api/sdk-parity.test.ts`` holds every class here to
the TypeScript interface of the same name, field for field — a field added to
one SDK and not the other fails on the server side, where somebody is looking.

Every field is named the Python way; :mod:`deliverd._wire` is the one place
``decidedById`` becomes ``decided_by_id``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from ._wire import Model

# ── Approvals ──────────────────────────────────────────────────────────────

#: ``pending`` | ``approved`` | ``rejected`` | ``changes_requested`` | ``expired`` | ``cancelled``
APPROVAL_STATUSES = ("pending", "approved", "rejected", "changes_requested", "expired", "cancelled")
#: ``low`` | ``medium`` | ``high`` | ``critical``
APPROVAL_RISKS = ("low", "medium", "high", "critical")


@dataclass
class ApprovalFactor:
    """One line of evidence, as the approval page shows it.

    A plain dataclass rather than a :class:`Model`, because this one travels in
    both directions: you build factors to send, and read them back off a
    request. A Model carries the payload it was built from, which a caller
    constructing one has no business supplying.
    """

    label: str
    #: ``ok`` | ``warning`` | ``info``.
    status: Optional[str] = None
    detail: Optional[str] = None


@dataclass
class ApprovalLink:
    """Where the approver can read more. Sent and returned, like a factor."""

    label: str
    url: str


@dataclass
class ApprovalQuestion(Model):
    id: str
    question: str
    answer: Optional[str]
    asked_at: str
    answered_at: Optional[str]


@dataclass
class ApprovalData(Model):
    id: str
    status: str
    #: The page the approver decides on.
    url: str
    title: str
    description: Optional[str]
    risk: str
    factors: List[ApprovalFactor]
    links: List[ApprovalLink]
    report_id: Optional[str]
    external_id: Optional[str]
    metadata: Dict[str, Any]
    #: What you proposed to run with, unchanged. ``None`` when you sent none.
    input: Optional[Dict[str, Any]]
    #: Which fields of it the approver may correct.
    editable_fields: List[str]
    #: What to run with once approved: ``input`` with any corrections.
    approved_input: Optional[Dict[str, Any]]
    #: What the approver changed: ``{"field", "from", "to"}`` each.
    changes: List[Dict[str, Any]]
    #: What the organisation's ethics rules asked whoever decides to weigh:
    #: ``{"principle", "rule", "concern"}`` each, as they read when this was
    #: asked. Empty when nothing matched. A flagged request is approved with a
    #: written reason, never from a sign-in-free link.
    concerns: List[Dict[str, Any]]
    requested_by: str
    approvers: List[str]
    #: How many people must agree before it settles. One unless a standing rule
    #: in the organisation escalated it — an agent cannot set this, and a rule
    #: can only push it up.
    required_approvals: int
    #: How many have approved so far. Compare with :attr:`required_approvals`.
    approvals_so_far: int
    #: Who decided, as a name rather than an id — the same as a review's ``by``.
    decided_by: Optional[str]
    #: Their user id, for anything that needs the key rather than the person.
    decided_by_id: Optional[str]
    decided_at: Optional[str]
    #: The approver's reason, on a rejection or an approval that carried one.
    note: Optional[str]
    expires_at: Optional[str]
    questions: List[ApprovalQuestion]
    created_at: str

    _NESTED_LISTS = {
        "factors": ApprovalFactor,
        "links": ApprovalLink,
        "questions": ApprovalQuestion,
    }


@dataclass
class Decision:
    """The answer to :meth:`Deliverd.approve`.

    Flat on purpose: the line after the call is ``if decision.approved:``, and
    anything a caller has to reach through to get there is a step this SDK
    exists to remove. The whole request is on :attr:`approval` when a field here
    does not cover it.
    """

    #: True only for an approval. False for rejected, changes requested, expired and cancelled.
    approved: bool
    #: ``approved`` | ``rejected`` | ``changes_requested`` | ``expired`` | ``cancelled``.
    status: str
    #: Their reason, when they gave one.
    note: Optional[str]
    #: Who decided, as a name rather than an id. Log it; put it in a message.
    decided_by: Optional[str]
    #: Their user id, when the key is what you need.
    decided_by_id: Optional[str]
    decided_at: Optional[str]
    id: str
    #: The page they decided on. Worth logging.
    url: str
    #: What to run with, when you sent ``input`` and it was approved: yours,
    #: with any corrections the approver made. ``None`` otherwise — never run
    #: the proposal when this is ``None``.
    input: Optional[Dict[str, Any]]
    #: What the approver changed: ``{"field", "from", "to"}`` each.
    changes: List[Dict[str, Any]]
    #: The request itself, for anything the fields above do not name.
    approval: Any

    def __bool__(self) -> bool:
        """``if decision:`` means the same as ``if decision.approved:``.

        Offered because somebody will write it, and a decision that was
        truthy merely by existing would make a rejection read as a yes — the
        one bug in this whole package that would do real damage.
        """
        return self.approved


# ── Reviews ────────────────────────────────────────────────────────────────

#: ``pending`` | ``approved`` | ``changes_requested`` | ``expired`` | ``cancelled``
REVIEW_STATUSES = ("pending", "approved", "changes_requested", "expired", "cancelled")


@dataclass
class ReviewerRef(Model):
    kind: str
    id: str
    label: str


@dataclass
class ReviewVerdict(Model):
    verdict: str
    #: Who gave it, as a name rather than an id.
    by: str
    note: Optional[str]
    at: str


@dataclass
class ReviewData(Model):
    id: str
    status: str
    #: The page the reviewer reads and decides on.
    url: str
    title: str
    instructions: Optional[str]
    report_id: Optional[str]
    version_id: Optional[str]
    external_id: Optional[str]
    metadata: Dict[str, Any]
    requested_by: str
    required_approvals: int
    reviewers: List[ReviewerRef]
    verdicts: List[ReviewVerdict]
    #: How many comment threads the reviewers opened while reading.
    thread_count: int
    settled_at: Optional[str]
    expires_at: Optional[str]
    created_at: str

    _NESTED_LISTS = {"reviewers": ReviewerRef, "verdicts": ReviewVerdict}


@dataclass
class ReviewOutcome:
    """The answer, flattened — what :meth:`Deliverd.review` hands back."""

    #: The one to branch on. False for changes requested, expired and cancelled.
    approved: bool
    status: str
    #: Every verdict returned, in the order they arrived.
    verdicts: List[ReviewVerdict]
    #: How many comment threads to read before producing the next version.
    thread_count: int
    id: str
    url: str
    review: ReviewData

    def __bool__(self) -> bool:
        return self.approved


# ── Collections ────────────────────────────────────────────────────────────

#: ``pending`` | ``complete`` | ``expired`` | ``cancelled``
COLLECTION_STATUSES = ("pending", "complete", "expired", "cancelled")
#: What kinds of question a collection may ask.
QUESTION_KINDS = (
    "text",
    "long_text",
    "number",
    "date",
    "choice",
    "multi_choice",
    "boolean",
)

#: What an answer can hold, shaped by its question's kind.
AnswerValue = Union[str, int, float, bool, List[str]]


@dataclass
class Question:
    """A question to ask, as you would ask it out loud.

    The input shape rather than the stored one: build these (or plain dicts) and
    hand them to :meth:`Deliverd.collect`.
    """

    #: The question, as you would ask it out loud.
    prompt: str
    kind: str = "text"
    #: The sentence under the field that stops the wrong answer being given.
    help: Optional[str] = None
    #: Required unless you say otherwise; a required question blocks submission.
    required: Optional[bool] = None
    #: For ``choice`` and ``multi_choice``. At least two, or it is not a question.
    options: Optional[List[str]] = None


@dataclass
class CollectionQuestion(Model):
    id: str
    prompt: str
    help: Optional[str]
    kind: str
    required: bool
    options: List[str]


@dataclass
class CollectionAnswer(Model):
    question: str
    kind: str
    value: AnswerValue


@dataclass
class CollectionReply(Model):
    #: Who answered, as a name rather than an id.
    respondent: str
    status: str
    submitted_at: Optional[str]
    #: Empty until they submit: a half-typed draft is not what they meant to say.
    answers: List[CollectionAnswer]

    _NESTED_LISTS = {"answers": CollectionAnswer}


@dataclass
class CollectionData(Model):
    id: str
    status: str
    #: The page the person fills in.
    url: str
    title: str
    instructions: Optional[str]
    report_id: Optional[str]
    external_id: Optional[str]
    metadata: Dict[str, Any]
    requested_by: str
    required_responses: int
    questions: List[CollectionQuestion]
    responses: List[CollectionReply]
    submitted_count: int
    asked_count: int
    settled_at: Optional[str]
    due_at: Optional[str]
    expires_at: Optional[str]
    created_at: str

    _NESTED_LISTS = {"questions": CollectionQuestion, "responses": CollectionReply}


@dataclass
class CollectedAnswers:
    """The answers, flattened — what :meth:`Deliverd.collect` hands back."""

    #: True when enough people replied; false if it expired or was withdrawn.
    complete: bool
    status: str
    #: Every submitted reply, in the order they arrived.
    responses: List[CollectionReply]
    #: The first submitted answer to each question, by its prompt — the shape
    #: most callers want when they asked one person for three facts. The keys
    #: are the questions as they were written, so they are never converted.
    answers: Dict[str, AnswerValue]
    id: str
    url: str
    collection: CollectionData

    def __bool__(self) -> bool:
        return self.complete

    def __getitem__(self, prompt: str) -> AnswerValue:
        """``answers["Headcount at 30 September"]``, without the middle word."""
        return self.answers[prompt]


# ── Reports ────────────────────────────────────────────────────────────────


@dataclass
class InlineFile:
    path: str
    content: str
    #: ``base64`` for an image or a font; text otherwise.
    encoding: Optional[str] = None


@dataclass
class ReportData(Model):
    id: str
    slug: str
    title: str
    url: str
    status: str
    current_version: Optional[int]
    #: The task this report was written for, when it was published with one.
    task_id: Optional[str]


@dataclass
class PublishResult(Model):
    """What a publish did.

    A publish held by a policy rule answers 202 with this instead of going
    live. :attr:`status` says which happened, so a caller that ignores it still
    gets a report object and a caller that reads it knows nobody can see the
    thing yet.
    """

    #: ``published`` | ``updated`` | ``pending_approval``.
    status: Optional[str]
    report: ReportData
    version: Optional[Dict[str, Any]]
    approval: Optional[Dict[str, Any]]
    warnings: Optional[List[str]]

    _NESTED = {"report": ReportData}

    @property
    def held(self) -> bool:
        """Nobody can open it yet: a rule is holding it for a person."""
        return self.status == "pending_approval"

    @property
    def url(self) -> str:
        """Where the report lives, held or not."""
        return self.report.url



# ── Flows ──────────────────────────────────────────────────────────────────

#: ``open`` | ``complete`` | ``cancelled``
FLOW_STATUSES = ("open", "complete", "cancelled")
#: What a flow can contain.
FLOW_MEMBER_KINDS = ("approval", "review", "collection", "report")


@dataclass
class FlowMember(Model):
    kind: str
    id: str
    title: str
    #: The member's own status word, which differs by kind.
    status: str
    #: Still waiting on somebody. Always false for a report.
    open: bool
    created_at: str


@dataclass
class FlowEvent(Model):
    """One line of the history: what happened, who did it, when."""

    event: str
    actor: str
    actor_type: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    at: str


@dataclass
class FlowData(Model):
    id: str
    status: str
    #: The timeline page a person can open.
    url: str
    title: str
    description: Optional[str]
    external_id: Optional[str]
    metadata: Dict[str, Any]
    started_by: str
    members: List[FlowMember]
    member_count: int
    open_count: int
    #: Nothing outstanding right now — not a claim that the job is finished.
    all_settled: bool
    #: Present on a single read, absent from a list.
    timeline: Optional[List[FlowEvent]]
    settled_at: Optional[str]
    created_at: str

    _NESTED_LISTS = {"members": FlowMember, "timeline": FlowEvent}


# ── Tasks ──────────────────────────────────────────────────────────────────
#
# Task Graph: an objective kept apart from the conversation doing the work, the
# side tasks branched out of it, and the findings each produced. Every nested
# shape is a named class, and the TypeScript SDK names the same ones, so the
# parity guard holds the two to each other field by field.

#: ``objective`` and the five kinds of side task.
TASK_KINDS = ("objective", "side_task", "investigation", "research", "debug", "decision")
TASK_STATUSES = ("open", "in_progress", "blocked", "awaiting_approval", "completed", "cancelled")
#: What ``tasks.update(status=...)`` may set; completing and cancelling have their own calls.
SETTABLE_TASK_STATUSES = ("open", "in_progress", "blocked", "awaiting_approval")
#: What became of a finished side task's result.
TASK_OUTCOMES = ("applied", "kept", "discarded")
FINDING_KINDS = (
    "hypothesis",
    "test",
    "evidence",
    "finding",
    "conclusion",
    "recommendation",
    "decision",
    "risk",
    "question",
    "action",
)
#: A decision is a suggestion until a person confirms it.
DECISION_STATUSES = ("suggested", "confirmed", "rejected")
TASK_LINK_KINDS = ("depends_on", "blocks", "related_to", "supersedes", "resulted_in")


@dataclass
class TaskState(Model):
    """Where a task stands, what is open, what is in the way, what comes next."""

    current_state: Optional[str]
    open_questions: List[str]
    constraints: List[str]
    blocked_by: List[str]
    next_action: Optional[str]


@dataclass
class TaskSnapshot(Model):
    """What a side task was given when it began. Facts, not a transcript."""

    root_objective: str
    parent_objective: str
    side_task_goal: str
    relevant_context: List[str]
    known_constraints: List[str]
    related_decisions: List[str]
    #: The parent's open question this side task was opened to answer, if any.
    resolves_question: Optional[str]


@dataclass
class TaskResultFinding(Model):
    title: str
    description: str
    evidence: Optional[List[str]]


@dataclass
class TaskResultDecision(Model):
    title: str
    rationale: Optional[str]


@dataclass
class TaskResult(Model):
    """What a side task came back with. Structured, so the parent can use it."""

    summary: str
    findings: List[TaskResultFinding]
    decisions: List[TaskResultDecision]
    recommendations: List[str]
    unresolved_questions: List[str]
    parent_impact: Optional[str]
    suggested_next_action: Optional[str]

    _NESTED_LISTS = {"findings": TaskResultFinding, "decisions": TaskResultDecision}


@dataclass
class SideTaskCounts(Model):
    """An objective's side tasks, counted. On a list only."""

    open: int
    done: int
    #: Finished and waiting for somebody to apply, keep or discard the result.
    awaiting: int


@dataclass
class TaskPathEntry(Model):
    id: str
    title: str
    kind: str


@dataclass
class TaskLink(Model):
    source_task_id: str
    target_task_id: str
    kind: str


@dataclass
class TaskNode(Model):
    """A task as the tree shows it: no state, no snapshot, one line of the result."""

    id: str
    parent_task_id: Optional[str]
    kind: str
    depth: int
    status: str
    title: str
    outcome: Optional[str]
    result_summary: Optional[str]
    url: str


@dataclass
class TaskFinding(Model):
    """An inspectable work product: what was tested, seen or concluded."""

    id: str
    task_id: str
    kind: str
    title: str
    body: str
    evidence: List[str]
    #: For a decision: ``suggested``, ``confirmed`` or ``rejected``.
    decision_status: Optional[str]
    decided_by: Optional[str]
    decided_at: Optional[str]
    approval_id: Optional[str]
    approval_status: Optional[str]
    #: The side task it came from, when it arrived with an applied result.
    source_task_id: Optional[str]
    created_by: str
    created_at: str


@dataclass
class TaskData(Model):
    id: str
    kind: str
    status: str
    #: The page a person can open.
    url: str
    title: str
    #: What the work is for: the objective's purpose, or a side task's goal.
    objective: str
    root_task_id: str
    parent_task_id: Optional[str]
    depth: int
    workspace_id: Optional[str]
    flow_id: Optional[str]
    state: TaskState
    snapshot: Optional[TaskSnapshot]
    result: Optional[TaskResult]
    #: Earlier results, kept when a completed task is reopened.
    previous_results: List[TaskResult]
    outcome: Optional[str]
    origin: str
    external_id: Optional[str]
    session_url: Optional[str]
    #: Pass it back as ``expected_version`` to refuse a stale update.
    version: int
    started_by: str
    created_at: str
    updated_at: str
    completed_at: Optional[str]
    #: On a list only.
    side_tasks: Optional[SideTaskCounts] = None
    #: On a single read, from here down: path, children, findings, links.
    path: Optional[List[TaskPathEntry]] = None
    children: Optional[List[TaskNode]] = None
    findings: Optional[List[TaskFinding]] = None
    links: Optional[List[TaskLink]] = None
    #: On create only: an open objective with this ``external_id`` came back.
    resumed: Optional[bool] = None

    _NESTED = {
        "state": TaskState,
        "snapshot": TaskSnapshot,
        "result": TaskResult,
        "side_tasks": SideTaskCounts,
    }
    _NESTED_LISTS = {
        "previous_results": TaskResult,
        "path": TaskPathEntry,
        "children": TaskNode,
        "findings": TaskFinding,
        "links": TaskLink,
    }


@dataclass
class TaskContextTask(Model):
    id: str
    kind: str
    title: str
    objective: str
    status: str
    is_side_task: bool


@dataclass
class TaskContextDecisions(Model):
    confirmed: List[str]
    suggested: List[str]


@dataclass
class TaskContextFinding(Model):
    kind: str
    title: str
    body: str


@dataclass
class ActiveSideTask(Model):
    id: str
    title: str
    kind: str
    status: str


@dataclass
class AwaitingSideTask(Model):
    """Finished, and waiting for somebody to apply, keep or discard the result."""

    id: str
    title: str
    summary: Optional[str]


@dataclass
class CompletedSideTask(Model):
    id: str
    title: str
    summary: Optional[str]
    outcome: Optional[str]


@dataclass
class TaskContextSideTasks(Model):
    active: List[ActiveSideTask]
    awaiting_outcome: List[AwaitingSideTask]
    completed: List[CompletedSideTask]

    _NESTED_LISTS = {
        "active": ActiveSideTask,
        "awaiting_outcome": AwaitingSideTask,
        "completed": CompletedSideTask,
    }


@dataclass
class TaskContextReport(Model):
    """A report published for a task, as its context names it."""

    id: str
    title: str
    url: str
    #: The live version; ``None`` until one has gone live.
    version: Optional[int]
    published_at: Optional[str]


@dataclass
class TaskContext(Model):
    """What an agent reads instead of the history. The objective comes first."""

    root_objective: str
    task: TaskContextTask
    path: List[TaskPathEntry]
    current_state: Optional[str]
    next_action: Optional[str]
    open_questions: List[str]
    constraints: List[str]
    blocked_by: List[str]
    decisions: TaskContextDecisions
    snapshot: Optional[TaskSnapshot]
    relevant_findings: List[TaskContextFinding]
    side_tasks: TaskContextSideTasks
    #: Reports published for this task, newest first, up to ten. Revise one with
    #: ``reports.update()`` rather than publishing a second on the same thing.
    reports: List[TaskContextReport]
    #: One paragraph to say back to yourself to re-anchor on the objective.
    reanchor: str

    _NESTED = {
        "task": TaskContextTask,
        "decisions": TaskContextDecisions,
        "snapshot": TaskSnapshot,
        "side_tasks": TaskContextSideTasks,
    }
    _NESTED_LISTS = {
        "path": TaskPathEntry,
        "relevant_findings": TaskContextFinding,
        "reports": TaskContextReport,
    }


@dataclass
class TaskGraph(Model):
    root: TaskData
    nodes: List[TaskNode]
    links: List[TaskLink]

    _NESTED = {"root": TaskData}
    _NESTED_LISTS = {"nodes": TaskNode, "links": TaskLink}


@dataclass
class AppliedSideTask(Model):
    """Both tasks as they now are, and the parent's fresh context to read next."""

    side_task: TaskData
    parent: TaskData
    message: str
    context: TaskContext

    _NESTED = {"side_task": TaskData, "parent": TaskData, "context": TaskContext}


@dataclass
class DecisionApproval(Model):
    finding: TaskFinding
    approval_id: str
    approval_url: str

    _NESTED = {"finding": TaskFinding}


@dataclass
class TaskLinkResult(Model):
    linked: bool
    source_task_id: str
    target_task_id: str
    kind: str
    #: False when the link already existed.
    created: bool


# ── Compliance Mode: governance on a task ─────────────────────────────────


@dataclass
class EvidenceResult(Model):
    """One thing an evaluation, test suite or red-team run measured."""

    #: As the tool names it — ``pass_rate``, ``attack_success_rate``.
    metric: str
    value: float
    #: The tool's own verdict on this result, where it gives one.
    passed: Optional[bool]
    #: How serious a failure of this result is: low, medium, high or critical.
    severity: Optional[str]
    category: Optional[str]
    dataset: Optional[str]
    #: The trace or row it can be inspected at.
    url: Optional[str]


@dataclass
class EvidenceRelease(Model):
    """The release a run tested: the parts of the AI system's fingerprint it names.

    A part left out is not compared. Digests, never the text — ``sha256:…``, a
    commit or a tag — as ``deliverd governance release`` records them.
    """

    provider: Optional[str]
    model: Optional[str]
    model_version: Optional[str]
    prompt_hash: Optional[str]
    guardrails_hash: Optional[str]


@dataclass
class EvidenceRun(Model):
    """The run a set of results came from."""

    tool: str
    run_id: Optional[str]
    name: Optional[str]
    url: Optional[str]
    started_at: Optional[str]
    #: The release the run tested. Evidence naming another release than the
    #: AI system now runs does not count.
    release: Optional[EvidenceRelease]

    _NESTED = {"release": EvidenceRelease}


@dataclass
class ThresholdRule(Model):
    metric: str
    #: ``>=``, ``>``, ``<=``, ``<`` or ``==``.
    comparator: str
    value: float


@dataclass
class ControlThresholds(Model):
    """What a control's scored evidence must meet. Set by a person."""

    rules: List[ThresholdRule]
    #: Fail on any result the tool marked failed at this severity or above.
    fail_on_severity: Optional[str]

    _NESTED_LISTS = {"rules": ThresholdRule}


@dataclass
class ControlScores(Model):
    """What the newest scored evidence came to, against a control's thresholds."""

    passed: bool
    reason: str
    evidence_id: str


@dataclass
class GovernanceControlSource(Model):
    framework: str
    version: str
    ref: str


@dataclass
class GovernanceControl(Model):
    key: str
    title: str
    family: str
    #: ``profile``, ``evidence`` or ``approval``: how it is satisfied.
    kind: str
    custom: bool
    #: ``outstanding``, ``satisfied`` or ``waived``.
    status: str
    required: bool
    #: Pieces of evidence that count towards it: since the last material
    #: change, and of the release the system runs now.
    evidence: int
    #: Evidence that tested another release than the system runs now, and so
    #: does not count.
    other_release: int
    #: What scored evidence must meet: the task's own, or the organisation's
    #: default when it has none.
    thresholds: Optional[ControlThresholds]
    #: ``task`` or ``organisation``: whose the thresholds are. None with none.
    thresholds_source: Optional[str]
    thresholds_set_by: Optional[str]
    #: The organisation's default for this control, whether or not the task
    #: has its own.
    default_thresholds: Optional[ControlThresholds]
    scores: Optional[ControlScores]
    sources: List[GovernanceControlSource]

    _NESTED = {"thresholds": ControlThresholds, "default_thresholds": ControlThresholds, "scores": ControlScores}
    _NESTED_LISTS = {"sources": GovernanceControlSource}


@dataclass
class GovernanceEvidence(Model):
    id: str
    type: str
    title: str
    description: str
    url: Optional[str]
    controls: List[str]
    results: Optional[List[EvidenceResult]]
    run: Optional[EvidenceRun]
    #: How the release its run tested differs from the one the system runs
    #: now, in a sentence, or None.
    other_release: Optional[str]
    created_by_label: str
    created_at: str

    _NESTED = {"run": EvidenceRun}
    _NESTED_LISTS = {"results": EvidenceResult}


@dataclass
class GovernanceReadiness(Model):
    required: int
    done: int
    missing: List[str]
    #: Controls satisfied or waived, of those required. Never a legal claim.
    percent: int


@dataclass
class GovernanceBlocker(Model):
    kind: str
    message: str
    id: Optional[str]


@dataclass
class GovernanceGate(Model):
    allowed: bool
    reason: str
    missing_controls: List[str]
    blockers: List[GovernanceBlocker]

    _NESTED_LISTS = {"blockers": GovernanceBlocker}


@dataclass
class GovernanceGateScore(Model):
    control: str
    passed: bool
    reason: str
    evidence_id: Optional[str]


@dataclass
class GovernanceGateCheck(Model):
    """Whether governed work may proceed. ``allowed`` false names what stands in the way."""

    task_id: str
    allowed: bool
    reason: str
    missing_controls: List[str]
    blockers: List[GovernanceBlocker]
    #: Each required control with thresholds, and why its newest run passed or failed.
    scores: List[GovernanceGateScore]
    readiness: GovernanceReadiness

    _NESTED = {"readiness": GovernanceReadiness}
    _NESTED_LISTS = {"blockers": GovernanceBlocker, "scores": GovernanceGateScore}


@dataclass
class GovernanceFramework(Model):
    key: str
    name: str
    version: str
    applies: bool
    covered: int
    applicable: int


@dataclass
class Governance(Model):
    """A governed task's governance: profile, controls, evidence, readiness and gate."""

    task_id: str
    title: str
    url: str
    #: The profile as the API returns it, with its field names.
    profile: Dict[str, Any]
    controls: List[GovernanceControl]
    evidence: List[GovernanceEvidence]
    readiness: GovernanceReadiness
    gate: GovernanceGate
    frameworks: List[GovernanceFramework]
    #: That this records governance and certifies nothing.
    statement: str

    _NESTED = {"readiness": GovernanceReadiness, "gate": GovernanceGate}
    _NESTED_LISTS = {"controls": GovernanceControl, "evidence": GovernanceEvidence, "frameworks": GovernanceFramework}


# ── Comments ───────────────────────────────────────────────────────────────


@dataclass
class CommentMessage(Model):
    """One message in a thread.

    Named here because TypeScript writes it inline inside ``CommentThread``
    and Python has no anonymous structural types; the alternative is an
    untyped dict at the one place a caller reads somebody's words.
    """

    #: What :meth:`Comments.retract` takes.
    comment_id: str
    author: str
    author_type: str
    body: str
    created_at: str
    #: True for the one message this credential could still take back.
    retractable: bool


@dataclass
class CommentThread(Model):
    thread_id: str
    status: str
    quote: Optional[str]
    messages: List[CommentMessage]

    _NESTED_LISTS = {"messages": CommentMessage}


@dataclass
class OpenThread(Model):
    """One open thread, as the organisation-wide list returns it.

    Deliberately thinner than a :class:`CommentThread`: this answers "where is
    the feedback" across every report, so it carries the report and the quoted
    passage rather than the whole conversation.
    """

    thread_id: str
    report_id: str
    report_title: str
    report_slug: str
    #: Who owns the report — filter on it to find the threads on yours.
    report_owner_id: Optional[str]
    quote: Optional[str]
    author: str
    author_type: str
    messages: int
    last_activity_at: str


# ── Schedules ──────────────────────────────────────────────────────────────


@dataclass
class ScheduleSummary(Model):
    id: str
    report_id: str
    report_slug: str
    report_title: str
    report_url: str
    agent_id: str
    agent_name: str
    #: Five-field cron expression, evaluated in UTC.
    recurrence: str
    enabled: bool
    last_run_at: Optional[str]
    next_run_at: Optional[str]
    current_version: Optional[int]
    due: bool
    due_since: Optional[str]


# ── Evidence ───────────────────────────────────────────────────────────────

#: What a step in an evidence pack can be.
EVIDENCE_STEP_KINDS = ("approval", "review", "collection", "report")


@dataclass
class EvidenceOutcome(Model):
    who: str
    #: What they said, in the words the step uses: "approved", "answered".
    said: str
    note: Optional[str]
    at: str


@dataclass
class EvidenceStep(Model):
    kind: str
    id: str
    title: str
    status: str
    url: str
    created_at: str
    settled_at: Optional[str]
    requested_by: str
    #: Whether an agent asked for this, which is the point of the record.
    requested_by_agent: bool
    asked: List[str]
    outcomes: List[EvidenceOutcome]
    #: Whatever else the step records: the description, the questions, the answers.
    detail: Dict[str, Any]

    _NESTED_LISTS = {"outcomes": EvidenceOutcome}


@dataclass
class EvidenceEvent(Model):
    at: str
    event: str
    actor: str
    actor_type: str
    #: Which step it happened to, when it happened to one.
    step: Optional[str]
    metadata: Dict[str, Any]


@dataclass
class EvidencePack(Model):
    """The whole record of a flow: every step, and the timeline across all of it.

    The nested blocks stay dicts. They are read, printed and filed rather than
    branched on, and giving each of them a class would be four more shapes for
    the parity guard to hold in step for no caller's benefit — except
    ``integrity``, which is worth reading: it carries, in the pack's own words,
    what the digest does and does not stand for.
    """

    pack_version: int
    generated_at: str
    generated_by: str
    organisation: Dict[str, Any]
    subject: Dict[str, Any]
    summary: Dict[str, Any]
    steps: List[EvidenceStep]
    timeline: List[EvidenceEvent]
    integrity: Dict[str, Any]

    _NESTED_LISTS = {"steps": EvidenceStep, "timeline": EvidenceEvent}

# ── Gates ──────────────────────────────────────────────────────────────────

#: ``allowed`` | ``denied`` | ``pending`` | ``approved`` | ``rejected``
#: | ``expired`` | ``cancelled``
#:
#: Seven, and the four beyond allowed/denied/pending earn their width.
#: ``allowed`` and ``denied`` are what a *rule* said; the rest are what a
#: *person* did about a request no rule settled. An action that went through
#: because policy permitted it and one that went through because somebody
#: agreed to it are not the same fact, and the ratio between them is the number
#: this whole layer exists to make computable.
GATE_STATUSES = (
    "allowed",
    "denied",
    "pending",
    "approved",
    "rejected",
    "changes_requested",
    "expired",
    "cancelled",
    "revoked",
    "used",
)
#: What a person decided, once one has.
GATE_OUTCOMES = ("approved", "rejected", "changes_requested", "cancelled", "expired")
#: What policy said, fixed when the gate was made.
GATE_DECISIONS = ("ALLOW", "APPROVAL_REQUIRED", "REVIEW_REQUIRED", "DENY")


@dataclass
class ExecutionReceipt(Model):
    """What an agent reported doing with a gate's permission.

    ``verification`` is ``verified`` only when Deliverd carried the act out
    itself, ``hash_matched`` when it checked the artifact's hash, and
    ``reported`` otherwise — the agent's word, recorded as the agent's word.
    """

    id: str
    gate_id: str
    #: ``started`` | ``completed`` | ``failed``
    phase: str
    claim_id: Optional[str]
    executed_at: Optional[str]
    artifact_sha256: Optional[str]
    destination: Optional[Dict[str, Any]]
    result: Dict[str, Any]
    verification: str
    detail: Optional[str]
    reported_by: str
    created_at: str


@dataclass
class GateData(Model):
    id: str
    status: str
    #: The one to branch on: a rule permitted it, or a person agreed to it.
    allowed: bool
    #: What to execute with: the validated input, or the approver's
    #: correction of it when they approved with changes.
    input: Dict[str, Any]
    #: What the approver changed: ``{"field", "from", "to"}`` each.
    changes: List[Dict[str, Any]]
    #: What the organisation's ethics rules raised about this action:
    #: ``{"principle", "rule", "concern"}`` each. A concern turns a policy's
    #: allow into a person. Empty when nothing matched.
    concerns: List[Dict[str, Any]]
    #: Whether a rule decided this or a person did.
    basis: str
    reason: Optional[str]
    #: The rule that decided, by name. ``None`` when nothing matched.
    rule: Optional[str]
    policy_version_id: Optional[str]
    approval_id: Optional[str]
    approval_url: Optional[str]
    outcome: Optional[str]
    settled_at: Optional[str]
    #: True when this call found a decision already made under your external id.
    reused: bool
    #: What policy said: one of :data:`GATE_DECISIONS`.
    decision: str
    #: Whether you may act on it now: authorised, inside its window, with a use
    #: left, not revoked. The organisation's authorisation only — the platform
    #: your agent runs on may still require its user's confirmation.
    can_execute: bool
    #: Why not, when ``can_execute`` is false.
    blocked_because: Optional[str]
    #: What the permission covers: ``destination``, ``recipientScope``,
    #: ``classification``, ``risk``, ``artifact`` (with its ``sha256``), ``digest``.
    scope: Dict[str, Any]
    #: ``validUntil``, ``maxUses``, ``usesRemaining``.
    authorisation: Dict[str, Any]
    action_id: str
    agent_id: Optional[str]
    flow_id: Optional[str]
    supersedes_gate_id: Optional[str]
    description: Optional[str]
    requested_by: str
    created_at: Optional[str]
    #: Returned once, by the call that made the gate and named a callback URL.
    callback_secret: Optional[str]
    #: On a single read: what has been reported against it.
    executions: Optional[List[ExecutionReceipt]]

    _NESTED_LISTS = {"executions": ExecutionReceipt}


@dataclass
class GateDecision:
    """The answer to :meth:`Deliverd.gate`.

    Flat on purpose, for the same reason :class:`Decision` is: the line after
    the call is ``if decision.allowed:``. The whole decision is on
    :attr:`gate` when a field here does not cover it.
    """

    #: True when a rule permitted it **or** a person agreed to it.
    allowed: bool
    #: One of :data:`GATE_STATUSES`.
    status: str
    reason: Optional[str]
    rule: Optional[str]
    #: What to execute with. Not the object you passed — the validated one,
    #: with any corrections the approver made.
    input: Dict[str, Any]
    #: What the approver changed. Empty unless they did.
    changes: List[Dict[str, Any]]
    id: str
    approval_url: Optional[str]
    #: The handle, for anything the fields above do not carry.
    gate: Any


# ── Webhooks ───────────────────────────────────────────────────────────────

#: Every event Deliverd will post to an endpoint.
WEBHOOK_EVENTS = (
    "report.published",
    "report.updated",
    "report.shared",
    "report.viewed",
    "comment.created",
    "access.requested",
    "schedule.due",
    "publish.held",
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.changes_requested",
    "approval.expired",
    "approval.escalated",
    "approval.question",
    "approval.answered",
    "review.requested",
    "review.approved",
    "review.changes_requested",
    "collection.requested",
    "collection.completed",
    "flow.completed",
    # A gate refused. The only gate event that relays: an allow fires on every
    # auto-allowed action, and an escalation already arrives as an
    # approval-requested event.
    #
    # Comments in this tuple name events without quotes. The parity guard
    # scrapes quoted strings from here, so a quoted event name in a comment
    # adds a phantom entry to the very list it is checking.
    "gate.denied",
    # A gate's whole life. Sent only to an endpoint that names them.
    "gate.created",
    "gate.approved",
    "gate.rejected",
    "gate.changes_requested",
    "gate.expired",
    "gate.cancelled",
    "gate.revoked",
    "gate.executed",
    # An objective finished. The other two are opt-in: a task moved into
    # blocked, or a side task finished and its result waits for a choice.
    "task.completed",
    "task.blocked",
    "side_task.completed",
)


@dataclass
class WebhookEvent(Model):
    event: str
    sent_at: str
    data: Dict[str, Any]
    #: True when somebody pressed *Send test* rather than something happening.
    test: Optional[bool] = None


@dataclass
class CallbackEnvelope(Model):
    """What arrives at a request's ``callback_url``.

    ``data`` is the object an organisation webhook carries for the same event.
    ``approval.question`` means the approver asked something and waits on your
    answer; every other event is the request settling.
    """

    event: str
    sent_at: str
    request_type: str
    request_id: str
    data: Dict[str, Any]


@dataclass
class DecisionSession(Model):
    """A page on which one approver decides one request, inside your product.

    ``url`` and ``client_secret`` come back once, when the session is made.
    Neither decides anything: the approver signs in, or confirms a code sent
    to their own address, before they can.
    """

    id: str
    object: str
    approval_id: str
    #: ``{"type": "member" | "guest", "email": ...}``
    approver: Dict[str, Any]
    #: ``"hosted"`` or ``"embedded"``.
    mode: str
    #: The site allowed to frame an embedded session.
    origin: Optional[str]
    return_url: Optional[str]
    #: The page, with the secret in it. Only on the response that made it.
    url: Optional[str]
    #: What ``Deliverd.mountDecision`` takes. Only on the response that made it.
    client_secret: Optional[str]
    #: ``open``, ``verified``, ``complete`` or ``expired``.
    status: str
    #: The approver's decision, once they have made it, here or anywhere else.
    decision: Optional[str]
    #: The request's own status, which another approver may have settled.
    approval_status: str
    expires_at: str
    verified_at: Optional[str]
    completed_at: Optional[str]
    created_at: str


# ── Webhook endpoints ──────────────────────────────────────────────────────

#: How an endpoint's body is shaped: ``json`` (the signed envelope), ``slack``
#: (Block Kit) or ``teams`` (an Adaptive Card). Signed either way.
WEBHOOK_FORMATS = ("json", "slack", "teams")


@dataclass
class WebhookEndpoint(Model):
    """An organisation's webhook endpoint. Never its secret."""

    id: str
    url: str
    description: Optional[str]
    #: Empty means every event, including ones added later, except the opt-in ones.
    events: List[str]
    format: str
    enabled: bool
    #: Consecutive failed deliveries. At twenty the endpoint is switched off.
    failure_count: int
    last_success_at: Optional[str]
    last_failure_at: Optional[str]
    last_error: Optional[str]
    created_at: str


@dataclass
class CreatedWebhookEndpoint(Model):
    """What :meth:`WebhookEndpoints.create` returns: the endpoint and its secret.

    **The only time the secret is returned.** No other call carries it and it
    cannot be retrieved afterwards; keep it with whatever receives the events
    and pass it to :func:`construct_event`.
    """

    id: str
    url: str
    description: Optional[str]
    events: List[str]
    format: str
    enabled: bool
    failure_count: int
    last_success_at: Optional[str]
    last_failure_at: Optional[str]
    last_error: Optional[str]
    created_at: str
    #: ``dlvw_…``. Shown once.
    secret: str


@dataclass
class WebhookTestResult(Model):
    """What an endpoint said to a test send. ``delivered=False`` is an answer, not an error."""

    delivered: bool
    #: ``None`` when it could not be reached.
    response_status: Optional[int]
    error: Optional[str]
