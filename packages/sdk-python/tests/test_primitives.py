"""The four verbs, against a scripted API.

The point of these is the *wait*: that it ends, that it ends on a refusal as
well as an approval, and that it says something useful when it does not end.
"""

import json
import threading
import unittest
from typing import Any, Dict, List, Mapping, Optional

from deliverd import Deliverd
from deliverd._http import HttpClient, Reply
from deliverd.approvals import Approvals
from deliverd.collections import Collections
from deliverd.errors import DeliverdError, DeliverdTimeoutError
from deliverd.reviews import Reviews

NOW = "2026-09-17T12:00:00Z"


def approval(status: str = "pending", **over: Any) -> Dict[str, Any]:
    row = {
        "id": "apr_1",
        "status": status,
        "url": "https://deliverd.dev/approve/apr_1",
        "title": "Refund £1,240 to Acme",
        "description": None,
        "risk": "high",
        "factors": [],
        "links": [],
        "reportId": None,
        "externalId": None,
        "metadata": {},
        "requestedBy": "Agent",
        "approvers": ["Finance"],
        "requiredApprovals": 1,
        "approvalsSoFar": 1 if status == "approved" else 0,
        "decidedBy": "Sarah Chen" if status in ("approved", "rejected") else None,
        "decidedById": "u_9" if status in ("approved", "rejected") else None,
        "decidedAt": NOW if status in ("approved", "rejected") else None,
        "note": "Duplicate confirmed." if status in ("approved", "rejected") else None,
        "expiresAt": None,
        "questions": [],
        "createdAt": NOW,
    }
    row.update(over)
    return row


class Script:
    """Answers each call from a queue, keyed by ``METHOD path``."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.seen: List[str] = []

    def __call__(self, url, method, body, headers, timeout) -> Reply:
        path = url.split("/api/v1", 1)[-1]
        self.seen.append("{} {}".format(method, path.split("?")[0]))
        # The last answer repeats. A wait polls until something changes, so a
        # queue that runs dry would fail as a network error and hide whatever
        # the test was actually about.
        payload = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(payload, Exception):
            raise payload
        return Reply(200, {}, json.dumps(payload))


def http(script: Script) -> HttpClient:
    return HttpClient(api_key="dlv_t", transport=script, backoff=lambda a: 0.0)


INSTANT = (0.0, 0.0, 0.0, 0.0)


class Waiting(unittest.TestCase):
    def test_returns_once_somebody_decides(self):
        script = Script(approval("pending"), approval("approved"))
        handle = Approvals(http(script)).create(title="t")
        settled = handle.wait(poll_intervals=INSTANT)
        self.assertTrue(settled.approved)
        self.assertEqual(settled.decided_by, "Sarah Chen")
        self.assertEqual(settled.decided_by_id, "u_9")

    def test_does_not_raise_on_a_refusal(self):
        """A no is an answer.

        ``if decision.approved:`` is the line that follows, and an SDK that
        raised here would make every caller write a try/except to discover
        something the API told it plainly.
        """
        script = Script(approval("pending"), approval("rejected"))
        settled = Approvals(http(script)).create(title="t").wait(poll_intervals=INSTANT)
        self.assertFalse(settled.approved)
        self.assertTrue(settled.rejected)
        self.assertEqual(settled.to_decision().status, "rejected")

    def test_returns_immediately_when_it_is_already_settled(self):
        # Decided between create and wait: no poll at all.
        script = Script(approval("approved"))
        handle = Approvals(http(script)).create(title="t")
        handle.wait(poll_intervals=INSTANT)
        self.assertEqual(script.seen, ["POST /approvals"])

    def test_a_pending_request_that_ran_out_reads_as_expired(self):
        # `wait` ended by the caller's clock, `to_decision` by the request's:
        # a request still pending when you stop waiting is not an approval.
        script = Script(approval("pending"))
        handle = Approvals(http(script)).create(title="t")
        self.assertEqual(handle.to_decision().status, "expired")
        self.assertFalse(handle.to_decision().approved)


class WhenItDoesNotEnd(unittest.TestCase):
    def test_says_nobody_decided(self):
        script = Script(approval("pending"))
        handle = Approvals(http(script)).create(title="t")
        with self.assertRaises(DeliverdTimeoutError) as caught:
            handle.wait(timeout=0.02, poll_intervals=INSTANT)
        self.assertIn("Nobody decided", str(caught.exception))
        self.assertIn("https://deliverd.dev/approve/apr_1", str(caught.exception))

    def test_says_an_approver_asked_something_instead(self):
        """The two are different situations and the message must say which.

        An approver who asked a question has not ignored the request — they are
        waiting on *you*, and "nobody decided in time" sends you to look at the
        wrong end of it.
        """
        asked = approval(
            "pending",
            questions=[
                {
                    "id": "q1",
                    "question": "Has this been through staging?",
                    "answer": None,
                    "askedAt": NOW,
                    "answeredAt": None,
                }
            ],
        )
        script = Script(asked)
        handle = Approvals(http(script)).create(title="t")
        with self.assertRaises(DeliverdTimeoutError) as caught:
            handle.wait(timeout=0.02, poll_intervals=INSTANT)
        message = str(caught.exception)
        self.assertIn("asked a question", message)
        self.assertIn("Has this been through staging?", message)
        self.assertIn("on_question", message)

    def test_a_cancel_event_stops_the_wait(self):
        stop = threading.Event()
        stop.set()
        script = Script(approval("pending"))
        handle = Approvals(http(script)).create(title="t")
        with self.assertRaises(DeliverdError) as caught:
            handle.wait(cancel=stop, poll_intervals=INSTANT)
        self.assertEqual(caught.exception.code, "aborted")


class AnsweringAQuestion(unittest.TestCase):
    def test_posts_the_answer_and_carries_on(self):
        asked = approval(
            "pending",
            questions=[
                {
                    "id": "q1",
                    "question": "Staged?",
                    "answer": None,
                    "askedAt": NOW,
                    "answeredAt": None,
                }
            ],
        )
        answered = approval(
            "pending",
            questions=[
                {
                    "id": "q1",
                    "question": "Staged?",
                    "answer": "Yes",
                    "askedAt": NOW,
                    "answeredAt": NOW,
                }
            ],
        )
        script = Script(approval("pending"), asked, answered, approval("approved"))
        handle = Approvals(http(script)).create(title="t")
        seen = []
        settled = handle.wait(
            on_question=lambda q, a: seen.append(q.question) or "Yes",
            poll_intervals=INSTANT,
        )
        self.assertEqual(seen, ["Staged?"])
        self.assertIn("POST /approvals/apr_1/answers", script.seen)
        self.assertTrue(settled.approved)

    def test_returning_none_leaves_it_for_a_person(self):
        asked = approval(
            "pending",
            questions=[
                {"id": "q1", "question": "Staged?", "answer": None, "askedAt": NOW, "answeredAt": None}
            ],
        )
        script = Script(approval("pending"), asked, approval("approved"))
        handle = Approvals(http(script)).create(title="t")
        handle.wait(on_question=lambda q, a: None, poll_intervals=INSTANT)
        self.assertNotIn("POST /approvals/apr_1/answers", script.seen)


class WhatGoesOnTheWire(unittest.TestCase):
    def test_the_create_body_is_camel_case(self):
        sent = {}

        def transport(url, method, body, headers, timeout):
            sent.update(json.loads(body.decode()))
            return Reply(200, {}, json.dumps(approval("approved")))

        Approvals(HttpClient(api_key="dlv_t", transport=transport)).create(
            title="t", external_id="e1", report_id="r1", metadata={"order_id": 1}
        )
        self.assertEqual(sent["externalId"], "e1")
        self.assertEqual(sent["reportId"], "r1")
        self.assertEqual(sent["metadata"], {"order_id": 1})

    def test_approve_always_sets_an_expiry_so_a_wait_always_ends(self):
        """The one promise ``wait()`` makes.

        A request with no expiry can be waited on for ever, so the client
        supplies one rather than leaving it to whether the caller remembered.
        """
        sent = {}

        def transport(url, method, body, headers, timeout):
            if method == "POST":
                sent.update(json.loads(body.decode()))
            return Reply(200, {}, json.dumps(approval("approved")))

        client = Deliverd(api_key="dlv_t", transport=transport)
        client.approve(title="t")
        self.assertIn("expiresAt", sent)
        self.assertTrue(sent["expiresAt"].endswith("Z"))


class Paging(unittest.TestCase):
    def test_a_limit_means_one_page(self):
        script = Script({"approvals": [approval()], "nextCursor": "c1"})
        rows = Approvals(http(script)).list(limit=1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(script.seen), 1)

    def test_no_limit_follows_the_cursor_to_the_end(self):
        """Otherwise a full page and a complete list are indistinguishable.

        Which is how somebody reports "we only have 20 approvals" about an
        organisation with two hundred.
        """
        script = Script(
            {"approvals": [approval(), approval()], "nextCursor": "c1"},
            {"approvals": [approval()], "nextCursor": None},
        )
        self.assertEqual(len(Approvals(http(script)).list()), 3)
        self.assertEqual(len(script.seen), 2)


class Reviewing(unittest.TestCase):
    def review(self, status: str, **over: Any) -> Dict[str, Any]:
        row = {
            "id": "rev_1",
            "status": status,
            "url": "https://deliverd.dev/review/rev_1",
            "title": "Q3 board pack",
            "instructions": "Check the figures.",
            "reportId": "rep_1",
            "versionId": None,
            "externalId": None,
            "metadata": {},
            "requestedBy": "Agent",
            "requiredApprovals": 1,
            "reviewers": [{"kind": "user", "id": "u1", "label": "Partner"}],
            "verdicts": [],
            "threadCount": 0,
            "settledAt": None,
            "expiresAt": None,
            "createdAt": NOW,
        }
        row.update(over)
        return row

    def test_changes_requested_is_an_answer_not_a_failure(self):
        settled = self.review(
            "changes_requested",
            verdicts=[{"verdict": "changes_requested", "by": "Partner", "note": "Two fixes", "at": NOW}],
            threadCount=2,
        )
        script = Script(self.review("pending"), settled)
        outcome = (
            Reviews(http(script))
            .create(title="t", reviewers=["p@f.example"])
            .wait(poll_intervals=INSTANT)
            .to_outcome()
        )
        self.assertFalse(outcome.approved)
        self.assertEqual(outcome.status, "changes_requested")
        self.assertEqual(outcome.thread_count, 2)
        self.assertEqual(outcome.verdicts[0].by, "Partner")


class Collecting(unittest.TestCase):
    def collection(self, status: str, responses: Optional[List[Any]] = None) -> Dict[str, Any]:
        return {
            "id": "col_1",
            "status": status,
            "url": "https://deliverd.dev/answer/col_1",
            "title": "Before I file the Q3 return",
            "instructions": None,
            "reportId": None,
            "externalId": None,
            "metadata": {},
            "requestedBy": "Agent",
            "requiredResponses": 1,
            "questions": [],
            "responses": responses or [],
            "submittedCount": len(responses or []),
            "askedCount": 2,
            "settledAt": None,
            "dueAt": None,
            "expiresAt": None,
            "createdAt": NOW,
        }

    def test_answers_are_keyed_by_the_question_as_it_was_asked(self):
        done = self.collection(
            "complete",
            [
                {
                    "respondent": "Finance",
                    "status": "submitted",
                    "submittedAt": NOW,
                    "answers": [
                        {"question": "Headcount at 30 September", "kind": "number", "value": 42}
                    ],
                }
            ],
        )
        script = Script(self.collection("pending"), done)
        got = (
            Collections(http(script))
            .create(title="t", questions=[], respondents=["f@f.example"])
            .wait(poll_intervals=INSTANT)
            .to_collected()
        )
        self.assertTrue(got.complete)
        self.assertEqual(got.answers["Headcount at 30 September"], 42)
        self.assertEqual(got["Headcount at 30 September"], 42)

    def test_the_first_submission_wins_rather_than_being_merged(self):
        """Silently blending two people's answers would be worse than choosing.

        ``responses`` has all of them when the caller needs all of them.
        """
        done = self.collection(
            "complete",
            [
                {
                    "respondent": "First",
                    "status": "submitted",
                    "submittedAt": NOW,
                    "answers": [{"question": "Headcount", "kind": "number", "value": 42}],
                },
                {
                    "respondent": "Second",
                    "status": "submitted",
                    "submittedAt": NOW,
                    "answers": [{"question": "Headcount", "kind": "number", "value": 43}],
                },
            ],
        )
        script = Script(self.collection("pending"), done)
        got = (
            Collections(http(script))
            .create(title="t", questions=[], respondents=["a", "b"])
            .wait(poll_intervals=INSTANT)
            .to_collected()
        )
        self.assertEqual(got.answers["Headcount"], 42)
        self.assertEqual(len(got.responses), 2)

    def test_a_draft_is_not_an_answer(self):
        """A half-typed reply is not what they meant to say.

        The draft carries answers here, deliberately. The first version of this
        used an empty one — so deleting the `status != "submitted"` filter
        still produced an empty result and the test stayed green, satisfied by
        the fixture rather than by the code. A draft with nothing in it cannot
        prove anything about a filter that excludes drafts.
        """
        pending_reply = self.collection(
            "expired",
            [
                {
                    "respondent": "Finance",
                    "status": "pending",
                    "submittedAt": None,
                    "answers": [{"question": "Headcount", "kind": "number", "value": 99}],
                }
            ],
        )
        script = Script(self.collection("pending"), pending_reply)
        got = (
            Collections(http(script))
            .create(title="t", questions=[], respondents=["f"])
            .wait(poll_intervals=INSTANT)
            .to_collected()
        )
        self.assertFalse(got.complete)
        self.assertEqual(got.answers, {})
        self.assertEqual(got.responses, [])


class Reuse(unittest.TestCase):
    def test_an_external_id_finds_the_earlier_request_rather_than_asking_twice(self):
        """A crashed agent restarting must not ask two people about one act."""
        script = Script(
            {"approvals": [approval("approved")], "nextCursor": None},
        )
        client = Deliverd(api_key="dlv_t", transport=script)
        decision = client.approve(title="t", external_id="job-42")
        self.assertTrue(decision.approved)
        self.assertEqual(script.seen, ["GET /approvals"])

    def test_reuse_can_be_turned_off(self):
        script = Script(approval("approved"))
        client = Deliverd(api_key="dlv_t", transport=script)
        client.approve(title="t", external_id="job-42", reuse=False)
        self.assertEqual(script.seen, ["POST /approvals"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
