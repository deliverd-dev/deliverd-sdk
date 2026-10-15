"""Verifying what Deliverd sends.

Every test here is a way an unverified body could get through, because that is
what the module is for: a receiver that skips this is accepting anything anyone
posts at the URL.
"""

import hashlib
import hmac
import json
import time
import unittest

from deliverd.errors import DeliverdError
from deliverd.webhooks import (
    SIGNATURE_HEADER,
    TOLERANCE_SECONDS,
    construct_event,
    signed_payload,
    verify_signature,
)

SECRET = "whsec_test"


def sign(body: str, at: int, secret: str = SECRET) -> str:
    digest = hmac.new(
        secret.encode(), signed_payload(at, body).encode(), hashlib.sha256
    ).hexdigest()
    return "t={},v1={}".format(at, digest)


BODY = json.dumps({"event": "approval.approved", "sentAt": "2026-09-17T12:00:00Z", "data": {"id": "a"}})


class Verifying(unittest.TestCase):
    def test_accepts_a_real_signature(self):
        now = int(time.time())
        self.assertTrue(verify_signature(SECRET, BODY, sign(BODY, now), now=now))

    def test_refuses_the_wrong_secret(self):
        now = int(time.time())
        self.assertFalse(verify_signature("whsec_other", BODY, sign(BODY, now), now=now))

    def test_refuses_a_body_that_changed_after_signing(self):
        now = int(time.time())
        header = sign(BODY, now)
        self.assertFalse(verify_signature(SECRET, BODY.replace('"a"', '"b"'), header, now=now))

    def test_refuses_a_re_encoded_body(self):
        """The commonest way this goes wrong.

        ``json.dumps(json.loads(body))`` is a different string — different
        spacing, maybe different key order — and will never verify. Frameworks
        hand you the parsed object by default, so this is the mistake waiting
        for everyone.
        """
        now = int(time.time())
        header = sign(BODY, now)
        re_encoded = json.dumps(json.loads(BODY), indent=2)
        self.assertFalse(verify_signature(SECRET, re_encoded, header, now=now))

    def test_refuses_a_signature_from_last_week(self):
        # A replay of a real, correctly-signed delivery.
        old = int(time.time()) - TOLERANCE_SECONDS - 1
        self.assertFalse(verify_signature(SECRET, BODY, sign(BODY, old), now=int(time.time())))

    def test_refuses_one_from_the_future_too(self):
        # Symmetric: a clock the sender controls is not a clock to trust.
        ahead = int(time.time()) + TOLERANCE_SECONDS + 1
        self.assertFalse(verify_signature(SECRET, BODY, sign(BODY, ahead), now=int(time.time())))

    def test_refuses_a_missing_or_malformed_header(self):
        now = int(time.time())
        for header in [None, "", "nonsense", "t=,v1=", "v1=abc", "t={}".format(now)]:
            self.assertFalse(verify_signature(SECRET, BODY, header, now=now), repr(header))

    def test_survives_extra_parts_in_the_header(self):
        # Room for a v2 later, without every receiver breaking on the day.
        now = int(time.time())
        header = sign(BODY, now) + ",v2=whatever"
        self.assertTrue(verify_signature(SECRET, BODY, header, now=now))


class Constructing(unittest.TestCase):
    def test_parses_a_verified_body(self):
        now = int(time.time())
        event = construct_event(SECRET, BODY, sign(BODY, now), now=now)
        self.assertEqual(event.event, "approval.approved")
        self.assertEqual(event.sent_at, "2026-09-17T12:00:00Z")
        self.assertEqual(event.data, {"id": "a"})

    def test_raises_rather_than_returning_nothing(self):
        """A route that treats an unverifiable body as "no event" answers 200.

        Which tells whoever is posting that everything is fine.
        """
        with self.assertRaises(DeliverdError) as caught:
            construct_event(SECRET, BODY, "t=1,v1=nope", now=1)
        self.assertEqual(caught.exception.code, "invalid_signature")
        self.assertIn("raw request body", str(caught.exception))

    def test_says_so_when_a_verified_body_is_not_json(self):
        now = int(time.time())
        body = "not json"
        with self.assertRaises(DeliverdError) as caught:
            construct_event(SECRET, body, sign(body, now), now=now)
        self.assertEqual(caught.exception.code, "invalid_json")

    def test_marks_a_test_delivery(self):
        # So a channel never mistakes the sample for a real report.
        now = int(time.time())
        body = json.dumps({"event": "report.published", "sentAt": "x", "data": {}, "test": True})
        self.assertTrue(construct_event(SECRET, body, sign(body, now), now=now).test)


class TheHeaderName(unittest.TestCase):
    def test_is_the_one_the_server_sends(self):
        # Held to the server's own constant by sdk-parity.test.ts; here so the
        # package's own suite fails too if somebody edits it.
        self.assertEqual(SIGNATURE_HEADER, "deliverd-signature")
        self.assertEqual(TOLERANCE_SECONDS, 300)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
