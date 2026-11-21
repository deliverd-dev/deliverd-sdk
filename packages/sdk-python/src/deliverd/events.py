"""Be told, instead of asking.

Deliverd speaks MCP Events (``io.modelcontextprotocol/events``, SEP-3415): an
approval decided, a gate settled, a review landed, a screening held for a
person, an agent drifting. MCP clients hear them on ``/api/mcp/v2``; this
module reads the same log over REST, for code that is not an MCP client::

    approval = deliverd.approvals.create(title="Refund £1,240", approvers=["finance@firm.example"])
    decided = deliverd.events.wait_for_decision(approval_id=approval.id)
    if decided["status"] == "approved":
        refund()

Nothing here changes ``approval.wait()`` or ``gate.wait()``. This is the opt-in
alternative that reads one cursor, and it falls back to reading the request
when the server it is pointed at has no events (an older self-hosted copy).
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional
from urllib.parse import quote

from ._http import HttpClient
from .approvals import _sleep
from .errors import DeliverdError, DeliverdTimeoutError

EVENT_NAMES = (
    "approval.decided",
    "approval.question",
    "approval.requested",
    "gate.decided",
    "gate.denied",
    "review.settled",
    "collection.completed",
    "task.updated",
    "screen.held",
    "drift.detected",
    "risk_indicator.breached",
    "context.changed",
)

_SETTLED = {"approved", "rejected", "changes_requested", "expired", "cancelled", "revoked", "denied", "allowed", "used"}


class Events:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self) -> List[Dict[str, Any]]:
        """The events this key's scopes can hear."""
        return self._http.request("GET", "/events")["events"]

    def poll(
        self,
        name: str,
        arguments: Optional[Dict[str, str]] = None,
        cursor: Optional[str] = None,
        max_age_ms: Optional[int] = None,
        max_events: Optional[int] = None,
    ) -> Dict[str, Any]:
        """One poll: what happened since ``cursor`` (``None`` starts from now)."""
        body: Dict[str, Any] = {"name": name, "arguments": arguments or {}, "cursor": cursor}
        if max_age_ms is not None:
            body["maxAgeMs"] = max_age_ms
        if max_events is not None:
            body["maxEvents"] = max_events
        return self._http.request("POST", "/events/poll", body=body)

    def watch(
        self,
        name: str,
        arguments: Optional[Dict[str, str]] = None,
        cursor: Optional[str] = None,
        on_cursor: Optional[Callable[[str], None]] = None,
        cancel: Optional[threading.Event] = None,
        min_poll_seconds: float = 1.0,
    ) -> Iterator[Dict[str, Any]]:
        """Every matching event as it happens, until ``cancel`` is set."""
        while cancel is None or not cancel.is_set():
            page = self.poll(name, arguments, cursor)
            cursor = page["cursor"]
            if on_cursor:
                on_cursor(cursor)
            for event in page["events"]:
                yield event
            if not page.get("hasMore"):
                _sleep(max(min_poll_seconds, page.get("nextPollMs", 15000) / 1000.0), cancel)

    def wait_for_decision(
        self,
        approval_id: Optional[str] = None,
        gate_id: Optional[str] = None,
        timeout: Optional[float] = None,
        cancel: Optional[threading.Event] = None,
        min_poll_seconds: float = 1.0,
    ) -> Dict[str, Any]:
        """Wait for one approval or gate to settle, told by an event.

        Returns ``{"status", "data", "via"}`` (and ``canExecute`` for a gate),
        ``via`` being ``"event"`` or ``"read"`` when it fell back to reading.
        """
        if (approval_id is None) == (gate_id is None):
            raise ValueError("pass exactly one of approval_id or gate_id")
        is_gate = gate_id is not None
        target = gate_id if is_gate else approval_id
        assert target is not None
        name = "gate.decided" if is_gate else "approval.decided"
        read_path = ("/gates/" if is_gate else "/approvals/") + quote(target, safe="")
        deadline = time.monotonic() + timeout if timeout is not None else None

        def shaped(data: Dict[str, Any], via: str) -> Dict[str, Any]:
            out: Dict[str, Any] = {"status": str(data.get("status", "")), "data": data, "via": via}
            if is_gate:
                out["canExecute"] = data.get("canExecute") is True
            return out

        def read() -> Optional[Dict[str, Any]]:
            data = self._http.request("GET", read_path)
            status = str(data.get("status", ""))
            if status in _SETTLED or (is_gate and data.get("canExecute") is True):
                return shaped(data, "read")
            return None

        events = True
        cursor: Optional[str] = None
        try:
            cursor = self.poll(name, {"id": target}, None)["cursor"]
        except DeliverdError as err:
            if err.status != 404:
                raise
            events = False

        first = read()
        if first:
            return first

        pause = 2.0
        while True:
            if cancel is not None and cancel.is_set():
                raise DeliverdError(0, "aborted", "The wait was aborted.")
            if deadline is not None and time.monotonic() >= deadline:
                raise DeliverdTimeoutError("No decision on {} within the timeout.".format(target))
            if events:
                page = self.poll(name, {"id": target}, cursor)
                cursor = page["cursor"]
                if page["events"]:
                    return shaped(page["events"][0]["data"], "event")
                if page.get("truncated"):
                    settled = read()
                    if settled:
                        return settled
                pause = 0.0 if page.get("hasMore") else page.get("nextPollMs", 3000) / 1000.0
            else:
                settled = read()
                if settled:
                    return settled
                pause = min(15.0, pause * 1.5)
            wait = max(min_poll_seconds, pause)
            if deadline is not None:
                wait = min(wait, max(0.0, deadline - time.monotonic()))
            _sleep(wait, cancel)
