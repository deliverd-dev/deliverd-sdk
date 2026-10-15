"""What the client does on the wire, and what it does when the wire fails."""

import json
import unittest
from typing import Any, Dict, List, Mapping, Optional

from deliverd._http import HttpClient, Reply
from deliverd.errors import DeliverdError


class Recorder:
    """A transport that records what it was asked and answers from a script."""

    def __init__(self, *replies: Reply) -> None:
        self.replies = list(replies)
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        url: str,
        method: str,
        body: Optional[bytes],
        headers: Mapping[str, str],
        timeout: float,
    ) -> Reply:
        self.calls.append(
            {
                "url": url,
                "method": method,
                "body": json.loads(body.decode()) if body else None,
                "headers": dict(headers),
            }
        )
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def ok(payload: Any = None, status: int = 200, headers: Optional[Dict[str, str]] = None) -> Reply:
    return Reply(status, headers or {}, json.dumps(payload if payload is not None else {}))


def failure(status: int, code: str, message: str, headers: Optional[Dict[str, str]] = None) -> Reply:
    return Reply(status, headers or {}, json.dumps({"error": {"code": code, "message": message}}))


def client(transport: Any, **kwargs: Any) -> HttpClient:
    kwargs.setdefault("max_retries", 3)
    # No waiting in the suite. The curve itself is checked in Backoff below,
    # where it is the thing under test rather than a delay in front of one.
    kwargs.setdefault("backoff", lambda attempt: 0.0)
    return HttpClient(api_key="dlv_test", transport=transport, **kwargs)


class TheRequest(unittest.TestCase):
    def test_sends_the_key_as_a_bearer_token(self):
        t = Recorder(ok({"id": "a"}))
        client(t).request("GET", "/approvals/a")
        self.assertEqual(t.calls[0]["headers"]["Authorization"], "Bearer dlv_test")

    def test_builds_the_v1_url_and_drops_unset_query_parameters(self):
        t = Recorder(ok({"approvals": []}))
        client(t).request("GET", "/approvals", query={"status": "pending", "limit": None})
        self.assertEqual(t.calls[0]["url"], "https://deliverd.dev/api/v1/approvals?status=pending")

    def test_refuses_to_exist_without_a_key(self):
        # Caught here rather than as a 401 three seconds later, with the hint
        # that names the environment variable.
        with self.assertRaises(DeliverdError) as caught:
            HttpClient(api_key="")
        self.assertEqual(caught.exception.code, "no_api_key")
        self.assertIn("DELIVERD_API_KEY", str(caught.exception))

    def test_carries_a_correlation_id_so_there_is_something_to_quote(self):
        t = Recorder(ok())
        client(t).request("GET", "/approvals")
        self.assertTrue(t.calls[0]["headers"]["deliverd-correlation-id"])


class Idempotency(unittest.TestCase):
    def test_a_post_carries_a_key(self):
        t = Recorder(ok({"id": "a"}))
        client(t).request("POST", "/approvals", body={"title": "t"})
        self.assertIn("Idempotency-Key", t.calls[0]["headers"])

    def test_a_get_does_not_because_nothing_is_created(self):
        t = Recorder(ok())
        client(t).request("GET", "/approvals")
        self.assertNotIn("Idempotency-Key", t.calls[0]["headers"])

    def test_the_key_is_held_across_retries(self):
        """The whole reason the server needs replay protection.

        A POST that arrived and lost its response on the way back is retried
        here. A fresh key on the retry would make it a second create — and for
        an approval that means two people asked to authorise one act.
        """
        t = Recorder(failure(503, "unavailable", "try later"), ok({"id": "a"}))
        client(t, max_retries=2).request("POST", "/approvals", body={"title": "t"})
        first, second = t.calls
        self.assertEqual(first["headers"]["Idempotency-Key"], second["headers"]["Idempotency-Key"])

    def test_the_caller_can_supply_their_own(self):
        # A job that reruns from the start after a crash wants the key its
        # first run used, which only the caller knows how to derive.
        t = Recorder(ok({"id": "a"}))
        client(t).request("POST", "/approvals", body={}, idempotency_key="job-42")
        self.assertEqual(t.calls[0]["headers"]["Idempotency-Key"], "job-42")


class Retries(unittest.TestCase):
    def test_repeats_a_429(self):
        t = Recorder(failure(429, "rate_limited", "slow down"), ok({"id": "a"}))
        result = client(t, max_retries=2).request("GET", "/approvals/a")
        self.assertEqual(result, {"id": "a"})
        self.assertEqual(len(t.calls), 2)

    def test_repeats_a_5xx(self):
        t = Recorder(failure(500, "server_error", "oops"), ok({"id": "a"}))
        client(t, max_retries=2).request("GET", "/approvals/a")
        self.assertEqual(len(t.calls), 2)

    def test_repeats_a_dropped_connection(self):
        t = Recorder(OSError("connection reset"), ok({"id": "a"}))
        client(t, max_retries=2).request("GET", "/approvals/a")
        self.assertEqual(len(t.calls), 2)

    def test_does_not_repeat_a_501(self):
        """"Not implemented" is a fact about the server, not about this moment."""
        t = Recorder(failure(501, "development_only", "not here"), ok({"id": "a"}))
        with self.assertRaises(DeliverdError):
            client(t, max_retries=3).request("GET", "/x")
        self.assertEqual(len(t.calls), 1)

    def test_does_repeat_the_5xx_that_might_pass_next_time(self):
        for status in (500, 502, 503, 504):
            t = Recorder(failure(status, "server_error", "oops"), ok({"id": "a"}))
            client(t, max_retries=2).request("GET", "/x")
            self.assertEqual(len(t.calls), 2, "status {} was not retried".format(status))

    def test_does_not_repeat_a_4xx(self):
        """A 4xx is the API saying the request itself is wrong.

        It will be just as wrong in a second, and retrying a self-approval
        refusal three times is three log lines saying the same thing.
        """
        t = Recorder(failure(403, "self_approval", "no"), ok({"id": "a"}))
        with self.assertRaises(DeliverdError):
            client(t, max_retries=3).request("GET", "/approvals/a")
        self.assertEqual(len(t.calls), 1)

    def test_honours_retry_after_rather_than_guessing(self):
        # Guessing against a server that has told you the answer is how a
        # client turns a rate limit into an outage. The curve here would return
        # zero, so a wait that happens at all came from the header.
        waited = []
        t = Recorder(
            failure(429, "rate_limited", "slow down", {"Retry-After": "0.02"}), ok({"id": "a"})
        )
        import time as _time

        before = _time.monotonic()
        client(t, max_retries=2).request("GET", "/approvals/a")
        waited.append(_time.monotonic() - before)
        self.assertEqual(len(t.calls), 2)
        self.assertGreaterEqual(waited[0], 0.02)

    def test_gives_up_and_raises_the_last_failure(self):
        t = Recorder(*[failure(503, "unavailable", "later") for _ in range(3)])
        with self.assertRaises(DeliverdError) as caught:
            client(t, max_retries=3).request("GET", "/approvals/a")
        self.assertEqual(caught.exception.status, 503)


class Answers(unittest.TestCase):
    def test_maps_the_error_envelope_onto_the_exception(self):
        t = Recorder(Reply(403, {}, json.dumps({"error": {"code": "self_approval", "message": "no"}})))
        with self.assertRaises(DeliverdError) as caught:
            client(t).request("GET", "/approvals/a")
        err = caught.exception
        self.assertEqual(err.code, "self_approval")
        self.assertTrue(err.is_auth)
        self.assertFalse(err.is_rate_limit)
        # The hint is what the developer actually needs, and it is on the message.
        self.assertIn("Name somebody else", str(err))

    def test_a_204_is_none_rather_than_a_json_error(self):
        self.assertIsNone(client(Recorder(Reply(204, {}, ""))).request("POST", "/x/cancel"))

    def test_says_what_it_got_when_the_body_is_not_json(self):
        t = Recorder(Reply(200, {}, "<html>gateway</html>"))
        with self.assertRaises(DeliverdError) as caught:
            client(t).request("GET", "/approvals")
        self.assertEqual(caught.exception.code, "invalid_response")
        self.assertIn("<html>", str(caught.exception))

    def test_a_programming_error_in_the_transport_surfaces_as_itself(self):
        """Not every failure is the network, and saying so wastes somebody's hour.

        A blanket `except Exception` here turned a mistyped development option
        into "Could not reach Deliverd — check your network", retried three
        times first. Found by typing one.
        """

        def broken(url, method, body, headers, timeout):
            raise ValueError("Unknown development outcome 'maybe'.")

        with self.assertRaises(ValueError):
            client(broken).request("GET", "/approvals")

    def test_a_truncated_response_is_a_network_failure_though(self):
        # urllib does not report this as an OSError, so it needs naming.
        import http.client

        def cut_off(url, method, body, headers, timeout):
            raise http.client.IncompleteRead(b"half")

        with self.assertRaises(DeliverdError) as caught:
            client(cut_off, max_retries=1).request("GET", "/approvals")
        self.assertEqual(caught.exception.code, "network_error")

    def test_a_network_failure_says_which_host_to_check(self):
        t = Recorder(OSError("nodename nor servname provided"))
        with self.assertRaises(DeliverdError) as caught:
            client(t, max_retries=1).request("GET", "/approvals")
        self.assertEqual(caught.exception.code, "network_error")
        self.assertIn("base_url", str(caught.exception))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class Backoff(unittest.TestCase):
    """The curve itself, where it is the thing under test."""

    def test_grows_and_is_jittered_and_has_a_ceiling(self):
        from deliverd._http import _backoff_seconds

        # Jitter, so a fleet of agents started by one cron does not resonate:
        # every delay sits in the lower and upper half of its own base.
        for attempt, base in [(1, 0.5), (2, 1.0), (3, 2.0), (9, 8.0)]:
            seen = {round(_backoff_seconds(attempt), 4) for _ in range(50)}
            self.assertGreater(len(seen), 1, "attempt {} is not jittered".format(attempt))
            for value in seen:
                self.assertGreaterEqual(value, base / 2)
                self.assertLessEqual(value, base)
