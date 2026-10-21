"""Ask people to read what you made.

The other half of judgement. :mod:`deliverd.approvals` asks permission before
you act; this asks whether what you already produced is right, and comes back
with the reviewers' verdicts and a count of the comment threads they opened.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .approvals import FAST_POLL_SCHEDULE, POLL_SCHEDULE, _poll_delay, _sleep
from .errors import DeliverdError, DeliverdTimeoutError
from .paging import Page, list_or_collect
from .types import ReviewData, ReviewOutcome

__all__ = ["Review", "Reviews", "FAST_POLL_SCHEDULE"]

PollHandler = Callable[["ReviewData"], None]


class Review:
    """A review, and what you can do with it."""

    def __init__(self, http: HttpClient, data: ReviewData) -> None:
        self._http = http
        self._data = data
        #: The secret this request's callbacks are signed with, when you gave a
        #: ``callback_url``. Only on the handle ``create()`` returned — the API
        #: hands it over once — so keep it with whatever receives the callback
        #: and check each one with ``deliverd.webhooks.construct_callback``.
        self.callback_secret: Optional[str] = None

    @property
    def data(self) -> ReviewData:
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def url(self) -> str:
        """The page the reviewer reads and decides on."""
        return self._data.url

    @property
    def title(self) -> str:
        return self._data.title

    @property
    def verdicts(self) -> List[Any]:
        return self._data.verdicts or []

    @property
    def thread_count(self) -> int:
        """How many comment threads to read before producing the next version."""
        return self._data.thread_count or 0

    @property
    def approved(self) -> bool:
        return self._data.status == "approved"

    @property
    def changes_requested(self) -> bool:
        return self._data.status == "changes_requested"

    @property
    def pending(self) -> bool:
        return self._data.status == "pending"

    def to_outcome(self) -> ReviewOutcome:
        """The answer, flattened — what :meth:`Deliverd.review` hands back."""
        status = "expired" if self._data.status == "pending" else self._data.status
        return ReviewOutcome(
            approved=self._data.status == "approved",
            status=status,
            verdicts=self.verdicts,
            thread_count=self.thread_count,
            id=self._data.id,
            url=self._data.url,
            review=self._data,
        )

    def refresh(self) -> "Review":
        self._data = ReviewData.from_wire(
            self._http.request("GET", "/reviews/{}".format(self._data.id))
        )
        return self

    def cancel(self) -> "Review":
        """Withdraw it. The row stays as evidence of what was asked and dropped."""
        self._data = ReviewData.from_wire(
            self._http.request("POST", "/reviews/{}/cancel".format(self._data.id))
        )
        return self

    def wait(
        self,
        on_poll: Optional[PollHandler] = None,
        timeout: Optional[float] = None,
        cancel: Optional[threading.Event] = None,
        poll_intervals: Optional[Sequence[float]] = None,
    ) -> "Review":
        """Block until the reviewers settle it, then return.

        Returns on changes requested as well as approval, because that is an
        answer — usually the more useful one.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        poll = 0
        if not self.pending:
            return self

        while True:
            if cancel is not None and cancel.is_set():
                raise DeliverdError(0, "aborted", "The wait was cancelled.")
            if deadline is not None and time.monotonic() >= deadline:
                raise DeliverdTimeoutError(
                    'Nobody reviewed "{}" within the timeout. It is still open at {}.'.format(
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
        return "<Review {} {}>".format(self._data.id, self._data.status)


class Reviews:
    """The ``/reviews`` half of the API, as objects."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        title: str,
        reviewers: Sequence[str],
        instructions: Optional[str] = None,
        report_id: Optional[str] = None,
        version_id: Optional[str] = None,
        required_approvals: Optional[int] = None,
        expires_at: Optional[str] = None,
        external_id: Optional[str] = None,
        flow_id: Optional[str] = None,
        agent: Optional[Dict[str, Any]] = None,
        model: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Review:
        body = body_from(
            {
                "title": title,
                "reviewers": list(reviewers),
                "instructions": instructions,
                "report_id": report_id,
                "version_id": version_id,
                "required_approvals": required_approvals,
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
        data = self._http.request("POST", "/reviews", body=body, idempotency_key=idempotency_key)
        created = Review(self._http, ReviewData.from_wire(data))
        created.callback_secret = data.get("callbackSecret") if isinstance(data, dict) else None
        return created

    def get(self, review_id: str) -> Review:
        return Review(
            self._http, ReviewData.from_wire(self._http.request("GET", "/reviews/" + review_id))
        )

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        report_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[Review]:
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(
                status=status,
                external_id=external_id,
                report_id=report_id,
                limit=page_limit,
                cursor=page_cursor,
            ),
        )

    def list_page(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        report_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> "Page[Review]":
        payload = self._http.request(
            "GET",
            "/reviews",
            query={
                "status": status,
                "externalId": external_id,
                "reportId": report_id,
                "limit": limit,
                "cursor": cursor,
            },
        )
        return Page(
            [Review(self._http, ReviewData.from_wire(row)) for row in payload.get("reviews", [])],
            payload.get("nextCursor"),
        )

    def request(self, **kwargs: Any) -> Review:
        """Ask and wait, where there is nothing to do in between."""
        wait_keys = ("on_poll", "timeout", "cancel", "poll_intervals")
        wait_args = {k: kwargs.pop(k) for k in wait_keys if k in kwargs}
        return self.create(**kwargs).wait(**wait_args)

    def find_by_external_id(self, external_id: str) -> Optional[Review]:
        """The same review as before, so a restarted agent does not ask twice."""
        found = self.list(external_id=external_id, limit=1)
        return found[0] if found else None
