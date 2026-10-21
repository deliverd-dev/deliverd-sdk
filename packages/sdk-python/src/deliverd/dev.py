"""Development mode: the whole loop, on your machine, with nobody in it.

::

    from deliverd import Deliverd

    deliverd = Deliverd(mode="development")
    decision = deliverd.approve(title="Deploy to production")

No key, no network, no colleague to interrupt — and the four things that can
happen to a real request all reachable before you have an account: approved,
rejected, nobody answered, and somebody asked you a question. That last one is
the path people forget to write, which is exactly why it should be one line to
try.

Implemented as a stand-in transport rather than a branch inside the client, so
development mode runs the *same* code as production — the same retries, the same
error mapping, the same polling in ``wait()``. A simulator that bypassed all
that would prove your integration works against the simulator.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import uuid
from typing import Any, Callable, Dict, List, Mapping, Optional, Union

from ._http import Reply, Transport
from .data_screen import assess_counts, describe_counts

#: What the imaginary approver does.
#: What development mode makes happen.
#:
#: Four for the primitives that ask a person, and a fifth for the gate:
#: ``denied`` is a **policy** refusal, which nothing else can have — an approval
#: cannot be refused without somebody refusing it. It is the outcome an agent
#: must handle by not retrying, and rehearsing that offline is worth a word of
#: its own. On the other primitives it is treated as ``rejected``.
OUTCOMES = ("approved", "rejected", "denied", "timeout", "question")

DEFAULT_QUESTION = "Has this been through staging?"

#: ``"approved"``, or a callable given the request and returning one.
Outcome = Union[str, Callable[[Dict[str, Any]], str]]


class DevelopmentOptions:
    """How the imaginary person behaves."""

    def __init__(
        self,
        outcome: Optional[Outcome] = None,
        delay: float = 0.0,
        note: Optional[str] = None,
        question: Optional[str] = None,
        log: bool = True,
        edits: Optional[Dict[str, Any]] = None,
    ) -> None:
        #: Default ``approved``, or the value of ``DELIVERD_DEV_OUTCOME``, so a
        #: whole test suite can be flipped from the command line without
        #: touching the code.
        self.outcome = outcome or os.environ.get("DELIVERD_DEV_OUTCOME") or "approved"
        #: How long they take to do it, in seconds.
        self.delay = delay
        #: What they say. Defaults suit the outcome.
        self.note = note
        #: What they ask, when the outcome is ``question``.
        self.question = question or DEFAULT_QUESTION
        #: Print what the approver would have seen.
        self.log = log
        #: Corrections the approver makes when approving a request that sent an
        #: ``input``. Only fields named in ``editable_fields`` are applied, as in
        #: production, so the approve-with-changes path runs offline.
        self.edits = dict(edits or {})



def _declared_agent(body: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The agent a request declared, echoed the way the API returns it.

    Every field present and ``None`` when unsaid, and ``None`` for the whole
    when nothing was said — the shape a real response has.
    """
    agent = body.get("agent")
    if not isinstance(agent, Mapping) or not any(agent.get(k) for k in ("name", "provider", "externalId")):
        return None
    return {"name": agent.get("name"), "provider": agent.get("provider"), "externalId": agent.get("externalId")}

def _now() -> float:
    return time.monotonic()


def _stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _dev_artifact(artifact: Any) -> Optional[Dict[str, Any]]:
    """The artifact a development gate is about, as far as it can be known offline."""
    if not isinstance(artifact, Mapping):
        return None
    sha = artifact.get("sha256")
    return {
        "kind": "report_version" if artifact.get("versionId") else "external",
        "reportId": artifact.get("reportId"),
        "versionId": artifact.get("versionId"),
        "versionNumber": None,
        "sha256": sha.lower() if isinstance(sha, str) else None,
        "name": artifact.get("name"),
        "mimeType": None,
        "size": None,
        "uri": None,
        "verified": False,
    }


def _say(line: str, options: DevelopmentOptions) -> None:
    if options.log:
        print(line, file=sys.stderr)


class _Store:
    """One request, and when the imaginary person acts on it."""

    def __init__(self, data: Dict[str, Any], decide_at: float, outcome: str) -> None:
        self.data = data
        self.decide_at = decide_at
        self.outcome = outcome
        self.announced = False


def development_transport(options: Optional[DevelopmentOptions] = None) -> Transport:
    """A transport that serves the ask APIs from memory.

    Deliberately narrow: it answers the calls the primitives make and 501s the
    rest, with a message saying so, rather than pretending to be the whole API
    and quietly returning something plausible.
    """
    opts = options or DevelopmentOptions()
    approvals: Dict[str, _Store] = {}
    reviews: Dict[str, _Store] = {}
    collections: Dict[str, _Store] = {}
    # Flows hold plain data rather than a `_Store`: there is no imaginary
    # person to settle, because a flow decides nothing. It groups.
    flows: Dict[str, Dict[str, Any]] = {}
    # Gates hold plain data plus the caller's id, for the reuse lookup that the
    # real endpoint enforces in the database.
    gates: Dict[str, Dict[str, Any]] = {}
    counter = {"n": 0}
    # Tasks hold plain data too, for the same reason as flows: nobody is
    # imagined, because nothing in the Task Graph waits on a person.
    tasks = _DevelopmentTasks(opts, counter)

    def resolve_outcome(data: Mapping[str, Any]) -> str:
        chosen = opts.outcome(dict(data)) if callable(opts.outcome) else opts.outcome
        if chosen not in OUTCOMES:
            raise ValueError(
                "Unknown development outcome {!r}. Use one of: {}.".format(
                    chosen, ", ".join(OUTCOMES)
                )
            )
        return chosen

    def reply(payload: Any, status: int = 200) -> Reply:
        return Reply(status, {"content-type": "application/json"}, json.dumps(payload))

    def not_implemented(method: str, path: str) -> Reply:
        return reply(
            {
                "error": {
                    "code": "development_only",
                    "message": (
                        "Development mode serves the ask primitives, flows, tasks and screening, not "
                        "{} {}. Use a real API key for that call, or mode=\"live\".".format(
                            method, path
                        )
                    ),
                }
            },
            501,
        )

    # ── approvals ──────────────────────────────────────────────────────────

    def settle_approval(store: _Store) -> None:
        if store.data["status"] != "pending" or _now() < store.decide_at:
            return
        if store.outcome == "timeout":
            store.data["status"] = "expired"
        elif store.outcome == "question":
            # A question does not settle it: the request stays pending and the
            # requester is now the one holding it up, which is the whole point
            # of being able to try this path.
            if not store.data["questions"]:
                store.data["questions"] = [
                    {
                        "id": "q_" + uuid.uuid4().hex[:8],
                        "question": opts.question,
                        "answer": None,
                        "askedAt": _stamp(),
                        "answeredAt": None,
                    }
                ]
            return
        else:
            store.data["status"] = store.outcome
            store.data["decidedBy"] = "Development approver"
            store.data["decidedById"] = "00000000-0000-0000-0000-00000000dev0"
            store.data["decidedAt"] = _stamp()
            store.data["approvalsSoFar"] = store.data["requiredApprovals"]
            store.data["note"] = opts.note or (
                "Looks fine." if store.outcome == "approved" else "Not this time."
            )
            proposed = store.data.get("input")
            if store.outcome == "approved" and proposed is not None:
                offered = store.data.get("editableFields") or []
                changed = {
                    field: value
                    for field, value in opts.edits.items()
                    if field in offered and proposed.get(field) != value
                }
                store.data["approvedInput"] = dict(proposed, **changed)
                store.data["changes"] = [
                    {"field": field, "from": proposed.get(field), "to": value}
                    for field, value in changed.items()
                ]
        announce_approval(store)

    def announce_approval(store: _Store) -> None:
        if store.announced:
            return
        store.announced = True
        _say(
            "[deliverd] development: {} — {}{}".format(
                store.data["title"],
                store.data["status"],
                " ({})".format(store.data["note"]) if store.data.get("note") else "",
            ),
            opts,
        )

    def create_approval(body: Mapping[str, Any]) -> Reply:
        approval_id = "apr_dev_" + uuid.uuid4().hex[:12]
        outcome = resolve_outcome(body)
        data: Dict[str, Any] = {
            "id": approval_id,
            "status": "pending",
            "url": "https://deliverd.dev/approve/{}".format(approval_id),
            "title": body.get("title") or "Untitled request",
            "description": body.get("description"),
            "risk": body.get("risk") or "medium",
            "factors": body.get("factors") or [],
            "links": body.get("links") or [],
            "reportId": body.get("reportId"),
            "externalId": body.get("externalId"),
            "metadata": body.get("metadata") or {},
            "input": body.get("input"),
            "editableFields": body.get("editableFields") or [],
            "approvedInput": None,
            "changes": [],
            "concerns": [],
            "requestedBy": "Development agent",
            "agent": _declared_agent(body),
            "model": body.get("model") or None,
            "approvers": body.get("approvers") or ["Development approver"],
            "requiredApprovals": 1,
            "approvalsSoFar": 0,
            "decidedBy": None,
            "decidedById": None,
            "decidedAt": None,
            "note": None,
            "expiresAt": body.get("expiresAt"),
            "questions": [],
            "createdAt": _stamp(),
        }
        approvals[approval_id] = _Store(data, _now() + opts.delay, outcome)
        _say("[deliverd] development: asked — {}".format(data["title"]), opts)
        return reply(data)

    # ── reviews ────────────────────────────────────────────────────────────

    def settle_review(store: _Store) -> None:
        if store.data["status"] != "pending" or _now() < store.decide_at:
            return
        if store.outcome == "timeout":
            store.data["status"] = "expired"
        else:
            verdict = "approved" if store.outcome == "approved" else "changes_requested"
            store.data["status"] = verdict
            store.data["verdicts"] = [
                {
                    "verdict": verdict,
                    "by": "Development reviewer",
                    "note": opts.note
                    or ("Reads well." if verdict == "approved" else "Two things to fix."),
                    "at": _stamp(),
                }
            ]
            store.data["threadCount"] = 0 if verdict == "approved" else 2
            store.data["settledAt"] = _stamp()
        if not store.announced:
            store.announced = True
            _say(
                "[deliverd] development: {} — {}".format(store.data["title"], store.data["status"]),
                opts,
            )

    def create_review(body: Mapping[str, Any]) -> Reply:
        review_id = "rev_dev_" + uuid.uuid4().hex[:12]
        data: Dict[str, Any] = {
            "id": review_id,
            "status": "pending",
            "url": "https://deliverd.dev/review/{}".format(review_id),
            "title": body.get("title") or "Untitled review",
            "instructions": body.get("instructions"),
            "reportId": body.get("reportId"),
            "versionId": body.get("versionId"),
            "externalId": body.get("externalId"),
            "metadata": body.get("metadata") or {},
            "requestedBy": "Development agent",
            "agent": _declared_agent(body),
            "model": body.get("model") or None,
            "requiredApprovals": body.get("requiredApprovals") or 1,
            "reviewers": [
                {"kind": "user", "id": "dev", "label": name}
                for name in (body.get("reviewers") or ["Development reviewer"])
            ],
            "verdicts": [],
            "threadCount": 0,
            "settledAt": None,
            "expiresAt": body.get("expiresAt"),
            "createdAt": _stamp(),
        }
        reviews[review_id] = _Store(data, _now() + opts.delay, resolve_outcome(body))
        _say("[deliverd] development: review asked — {}".format(data["title"]), opts)
        return reply(data)

    # ── collections ────────────────────────────────────────────────────────

    def sample_answer(question: Mapping[str, Any]) -> Any:
        kind = question.get("kind") or "text"
        if kind == "number":
            return 42
        if kind == "boolean":
            return True
        if kind == "date":
            return _stamp()[:10]
        if kind in ("choice", "multi_choice"):
            options = question.get("options") or ["Yes", "No"]
            return options[0] if kind == "choice" else [options[0]]
        if kind == "long_text":
            return "A development answer, long enough to look like a real one."
        return "A development answer"

    def settle_collection(store: _Store) -> None:
        if store.data["status"] != "pending" or _now() < store.decide_at:
            return
        if store.outcome == "timeout":
            store.data["status"] = "expired"
        else:
            store.data["responses"] = [
                {
                    "respondent": "Development respondent",
                    "status": "submitted",
                    "submittedAt": _stamp(),
                    "answers": [
                        {
                            "question": q["prompt"],
                            "kind": q.get("kind") or "text",
                            "value": sample_answer(q),
                        }
                        for q in store.data["questions"]
                    ],
                }
            ]
            store.data["status"] = "complete"
            store.data["submittedCount"] = 1
            store.data["settledAt"] = _stamp()
        if not store.announced:
            store.announced = True
            _say(
                "[deliverd] development: {} — {}".format(store.data["title"], store.data["status"]),
                opts,
            )

    def create_collection(body: Mapping[str, Any]) -> Reply:
        collection_id = "col_dev_" + uuid.uuid4().hex[:12]
        questions = [
            {
                "id": "q_" + uuid.uuid4().hex[:8],
                "prompt": q.get("prompt") or "Untitled question",
                "help": q.get("help"),
                "kind": q.get("kind") or "text",
                "required": q.get("required", True),
                "options": q.get("options") or [],
            }
            for q in (body.get("questions") or [])
        ]
        respondents = body.get("respondents") or ["Development respondent"]
        data: Dict[str, Any] = {
            "id": collection_id,
            "status": "pending",
            "url": "https://deliverd.dev/answer/{}".format(collection_id),
            "title": body.get("title") or "Untitled request",
            "instructions": body.get("instructions"),
            "reportId": body.get("reportId"),
            "externalId": body.get("externalId"),
            "metadata": body.get("metadata") or {},
            "requestedBy": "Development agent",
            "agent": _declared_agent(body),
            "model": body.get("model") or None,
            "requiredResponses": body.get("requiredResponses") or len(respondents),
            "questions": questions,
            "responses": [],
            "submittedCount": 0,
            "askedCount": len(respondents),
            "settledAt": None,
            "dueAt": body.get("dueAt"),
            "expiresAt": body.get("expiresAt"),
            "createdAt": _stamp(),
        }
        collections[collection_id] = _Store(data, _now() + opts.delay, resolve_outcome(body))
        _say("[deliverd] development: asked for {} facts".format(len(questions)), opts)
        return reply(data)

    # ── flows ──────────────────────────────────────────────────────────────

    def create_flow(body: Mapping[str, Any]) -> Reply:
        """A flow in development, so `flow.approve()` runs offline too.

        Nothing is simulated here because nothing is decided: a flow groups
        and that is all it does. Members are not tracked — the server derives
        them from rows this store does not keep — so a development flow
        reports what it knows rather than inventing a membership.
        """
        counter["n"] += 1
        flow_id = "flw_dev_{}".format(counter["n"])
        data: Dict[str, Any] = {
            "id": flow_id,
            "status": "open",
            "url": "https://deliverd.dev/flows/{}".format(flow_id),
            "title": body.get("title") or "Untitled",
            "description": body.get("description"),
            "externalId": body.get("externalId"),
            "metadata": body.get("metadata") or {},
            "startedBy": "You (development mode)",
            "members": [],
            "memberCount": 0,
            "openCount": 0,
            "allSettled": False,
            "timeline": [],
            "settledAt": None,
            "createdAt": _stamp(),
        }
        flows[flow_id] = data
        _say("[deliverd] development: flow started — {}".format(data["title"]), opts)
        return reply(data, 201)

    def evidence_pack(kind: str, subject_id: str) -> Reply:
        """The shape and not the substance.

        This store holds no audit rows, so the pack comes back with its
        subject and an empty record rather than an invented one — what it
        proves is that `flow.evidence()` reaches the right path and returns
        something a caller can read. An imaginary approval trail would be
        worse than none, which is why the integrity block says so in words
        that survive being pasted into an email.
        """
        now = _stamp()
        title = flows.get(subject_id, {}).get("title", "A flow") if kind == "flow" else "A report"
        return reply(
            {
                "packVersion": 2,
                "generatedAt": now,
                "generatedBy": "You (development mode)",
                "organisation": {"id": "org_dev", "name": "Development"},
                "subject": {
                    "kind": kind,
                    "id": subject_id,
                    "title": title,
                    "url": "https://deliverd.dev/{}s/{}".format(kind, subject_id),
                    "status": "open",
                    "startedBy": "You (development mode)",
                    "startedAt": now,
                },
                "summary": {"steps": 0, "events": 0, "firstEventAt": None, "lastEventAt": None},
                "steps": [],
                "timeline": [],
                "integrity": {
                    "algorithm": "sha256",
                    "digest": "development",
                    "covers": (
                        "Nothing: this pack was produced in development mode and holds "
                        "no records."
                    ),
                    "doesNotCover": "Everything. Do not hand this to anybody.",
                    "recordsAreInsertOnly": True,
                },
            }
        )

    # ── the transport itself ───────────────────────────────────────────────

    def listing(
        store: Dict[str, _Store], key: str, settle: Callable[[_Store], None], query: Mapping[str, List[str]]
    ) -> Reply:
        rows = []
        for entry in store.values():
            settle(entry)
            wanted = query.get("externalId")
            if wanted and entry.data.get("externalId") != wanted[0]:
                continue
            # One person's inbox: the requests that name them.
            who = query.get("approver") if key == "approvals" else None
            if who and who[0].lower() not in [str(a).lower() for a in entry.data.get("approvers") or []]:
                continue
            rows.append(entry.data)
        return reply({key: rows, "nextCursor": None})

    # ── gates ──────────────────────────────────────────────────────────────

    def settle_gate(gate: Dict[str, Any], outcome: str, decide_at: float) -> None:
        """Move a gate that went to a person once that person has answered.

        Only the outcomes that involve one. ``denied`` was settled by a rule at
        creation and has nothing to wait for — which is the honest shape,
        because in production most gated calls never reach a human either.
        """
        if gate["status"] != "pending":
            return
        if time.time() < decide_at:
            return
        if outcome in ("timeout", "question", "denied"):
            return
        approved = outcome == "approved"
        gate["status"] = "approved" if approved else "rejected"
        gate["allowed"] = approved
        gate["canExecute"] = approved
        gate["blockedBecause"] = None if approved else "A person rejected this action."
        gate["outcome"] = "approved" if approved else "rejected"
        gate["settledAt"] = _stamp()
        gate["basis"] = "human"
        gate["reason"] = (
            "A development approver agreed to it."
            if approved
            else "A development approver refused it."
        )

    def create_gate(body: Mapping[str, Any]) -> Reply:
        external_id = str(body.get("externalId") or "")
        # Server-side reuse, which the real endpoint enforces in the database.
        # Offline it is a dict scan, and it is here rather than left out because
        # the one thing a gate promises over an approval is that a retry
        # re-reads its decision — testing that without an account is the whole
        # point of this module.
        for stored in gates.values():
            if stored["externalId"] == external_id:
                settle_gate(stored["gate"], stored["outcome"], stored["decideAt"])
                return reply(dict(stored["gate"], reused=True))

        gate_id = "gat_dev_" + uuid.uuid4().hex[:12]
        outcome = resolve_outcome(body)
        # `denied` is settled by a rule and reaches nobody; everything else goes
        # through a person, which is where `wait()` earns its place.
        by_rule = outcome == "denied"
        gate: Dict[str, Any] = {
            "id": gate_id,
            "status": "denied" if by_rule else "pending",
            "allowed": False,
            "input": body.get("input") or {},
            "changes": [],
            "concerns": [],
            "basis": "policy" if by_rule else "human",
            "reason": (
                "Development mode refused it. A real rule would say which one and why."
                if by_rule
                else "No rule covers this action yet, so it needs a person."
            ),
            "rule": "Development mode" if by_rule else None,
            "policyVersionId": None,
            "approvalId": None if by_rule else "apr_dev_" + gate_id,
            "approvalUrl": (
                None if by_rule else "https://deliverd.dev/approve/apr_dev_" + gate_id
            ),
            "outcome": None,
            "settledAt": None,
            "reused": False,
            "decision": "DENY" if by_rule else "APPROVAL_REQUIRED",
            "canExecute": False,
            "blockedBecause": (
                "Policy does not allow this action."
                if by_rule
                else "Waiting for a person to decide."
            ),
            "scope": {
                "destination": body.get("destination"),
                # Offline there is no directory to consult, so nothing is known to be internal.
                "recipientScope": "external" if body.get("destination") else None,
                "classification": body.get("classification"),
                "risk": body.get("risk"),
                "artifact": _dev_artifact(body.get("artifact")),
                "digest": None,
            },
            "authorisation": {"validUntil": None, "maxUses": 1, "usesRemaining": 1},
            "actionId": str(body.get("actionId") or ""),
            "agentId": None,
            "flowId": body.get("flowId"),
            "supersedesGateId": body.get("supersedesGateId"),
            "description": body.get("description") or body.get("reason"),
            "requestedBy": "Development agent",
            "createdAt": _stamp(),
        }
        gates[gate_id] = {
            "gate": gate,
            "externalId": external_id,
            "outcome": outcome,
            "decideAt": time.time() + (opts.delay or 0.0),
        }
        return reply(gate, 201)


    def gate_action(gate_id: str, action: str, body: Mapping[str, Any]) -> Reply:
        """What was done with a permission, offline.

        One use, spent by the first claim, and a hash that has to match the one
        asked about — the two refusals worth rehearsing before there is an
        account to be refused by.
        """
        stored = gates.get(gate_id)
        if stored is None:
            return reply(
                {"error": {"code": "not_found", "message": "No such gate in this development session."}},
                404,
            )
        settle_gate(stored["gate"], stored["outcome"], stored["decideAt"])
        gate = stored["gate"]
        if action == "cancel":
            gate["status"] = "cancelled"
            gate["canExecute"] = False
            gate["blockedBecause"] = "This request was withdrawn."
            return reply(gate)
        if not gate["canExecute"]:
            code = "gate_used" if gate["status"] == "used" else "not_authorised"
            return reply(
                {"error": {"code": code, "message": gate["blockedBecause"] or "Not authorised."}},
                409 if code == "gate_used" else 403,
            )
        sha = body.get("artifactSha256")
        sha = sha.lower() if isinstance(sha, str) else None
        wanted = (gate["scope"].get("artifact") or {}).get("sha256")
        if wanted and sha != wanted:
            return reply(
                {
                    "error": {
                        "code": "approval_invalidated" if sha else "artifact_missing",
                        "message": "The artifact is not the one that was approved.",
                    }
                },
                409 if sha else 400,
            )
        gate["status"] = "used"
        gate["canExecute"] = False
        gate["blockedBecause"] = "This permission has been used. A further action needs a new request."
        gate["authorisation"] = dict(gate["authorisation"], usesRemaining=0)
        receipt = {
            "id": "exe_dev_" + uuid.uuid4().hex[:12],
            "gateId": gate["id"],
            "phase": body.get("phase") or "completed",
            "claimId": None,
            "executedAt": _stamp(),
            "artifactSha256": sha,
            "destination": body.get("destination"),
            "result": body.get("result") or {},
            "verification": "hash_matched" if wanted else "reported",
            "detail": body.get("detail"),
            "reportedBy": "Development agent",
            "createdAt": _stamp(),
        }
        return reply({"receipt": receipt, "gate": gate}, 201)

    def transport(
        url: str,
        method: str,
        body: Optional[bytes],
        headers: Mapping[str, str],
        timeout: float,
    ) -> Reply:
        parsed = urllib.parse.urlparse(url)
        path = parsed.path.split("/api/v1", 1)[-1] or "/"
        query = urllib.parse.parse_qs(parsed.query)
        payload: Dict[str, Any] = json.loads(body.decode("utf-8")) if body else {}
        parts = [p for p in path.split("/") if p]

        if method == "POST" and path == "/approvals":
            return create_approval(payload)
        if method == "POST" and path == "/gates":
            return create_gate(payload)
        # Screening with no organisation behind it: no register record and no
        # policy, so the defaults decide, and an `ask` files an ordinary
        # development approval that the imaginary approver decides.
        if method == "POST" and path == "/screen":
            counts = payload.get("counts") or {}
            term_classification = "restricted" if payload.get("termClassification") == "restricted" else "confidential"
            assessment = assess_counts(counts, None, None, term_classification)
            approval = None
            if assessment.verdict == "ask" and payload.get("ask") is not False:
                created = json.loads(
                    create_approval(
                        {
                            "title": "Send {} to an AI model?".format(describe_counts(counts)),
                            "description": "\n".join(assessment.reasons),
                            "risk": "high" if assessment.classification == "restricted" else "medium",
                            "externalId": payload.get("externalId"),
                        }
                    ).body
                )
                approval = {"id": created["id"], "url": created["url"], "status": created["status"]}
            return reply(
                {
                    "verdict": assessment.verdict,
                    "allowed": assessment.verdict in ("allow", "redact"),
                    "classification": assessment.classification,
                    "personalData": assessment.personal_data,
                    "categories": assessment.categories,
                    "counts": counts,
                    "offending": assessment.offending,
                    "reasons": assessment.reasons,
                    "target": None,
                    "findings": None,
                    "redactedText": None,
                    "approval": approval,
                }
            )
        if method == "POST" and len(parts) == 3 and parts[0] == "gates" and parts[2] in ("execution", "cancel"):
            return gate_action(parts[1], parts[2], payload)
        if method == "GET" and len(parts) == 2 and parts[0] == "gates":
            stored = gates.get(parts[1])
            if stored is None:
                return reply(
                    {
                        "error": {
                            "code": "not_found",
                            "message": "No such gate in this development session.",
                        }
                    },
                    404,
                )
            settle_gate(stored["gate"], stored["outcome"], stored["decideAt"])
            return reply(stored["gate"])
        if method == "POST" and path == "/reviews":
            return create_review(payload)
        if method == "POST" and path == "/collections":
            return create_collection(payload)
        if method == "GET" and path == "/approvals":
            return listing(approvals, "approvals", settle_approval, query)
        if method == "GET" and path == "/reviews":
            return listing(reviews, "reviews", settle_review, query)
        if method == "GET" and path == "/collections":
            return listing(collections, "collections", settle_collection, query)

        if method == "POST" and path == "/flows":
            return create_flow(payload)
        if method == "GET" and path == "/flows":
            wanted = query.get("externalId")
            rows = [f for f in flows.values() if not wanted or f.get("externalId") == wanted[0]]
            return reply({"flows": rows, "nextCursor": None})
        if method == "GET" and len(parts) == 3 and parts[2] == "evidence" and parts[0] in (
            "flows",
            "reports",
        ):
            return evidence_pack("flow" if parts[0] == "flows" else "report", parts[1])
        if parts and parts[0] == "flows" and len(parts) >= 2:
            flow = flows.get(parts[1])
            if flow is None:
                return reply(
                    {
                        "error": {
                            "code": "not_found",
                            "message": "No such flow in this development session.",
                        }
                    },
                    404,
                )
            action = parts[2] if len(parts) > 2 else None
            if method == "POST" and action in ("complete", "cancel"):
                if flow["status"] != "open":
                    return reply(
                        {
                            "error": {
                                "code": "not_open",
                                "message": "This flow is already {}.".format(flow["status"]),
                            }
                        },
                        409,
                    )
                flow["status"] = "complete" if action == "complete" else "cancelled"
                flow["settledAt"] = _stamp()
            if method == "GET" and action is None:
                return reply(flow)
            if method == "POST" and action in ("complete", "cancel"):
                return reply(flow)

        if method == "POST" and path == "/tasks":
            task, resumed = tasks.create(payload)
            return reply(dict(task, resumed=resumed), 200 if resumed else 201)
        if method == "GET" and path == "/tasks":
            return reply({"tasks": tasks.list(query), "nextCursor": None})
        task_actions = (
            "context", "graph", "side-tasks", "findings", "complete", "apply", "reopen", "cancel", "links",
        )
        if parts and parts[0] == "tasks" and (
            len(parts) == 2 or (len(parts) == 3 and parts[2] in task_actions)
        ):
            status, answer = tasks.act(method, parts[1], parts[2] if len(parts) == 3 else None, payload)
            return reply(answer, status)

        # Publishing is deliberately *not* served here, and the TypeScript SDK
        # made the same call first with the better argument: publishing puts
        # bytes somewhere and there is nowhere local to put them, so an
        # example that appears to publish and then has not is worse than a
        # refusal a caller can read. This branch used to return a plausible
        # report with a URL that resolves to nothing — the one shape in this
        # transport that could be mistaken for the real thing and pasted to
        # somebody.

        families = {
            "approvals": (approvals, settle_approval),
            "reviews": (reviews, settle_review),
            "collections": (collections, settle_collection),
        }
        if len(parts) >= 2 and parts[0] in families:
            store, settle = families[parts[0]]
            entry = store.get(parts[1])
            if entry is None:
                return reply(
                    {"error": {"code": "not_found", "message": "No such request in development."}},
                    404,
                )
            action = parts[2] if len(parts) > 2 else None
            if method == "GET" and action is None:
                settle(entry)
                return reply(entry.data)
            if method == "POST" and action == "cancel":
                entry.data["status"] = "cancelled"
                return reply(entry.data)
            if method == "POST" and action == "answers":
                for question in entry.data.get("questions", []):
                    if question["id"] == payload.get("questionId"):
                        question["answer"] = payload.get("answer")
                        question["answeredAt"] = _stamp()
                # The question is answered, so the imaginary approver gets on
                # with it — approving, which is what makes the `question`
                # outcome a loop a caller can actually finish rather than a
                # dead end that always times out.
                entry.outcome = "approved"
                entry.decide_at = _now() + opts.delay
                settle(entry)
                return reply(entry.data)

        return not_implemented(method, path)

    return transport


# ── tasks ──────────────────────────────────────────────────────────────────

def _strings(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, str) and v.strip()]


def _merge_state(current: Dict[str, Any], patch: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """The server's state rules: a list sent replaces; add/resolve change it item by item."""
    if not patch:
        return current
    nxt = dict(current)
    if "currentState" in patch:
        nxt["currentState"] = patch.get("currentState")
    if "nextAction" in patch:
        nxt["nextAction"] = patch.get("nextAction")
    for key in ("openQuestions", "constraints", "blockedBy"):
        if patch.get(key):
            nxt[key] = _strings(patch.get(key))
    for question in _strings(patch.get("addOpenQuestions")):
        if question not in nxt["openQuestions"]:
            nxt["openQuestions"] = nxt["openQuestions"] + [question]
    gone = {q.lower() for q in _strings(patch.get("resolveOpenQuestions"))}
    if gone:
        nxt["openQuestions"] = [q for q in nxt["openQuestions"] if q.lower() not in gone]
    return nxt


class _DevelopmentTasks:
    """The Task Graph, in memory.

    Enough of the server's rules that the loop an agent actually runs —
    objective, side task, result, apply, context — does offline what it does
    live, the same as the TypeScript SDK's. Not the whole service: no
    workspaces, no permissions, no audit, and a context assembled from what this
    store holds. Putting a decision to an approval is left to the real API.
    """

    def __init__(self, opts: DevelopmentOptions, counter: Dict[str, int]) -> None:
        self.opts = opts
        self.counter = counter
        self.store: Dict[str, Dict[str, Any]] = {}
        self.findings: Dict[str, List[Dict[str, Any]]] = {}
        self.links: List[Dict[str, Any]] = []

    # ── helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _active(t: Mapping[str, Any]) -> bool:
        return t["status"] not in ("completed", "cancelled")

    @staticmethod
    def _error(code: str, message: str, status: int = 409) -> "tuple[int, Any]":
        return status, {"error": {"code": code, "message": message}}

    def _next_id(self, prefix: str) -> str:
        self.counter["n"] += 1
        return "{}_dev_{}".format(prefix, self.counter["n"])

    @staticmethod
    def _listed(t: Mapping[str, Any]) -> Dict[str, Any]:
        extra = ("sideTasks", "path", "children", "findings", "links", "resumed")
        return {k: v for k, v in t.items() if k not in extra}

    def _children(self, task_id: str) -> List[Dict[str, Any]]:
        return [t for t in self.store.values() if t["parentTaskId"] == task_id]

    @staticmethod
    def _node(t: Mapping[str, Any]) -> Dict[str, Any]:
        return {
            "id": t["id"],
            "parentTaskId": t["parentTaskId"],
            "kind": t["kind"],
            "depth": t["depth"],
            "status": t["status"],
            "title": t["title"],
            "outcome": t["outcome"],
            "resultSummary": (t["result"] or {}).get("summary"),
            "url": t["url"],
        }

    def _path_to(self, t: Mapping[str, Any]) -> List[Dict[str, Any]]:
        path: List[Dict[str, Any]] = []
        at: Optional[Mapping[str, Any]] = t
        while at is not None:
            path.insert(0, {"id": at["id"], "title": at["title"], "kind": at["kind"]})
            at = self.store.get(at["parentTaskId"]) if at["parentTaskId"] else None
        return path

    @staticmethod
    def _bump(t: Dict[str, Any]) -> None:
        t["version"] += 1
        t["updatedAt"] = _stamp()

    def _make(self, body: Mapping[str, Any], parent: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        task_id = self._next_id("tsk")
        now = _stamp()
        snapshot = None
        if parent is not None:
            decisions = [
                f
                for f in self.findings.get(parent["id"], [])
                if f["kind"] == "decision" and f["decisionStatus"] != "rejected"
            ]
            root = self.store.get(parent["rootTaskId"], parent)
            current = parent["state"]["currentState"]
            snapshot = {
                "rootObjective": root["objective"],
                "parentObjective": parent["objective"],
                "sideTaskGoal": body.get("goal") or "",
                "relevantContext": (
                    _strings(body.get("relevantContext"))
                    if "relevantContext" in body
                    else ([current] if current else [])
                ),
                "knownConstraints": (
                    _strings(body.get("knownConstraints"))
                    if "knownConstraints" in body
                    else list(parent["state"]["constraints"])
                ),
                "relatedDecisions": [
                    d["title"] if d["decisionStatus"] == "confirmed" else "{} (suggested)".format(d["title"])
                    for d in decisions
                ],
                "resolvesQuestion": body.get("resolvesQuestion"),
            }
        empty = {
            "currentState": None,
            "openQuestions": [],
            "constraints": [],
            "blockedBy": [],
            "nextAction": None,
        }
        return {
            "id": task_id,
            "kind": (body.get("kind") or "side_task") if parent is not None else "objective",
            "status": "open",
            "url": "https://deliverd.dev/tasks/{}".format(task_id),
            "title": body.get("title") or "Untitled",
            "objective": (body.get("goal") if parent is not None else body.get("objective")) or "",
            "rootTaskId": parent["rootTaskId"] if parent is not None else task_id,
            "parentTaskId": parent["id"] if parent is not None else None,
            "depth": parent["depth"] + 1 if parent is not None else 0,
            "workspaceId": parent["workspaceId"] if parent is not None else body.get("workspaceId"),
            "flowId": parent["flowId"] if parent is not None else body.get("flowId"),
            "state": _merge_state(empty, body.get("state")),
            "snapshot": snapshot,
            "result": None,
            "previousResults": [],
            "outcome": None,
            "origin": body.get("origin") or "manual",
            "externalId": None if parent is not None else body.get("externalId"),
            "sessionUrl": body.get("sessionUrl"),
            "version": 1,
            "startedBy": "You (development mode)",
            "createdAt": now,
            "updatedAt": now,
            "completedAt": None,
        }

    def _add_finding(
        self, t: Mapping[str, Any], body: Mapping[str, Any], source_task_id: Optional[str] = None
    ) -> Dict[str, Any]:
        kind = body.get("kind") or "finding"
        finding = {
            "id": self._next_id("fnd"),
            "taskId": t["id"],
            "kind": kind,
            "title": body.get("title") or "Untitled",
            "body": body.get("body") or "",
            "evidence": _strings(body.get("evidence")),
            "decisionStatus": "suggested" if kind == "decision" else None,
            "decidedBy": None,
            "decidedAt": None,
            "approvalId": None,
            "approvalStatus": None,
            "sourceTaskId": source_task_id,
            "createdBy": "You (development mode)",
            "createdAt": _stamp(),
        }
        self.findings[t["id"]] = [finding] + self.findings.get(t["id"], [])
        return finding

    def _context(self, t: Mapping[str, Any]) -> Dict[str, Any]:
        root = self.store.get(t["rootTaskId"], t)
        is_side = t["kind"] != "objective"
        own = self.findings.get(t["id"], [])
        inherited = [] if t["id"] == root["id"] else self.findings.get(root["id"], [])
        decisions = [f for f in inherited + own if f["kind"] == "decision"]
        children = self._children(t["id"])
        finished = [c for c in children if c["status"] == "completed"]
        awaiting = [c for c in finished if c["outcome"] is None]
        state = t["state"]
        nxt = state["nextAction"] or (None if is_side else root["state"]["nextAction"])
        reanchor = [
            "Objective: {}".format(root["objective"]),
            "You are in a side task: {}. Its goal: {}".format(t["title"], t["objective"]) if is_side else None,
            "Where it stands: {}".format(state["currentState"]) if state["currentState"] else None,
            "Next: {}".format(nxt) if nxt else None,
        ]
        summary = lambda c: (c["result"] or {}).get("summary")  # noqa: E731
        return {
            "rootObjective": root["objective"],
            "task": {
                "id": t["id"],
                "kind": t["kind"],
                "title": t["title"],
                "objective": t["objective"],
                "status": t["status"],
                "isSideTask": is_side,
            },
            "path": self._path_to(t),
            "currentState": state["currentState"],
            "nextAction": nxt,
            "openQuestions": state["openQuestions"],
            "constraints": state["constraints"]
            or ((t["snapshot"] or {}).get("knownConstraints") or []),
            "blockedBy": state["blockedBy"],
            "decisions": {
                "confirmed": [d["title"] for d in decisions if d["decisionStatus"] == "confirmed"],
                "suggested": [d["title"] for d in decisions if d["decisionStatus"] == "suggested"],
            },
            "snapshot": t["snapshot"],
            "relevantFindings": [
                {"kind": f["kind"], "title": f["title"], "body": f["body"]}
                for f in own
                if f["kind"] != "decision"
            ][:12],
            "sideTasks": {
                "active": [
                    {"id": c["id"], "title": c["title"], "kind": c["kind"], "status": c["status"]}
                    for c in children
                    if self._active(c)
                ],
                "awaitingOutcome": [
                    {"id": c["id"], "title": c["title"], "summary": summary(c)} for c in awaiting
                ],
                "completed": [
                    {"id": c["id"], "title": c["title"], "summary": summary(c), "outcome": c["outcome"]}
                    for c in finished
                    if c["outcome"] is not None
                ],
            },
            # Development mode publishes nothing, so no task has a report to name.
            "reports": [],
            "reanchor": "\n".join(line for line in reanchor if line),
        }

    # ── the routes ─────────────────────────────────────────────────────────

    def create(self, body: Mapping[str, Any]) -> "tuple[Dict[str, Any], bool]":
        external_id = body.get("externalId")
        if external_id:
            for t in self.store.values():
                if t["kind"] == "objective" and t["externalId"] == external_id and self._active(t):
                    return self._listed(t), True
        task = self._make(body, None)
        self.store[task["id"]] = task
        _say("[deliverd] development: objective — {}".format(task["title"]), self.opts)
        return self._listed(task), False

    def list(self, query: Mapping[str, List[str]]) -> List[Dict[str, Any]]:
        status = (query.get("status") or [None])[0]
        external_id = (query.get("externalId") or [None])[0]
        q = ((query.get("q") or [""])[0] or "").lower()
        rows = []
        for t in self.store.values():
            if t["kind"] != "objective":
                continue
            if status and (not self._active(t) if status == "active" else t["status"] != status):
                continue
            if external_id and t["externalId"] != external_id:
                continue
            if q and q not in "{} {}".format(t["title"], t["objective"]).lower():
                continue
            below = [s for s in self.store.values() if s["rootTaskId"] == t["id"] and s["id"] != t["id"]]
            row = self._listed(t)
            row["sideTasks"] = {
                "open": len([s for s in below if self._active(s)]),
                "done": len([s for s in below if s["status"] == "completed" and s["outcome"] is not None]),
                "awaiting": len([s for s in below if s["status"] == "completed" and s["outcome"] is None]),
            }
            rows.append(row)
        return rows

    def act(self, method: str, task_id: str, action: Optional[str], body: Mapping[str, Any]) -> "tuple[int, Any]":
        t = self.store.get(task_id)
        if t is None:
            return self._error("not_found", "No such task in this development session.", 404)

        if method == "GET" and action is None:
            row = self._listed(t)
            row["path"] = self._path_to(t)
            row["children"] = [self._node(c) for c in self._children(t["id"])]
            row["findings"] = self.findings.get(t["id"], [])
            row["links"] = [
                l for l in self.links if t["id"] in (l["sourceTaskId"], l["targetTaskId"])
            ]
            return 200, row
        if method == "GET" and action == "context":
            return 200, self._context(t)
        if method == "GET" and action == "graph":
            root = self.store.get(t["rootTaskId"], t)
            tree = [n for n in self.store.values() if n["rootTaskId"] == root["id"]]
            ids = {n["id"] for n in tree}
            return 200, {
                "root": self._listed(root),
                "nodes": [self._node(n) for n in tree],
                "links": [l for l in self.links if l["sourceTaskId"] in ids or l["targetTaskId"] in ids],
            }

        if method == "PATCH" and action is None:
            expected = body.get("expectedVersion")
            if isinstance(expected, int) and expected != t["version"]:
                return self._error(
                    "version_conflict", "The task changed since you read it. Read it again and retry."
                )
            for key in ("title", "objective", "status"):
                if isinstance(body.get(key), str):
                    t[key] = body[key]
            if "sessionUrl" in body:
                t["sessionUrl"] = body.get("sessionUrl")
            t["state"] = _merge_state(t["state"], body.get("state"))
            self._bump(t)
            return 200, self._listed(t)

        if method != "POST":
            return self._error("development_only", "{} is not simulated.".format(method), 501)

        if action == "side-tasks":
            if not self._active(t):
                return self._error("not_open", "The task this belongs to is finished. Reopen it first.")
            if t["depth"] >= 3:
                return self._error(
                    "invalid",
                    "Side tasks nest at most three deep. Branch from a task higher up instead.",
                    400,
                )
            side = self._make(body, t)
            self.store[side["id"]] = side
            _say("[deliverd] development: side task — {}".format(side["title"]), self.opts)
            return 201, self._listed(side)
        if action == "findings":
            return 201, self._add_finding(t, body)
        if action == "complete":
            if not self._active(t):
                return self._error("not_open", "This task is already complete or cancelled.")
            result = {
                "summary": body.get("summary") or "",
                "findings": body.get("findings") or [],
                "decisions": body.get("decisions") or [],
                "recommendations": _strings(body.get("recommendations")),
                "unresolvedQuestions": _strings(body.get("unresolvedQuestions")),
                "parentImpact": body.get("parentImpact"),
                "suggestedNextAction": body.get("suggestedNextAction"),
            }
            t["result"] = result
            for f in result["findings"]:
                self._add_finding(
                    t,
                    {"kind": "finding", "title": f.get("title"), "body": f.get("description"),
                     "evidence": f.get("evidence")},
                )
            for d in result["decisions"]:
                self._add_finding(t, {"kind": "decision", "title": d.get("title"), "body": d.get("rationale")})
            t["status"] = "completed"
            t["completedAt"] = _stamp()
            self._bump(t)
            return 200, self._listed(t)
        if action == "apply":
            parent = self.store.get(t["parentTaskId"]) if t["parentTaskId"] else None
            if parent is None:
                return self._error("invalid", "An objective has no parent to apply to.", 400)
            if t["status"] != "completed" or not t["result"]:
                return self._error(
                    "not_completed",
                    "This side task has not been completed yet, so there is no result to use.",
                )
            if t["outcome"] is not None:
                return self._error(
                    "already_applied",
                    "This result has already been applied to the main task. Reopen the side task to change it.",
                )
            outcome = body.get("outcome") or "applied"
            t["outcome"] = outcome
            self._bump(t)
            if outcome == "applied":
                for f in self.findings.get(t["id"], []):
                    self._add_finding(
                        parent,
                        {"kind": f["kind"], "title": f["title"], "body": f["body"], "evidence": f["evidence"]},
                        t["id"],
                    )
                patch: Dict[str, Any] = {"addOpenQuestions": t["result"]["unresolvedQuestions"]}
                resolves = (t["snapshot"] or {}).get("resolvesQuestion")
                if resolves:
                    patch["resolveOpenQuestions"] = [resolves]
                if t["result"]["suggestedNextAction"]:
                    patch["nextAction"] = t["result"]["suggestedNextAction"]
                parent["state"] = _merge_state(parent["state"], patch)
                self._bump(parent)
            if outcome == "applied":
                message = 'The result of "{}" is now part of "{}".'.format(t["title"], parent["title"])
            elif outcome == "kept":
                message = '"{}" is kept for reference; nothing in "{}" changed.'.format(t["title"], parent["title"])
            else:
                message = '"{}" was discarded; nothing in "{}" changed.'.format(t["title"], parent["title"])
            return 200, {
                "sideTask": self._listed(t),
                "parent": self._listed(parent),
                "message": message,
                "context": self._context(parent),
            }
        if action == "reopen":
            if self._active(t):
                return self._error("not_open", "Only a completed or cancelled task can be reopened.")
            if t["result"]:
                t["previousResults"] = [t["result"]] + t["previousResults"]
            t["result"] = None
            t["outcome"] = None
            t["status"] = "open"
            t["completedAt"] = None
            self._bump(t)
            return 200, self._listed(t)
        if action == "cancel":
            if not self._active(t):
                return self._error("not_open", "This task is already complete or cancelled.")
            t["status"] = "cancelled"
            t["completedAt"] = _stamp()
            self._bump(t)
            return 200, self._listed(t)
        if action == "links":
            target = body.get("targetTaskId") or ""
            if target == t["id"]:
                return self._error("invalid", "A task cannot be linked to itself.", 400)
            if target not in self.store:
                return self._error("not_found", "No such task in this development session.", 404)
            kind = body.get("kind")
            exists = any(
                l["sourceTaskId"] == t["id"] and l["targetTaskId"] == target and l["kind"] == kind
                for l in self.links
            )
            if not exists:
                self.links.append({"sourceTaskId": t["id"], "targetTaskId": target, "kind": kind})
            return 201, {
                "linked": True,
                "sourceTaskId": t["id"],
                "targetTaskId": target,
                "kind": kind,
                "created": not exists,
            }
        return self._error("development_only", "POST /tasks/{}/{} is not simulated.".format(task_id, action), 501)
