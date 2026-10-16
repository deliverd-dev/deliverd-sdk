"""An organisation's webhook endpoints: where its events are sent.

::

    endpoint = deliverd.webhook_endpoints.create(
        url="https://hooks.example.com/deliverd",
        events=["approval.approved", "approval.rejected"],
    )
    save_secret(endpoint.secret)  # returned this once, never again

**Needs an administrator's key with ``webhooks:manage``.** An endpoint receives
every event in the organisation, so the API checks the key's holder is an owner
or an administrator on every call, and refuses an agent key outright
(``agent_not_permitted``) — reads included.

Distinct from ``deliverd.webhooks``, which verifies what arrives at an endpoint
and makes no request at all.
"""

from __future__ import annotations

from typing import List, Optional, Sequence
from urllib.parse import quote

from ._http import HttpClient
from ._wire import body_from
from .paging import Page, list_or_collect
from .types import CreatedWebhookEndpoint, WebhookEndpoint, WebhookTestResult

__all__ = ["WebhookEndpoints"]


def _path(endpoint_id: str) -> str:
    return "/webhook-endpoints/{}".format(quote(endpoint_id, safe=""))


class WebhookEndpoints:
    """The ``/webhook-endpoints`` half of the API."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None) -> List[WebhookEndpoint]:
        """Newest first. With no ``limit`` this is every endpoint; with one, a page of that size."""
        return list_or_collect(
            limit,
            cursor,
            lambda page_limit, page_cursor: self.list_page(limit=page_limit, cursor=page_cursor),
        )

    def list_page(self, limit: Optional[int] = None, cursor: Optional[str] = None) -> "Page[WebhookEndpoint]":
        payload = self._http.request(
            "GET", "/webhook-endpoints", query={"limit": limit, "cursor": cursor}
        )
        return Page(
            [WebhookEndpoint.from_wire(row) for row in payload.get("webhookEndpoints", [])],
            payload.get("nextCursor"),
        )

    def create(
        self,
        url: str,
        events: Optional[Sequence[str]] = None,
        description: Optional[str] = None,
        format: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> CreatedWebhookEndpoint:
        """Add an endpoint. The result carries ``secret`` — the only time it is returned.

        ``url`` must be HTTPS on a public host. Leave ``events`` out, or pass an
        empty list, for every event except the opt-in ones. ``format`` is
        ``json`` (the default), ``slack``, ``teams`` or ``discord``. A retried call replays
        this same response, secret included, rather than adding a second one.
        """
        return CreatedWebhookEndpoint.from_wire(
            self._http.request(
                "POST",
                "/webhook-endpoints",
                body=body_from(
                    {
                        "url": url,
                        "events": list(events) if events is not None else None,
                        "description": description,
                        "format": format,
                    }
                ),
                idempotency_key=idempotency_key,
            )
        )

    def get(self, endpoint_id: str) -> WebhookEndpoint:
        """One endpoint, with its delivery health. Never its secret."""
        return WebhookEndpoint.from_wire(self._http.request("GET", _path(endpoint_id)))

    def update(
        self,
        endpoint_id: str,
        url: Optional[str] = None,
        events: Optional[Sequence[str]] = None,
        description: Optional[str] = None,
        format: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> WebhookEndpoint:
        """Change what you pass and nothing else; pass at least one.

        Turning an endpoint back on (``enabled=True``) clears its run of
        failures. The secret cannot be changed: delete and add again for a new one.
        """
        return WebhookEndpoint.from_wire(
            self._http.request(
                "PATCH",
                _path(endpoint_id),
                body=body_from(
                    {
                        "url": url,
                        "events": list(events) if events is not None else None,
                        "description": description,
                        "format": format,
                        "enabled": enabled,
                    }
                ),
            )
        )

    def delete(self, endpoint_id: str) -> None:
        """Remove it, and its delivery log. ``update(id, enabled=False)`` pauses it instead."""
        self._http.request("DELETE", _path(endpoint_id))

    def test(self, endpoint_id: str, event: Optional[str] = None) -> WebhookTestResult:
        """Send it one event now and return what it answered.

        ``"test": true`` and obviously fake ids; ``report.published`` unless you
        name another. Never retried, never counted toward switching the endpoint
        off. ``delivered=False`` is an answer about the endpoint, not an error.
        """
        return WebhookTestResult.from_wire(
            self._http.request(
                "POST",
                "/webhook-endpoints/{}/test".format(quote(endpoint_id, safe="")),
                body=body_from({"event": event}),
            )
        )
