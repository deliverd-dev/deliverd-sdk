"""Callbacks: being told when a person answers, instead of polling.

Two halves. What goes on the wire when a request names a ``callback_url``, and
what comes back — the secret, handed over once, on the handle ``create()``
returns. Then verifying what arrives at that address, which is the only thing
standing between a receiver and anyone who can POST to it.
"""

import hashlib
import hmac
import json
import time
import unittest

from deliverd import Deliverd, construct_callback
from deliverd._http import HttpClient, Reply
from deliverd.approvals import Approvals
from deliverd.errors import DeliverdError
from deliverd.webhooks import signed_payload

from test_primitives import approval

SECRET = "dlvcb_test"


def sign(body: str, at: int, secret: str = SECRET) -> str:
    digest = hmac.new(secret.encode(), signed_payload(at, body).encode(), hashlib.sha256).hexdigest()
    return "t={},v1={}".format(at, digest)


class AskingToBeCalledBack(unittest.TestCase):
    def test_sends_the_address_and_keeps_the_secret(self):
        sent = {}

        def transport(url, method, body, headers, timeout):
            sent.update(json.loads(body.decode()))
            return Reply(200, {}, json.dumps(dict(approval("pending"), callbackSecret="dlvcb_once")))

        handle = Approvals(HttpClient(api_key="dlv_t", transport=transport)).create(
            title="t", callback_url="https://agent.example.com/hooks/deliverd"
        )
        self.assertEqual(sent["callbackUrl"], "https://agent.example.com/hooks/deliverd")
        self.assertEqual(handle.callback_secret, "dlvcb_once")

    def test_a_read_carries_no_secret(self):
        def transport(url, method, body, headers, timeout):
            return Reply(200, {}, json.dumps(approval("approved")))

        handle = Approvals(HttpClient(api_key="dlv_t", transport=transport)).get("apr_1")
        self.assertIsNone(handle.callback_secret)

    def test_approve_passes_it_through(self):
        sent = {}

        def transport(url, method, body, headers, timeout):
            if method == "POST":
                sent.update(json.loads(body.decode()))
            return Reply(200, {}, json.dumps(approval("approved")))

        Deliverd(api_key="dlv_t", transport=transport).approve(
            title="t", callback_url="https://agent.example.com/cb"
        )
        self.assertEqual(sent["callbackUrl"], "https://agent.example.com/cb")


BODY = json.dumps(
    {
        "event": "approval.approved",
        "sentAt": "2026-09-23T08:00:00Z",
        "requestType": "approval",
        "requestId": "apr_1",
        "data": {"id": "apr_1", "status": "approved"},
    }
)


class ReceivingOne(unittest.TestCase):
    def test_verifies_and_parses(self):
        now = int(time.time())
        envelope = construct_callback(SECRET, BODY, sign(BODY, now), now=now)
        self.assertEqual(envelope.event, "approval.approved")
        self.assertEqual(envelope.request_type, "approval")
        self.assertEqual(envelope.request_id, "apr_1")
        self.assertEqual(envelope.data["status"], "approved")

    def test_refuses_another_requests_secret(self):
        now = int(time.time())
        with self.assertRaises(DeliverdError) as caught:
            construct_callback("dlvcb_other", BODY, sign(BODY, now), now=now)
        self.assertEqual(caught.exception.code, "invalid_signature")

    def test_refuses_an_altered_body(self):
        now = int(time.time())
        forged = BODY.replace("approved", "rejected")
        with self.assertRaises(DeliverdError):
            construct_callback(SECRET, forged, sign(BODY, now), now=now)

    def test_is_on_the_client_too(self):
        now = int(time.time())
        client = Deliverd(api_key="dlv_t")
        self.assertEqual(
            client.webhooks.construct_callback(SECRET, BODY, sign(BODY, now), now=now).request_id, "apr_1"
        )


if __name__ == "__main__":
    unittest.main()
