"""Publish HTML to a secure URL — the other half of the product.

An agent that has made something people need to *read* rather than decide on
publishes it here: a versioned URL behind the reader's own sign-in, rather than
an attachment nobody can revoke.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, list_or_collect
from .types import PublishResult, ReportData

__all__ = ["Reports"]


class Reports:
    """The ``/reports`` half of the API."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def publish(
        self,
        title: Optional[str] = None,
        content: Optional[str] = None,
        files: Optional[Sequence[Any]] = None,
        slug: Optional[str] = None,
        description: Optional[str] = None,
        workspace_id: Optional[str] = None,
        audience: Optional[Any] = None,
        classification: Optional[str] = None,
        living: Optional[bool] = None,
        source_tool: Optional[str] = None,
        source_model: Optional[str] = None,
        change_summary: Optional[str] = None,
        expected_version: Optional[int] = None,
        upload_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        flow_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> PublishResult:
        """Put it somewhere people can read it.

        Check :attr:`PublishResult.held` before you tell anyone the link works:
        an organisation's publishing rules can hold a version for a person's
        sign-off, and until they give it nobody can open the page.

        ``task_id`` keeps the report with the task (an objective or a side task)
        it was written for: it is listed on the task and returned in
        ``task.context()``, so the next agent publishes a new version instead of
        a second report. A later publish naming another task moves it; leaving
        it out keeps it where it is. Needs ``tasks:read`` on the key.
        ``flow_id`` puts a first publish in a flow; a new version keeps the
        report's flow.
        """
        body = body_from(
            {
                "title": title,
                "content": content,
                "files": list(files) if files is not None else None,
                "slug": slug,
                "description": description,
                "workspace_id": workspace_id,
                "audience": audience,
                "classification": classification,
                "living": living,
                "source_tool": source_tool,
                "source_model": source_model,
                "change_summary": change_summary,
                "expected_version": expected_version,
                "upload_id": upload_id,
                "flow_id": flow_id,
                "task_id": task_id,
            },
            passthrough=("audience",),
        )
        return PublishResult.from_wire(
            self._http.request("POST", "/reports", body=body, idempotency_key=idempotency_key)
        )

    def update(
        self,
        report_id: str,
        content: Optional[str] = None,
        files: Optional[Sequence[Any]] = None,
        title: Optional[str] = None,
        description: Optional[str] = None,
        source_tool: Optional[str] = None,
        source_model: Optional[str] = None,
        change_summary: Optional[str] = None,
        expected_version: Optional[int] = None,
        upload_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> PublishResult:
        """A new version of something already published.

        ``expected_version`` is how two agents publishing the same report stay
        out of each other's way: pass the version you read and the API refuses
        rather than overwriting somebody's work from a minute ago.

        ``task_id`` moves the report to another task; leave it out to keep the
        task it already has.
        """
        body = body_from(
            {
                "content": content,
                "files": list(files) if files is not None else None,
                "title": title,
                "description": description,
                "source_tool": source_tool,
                "source_model": source_model,
                "change_summary": change_summary,
                "expected_version": expected_version,
                "upload_id": upload_id,
                "task_id": task_id,
            }
        )
        return PublishResult.from_wire(
            self._http.request(
                "POST",
                "/reports/{}/versions".format(report_id),
                body=body,
                idempotency_key=idempotency_key,
            )
        )

    def get(self, report_id: str) -> ReportData:
        return ReportData.from_wire(self._http.request("GET", "/reports/" + report_id))

    def list(
        self,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> List[ReportData]:
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(limit=page_limit, cursor=page_cursor),
        )

    def list_page(
        self, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> "Page[ReportData]":
        payload = self._http.request("GET", "/reports", query={"limit": limit, "cursor": cursor})
        return Page(
            [ReportData.from_wire(row) for row in payload.get("reports", [])],
            payload.get("nextCursor"),
        )

    def share(
        self, report_id: str, audience: Any, capability: Optional[str] = None
    ) -> Dict[str, Any]:
        """Let somebody else open it. Names, teams, groups or emails.

        ``capability`` is what they may do: ``"view"`` (the default) or
        ``"comment"``. "Can manage", which lets someone share it on, is a
        person's decision made in the app and is not offered here.
        """
        body: Dict[str, Any] = {"audience": audience}
        if capability is not None:
            body["capability"] = capability
        return self._http.request("POST", "/reports/{}/share".format(report_id), body=body)
