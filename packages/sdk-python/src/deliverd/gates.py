"""Ask before you act.

The other primitives in this package are an agent asking a person to look at
work it has already done. This one asks first, and the answer comes from policy
the developer does not own — which is the point: what needs a human is an
organisation's decision, not a line in the agent's code.

    decision = deliverd.gate(
        action="finance.refund",
        external_id=f"refund:{order.id}",
        input={"customer_id": order.customer_id, "amount": 1240, "currency": "GBP"},
    )
    if not decision.allowed:
        return
    stripe.Refund.create(**decision.input)

**Execute with ``decision.input``, not your own dict.** It is what the action's
schema validated and what an approver actually saw. Passing the original works
right up until somebody edits a value before approving, and then it spends an
approval for £1200 on a refund of £1240.
"""

from __future__ import annotations

import random
import threading
import time
from typing import Any, Callable, Dict, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .errors import DeliverdError, DeliverdTimeoutError
from .types import ExecutionReceipt, GateData, GateDecision

#: How often to ask, as the wait gets longer. Seconds. The same schedule and the
#: same reasoning as an approval's: the first poll is quick because the decisions
#: that settle in two seconds are the ones somebody is watching.
POLL_SCHEDULE: Sequence[float] = (0.25, 0.75, 2.0, 4.0, 8.0, 15.0, 30.0)
POLL_CEILING = 60.0

#: Development mode: the approver is imaginary and instant, so keep up.
FAST_POLL_SCHEDULE: Sequence[float] = (0.01, 0.025, 0.05, 0.1)

PollHandler = Callable[["GateData"], None]


def _poll_delay(poll: int, schedule: Sequence[float]) -> float:
    base = schedule[min(poll, len(schedule) - 1)] if schedule else POLL_CEILING
    # Jitter, so a hundred agents started by the same cron do not arrive together.
    return base * 0.75 + random.random() * base * 0.5


def _sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
    if cancel is None:
        time.sleep(max(0.0, seconds))
        return
    if cancel.wait(max(0.0, seconds)):
        raise DeliverdError(0, "aborted", "The wait was cancelled.")


class Gate:
    """A decision, and what you can do with it.

    The data is a snapshot; :meth:`wait` and :meth:`refresh` replace it in
    place, so a handle held across a wait reads the settled decision rather than
    the pending one you created.
    """

    def __init__(self, http: HttpClient, data: GateData) -> None:
        self._http = http
        self._data = data

    @property
    def data(self) -> GateData:
        """Everything the API returned."""
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def allowed(self) -> bool:
        """The one to branch on.

        True when a rule permitted it **or** a person agreed to it; False for
        denied, rejected, expired, cancelled and while pending. An expiry is not
        permission — nobody said yes.
        """
        return self._data.allowed

    @property
    def pending(self) -> bool:
        """Still waiting on a person."""
        return self._data.status == "pending"

    @property
    def denied(self) -> bool:
        """Refused by a rule, as against rejected by a person."""
        return self._data.status == "denied"

    @property
    def input(self) -> Dict[str, Any]:
        """What to execute with: the input as the action's schema validated it."""
        return self._data.input

    @property
    def reason(self) -> Optional[str]:
        return self._data.reason

    @property
    def rule(self) -> Optional[str]:
        """The rule that decided, by name. ``None`` when nothing matched it."""
        return self._data.rule

    @property
    def approval_url(self) -> Optional[str]:
        return self._data.approval_url

    @property
    def approval_id(self) -> Optional[str]:
        return self._data.approval_id

    @property
    def reused(self) -> bool:
        """True when this call read back a decision already made under your id."""
        return self._data.reused

    @property
    def can_execute(self) -> bool:
        """Whether you may act on it **now**.

        Authorised, inside its window, with a use left, not revoked. Branch on
        this rather than :attr:`allowed`, which says it was authorised at some
        point. The organisation's authorisation only: the platform your agent
        runs on may still require its user's confirmation, or refuse.
        """
        return bool(self._data.can_execute)

    @property
    def decision(self) -> str:
        """``ALLOW``, ``APPROVAL_REQUIRED``, ``REVIEW_REQUIRED`` or ``DENY``."""
        return self._data.decision

    @property
    def blocked_because(self) -> Optional[str]:
        return self._data.blocked_because

    @property
    def scope(self) -> Dict[str, Any]:
        """What the permission covers: destination, artifact and its hash, classification."""
        return self._data.scope or {}

    @property
    def changes_requested(self) -> bool:
        """A person sent it back. Revise, then ask again with ``supersedes_gate_id=gate.id``."""
        return self._data.status == "changes_requested"

    def record_execution(
        self,
        phase: str = "completed",
        claim_id: Optional[str] = None,
        executed_at: Optional[str] = None,
        artifact_sha256: Optional[str] = None,
        destination: Optional[Dict[str, Any]] = None,
        result: Optional[Dict[str, Any]] = None,
        detail: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
    ) -> ExecutionReceipt:
        """Report what you did with the permission. Spends a use.

        A different artifact hash is refused as ``approval_invalidated``; a
        different destination as ``destination_mismatch``.
        """
        receipt, data = _record(
            self._http, self._data.id, phase, claim_id, executed_at, artifact_sha256, destination, result, detail, agent
        )
        self._data = data
        return receipt

    def cancel(self, note: Optional[str] = None, agent: Optional[Dict[str, Any]] = None) -> "Gate":
        """Withdraw it: the request if a person has not answered, the permission if unused."""
        self._data = GateData.from_wire(
            self._http.request("POST", f"/gates/{self._data.id}/cancel", body_from({"note": note, "agent": agent}))
        )
        return self

    def to_decision(self) -> GateDecision:
        """The answer, flattened — what :meth:`Deliverd.gate` hands back."""
        return GateDecision(
            allowed=self._data.allowed,
            status=self._data.status,
            reason=self._data.reason,
            rule=self._data.rule,
            input=self._data.input,
            changes=list(self._data.changes or []),
            id=self._data.id,
            approval_url=self._data.approval_url,
            gate=self,
        )

    def refresh(self) -> "Gate":
        self._data = GateData.from_wire(
            self._http.request("GET", f"/gates/{self._data.id}")
        )
        return self

    def wait(
        self,
        timeout: Optional[float] = None,
        on_poll: Optional[PollHandler] = None,
        cancel: Optional[threading.Event] = None,
        poll_intervals: Optional[Sequence[float]] = None,
    ) -> "Gate":
        """Block until a person decides, then return.

        Returns on every settled state — it does not raise on a refusal, because
        a no is an answer and ``if gate.allowed:`` is the line that follows. It
        raises only when the wait itself failed: a timeout, a cancellation, or
        the API being unreachable.

        Returns immediately when policy already settled it, which is the common
        case: most gated calls are allowed or denied by a rule and never reach a
        person at all.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        poll = 0

        if not self.pending:
            return self

        while True:
            if cancel is not None and cancel.is_set():
                raise DeliverdError(0, "aborted", "The wait was cancelled.")
            if deadline is not None and time.monotonic() >= deadline:
                where = (
                    f" It is still open at {self._data.approval_url}."
                    if self._data.approval_url
                    else " It is still open."
                )
                raise DeliverdTimeoutError(
                    f"Nobody decided the gate on {self._data.id} within the timeout.{where}"
                )

            delay = _poll_delay(poll, poll_intervals or POLL_SCHEDULE)
            poll += 1
            if deadline is not None:
                delay = min(delay, max(0.0, deadline - time.monotonic()))
            _sleep(delay, cancel)

            self.refresh()
            if on_poll is not None:
                on_poll(self._data)

            if not self.pending:
                return self


def _record(
    http: HttpClient,
    gate_id: str,
    phase: str,
    claim_id: Optional[str],
    executed_at: Optional[str],
    artifact_sha256: Optional[str],
    destination: Optional[Dict[str, Any]],
    result: Optional[Dict[str, Any]],
    detail: Optional[str],
    agent: Optional[Dict[str, Any]],
) -> "tuple[ExecutionReceipt, GateData]":
    body = body_from(
        {
            "phase": phase,
            "claimId": claim_id,
            "executedAt": executed_at,
            "artifactSha256": artifact_sha256,
            "destination": destination,
            "result": result,
            "detail": detail,
            "agent": agent,
        },
        passthrough=("result",),
    )
    raw = http.request("POST", f"/gates/{gate_id}/execution", body)
    return ExecutionReceipt.from_wire(raw["receipt"]), GateData.from_wire(raw["gate"])


class Gates:
    """The ``/gates`` half of the API, as objects."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def check(self, action_id: str, input: Dict[str, Any], external_id: str, **scope: Any) -> Gate:
        """Ask whether you may act, and return at once — :meth:`create`, named for what it does."""
        return self.create(action_id, input, external_id, **scope)

    def record_execution(self, gate_id: str, **report: Any) -> ExecutionReceipt:
        """Report what you did with a gate's permission. See :meth:`Gate.record_execution`.

        The gate as it now stands is on :meth:`get`; with a :class:`Gate` in
        hand, its own ``record_execution`` updates it in place.
        """
        receipt, _ = _record(
            self._http,
            gate_id,
            report.get("phase", "completed"),
            report.get("claim_id"),
            report.get("executed_at"),
            report.get("artifact_sha256"),
            report.get("destination"),
            report.get("result"),
            report.get("detail"),
            report.get("agent"),
        )
        return receipt

    def cancel(self, gate_id: str, note: Optional[str] = None, agent: Optional[Dict[str, Any]] = None) -> Gate:
        """Withdraw a request, or an unused permission."""
        return Gate(
            self._http,
            GateData.from_wire(self._http.request("POST", f"/gates/{gate_id}/cancel", body_from({"note": note, "agent": agent}))),
        )

    def release(self, gate_id: str, agent: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Have Deliverd make the staged report version the gate authorised live.

        The receipt is ``verified``: Deliverd carried it out. Returns
        ``{"receipt": ExecutionReceipt, "gate": GateData, "url": str}``.
        """
        raw = self._http.request("POST", f"/gates/{gate_id}/release", body_from({"agent": agent}))
        return {
            "receipt": ExecutionReceipt.from_wire(raw["receipt"]),
            "gate": GateData.from_wire(raw["gate"]),
            "url": raw["url"],
        }

    def evidence(self, gate_id: str) -> Dict[str, Any]:
        """The gate's evidence pack, as the JSON the API returns."""
        return self._http.request("GET", f"/gates/{gate_id}/evidence")

    def create(
        self,
        action_id: str,
        input: Dict[str, Any],
        external_id: str,
        environment: Optional[str] = None,
        reason: Optional[str] = None,
        flow_id: Optional[str] = None,
        description: Optional[str] = None,
        destination: Optional[Dict[str, Any]] = None,
        classification: Optional[str] = None,
        risk: Optional[str] = None,
        artifact: Optional[Dict[str, Any]] = None,
        agent: Optional[Dict[str, Any]] = None,
        execution: Optional[Dict[str, Any]] = None,
        supersedes_gate_id: Optional[str] = None,
        callback_url: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Gate:
        """Raise a decision and return straight away, even if it went to a person.

        The non-blocking half of :meth:`Deliverd.gate`. Use it when the work
        resumes on a webhook or a later poll rather than inside this call.

        ``external_id`` is required, which no other create here is. Every other
        POST mints a random idempotency key per attempt, which guards a retried
        *request*; this guards a retried *decision*. A crashed agent re-running
        its refund step must re-read the answer it already got rather than ask a
        second person about the same money, and no id this library could invent
        would know which two calls are the same attempt.
        """
        body = body_from(
            {
                "actionId": action_id,
                "input": input,
                "externalId": external_id,
                "environment": environment,
                "reason": reason,
                "flowId": flow_id,
                "description": description,
                "destination": destination,
                "classification": classification,
                "risk": risk,
                "artifact": artifact,
                "agent": agent,
                "execution": execution,
                "supersedesGateId": supersedes_gate_id,
                "callbackUrl": callback_url,
                "metadata": metadata,
            },
            passthrough=("input", "metadata"),
        )
        # The caller's own id as the HTTP idempotency key too. The server
        # enforces reuse against the gate row, so this is belt and braces — but
        # it means a transport-level retry and a caller-level retry carry one
        # key rather than one guarding the request and the other the decision.
        return Gate(
            self._http,
            GateData.from_wire(
                self._http.request("POST", "/gates", body, idempotency_key=external_id)
            ),
        )

    def get(self, gate_id: str) -> Gate:
        """One decision by its id."""
        return Gate(
            self._http, GateData.from_wire(self._http.request("GET", f"/gates/{gate_id}"))
        )
