"""The behaviour this SDK shares with the TypeScript one, read from one table.

Everything else that compares the two packages compares *shapes* — exported
names, namespaces, every field of every type. Both SDKs then drifted in
behaviour anyway, in opposite directions, and neither was caught by any check:
this package's development mode could not start a flow, TypeScript's would not
publish and this one faked it. Both were found by installing a package and
running its own README.

So the cases live in ``packages/conformance/cases.json`` and both suites read
it. A case added there fails in whichever language has not implemented it,
which is the property that was missing.
"""

import json
import os
import time
import unittest
from typing import Any, Dict, List, Mapping, Optional

from deliverd._http import HttpClient, Reply
from deliverd.duration import duration_seconds
from deliverd.errors import DeliverdError
from deliverd.webhooks import TOLERANCE_SECONDS, verify_signature

CASES: Dict[str, Any] = json.load(
    open(
        os.path.join(os.path.dirname(__file__), "..", "..", "conformance", "cases.json"),
        encoding="utf-8",
    )
)


class Answering:
    """A transport that always answers the same way, and counts the asking.

    ``retry-after: 0`` so the suite does not spend real seconds asleep proving
    an attempt count. It is the same retry path either way — ``_is_retryable``
    reads the status and nothing else — and the header's own conversion is
    pinned separately below, where the number matters.
    """

    def __init__(self, status: int, retry_after: str = "0") -> None:
        self.status = status
        self.retry_after = retry_after
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        url: str,
        method: str,
        body: Optional[bytes],
        headers: Mapping[str, str],
        timeout: float,
    ) -> Reply:
        self.calls.append({"at": time.monotonic(), "headers": {k.lower(): v for k, v in headers.items()}})
        return Reply(
            self.status,
            {"content-type": "application/json", "retry-after": self.retry_after},
            json.dumps({"error": {"code": "x", "message": "x"}}),
        )


def client(transport: Any, **kwargs: Any) -> HttpClient:
    return HttpClient(api_key="dlv_conformance", transport=transport, **kwargs)


class Durations(unittest.TestCase):
    def test_reads_every_shared_string_the_same_way(self):
        shared = CASES["durations"]["shared"]
        self.assertGreater(len(shared), 5)
        for case in shared:
            self.assertEqual(
                duration_seconds(case["input"]),
                float(case["seconds"]),
                "duration_seconds({!r})".format(case["input"]),
            )

    def test_a_bare_number_is_seconds_because_that_is_what_sleep_takes(self):
        # The one deliberate divergence, and the table has to say why in its
        # own field rather than leaving the next reader to guess whether it is
        # a bug. `time.sleep` counts seconds and `setTimeout` counts
        # milliseconds; reading either as the other is wrong by a thousand in
        # code that looks right.
        for case in CASES["durations"]["divergent"]:
            self.assertGreater(len(case["why"]), 40, "A divergence needs a reason, not a note.")
            self.assertEqual(duration_seconds(case["input"]), float(case["py_seconds"]))

    def test_refuses_everything_the_table_says_is_not_a_duration(self):
        for value in CASES["durations"]["rejected"]:
            with self.assertRaises((ValueError, TypeError), msg=repr(value)):
                duration_seconds(value)


class Retries(unittest.TestCase):
    def test_the_same_answers_are_worth_asking_again(self):
        attempts = CASES["retries"]["_maxAttempts"]
        self.assertGreater(len(CASES["retries"]["cases"]), 8)
        for case in CASES["retries"]["cases"]:
            spy = Answering(case["status"])
            with self.assertRaises(DeliverdError):
                client(spy, max_retries=attempts).request("GET", "/reports")
            self.assertEqual(
                len(spy.calls),
                case["attempts"],
                "{} was asked {}x and the table says {} — {}".format(
                    case["status"], len(spy.calls), case["attempts"], case["why"]
                ),
            )


class RetryAfterHeader(unittest.TestCase):
    def test_turns_the_headers_seconds_into_seconds(self):
        """A Retry-After of 2 is two seconds of waiting, not two thousand.

        Asserted as a floor rather than an equality — a machine under load
        sleeps longer, and what a unit slip does is make the retry fire a
        thousand times too early.
        """
        spy = Answering(503, retry_after=CASES["retryAfter"]["header"])
        self.assertTrue(CASES["retryAfter"]["honoured"])
        with self.assertRaises(DeliverdError):
            client(spy, max_retries=2).request("GET", "/reports")
        self.assertEqual(len(spy.calls), 2)
        waited = spy.calls[1]["at"] - spy.calls[0]["at"]
        self.assertGreaterEqual(
            waited,
            CASES["retryAfter"]["py_seconds"] * 0.9,
            "The retry came after {:.3f}s and Retry-After said {}s.".format(
                waited, CASES["retryAfter"]["py_seconds"]
            ),
        )


class Idempotency(unittest.TestCase):
    def test_a_retried_post_carries_one_key(self):
        # The key exists so a retry cannot create a second thing. A client that
        # mints a fresh one per attempt has the bug the header was added to
        # prevent, and it only appears under a retry — which is exactly when
        # nobody is watching.
        spec = CASES["idempotency"]
        spy = Answering(spec["retryStatus"])
        with self.assertRaises(DeliverdError):
            client(spy, max_retries=CASES["retries"]["_maxAttempts"]).request(
                "POST", "/approvals", body={"title": "x"}
            )
        self.assertEqual(len(spy.calls), spec["expectedAttempts"])
        keys = {c["headers"].get(spec["header"]) for c in spy.calls}
        self.assertNotIn(None, keys, "A POST went out with no idempotency key.")
        self.assertEqual(
            len(keys),
            1,
            "{} different idempotency keys across {} attempts. A retry that mints a new "
            "key is a second create.".format(len(keys), len(spy.calls)),
        )


class Signatures(unittest.TestCase):
    def test_agrees_with_the_tables_fixed_vectors(self):
        """Fixed vectors rather than sign-then-verify.

        A round trip passes even when both ends are wrong in the same way, and
        the thing at stake is a receiver somebody wrote against the other SDK.
        """
        spec = CASES["signatures"]
        self.assertEqual(spec["toleranceSeconds"], TOLERANCE_SECONDS)
        for case in spec["cases"]:
            self.assertEqual(
                verify_signature(
                    spec["secret"],
                    spec["body"],
                    case["header"],
                    now=case["now"],
                    tolerance_seconds=spec["toleranceSeconds"],
                ),
                case["verifies"],
                "{}: expected {}".format(case["name"], case["verifies"]),
            )


class Gate(unittest.TestCase):
    """The gate answers the same in both SDKs.

    Run against a real handle rather than asserted as a table of its own.
    ``allowed`` is a derived boolean and the one an agent branches on: a
    language that got it wrong would make a refund the other would not, with
    nothing raised either way.
    """

    def _handle(self, status, allowed):
        from deliverd.gates import Gate as GateHandle
        from deliverd.types import GateData

        return GateHandle(
            None,
            GateData.from_wire(
                {
                    "id": "gat_1",
                    "status": status,
                    "allowed": allowed,
                    "input": {},
                    "basis": "policy",
                    "reason": None,
                    "rule": None,
                    "policyVersionId": None,
                    "approvalId": None,
                    "approvalUrl": None,
                    "outcome": None,
                    "settledAt": None,
                    "reused": False,
                }
            ),
        )

    def test_agrees_on_what_counts_as_permission(self):
        for case in CASES["gate"]["allowed"]:
            gate = self._handle(case["status"], case["allowed"])
            self.assertEqual(
                gate.allowed, case["allowed"], "{}: {}".format(case["status"], case["why"])
            )
            self.assertEqual(gate.pending, case["status"] == "pending")
            self.assertEqual(gate.denied, case["status"] == "denied")
            # The flattened answer must agree with the handle, or `gate()` and
            # `gates.create()` disagree about the same decision.
            self.assertEqual(gate.to_decision().allowed, case["allowed"])
            self.assertEqual(gate.to_decision().status, case["status"])

    def test_requires_the_callers_own_id_as_the_idempotency_key(self):
        from deliverd import Deliverd

        self.assertTrue(CASES["gate"]["externalId"]["required"])
        self.assertTrue(CASES["gate"]["externalId"]["sentAsIdempotencyKey"])

        seen = {}

        def transport(url, method, body, headers, timeout):
            from deliverd._http import Reply

            seen["key"] = {k.lower(): v for k, v in headers.items()}.get("idempotency-key")
            return Reply(
                201,
                {"content-type": "application/json"},
                json.dumps(self._handle("allowed", True).data.raw),
            )

        client = Deliverd(api_key="dlv_test", transport=transport)
        client.gates.create(action_id="finance.refund", input={}, external_id="refund:1")
        self.assertEqual(
            seen["key"],
            "refund:1",
            "The gate sent a random idempotency key instead of the caller's id, so a "
            "retry would ask a second person about the same money.",
        )

    def test_offers_the_same_development_outcomes(self):
        from deliverd.dev import OUTCOMES

        self.assertEqual(
            list(OUTCOMES), CASES["gate"]["developmentOutcomes"]["outcomes"]
        )


class Resume(unittest.TestCase):
    """A restarted agent picks its flow and its objective up in every SDK."""

    def _offline(self) -> Any:
        from deliverd import Deliverd
        from deliverd.dev import DevelopmentOptions

        return Deliverd(mode="development", development=DevelopmentOptions(log=False))

    def test_resumes_the_open_flow_and_never_a_closed_one(self):
        case = CASES["resume"]["flow"]
        c = self._offline()
        first = c.flows.resume(title=case["title"], external_id=case["externalId"])
        again = c.flows.resume(title=case["title"], external_id=case["externalId"])
        self.assertEqual(again.id == first.id, case["restartReturnsTheOpenFlow"], case["why"])
        first.close()
        after = c.flows.resume(title=case["title"], external_id=case["externalId"])
        self.assertEqual(after.id != first.id, case["closedFlowStartsANewOne"], case["why"])
        self.assertTrue(after.open)

    def test_returns_the_open_objective_and_says_it_resumed(self):
        case = CASES["resume"]["task"]
        c = self._offline()
        kwargs = dict(title=case["title"], objective=case["objective"], external_id=case["externalId"])
        first = c.tasks.create(**kwargs)
        self.assertFalse(first.resumed)
        again = c.tasks.create(**kwargs)
        self.assertEqual(again.id == first.id, case["restartReturnsTheOpenObjective"], case["why"])
        self.assertEqual(again.resumed, case["resumedIsTrue"], case["why"])
        first.complete(summary="Done.")
        after = c.tasks.create(**kwargs)
        self.assertEqual(after.id != first.id, case["completedObjectiveStartsANewOne"], case["why"])
        self.assertFalse(after.resumed)
