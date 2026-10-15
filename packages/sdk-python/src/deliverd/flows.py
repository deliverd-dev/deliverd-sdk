"""A flow: the thread that ties one job's asks together.

The reason it exists in this SDK rather than only in the API is the handle
below. An agent doing a multi-step job would otherwise carry a ``flow_id``
through every call and pass it by hand each time — which works right up until
one call is written without it, and that step is then missing from the history
with nothing to say so. ``flow.approve()`` cannot forget.

It groups and nothing else. Nothing waits on a flow; nothing is blocked by one;
there are no steps to declare up front. Do the work in the order you want it
done and name the flow as you go.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, list_or_collect
from .types import CollectedAnswers, Decision, EvidencePack, FlowData, ReviewOutcome

__all__ = ["Flow", "Flows"]


class Flow:
    """A flow, and what you can do inside it."""

    def __init__(self, http: HttpClient, data: FlowData, client: Any) -> None:
        self._http = http
        self._data = data
        # The client itself, so `flow.approve()` is `deliverd.approve()` with
        # the flow filled in rather than a second implementation of the same
        # call that can drift from it.
        self._client = client

    @property
    def data(self) -> FlowData:
        return self._data

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def status(self) -> str:
        return self._data.status

    @property
    def url(self) -> str:
        """The timeline page a person can open."""
        return self._data.url

    @property
    def title(self) -> str:
        return self._data.title

    @property
    def members(self) -> List[Any]:
        return self._data.members or []

    @property
    def timeline(self) -> List[Any]:
        """Present on a single read, absent from a list."""
        return self._data.timeline or []

    @property
    def member_count(self) -> int:
        return self._data.member_count or 0

    @property
    def open_count(self) -> int:
        return self._data.open_count or 0

    @property
    def open(self) -> bool:
        return self._data.status == "open"

    @property
    def complete(self) -> bool:
        return self._data.status == "complete"

    @property
    def cancelled(self) -> bool:
        return self._data.status == "cancelled"

    @property
    def all_settled(self) -> bool:
        """Nothing in it is waiting on anybody *at this moment*.

        Not a claim that the job is finished — you may be about to add the next
        step, and an empty flow is never settled. Branch on it to decide whether
        to move on; call :meth:`close` to say the work is over.
        """
        return bool(self._data.all_settled)

    def refresh(self) -> "Flow":
        self._data = FlowData.from_wire(self._http.request("GET", "/flows/" + self._data.id))
        return self

    # ── the three primitives, inside this flow ─────────────────────────────

    def approve(self, **kwargs: Any) -> Decision:
        """Ask permission, inside this flow.

        Exactly :meth:`Deliverd.approve` with the flow already named — which is
        the point: a ``flow_id`` passed by hand at four call sites is one that
        gets left off the fifth.
        """
        kwargs["flow_id"] = self._data.id
        return self._client.approve(**kwargs)

    def review(self, **kwargs: Any) -> ReviewOutcome:
        """Ask for judgement, inside this flow."""
        kwargs["flow_id"] = self._data.id
        return self._client.review(**kwargs)

    def collect(self, **kwargs: Any) -> CollectedAnswers:
        """Ask for facts, inside this flow."""
        kwargs["flow_id"] = self._data.id
        return self._client.collect(**kwargs)

    # ── the record, and the end ────────────────────────────────────────────

    def evidence(self) -> EvidencePack:
        """The whole record: every step with who was asked and what they said.

        What to hand over when somebody asks you to show your working. Needs
        every read scope, because it contains everything.
        """
        return EvidencePack.from_wire(
            self._http.request("GET", "/flows/{}/evidence".format(self._data.id))
        )

    def close(self) -> "Flow":
        """Say the work is done. It stops taking new members from here.

        Named ``close()`` rather than ``complete()`` so it does not collide with
        the :attr:`complete` property, which every other primitive in this SDK
        also has: ``flow.complete`` asks, ``flow.close()`` decides.

        Allowed with steps still outstanding, and how many is recorded — a flow
        that could not be closed until every reviewer replied would be one that
        stayed open for ever.
        """
        self._data = FlowData.from_wire(
            self._http.request("POST", "/flows/{}/complete".format(self._data.id))
        )
        return self

    def cancel(self) -> "Flow":
        """Call it off.

        The flow and its members stay as evidence; nothing inside is cancelled.
        """
        self._data = FlowData.from_wire(
            self._http.request("POST", "/flows/{}/cancel".format(self._data.id))
        )
        return self

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<Flow {} {}>".format(self._data.id, self._data.status)


class Flows:
    """The ``/flows`` half of the API, as objects."""

    def __init__(self, http: HttpClient, client: Any) -> None:
        self._http = http
        self._client = client

    def create(
        self,
        title: str,
        description: Optional[str] = None,
        workspace_id: Optional[str] = None,
        external_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Flow:
        body = body_from(
            {
                "title": title,
                "description": description,
                "workspace_id": workspace_id,
                "external_id": external_id,
                "metadata": metadata,
            },
            passthrough=("metadata",),
        )
        data = self._http.request("POST", "/flows", body=body, idempotency_key=idempotency_key)
        return Flow(self._http, FlowData.from_wire(data), self._client)

    def get(self, flow_id: str) -> Flow:
        return Flow(
            self._http,
            FlowData.from_wire(self._http.request("GET", "/flows/" + flow_id)),
            self._client,
        )

    def list(
        self,
        status: Optional[str] = None,
        external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[Flow]:
        """The organisation's flows, newest first.

        With no ``limit`` this is every one of them; with a ``limit`` it is one
        page of that size.
        """
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
    ) -> "Page[Flow]":
        payload = self._http.request(
            "GET",
            "/flows",
            query={"status": status, "externalId": external_id, "limit": limit, "cursor": cursor},
        )
        return Page(
            [
                Flow(self._http, FlowData.from_wire(row), self._client)
                for row in payload.get("flows", [])
            ],
            payload.get("nextCursor"),
        )

    def find_by_external_id(self, external_id: str) -> Optional[Flow]:
        """The same job as before, so a restart extends it rather than starting a second."""
        found = self.list(external_id=external_id, limit=1)
        return found[0] if found else None

    def resume(self, title: str, external_id: str, **kwargs: Any) -> Flow:
        """The flow for this reference, started if it does not exist yet.

        What a restartable agent actually wants: one line that is correct on the
        first run and on the fourth. Without it the caller writes the lookup, the
        branch and the create by hand, and a crash between the lookup and the
        create leaves two flows for one job.

        A *closed* flow with this reference is not resumed — it takes no new
        members, so extending it is not something the API would allow and
        returning it would hand back a handle whose next call fails.
        """
        existing = self.find_by_external_id(external_id)
        if existing is not None and existing.open:
            return existing
        return self.create(title=title, external_id=external_id, **kwargs)
