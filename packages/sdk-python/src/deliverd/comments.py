"""The feedback on a published report, and what to do about it.

The other direction of the publishing half: `reports.publish()` sends work to
people, and this is what comes back — a reader's note anchored to the passage
it is about, which an agent can read and revise against.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import quote

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, collect
from .types import CommentThread, OpenThread

__all__ = ["Comments"]


class Comments:
    """The comment half of the API."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, report: str, status: str = "open") -> List[CommentThread]:
        """Every thread on a report, newest activity first.

        ``status`` is ``open``, ``resolved`` or ``all``. Follows the cursor to
        the end, because a caller asking for the feedback on one report wants
        the feedback on that report rather than the first page of it.
        """

        def fetch(cursor: Optional[str]) -> "Page[CommentThread]":
            payload = self._http.request(
                "GET",
                "/reports/{}/comments".format(quote(report, safe="")),
                query={"status": status, "cursor": cursor},
            )
            return Page(
                [CommentThread.from_wire(t) for t in payload.get("threads", [])],
                payload.get("nextCursor"),
            )

        return collect(fetch)

    def open(self) -> List[OpenThread]:
        """Every open thread in the organisation, newest activity first.

        The answer to "is anything waiting on me?" without naming a report
        first. :meth:`list` needs one, which means enumerating every report to
        find the two with feedback on them.

        Threads on archived reports are left out: the URL does not serve, so
        nothing can be done about them until somebody unarchives the report.
        """

        def fetch(cursor: Optional[str]) -> "Page[OpenThread]":
            payload = self._http.request("GET", "/comments", query={"cursor": cursor})
            return Page(
                [OpenThread.from_wire(t) for t in payload.get("threads", [])],
                payload.get("nextCursor"),
            )

        return collect(fetch)

    def create(
        self,
        report: str,
        body: str,
        quote_text: Optional[str] = None,
        thread_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Leave a comment.

        ``quote_text`` anchors it to a passage; ``thread_id`` replies to an
        existing thread. Named ``quote_text`` rather than ``quote`` because
        ``quote`` is ``urllib``'s own function, imported in this module — a
        collision that would read fine and shadow it.
        """
        return self._http.request(
            "POST",
            "/reports/{}/comments".format(quote(report, safe="")),
            body=body_from({"body": body, "quote": quote_text, "thread_id": thread_id}),
            idempotency_key=idempotency_key,
        )

    def retract(self, report: str, comment_id: str) -> Dict[str, Any]:
        """Take back a comment you posted.

        Your own last comment in a thread, while the thread is open. Once
        somebody has replied it stays — their reply would otherwise be left
        answering something no longer on the page. Retracting the only comment
        in a thread takes the thread with it.

        ``comment_id`` comes back from :meth:`create`, and :meth:`list` carries
        one on every message with ``retractable`` beside it.

        **This closes what a reader can see and unsends nothing.** The report's
        owner may already have been emailed, and a receiver may have relayed it
        into a channel.
        """
        return self._http.request(
            "DELETE",
            "/reports/{}/comments/{}".format(quote(report, safe=""), quote(comment_id, safe="")),
        )

    def resolve(
        self,
        thread_id: str,
        note: Optional[str] = None,
        reopen: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Mark a thread resolved, with a note on what changed.

        A thread, not a report: resolving is keyed on the thread alone, so this
        takes no report id. (The first draft of this method put it under
        ``/reports/{id}/comments/{threadId}/resolve``, which is where it reads
        like it should live and is not where it is — a 404 on every call.)

        ``reopen=True`` puts it back, which is the route to retracting your own
        comment on a thread somebody closed: retraction needs the thread open.

        The text stays on the page. Resolving says it has been dealt with, not
        that it was never said — :meth:`retract` is for taking your own words
        back.
        """
        return self._http.request(
            "POST",
            "/comments/{}/resolve".format(quote(thread_id, safe="")),
            body=body_from({"note": note, "reopen": reopen}),
        )
