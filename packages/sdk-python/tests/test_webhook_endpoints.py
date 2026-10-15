"""``deliverd.webhook_endpoints``: what reaches the wire, and what comes back.

The properties worth pinning are the ones a caller cannot see from the method
signature: the paths and bodies, that the cursor is followed, that the secret is
on the create result and on nothing else, and that an agent key's refusal
arrives as the API's own code.
"""

import json
import os
import sys
import unittest
from typing import Any, Dict, List
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd import (  # noqa: E402
    CreatedWebhookEndpoint,
    Deliverd,
    DeliverdError,
    WebhookEndpoint,
    WebhookTestResult,
)
from deliverd._http import Reply  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402

NOW = "2026-10-09T09:00:00.000Z"


def endpoint(**over: Any) -> Dict[str, Any]:
    row = {
        "id": "8f0c6c9e-0000-4000-8000-000000000001",
        "url": "https://hooks.example.com/deliverd",
        "description": None,
        "events": [],
        "format": "json",
        "enabled": True,
        "failureCount": 0,
        "lastSuccessAt": None,
        "lastFailureAt": None,
        "lastError": None,
        "createdAt": NOW,
    }
    row.update(over)
    return row


class Spy:
    """Records every call and answers from a queue; the last answer repeats."""

    def __init__(self, *answers: Any, status: int = 200) -> None:
        self.answers = list(answers) or [{}]
        self.status = status
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, url, method, body, headers, timeout) -> Reply:
        parsed = urlparse(url)
        self.calls.append(
            {
                "method": method,
                "path": parsed.path.split("/api/v1", 1)[-1],
                "query": {k: v[0] for k, v in parse_qs(parsed.query).items()},
                "body": json.loads(body.decode()) if body else None,
                "headers": dict(headers),
            }
        )
        payload = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return Reply(self.status, {}, "" if payload is None else json.dumps(payload))


def client(spy: Spy) -> Deliverd:
    return Deliverd(api_key="dlv_t", transport=spy, max_retries=1)


class Create(unittest.TestCase):
    def test_sends_the_endpoint_and_returns_the_secret(self):
        spy = Spy(dict(endpoint(format="slack"), secret="dlvw_abc"), status=201)
        created = client(spy).webhook_endpoints.create(
            url="https://hooks.example.com/deliverd",
            events=["approval.approved"],
            format="slack",
        )
        self.assertIsInstance(created, CreatedWebhookEndpoint)
        self.assertEqual(created.secret, "dlvw_abc")
        self.assertEqual(created.format, "slack")
        call = spy.calls[0]
        self.assertEqual((call["method"], call["path"]), ("POST", "/webhook-endpoints"))
        # Unset arguments are left out rather than sent as null.
        self.assertEqual(
            call["body"],
            {"url": "https://hooks.example.com/deliverd", "events": ["approval.approved"], "format": "slack"},
        )

    def test_the_read_shape_has_no_secret_to_carry(self):
        """The secret is on the create result only, and the read model cannot hold one."""
        self.assertIn("secret", CreatedWebhookEndpoint.field_names())
        self.assertNotIn("secret", WebhookEndpoint.field_names())


class ReadChangeRemove(unittest.TestCase):
    def test_get_update_and_delete_address_the_endpoint(self):
        spy = Spy(endpoint(), endpoint(enabled=False), None)
        endpoints = client(spy).webhook_endpoints
        got = endpoints.get("ep/1")
        changed = endpoints.update("ep/1", enabled=False, events=["report.published"])
        endpoints.delete("ep/1")
        self.assertEqual(
            ["{} {}".format(c["method"], c["path"]) for c in spy.calls],
            [
                "GET /webhook-endpoints/ep%2F1",
                "PATCH /webhook-endpoints/ep%2F1",
                "DELETE /webhook-endpoints/ep%2F1",
            ],
        )
        self.assertEqual(spy.calls[1]["body"], {"enabled": False, "events": ["report.published"]})
        self.assertIsInstance(got, WebhookEndpoint)
        self.assertEqual(got.failure_count, 0)
        self.assertFalse(changed.enabled)

    def test_an_empty_description_is_sent_and_none_is_left_out(self):
        """The CHANGELOG tells a caller to clear a description with ``""``; hold it to that."""
        spy = Spy(endpoint())
        client(spy).webhook_endpoints.update("ep_1", description="")
        client(spy).webhook_endpoints.update("ep_1", description=None, enabled=True)
        self.assertEqual(spy.calls[0]["body"], {"description": ""})
        self.assertEqual(spy.calls[1]["body"], {"enabled": True})

    def test_list_follows_the_cursor_to_the_end(self):
        spy = Spy(
            {"webhookEndpoints": [endpoint(id="a")], "nextCursor": "c1"},
            {"webhookEndpoints": [endpoint(id="b")], "nextCursor": None},
        )
        everything = client(spy).webhook_endpoints.list()
        self.assertEqual([e.id for e in everything], ["a", "b"])
        self.assertEqual([c["query"] for c in spy.calls], [{}, {"cursor": "c1"}])

    def test_list_page_returns_one_page_and_its_cursor(self):
        spy = Spy({"webhookEndpoints": [endpoint()], "nextCursor": "next"})
        items, cursor = client(spy).webhook_endpoints.list_page(limit=1)
        self.assertEqual(len(items), 1)
        self.assertEqual(cursor, "next")
        self.assertEqual(spy.calls[0]["query"], {"limit": "1"})


class Test(unittest.TestCase):
    def test_returns_what_the_endpoint_said_delivered_or_not(self):
        spy = Spy({"delivered": False, "responseStatus": 500, "error": "Endpoint answered 500."})
        result = client(spy).webhook_endpoints.test("ep_1", event="approval.approved")
        self.assertIsInstance(result, WebhookTestResult)
        self.assertFalse(result.delivered)
        self.assertEqual(result.response_status, 500)
        self.assertEqual(spy.calls[0]["path"], "/webhook-endpoints/ep_1/test")
        self.assertEqual(spy.calls[0]["body"], {"event": "approval.approved"})

    def test_with_no_event_sends_an_empty_body_for_the_server_default(self):
        spy = Spy({"delivered": True, "responseStatus": 204, "error": None})
        client(spy).webhook_endpoints.test("ep_1")
        self.assertEqual(spy.calls[0]["body"], {})


class Refusals(unittest.TestCase):
    def test_an_agent_key_is_refused_with_the_apis_own_code(self):
        spy = Spy(
            {"error": {"code": "agent_not_permitted", "message": "An agent cannot manage webhook endpoints."}},
            status=403,
        )
        with self.assertRaises(DeliverdError) as caught:
            client(spy).webhook_endpoints.create(url="https://hooks.example.com/x")
        self.assertEqual(caught.exception.code, "agent_not_permitted")
        self.assertEqual(caught.exception.status, 403)

    def test_development_mode_does_not_invent_an_endpoint(self):
        quiet = Deliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        with self.assertRaises(DeliverdError) as caught:
            quiet.webhook_endpoints.create(url="https://hooks.example.com/x")
        # This package's development transport names the refusal `development_only`.
        self.assertEqual(caught.exception.code, "development_only")
        self.assertEqual(caught.exception.status, 501)


class Async(unittest.TestCase):
    def test_the_async_client_mirrors_it(self):
        import asyncio
        import inspect

        aio = AsyncDeliverd(api_key="dlv_t", transport=Spy({"webhookEndpoints": [], "nextCursor": None}))
        self.assertTrue(inspect.iscoroutinefunction(aio.webhook_endpoints.create))
        self.assertEqual(asyncio.run(aio.webhook_endpoints.list()), [])


if __name__ == "__main__":
    unittest.main()
