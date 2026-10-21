"""Ask people for what you do not have.

:mod:`deliverd.approvals` asks permission, :mod:`deliverd.reviews` asks
judgement, and this asks for a fact — a figure, a date, a choice between
options, the sentence only they can write.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .approvals import POLL_SCHEDULE, _poll_delay, _sleep
from .errors import DeliverdError, DeliverdTimeoutError
from .paging import Page, list_or_collect
from .types import AnswerValue, CollectedAnswers, CollectionData

__all__ = ["Collection", "Collections"]

PollHandler = Callable[["CollectionData"], None]


class Collection:
    """A request for information, and what you can do with it."""

    def __init__(self, http: HttpClient, data: CollectionData) -> None:
        self._http = http
        self._data = data
        #: The secret this request's callbacks are signed with, when you gave a
        #: ``callback_url``. Only on the handle ``create()`` returned — the API
        #: hands it over once — so keep it with whatever receives the callback
        #: and check each one with ``deliverd.webhooks.construct_callback``.
        self.callback_secret: Optional[str] = None

    @property
    def data(self) -> CollectionData:
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def url(self) -> str:
        """The page the person fills in."""
        return self._data.url

    @property
    def title(self) -> str:
        return self._data.title

    @property
    def complete(self) -> bool:
        """True when enough people replied."""
        return self._data.status == "complete"

    @property
    def pending(self) -> bool:
        return self._data.status == "pending"

    @property
    def answers(self) -> Dict[str, AnswerValue]:
        """The first submitted answer to each question, keyed by its prompt.

        The shape most callers want when they asked one person for three facts.
        When several people answered the same question, later replies do not
        overwrite the first — use :attr:`responses` when you need all of them,
        and note that this returns the earliest submission rather than a merge,
        since silently blending two people's answers would be worse than making
        you choose.

        The keys are the questions as they were written, so they are never
        converted to snake_case: a prompt is a sentence a person typed.
        """
        out: Dict[str, AnswerValue] = {}
        for reply in self._data.responses or []:
            if reply.status != "submitted":
                continue
            for answer in reply.answers or []:
                if answer.question not in out:
                    out[answer.question] = answer.value
        return out

    @property
    def responses(self) -> List[Any]:
        return self._data.responses or []

    def to_collected(self) -> CollectedAnswers:
        """The answers, flattened — what :meth:`Deliverd.collect` hands back."""
        status = "expired" if self._data.status == "pending" else self._data.status
        return CollectedAnswers(
            complete=self._data.status == "complete",
            status=status,
            responses=[r for r in self.responses if r.status == "submitted"],
            answers=self.answers,
            id=self._data.id,
            url=self._data.url,
            collection=self._data,
        )

    def refresh(self) -> "Collection":
        self._data = CollectionData.from_wire(
            self._http.request("GET", "/collections/{}".format(self._data.id))
        )
        return self

    def cancel(self) -> "Collection":
        """Withdraw it. The row stays as evidence of what was asked and dropped."""
        self._data = CollectionData.from_wire(
            self._http.request("POST", "/collections/{}/cancel".format(self._data.id))
        )
        return self

    def wait(
        self,
        on_poll: Optional[PollHandler] = None,
        timeout: Optional[float] = None,
        cancel: Optional[threading.Event] = None,
        poll_intervals: Optional[Sequence[float]] = None,
    ) -> "Collection":
        """Block until enough people reply, or the request ends."""
        deadline = None if timeout is None else time.monotonic() + timeout
        poll = 0
        if not self.pending:
            return self

        while True:
            if cancel is not None and cancel.is_set():
                raise DeliverdError(0, "aborted", "The wait was cancelled.")
            if deadline is not None and time.monotonic() >= deadline:
                raise DeliverdTimeoutError(
                    'Nobody answered "{}" within the timeout. It is still open at {}.'.format(
                        self._data.title, self._data.url
                    )
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

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<Collection {} {}>".format(self._data.id, self._data.status)


class Collections:
    """The ``/collections`` half of the API, as objects."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        title: str,
        questions: Sequence[Any],
        respondents: Sequence[str],
        instructions: Optional[str] = None,
        required_responses: Optional[int] = None,
        report_id: Optional[str] = None,
        due_at: Optional[str] = None,
        expires_at: Optional[str] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Collection:
        body = body_from(
            {
                "title": title,
                "questions": list(questions),
                "respondents": list(respondents),
                "instructions": instructions,
                "required_responses": required_responses,
                "report_id": report_id,
                "due_at": due_at,
                "expires_at": expires_at,
                "external_id": external_id,
                "flow_id": flow_id,
                "agent": agent,
                "model": model,
                "metadata": metadata,
                "callback_url": callback_url,
            },
            passthrough=("metadata",),
        )
        data = self._http.request("POST", "/collections", body=body, idempotency_key=idempotency_key)
        created = Collection(self._http, CollectionData.from_wire(data))
        created.callback_secret = data.get("callbackSecret") if isinstance(data, dict) else None
        return created

    def get(self, collection_id: str) -> Collection:
        return Collection(
            self._http,
            CollectionData.from_wire(self._http.request("GET", "/collections/" + collection_id)),
        )

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[Collection]:
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(
                status=status, external_id=external_id, limit=page_limit, cursor=page_cursor
            ),
        )

    def list_page(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> "Page[Collection]":
        payload = self._http.request(
            "GET",
            "/collections",
            query={"status": status, "externalId": external_id, "limit": limit, "cursor": cursor},
        )
        return Page(
            [
                Collection(self._http, CollectionData.from_wire(row))
                for row in payload.get("collections", [])
            ],
            payload.get("nextCursor"),
        )

    def request(self, **kwargs: Any) -> Collection:
        """Ask and wait, where there is nothing to do in between."""
        wait_keys = ("on_poll", "timeout", "cancel", "poll_intervals")
        wait_args = {k: kwargs.pop(k) for k in wait_keys if k in kwargs}
        return self.create(**kwargs).wait(**wait_args)

    def find_by_external_id(self, external_id: str) -> Optional[Collection]:
        """The same request as before, so a restarted agent does not ask twice."""
        found = self.list(external_id=external_id, limit=1)
        return found[0] if found else None
