"""``on_unavailable``: what ``gate()`` does when Deliverd cannot be reached.

A network failure or a 5xx is an outage the caller chose how to ride out; a
4xx is a bug or an answer, and is never hidden.
"""

import json
import unittest
from typing import Any

from deliverd import Deliverd
from deliverd._http import Reply
from deliverd.errors import DeliverdError

ASK = {"action": "finance.refund", "external_id": "refund:1", "input": {"amount": 10}}


def client(reply: Any) -> Deliverd:
    def transport(url, method, body, headers, timeout):  # type: ignore[no-untyped-def]
        if isinstance(reply, Exception):
            raise reply
        return reply

    return Deliverd(api_key="dlv_test", transport=transport, max_retries=1)


def status(code: int) -> Reply:
    return Reply(code, {}, json.dumps({"error": {"code": "not_found" if code == 404 else "server_error", "message": "x"}}))


class GateWhenUnreachable(unittest.TestCase):
    def test_raises_by_default(self):
        with self.assertRaises(DeliverdError):
            client(OSError("down")).gate(**ASK)

    def test_deny_refuses_and_says_so(self):
        d = client(OSError("down")).gate(**ASK, on_unavailable="deny")
        self.assertFalse(d.allowed)
        self.assertEqual(d.status, "denied")
        self.assertTrue(d.unavailable)
        self.assertEqual(d.id, "")
        self.assertIsNone(d.decision_token)

    def test_allow_answers_yes_with_the_callers_input(self):
        d = client(status(503)).gate(**ASK, on_unavailable="allow")
        self.assertTrue(d.allowed)
        self.assertTrue(d.unavailable)
        self.assertEqual(d.input, {"amount": 10})

    def test_never_turns_a_4xx_into_an_answer(self):
        with self.assertRaises(DeliverdError) as caught:
            client(status(404)).gate(**ASK, on_unavailable="allow")
        self.assertEqual(caught.exception.status, 404)

    def test_rejects_an_unknown_mode(self):
        with self.assertRaises(ValueError):
            client(status(503)).gate(**ASK, on_unavailable="maybe")

    def test_sends_model_and_traceparent(self):
        sent = {}

        def transport(url, method, body, headers, timeout):  # type: ignore[no-untyped-def]
            sent.update(json.loads(body.decode()))
            return Reply(201, {}, json.dumps({"id": "g", "status": "allowed", "allowed": True, "input": {}, "reason": None, "rule": None}))

        tp = "00-" + "a" * 32 + "-" + "b" * 16 + "-01"
        Deliverd(api_key="dlv_test", transport=transport).gates.create(action_id="x", input={}, external_id="e", model="claude-sonnet-4-5", traceparent=tp)
        self.assertEqual(sent["model"], "claude-sonnet-4-5")
        self.assertEqual(sent["traceparent"], tp)


if __name__ == "__main__":
    unittest.main()
