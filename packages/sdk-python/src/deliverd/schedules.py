"""A recurring publish: "the board pack, every Friday".

A schedule is an instruction *to* an agent rather than something an agent asks
a person, which is why the writes here refuse an agent key. The read side works
the same way round: an agent sees the schedules addressed to it.

Nothing here publishes anything. The sweep marks a schedule due and emits
``schedule.due``; the agent that owns it does the work and calls
:meth:`Reports.publish`. A schedule that republished by itself would be a cron
job with your credentials, which is a different product.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import quote

from ._http import HttpClient
from ._wire import body_from
from .types import ScheduleSummary

__all__ = ["Schedules"]


class Schedules:
    """The ``/schedules`` half of the API."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, due_only: bool = False) -> List[ScheduleSummary]:
        """Every schedule, or only the ones waiting on a publish.

        Not paged, in either SDK: the count is bounded by the plan's
        ``maxScheduledAgents`` limit, so there is no page to be on the wrong
        side of.
        """
        payload = self._http.request(
            "GET", "/schedules", query={"due": "1"} if due_only else None
        )
        return [ScheduleSummary.from_wire(row) for row in payload.get("schedules", [])]

    def create(
        self,
        report_id: str,
        agent_id: str,
        recurrence: str,
        idempotency_key: Optional[str] = None,
    ) -> ScheduleSummary:
        """Set a timetable.

        ``recurrence`` is a five-field cron expression in UTC, and it has to
        have a next occurrence — ``0 0 30 2 *`` is five well-formed fields and a
        date that never arrives, and is refused rather than stored.
        """
        return ScheduleSummary.from_wire(
            self._http.request(
                "POST",
                "/schedules",
                body=body_from(
                    {"report_id": report_id, "agent_id": agent_id, "recurrence": recurrence}
                ),
                idempotency_key=idempotency_key,
            )
        )

    def update(
        self,
        schedule_id: str,
        recurrence: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> ScheduleSummary:
        """Change the cadence, or turn it on or off.

        Changing the cadence re-times the next run, so moving a weekly publish
        from Friday to Monday does not fire once more on the Friday. Enabling
        one that has been off for a month re-times it too, rather than firing
        immediately on a next run that is in the past.
        """
        return ScheduleSummary.from_wire(
            self._http.request(
                "PATCH",
                "/schedules/{}".format(quote(schedule_id, safe="")),
                body=body_from({"recurrence": recurrence, "enabled": enabled}),
            )
        )

    def delete(self, schedule_id: str) -> None:
        """Remove it.

        A distinct decision from disabling — "the job is over" against "not for
        now" — and audited as its own event. ``update(id, enabled=False)``
        pauses it instead.
        """
        self._http.request("DELETE", "/schedules/{}".format(quote(schedule_id, safe="")))
