"""Development mode: the whole loop, on this machine, with nobody in it.

The property worth testing is not that the fake works — it is that development
mode runs the *same* code as production. Everything here goes through the real
client, the real retries and the real ``wait()``; only the transport differs.
"""

import unittest

from deliverd import Deliverd, DeliverdError, DeliverdTimeoutError
from deliverd.dev import DevelopmentOptions

QUIET = dict(log=False)


def client(**options) -> Deliverd:
    return Deliverd(mode="development", development=DevelopmentOptions(**dict(QUIET, **options)))


class NoKeyNoNetwork(unittest.TestCase):
    def test_runs_without_an_api_key(self):
        # The point: you can try the loop before you have an account.
        self.assertTrue(client().development)

    def test_never_touches_the_network(self):
        """Proved by the only means that proves it: the real transport is gone.

        A test that asserted "no request was made" against a fake would be
        asserting something about the fake.
        """
        from deliverd._http import urllib_transport

        self.assertIsNot(client().http._transport, urllib_transport)


class TheFourEndings(unittest.TestCase):
    def test_approved(self):
        decision = client().approve(title="Deploy to production")
        self.assertTrue(decision.approved)
        self.assertEqual(decision.status, "approved")
        self.assertEqual(decision.decided_by, "Development approver")

    def test_rejected(self):
        decision = client(outcome="rejected").approve(title="Delete the database")
        self.assertFalse(decision.approved)
        self.assertEqual(decision.status, "rejected")
        self.assertTrue(decision.note)

    def test_nobody_answered(self):
        """Expires rather than raising, because that is what production does.

        A request nobody decides runs out, and ``approve()`` returns a decision
        that is not an approval. Raising here would teach an integration to
        handle an exception production never throws.
        """
        decision = client(outcome="timeout").approve(title="Nobody is looking")
        self.assertEqual(decision.status, "expired")
        self.assertFalse(decision.approved)

    def test_somebody_asked_a_question(self):
        """The ending people forget to write, which is why it is one line to try."""
        asked = []
        decision = client(outcome="question").approve(
            title="Ship it",
            on_question=lambda q, a: asked.append(q.question) or "Staged on Tuesday",
        )
        self.assertEqual(asked, ["Has this been through staging?"])
        self.assertTrue(decision.approved)

    def test_an_unanswered_question_ends_the_wait_with_a_message_that_helps(self):
        # An explicit timeout, because the message is what is under test here
        # and the default would spend two seconds proving it.
        with self.assertRaises(DeliverdTimeoutError) as caught:
            client(outcome="question").approve(title="Ship it", timeout=0.05)
        self.assertIn("asked a question", str(caught.exception))

    def test_a_development_wait_gives_up_by_itself(self):
        """The imaginary approver is instant, so a wait still running will never end.

        Ending it quickly turns that into a message; leaving it turns it into a
        hung test suite in somebody else's project.
        """
        from deliverd import DEVELOPMENT_TIMEOUT

        self.assertEqual(DEVELOPMENT_TIMEOUT, 2.0)
        args = client()._wait_args(None, None, None, None)
        self.assertEqual(args["timeout"], DEVELOPMENT_TIMEOUT)
        # And a live client waits on the request's own expiry instead.
        self.assertIsNone(Deliverd(api_key="dlv_x")._wait_args(None, None, None, None)["timeout"])

    def test_the_outcome_can_be_decided_per_request(self):
        # So one suite can exercise both branches without two clients.
        decide = lambda request: "rejected" if request["risk"] == "critical" else "approved"
        c = client(outcome=decide)
        self.assertFalse(c.approve(title="Wipe it", risk="critical").approved)
        self.assertTrue(c.approve(title="Tidy up", risk="low").approved)

    def test_an_unknown_outcome_says_which_ones_exist(self):
        with self.assertRaises(ValueError) as caught:
            client(outcome="maybe").approve(title="t")
        self.assertIn("approved", str(caught.exception))


class TheOtherVerbs(unittest.TestCase):
    def test_review(self):
        outcome = client().review(title="Q3 pack", reviewers=["partner@firm.example"])
        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.verdicts[0].by, "Development reviewer")

    def test_review_with_changes_requested(self):
        outcome = client(outcome="rejected").review(title="Q3 pack", reviewers=["p@f.example"])
        self.assertFalse(outcome.approved)
        self.assertEqual(outcome.status, "changes_requested")
        self.assertGreater(outcome.thread_count, 0)

    def test_collect_answers_every_kind_of_question(self):
        got = client().collect(
            title="Before I file",
            respondents=["finance@firm.example"],
            questions=[
                {"prompt": "Headcount", "kind": "number"},
                {"prompt": "Any disposals?", "kind": "boolean"},
                {"prompt": "Which office?", "kind": "choice", "options": ["Leeds", "York"]},
                {"prompt": "Anything else?", "kind": "long_text"},
            ],
        )
        self.assertTrue(got.complete)
        self.assertEqual(got.answers["Headcount"], 42)
        self.assertIs(got.answers["Any disposals?"], True)
        self.assertEqual(got.answers["Which office?"], "Leeds")

    def test_the_whole_flow_loop_runs_offline(self):
        """The README's Flows section, with no key and no network.

        This is the example a reader tries first and it threw on its first
        line in 0.2.0: the development transport had never been taught the
        flow routes, so `resume()` came back `development_only` while the
        same code worked in TypeScript. Nothing in this suite noticed,
        because nothing here had ever started a flow offline.
        """
        c = client()
        flow = c.flows.resume(title="Close the March books", external_id="job-8821")
        self.assertTrue(flow.open)
        # Resuming is the point: a restarted agent extends the job rather than
        # beginning a second one, offline as well as against the API.
        self.assertEqual(c.flows.resume(title="Close the March books", external_id="job-8821").id,
                         flow.id)
        decision = flow.approve(title="Refund the duplicate charge", approvers=["Finance"])
        self.assertTrue(decision.approved)
        # Evidence offline is the shape and not the substance, and says so.
        pack = flow.evidence()
        self.assertEqual(pack.subject["kind"], "flow")
        self.assertEqual(pack.steps, [])
        self.assertIn("Do not hand this to anybody", pack.integrity["doesNotCover"])
        self.assertTrue(flow.close().complete)

    def test_publish_is_refused_rather_than_faked(self):
        """The one verb development mode will not pretend to do.

        Asking a person can be simulated: there is an imaginary approver and
        the answer is a value. Publishing puts bytes somewhere and there is
        nowhere local to put them, so the old behaviour here handed back
        `status: "published"` and a deliverd.dev URL that resolves to
        nothing — the one shape in this transport somebody could paste to a
        client. The TypeScript SDK made this call first, with a guard; this
        package disagreed with it in silence until a check compared the two.
        """
        with self.assertRaises(DeliverdError) as caught:
            client().publish(title="Weekly figures", content="<h1>Hi</h1>", slug="weekly")
        self.assertIn("POST /reports", str(caught.exception))
        self.assertIn("real API key", str(caught.exception))


class WhatItRefuses(unittest.TestCase):
    def test_says_so_rather_than_answering_something_plausible(self):
        """Deliberately narrow.

        A simulator that pretended to be the whole API and returned a plausible
        empty list would have somebody build against an answer that does not
        exist.
        """
        with self.assertRaises(DeliverdError) as caught:
            client().reports.share("rep_1", audience=["someone@example.com"])
        self.assertEqual(caught.exception.status, 501)
        self.assertEqual(caught.exception.code, "development_only")
        self.assertIn("mode", str(caught.exception))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class GovernedGates(unittest.TestCase):
    """What an agent does with a permission, rehearsed offline."""

    SHA = "a" * 64

    def gate(self, **options):
        c = client(**options)
        gate = c.gates.check(
            action_id="report.publish",
            input={"amount_gbp": 5},
            external_id="publish:1",
            destination={"type": "email", "id": "partner@example.com"},
            artifact={"report_id": "rep_1", "sha256": self.SHA.upper()},
        ).wait(timeout=1)
        return c, gate

    def test_can_execute_once_a_person_approves(self):
        _, gate = self.gate()
        self.assertTrue(gate.can_execute)
        self.assertEqual(gate.decision, "APPROVAL_REQUIRED")
        # Sent snake_case, recorded as the wire shape, hash normalised.
        self.assertEqual(gate.scope["artifact"]["reportId"], "rep_1")
        self.assertEqual(gate.scope["artifact"]["sha256"], self.SHA)

    def test_a_refusal_cannot_be_executed(self):
        _, gate = self.gate(outcome="rejected")
        self.assertFalse(gate.can_execute)
        self.assertTrue(gate.blocked_because)

    def test_a_permission_is_spent_by_its_first_use(self):
        c, gate = self.gate()
        receipt = gate.record_execution(artifact_sha256=self.SHA, result={"messageId": "m1"})
        self.assertEqual(receipt.verification, "hash_matched")
        self.assertEqual(receipt.result, {"messageId": "m1"})
        self.assertFalse(gate.can_execute)
        self.assertEqual(gate.status, "used")
        with self.assertRaises(DeliverdError) as caught:
            c.gates.record_execution(gate.id, artifact_sha256=self.SHA)
        self.assertEqual(caught.exception.code, "gate_used")

    def test_a_different_artifact_invalidates_the_approval(self):
        _, gate = self.gate()
        with self.assertRaises(DeliverdError) as caught:
            gate.record_execution(artifact_sha256="b" * 64)
        self.assertEqual(caught.exception.code, "approval_invalidated")
        self.assertTrue(gate.can_execute, "a refused report spends nothing")

    def test_cancelled_is_not_executable(self):
        _, gate = self.gate()
        gate.cancel(note="Not needed")
        self.assertEqual(gate.status, "cancelled")
        self.assertFalse(gate.can_execute)

    def test_input_keys_arrive_as_written(self):
        _, gate = self.gate()
        self.assertEqual(gate.data.input, {"amount_gbp": 5})


class AnInboxOffline(unittest.TestCase):
    """``approver=`` filters offline the way it does against the API."""

    def test_lists_only_the_requests_naming_that_person(self):
        c = client(outcome="timeout")
        mine = c.approvals.create(title="Refund 40", approvers=["sarah@acme.example"])
        c.approvals.create(title="Refund 90", approvers=["tom@acme.example"])
        ids = [a.id for a in c.approvals.list(approver="Sarah@Acme.example")]
        self.assertEqual(ids, [mine.id])
        self.assertEqual(c.approvals.list(approver="nobody@acme.example"), [])

    def test_a_decision_session_is_refused_rather_than_faked(self):
        c = client()
        approval = c.approvals.create(title="Refund 40", approvers=["sarah@acme.example"])
        with self.assertRaises(DeliverdError) as caught:
            c.approvals.create_session(approval.id, approver="sarah@acme.example")
        self.assertEqual(caught.exception.code, "development_only")
