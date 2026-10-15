"""Ask a person before you act.

The point of this module is one line — ``approval.wait()`` — and everything in
it exists to make that line safe to write in a real agent: polling that backs
off instead of hammering, a question from the approver answered without leaving
the wait, and an end that is guaranteed by the request's own expiry rather than
by hope.
"""

from __future__ import annotations

import random
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .errors import DeliverdError, DeliverdTimeoutError
from .paging import Page, list_or_collect
from .types import ApprovalData, ApprovalQuestion, Decision, DecisionSession

#: How often to ask, as the wait gets longer. Seconds.
#:
#: The first one is deliberately quick. Most approvals take minutes, but the
#: ones that take two seconds are the ones somebody is watching — a demo, a
#: deploy with the approver stood next to you — and a client whose first look is
#: two seconds away makes an instant decision feel like a slow one. One cheap
#: early request buys that, and against a limit of 120 a minute it costs
#: nothing. After a few polls the schedule is somebody's afternoon, not a
#: progress bar.
POLL_SCHEDULE: Sequence[float] = (0.25, 0.75, 2.0, 4.0, 8.0, 15.0, 30.0)
POLL_CEILING = 60.0

#: Development mode: the approver is imaginary and instant, so keep up.
FAST_POLL_SCHEDULE: Sequence[float] = (0.01, 0.025, 0.05, 0.1)

#: What a caller passes to answer a question without leaving the wait.
QuestionHandler = Callable[["ApprovalQuestion", "ApprovalData"], Optional[str]]
PollHandler = Callable[["ApprovalData"], None]


def _poll_delay(poll: int, schedule: Sequence[float]) -> float:
    base = schedule[min(poll, len(schedule) - 1)] if schedule else POLL_CEILING
    # Jitter, so a hundred agents started by the same cron do not arrive together.
    return base * 0.75 + random.random() * base * 0.5


def _sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
    """Sleep, unless somebody asks us to stop.

    ``threading.Event`` is Python's ``AbortSignal``: ``wait()`` returns as soon
    as it is set, so a cancelled wait stops within the sleep rather than at the
    end of it.
    """
    if cancel is None:
        time.sleep(max(0.0, seconds))
        return
    if cancel.wait(max(0.0, seconds)):
        raise DeliverdError(0, "aborted", "The wait was cancelled.")


class Approval:
    """A request, and what you can do with it.

    The data is a snapshot; :meth:`wait` and :meth:`refresh` replace it in
    place, so a handle held across a wait reads the settled request rather than
    the one you created.
    """

    def __init__(self, http: HttpClient, data: ApprovalData) -> None:
        self._http = http
        self._data = data
        #: The secret this request's callbacks are signed with, when you gave a
        #: ``callback_url``. Only on the handle ``create()`` returned — the API
        #: hands it over once — so keep it with whatever receives the callback
        #: and check each one with ``deliverd.webhooks.construct_callback``.
        self.callback_secret: Optional[str] = None

    @property
    def data(self) -> ApprovalData:
        """Everything the API returned, if you want a field the properties skip."""
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def url(self) -> str:
        """The page the approver decides on. Put it in your own UI or logs."""
        return self._data.url

    @property
    def title(self) -> str:
        return self._data.title

    @property
    def note(self) -> Optional[str]:
        """Their reason, when they gave one."""
        return self._data.note

    @property
    def decided_by(self) -> Optional[str]:
        """Who decided, as a name rather than an id."""
        return self._data.decided_by

    @property
    def decided_by_id(self) -> Optional[str]:
        return self._data.decided_by_id

    @property
    def decided_at(self) -> Optional[str]:
        return self._data.decided_at

    @property
    def questions(self) -> List[ApprovalQuestion]:
        return self._data.questions or []

    @property
    def open_questions(self) -> List[ApprovalQuestion]:
        """Questions the approver is still waiting on you to answer."""
        return [q for q in self.questions if not q.answer]

    @property
    def approved(self) -> bool:
        """The one to branch on. False for rejected, expired and cancelled alike."""
        return self._data.status == "approved"

    @property
    def rejected(self) -> bool:
        return self._data.status == "rejected"

    @property
    def expired(self) -> bool:
        return self._data.status == "expired"

    @property
    def cancelled(self) -> bool:
        return self._data.status == "cancelled"

    @property
    def pending(self) -> bool:
        return self._data.status == "pending"

    def to_decision(self) -> Decision:
        """The answer, flattened — what :meth:`Deliverd.approve` hands back.

        ``approved`` is a bool so ``if decision.approved:`` reads as the
        sentence it is; ``status`` is the word for a comparison. Both, because
        people write both and neither should be the wrong one.
        """
        status = "expired" if self._data.status == "pending" else self._data.status
        return Decision(
            approved=self._data.status == "approved",
            status=status,
            note=self._data.note,
            decided_by=self._data.decided_by,
            decided_by_id=self._data.decided_by_id,
            decided_at=self._data.decided_at,
            id=self._data.id,
            url=self._data.url,
            input=(self._data.approved_input or self._data.input)
            if self._data.status == "approved"
            else None,
            changes=list(self._data.changes or []),
            approval=self,
        )

    def refresh(self) -> "Approval":
        self._data = ApprovalData.from_wire(
            self._http.request("GET", "/approvals/{}".format(self._data.id))
        )
        return self

    def answer(self, question_id: str, answer: str) -> "Approval":
        """Answer a question the approver asked. Only the requester may."""
        self._data = ApprovalData.from_wire(
            self._http.request(
                "POST",
                "/approvals/{}/answers".format(self._data.id),
                body={"questionId": question_id, "answer": answer},
            )
        )
        return self

    def cancel(self) -> "Approval":
        """Withdraw it. The row stays as evidence of what was asked and dropped."""
        self._data = ApprovalData.from_wire(
            self._http.request("POST", "/approvals/{}/cancel".format(self._data.id))
        )
        return self

    def wait(
        self,
        on_question: Optional[QuestionHandler] = None,
        on_poll: Optional[PollHandler] = None,
        timeout: Optional[float] = None,
        cancel: Optional[threading.Event] = None,
        poll_intervals: Optional[Sequence[float]] = None,
    ) -> "Approval":
        """Block until a person decides, then return.

        Returns on approved, rejected, expired and cancelled — it does not raise
        on a no, because a refusal is an answer and ``if approval.approved:`` is
        the line that should follow. It raises only when the wait itself failed:
        a timeout, a cancellation, or the API being unreachable.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        poll = 0

        # Already settled, or answered between create and wait.
        if not self.pending:
            return self

        while True:
            if cancel is not None and cancel.is_set():
                raise DeliverdError(0, "aborted", "The wait was cancelled.")
            if deadline is not None and time.monotonic() >= deadline:
                raise DeliverdTimeoutError(self._timeout_message())

            delay = _poll_delay(poll, poll_intervals or POLL_SCHEDULE)
            poll += 1
            if deadline is not None:
                delay = min(delay, max(0.0, deadline - time.monotonic()))
            _sleep(delay, cancel)

            self.refresh()
            if on_poll is not None:
                on_poll(self._data)

            if on_question is not None:
                for question in self.open_questions:
                    reply = on_question(question, self._data)
                    if isinstance(reply, str) and reply.strip():
                        self.answer(question.id, reply)

            if not self.pending:
                return self

    def _timeout_message(self) -> str:
        """Say which of the two happened.

        An approver who asked a question and got no answer has not ignored the
        request — they are waiting on you, and "nobody decided in time" sends
        you to look at the wrong end of it.
        """
        unanswered = next((q for q in self.questions if not q.answer), None)
        if unanswered is not None:
            return (
                'An approver asked a question about "{}" and nothing answered it: '
                '"{}". Pass an on_question handler, or answer it at {}.'.format(
                    self._data.title, unanswered.question, self._data.url
                )
            )
        return 'Nobody decided "{}" within the timeout. It is still open at {}.'.format(
            self._data.title, self._data.url
        )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<Approval {} {}>".format(self._data.id, self._data.status)


class Approvals:
    """The ``/approvals`` half of the API, as objects."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        title: str,
        description: Optional[str] = None,
        risk: Optional[str] = None,
        factors: Optional[Sequence[Any]] = None,
        links: Optional[Sequence[Any]] = None,
        report_id: Optional[str] = None,
        approvers: Optional[Sequence[str]] = None,
        expires_at: Optional[str] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        input: Optional[Dict[str, Any]] = None,
        editable_fields: Optional[Sequence[str]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Approval:
        """Ask.

        Returns as soon as the request is filed — the approvers are being told
        while this returns — so call :meth:`Approval.wait` next, or keep the id
        and poll later.
        """
        body = body_from(
            {
                "title": title,
                "description": description,
                "risk": risk,
                "factors": list(factors) if factors is not None else None,
                "links": list(links) if links is not None else None,
                "report_id": report_id,
                "approvers": list(approvers) if approvers is not None else None,
                "expires_at": expires_at,
                "external_id": external_id,
                "flow_id": flow_id,
                "metadata": metadata,
                "callback_url": callback_url,
                "input": input,
                "editable_fields": list(editable_fields) if editable_fields is not None else None,
            },
            # Field names inside ``input`` are the caller's arguments, sent as written.
            passthrough=("metadata", "input"),
        )
        data = self._http.request("POST", "/approvals", body=body, idempotency_key=idempotency_key)
        created = Approval(self._http, ApprovalData.from_wire(data))
        created.callback_secret = data.get("callbackSecret") if isinstance(data, dict) else None
        return created

    def get(self, approval_id: str) -> Approval:
        return Approval(
            self._http, ApprovalData.from_wire(self._http.request("GET", "/approvals/" + approval_id))
        )

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        approver: Optional[str] = None,
    ) -> List[Approval]:
        """The organisation's approvals, newest first.

        With no ``limit`` this is every one of them: the API says where each
        page stopped and this follows the cursor to the end. With a ``limit`` it
        is one page of that size, and :meth:`list_page` hands back the cursor to
        continue from.

        ``approver`` keeps the requests naming one person — a member's id or
        email, or an admitted guest's email: their inbox, for your own UI.
        """
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(
                status=status, external_id=external_id, limit=page_limit, cursor=page_cursor, approver=approver
            ),
        )

    def list_page(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        approver: Optional[str] = None,
    ) -> "Page[Approval]":
        """One page, and the cursor to continue from — ``None`` when it is the end."""
        payload = self._http.request(
            "GET",
            "/approvals",
            query={
                "status": status,
                "externalId": external_id,
                "approver": approver,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return Page(
            [Approval(self._http, ApprovalData.from_wire(row)) for row in payload.get("approvals", [])],
            payload.get("nextCursor"),
        )

    def request(self, **kwargs: Any) -> Approval:
        """Ask and wait, where there is nothing to do in between."""
        wait_keys = ("on_question", "on_poll", "timeout", "cancel", "poll_intervals")
        wait_args = {k: kwargs.pop(k) for k in wait_keys if k in kwargs}
        return self.create(**kwargs).wait(**wait_args)

    def find_by_external_id(self, external_id: str) -> Optional[Approval]:
        """The same request as before, when there was one.

        Best effort, and worth being exact about what that means: it looks for a
        request with this ``external_id`` and returns it rather than filing a
        second. That makes an agent safe to restart — a crash between "asked"
        and "recorded that I asked" does not produce two notifications for one
        decision. Two *concurrent* calls can still both find nothing and both
        create; real idempotency needs a key the server enforces, which is what
        ``idempotency_key`` is for.
        """
        found = self.list(external_id=external_id, limit=1)
        return found[0] if found else None

    def create_session(
        self,
        approval_id: str,
        approver: str,
        mode: str = "hosted",
        origin: Optional[str] = None,
        return_url: Optional[str] = None,
        expires_in: Optional[int] = None,
    ) -> DecisionSession:
        """A page on which one approver decides this request, inside your product.

        ``mode="hosted"`` returns a ``url`` to send them to, and ``return_url``
        brings them back with ``deliverd_session`` and ``deliverd_decision``
        added. ``mode="embedded"`` returns a ``client_secret`` to mount with
        ``https://deliverd.dev/elements/v1.js``, framed only by ``origin``. Both
        come back once. Neither decides anything: the approver signs in, or
        confirms a code sent to their own address, first.
        """
        payload = self._http.request(
            "POST",
            "/approvals/{}/sessions".format(approval_id),
            body=body_from(
                {
                    "approver": approver,
                    "mode": mode,
                    "origin": origin,
                    "return_url": return_url,
                    "expires_in": expires_in,
                }
            ),
        )
        return DecisionSession.from_wire(payload)


class DecisionSessions:
    """Decision sessions after they are made: where one stands, and ending it early."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(self, session_id: str) -> DecisionSession:
        return DecisionSession.from_wire(self._http.request("GET", "/decision-sessions/{}".format(session_id)))

    def expire(self, session_id: str) -> DecisionSession:
        """End it now. A decision already made through it stays made."""
        return DecisionSession.from_wire(self._http.request("POST", "/decision-sessions/{}/expire".format(session_id)))

