"""Flows, comments and schedules.

The flow tests are mostly about one property — that the handle cannot forget
the flow id — because that is the only reason `Flow` exists rather than a
caller passing `flow_id` themselves.
"""

import json
import unittest
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from deliverd import Deliverd
from deliverd._http import HttpClient, Reply

NOW = "2026-09-17T12:00:00Z"


def flow(status: str = "open", **over: Any) -> Dict[str, Any]:
    row = {
        "id": "flw_1",
        "status": status,
        "url": "https://deliverd.dev/flows/flw_1",
        "title": "Q3 close",
        "description": None,
        "externalId": "job-42",
        "metadata": {},
        "startedBy": "Agent",
        "members": [],
        "memberCount": 0,
        "openCount": 0,
        "allSettled": True,
        "timeline": None,
        "settledAt": None,
        "createdAt": NOW,
    }
    row.update(over)
    return row


def approval(status: str = "approved") -> Dict[str, Any]:
    return {
        "id": "apr_1", "status": status, "url": "https://deliverd.dev/approve/apr_1",
        "title": "t", "description": None, "risk": "medium", "factors": [], "links": [],
        "reportId": None, "externalId": None, "metadata": {}, "requestedBy": "Agent",
        "approvers": [], "requiredApprovals": 1, "approvalsSoFar": 1,
        "decidedBy": "Sarah", "decidedById": "u1", "decidedAt": NOW, "note": None,
        "expiresAt": None, "questions": [], "createdAt": NOW,
    }


class Spy:
    """Records every call and answers from a queue; the last answer repeats."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers) or [{}]
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, url, method, body, headers, timeout) -> Reply:
        parsed = urlparse(url)
        self.calls.append(
            {
                "method": method,
                "path": parsed.path.split("/api/v1", 1)[-1],
                "query": {k: v[0] for k, v in parse_qs(parsed.query).items()},
                "body": json.loads(body.decode()) if body else None,
            }
        )
        payload = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return Reply(200, {}, json.dumps(payload))

    @property
    def paths(self) -> List[str]:
        return ["{} {}".format(c["method"], c["path"]) for c in self.calls]


def client(spy: Spy) -> Deliverd:
    return Deliverd(api_key="dlv_t", transport=spy)


# No poll schedule is needed anywhere here: every fixture comes back already
# settled, so `wait()` takes its early exit and never sleeps. `poll_intervals`
# is a wait-level argument and the client-level verbs do not take one — passing
# it was a TypeError, which is the signature being right rather than wrong.


class TheFlowHandle(unittest.TestCase):
    def test_approve_inside_a_flow_names_the_flow(self):
        """The entire reason `Flow` exists.

        A `flow_id` passed by hand at four call sites is one that gets left off
        the fifth, and that step is then missing from the history with nothing
        to say so.
        """
        spy = Spy(flow(), approval())
        c = client(spy)
        handle = c.flows.get("flw_1")
        handle.approve(title="Refund £1,240")
        created = next(x for x in spy.calls if x["path"] == "/approvals")
        self.assertEqual(created["body"]["flowId"], "flw_1")

    def test_review_and_collect_do_the_same(self):
        for verb, kwargs, path in [
            ("review", {"reviewers": ["p@f.example"]}, "/reviews"),
            ("collect", {"questions": [], "respondents": ["f@f.example"]}, "/collections"),
        ]:
            settled = {
                "/reviews": {
                    "id": "rev_1", "status": "approved", "url": "u", "title": "t",
                    "instructions": None, "reportId": None, "versionId": None,
                    "externalId": None, "metadata": {}, "requestedBy": "A",
                    "requiredApprovals": 1, "reviewers": [], "verdicts": [],
                    "threadCount": 0, "settledAt": NOW, "expiresAt": None, "createdAt": NOW,
                },
                "/collections": {
                    "id": "col_1", "status": "complete", "url": "u", "title": "t",
                    "instructions": None, "reportId": None, "externalId": None,
                    "metadata": {}, "requestedBy": "A", "requiredResponses": 1,
                    "questions": [], "responses": [], "submittedCount": 1, "askedCount": 1,
                    "settledAt": NOW, "dueAt": None, "expiresAt": None, "createdAt": NOW,
                },
            }[path]
            spy = Spy(flow(), settled)
            handle = client(spy).flows.get("flw_1")
            getattr(handle, verb)(title="t", **kwargs)
            created = next(x for x in spy.calls if x["path"] == path)
            self.assertEqual(created["body"]["flowId"], "flw_1", verb)

    def test_close_is_not_the_complete_property(self):
        """`flow.complete` asks; `flow.close()` decides.

        Named apart because every other primitive here has a `complete`-shaped
        property, and a method with the same name would shadow the question
        with the act.
        """
        spy = Spy(flow("open"), flow("complete"))
        handle = client(spy).flows.get("flw_1")
        self.assertFalse(handle.complete)
        handle.close()
        self.assertTrue(handle.complete)
        self.assertIn("POST /flows/flw_1/complete", spy.paths)

    def test_cancel_calls_it_off_and_leaves_the_members_alone(self):
        """The flow and its members stay as evidence; nothing inside is cancelled.

        So the only thing to prove here is that it is the flow's own cancel
        route and that the handle moves with it — a `cancel()` that posted
        somewhere else would still return a handle reading "cancelled",
        because the handle reads whatever came back.
        """
        spy = Spy(flow("open"), flow("cancelled"))
        handle = client(spy).flows.get("flw_1")
        handle.cancel()
        self.assertEqual(spy.paths, ["GET /flows/flw_1", "POST /flows/flw_1/cancel"])
        self.assertTrue(handle.cancelled)
        self.assertFalse(handle.open)

    def test_all_settled_is_not_a_claim_that_the_job_is_done(self):
        # An empty flow is never settled by having nothing in it — but a flow
        # with nothing outstanding right now is, and the caller may be about to
        # add the next step.
        handle = client(Spy(flow("open", allSettled=True, openCount=0))).flows.get("flw_1")
        self.assertTrue(handle.all_settled)
        self.assertTrue(handle.open)
        self.assertFalse(handle.complete)

    def test_evidence_is_the_whole_record(self):
        pack = {
            "packVersion": 1, "generatedAt": NOW, "generatedBy": "A",
            "organisation": {"id": "o", "name": "Acme"},
            "subject": {"kind": "flow", "id": "flw_1", "title": "t", "url": "u",
                        "status": "open", "startedBy": "A", "startedAt": NOW},
            "summary": {"steps": 1, "events": 2, "firstEventAt": NOW, "lastEventAt": NOW},
            "steps": [{"kind": "approval", "id": "a", "title": "t", "status": "approved",
                       "url": "u", "createdAt": NOW, "settledAt": NOW, "requestedBy": "A",
                       "requestedByAgent": True, "asked": ["Finance"],
                       "outcomes": [{"who": "Sarah", "said": "approved", "note": None, "at": NOW}],
                       "detail": {}}],
            "timeline": [{"at": NOW, "event": "approval.requested", "actor": "A",
                          "actorType": "agent", "step": "a", "metadata": {}}],
            "integrity": {"algorithm": "sha256", "digest": "d", "covers": "x",
                          "doesNotCover": "y", "recordsAreInsertOnly": True},
        }
        spy = Spy(flow(), pack)
        got = client(spy).flows.get("flw_1").evidence()
        # The path, not only the decoding. Everything below proves the pack is
        # read correctly, and would go on proving it against a 404 — the Spy
        # answers whatever it is asked. `comments.resolve` shipped its first
        # draft pointed at a route that does not exist for exactly that reason.
        self.assertEqual(spy.paths[-1], "GET /flows/flw_1/evidence")
        self.assertEqual(got.steps[0].requested_by_agent, True)
        self.assertEqual(got.steps[0].outcomes[0].who, "Sarah")
        self.assertEqual(got.timeline[0].actor_type, "agent")
        # The integrity block stays a dict, and says what it does not cover.
        self.assertIn("doesNotCover", got.integrity)


class Resuming(unittest.TestCase):
    def test_returns_the_open_flow_rather_than_starting_a_second(self):
        spy = Spy({"flows": [flow("open")], "nextCursor": None})
        got = client(spy).flows.resume(title="Q3 close", external_id="job-42")
        self.assertEqual(got.id, "flw_1")
        self.assertEqual(spy.paths, ["GET /flows"])

    def test_starts_one_when_there_is_none(self):
        spy = Spy({"flows": [], "nextCursor": None}, flow("open"))
        client(spy).flows.resume(title="Q3 close", external_id="job-42")
        self.assertIn("POST /flows", spy.paths)

    def test_does_not_resume_a_closed_flow(self):
        """A closed flow takes no new members.

        Handing it back would return a handle whose very next call fails, which
        is worse than starting the flow the caller asked for.
        """
        spy = Spy({"flows": [flow("complete")], "nextCursor": None}, flow("open"))
        client(spy).flows.resume(title="Q3 close", external_id="job-42")
        self.assertIn("POST /flows", spy.paths)


class TheComments(unittest.TestCase):
    def thread(self, thread_id: str = "th_1") -> Dict[str, Any]:
        return {
            "threadId": thread_id, "status": "open", "quote": "the figure on page 4",
            "messages": [{"commentId": "c1", "author": "Client", "authorType": "guest",
                          "body": "Is this net or gross?", "createdAt": NOW,
                          "retractable": False}],
        }

    def test_reads_a_thread_and_the_id_retract_takes(self):
        spy = Spy({"threads": [self.thread()], "nextCursor": None})
        threads = client(spy).comments.list("rep_1")
        self.assertEqual(threads[0].thread_id, "th_1")
        self.assertEqual(threads[0].messages[0].comment_id, "c1")
        self.assertFalse(threads[0].messages[0].retractable)

    def test_list_follows_the_cursor(self):
        spy = Spy(
            {"threads": [self.thread("th_1")], "nextCursor": "c1"},
            {"threads": [self.thread("th_2")], "nextCursor": None},
        )
        self.assertEqual(len(client(spy).comments.list("rep_1")), 2)

    def test_open_asks_the_organisation_wide_route(self):
        # Not `/reports/x/comments`: the whole point is not naming a report.
        row = {"threadId": "th_1", "reportId": "r", "reportTitle": "T", "reportSlug": "s",
               "reportOwnerId": "u1", "quote": None, "author": "Client",
               "authorType": "guest", "messages": 2, "lastActivityAt": NOW}
        spy = Spy({"threads": [row], "nextCursor": None})
        got = client(spy).comments.open()
        self.assertEqual(spy.paths, ["GET /comments"])
        self.assertEqual(got[0].report_owner_id, "u1")

    def test_resolve_is_keyed_on_the_thread_not_the_report(self):
        """The route reads like it should live under the report and does not.

        The first version of this method built
        `/reports/{id}/comments/{threadId}/resolve`, which is a 404 on every
        call — caught by checking the route tree rather than by reasoning.
        """
        spy = Spy({})
        client(spy).comments.resolve("th_1", note="Fixed in v4")
        self.assertEqual(spy.paths, ["POST /comments/th_1/resolve"])
        self.assertEqual(spy.calls[0]["body"], {"note": "Fixed in v4"})

    def test_create_anchors_to_a_passage_under_the_api_s_own_name(self):
        # `quote_text` here, `quote` on the wire: the Python argument is named
        # apart because `quote` is urllib's function, imported in that module.
        spy = Spy({"threadId": "th_1", "commentId": "c1"})
        client(spy).comments.create(
            report="rep_1", body="This figure is stale.", quote_text="£1,240", thread_id="th_1"
        )
        self.assertEqual(spy.paths, ["POST /reports/rep_1/comments"])
        self.assertEqual(
            spy.calls[0]["body"],
            {"body": "This figure is stale.", "quote": "£1,240", "threadId": "th_1"},
        )

    def test_retract_is_keyed_on_the_report_and_the_comment(self):
        spy = Spy({})
        client(spy).comments.retract("rep_1", "c1")
        self.assertEqual(spy.paths, ["DELETE /reports/rep_1/comments/c1"])

    def test_a_slug_with_a_slash_in_it_is_escaped(self):
        # A report is addressable by slug, and a slug that split the path would
        # silently call a different route.
        spy = Spy({"threads": [], "nextCursor": None})
        client(spy).comments.list("a/b")
        self.assertEqual(spy.paths, ["GET /reports/a%2Fb/comments"])


class TheSchedules(unittest.TestCase):
    def summary(self) -> Dict[str, Any]:
        return {
            "id": "sch_1", "reportId": "rep_1", "reportSlug": "weekly",
            "reportTitle": "Weekly figures", "reportUrl": "u", "agentId": "agt_1",
            "agentName": "Reporter", "recurrence": "0 9 * * 5", "enabled": True,
            "lastRunAt": None, "nextRunAt": NOW, "currentVersion": 3,
            "due": False, "dueSince": None,
        }

    def test_lists_and_reads_the_cron_expression(self):
        spy = Spy({"schedules": [self.summary()]})
        got = client(spy).schedules.list()
        self.assertEqual(got[0].recurrence, "0 9 * * 5")
        self.assertEqual(got[0].next_run_at, NOW)
        self.assertEqual(spy.paths, ["GET /schedules"])
        self.assertEqual(spy.calls[0]["query"], {})

    def test_due_only_asks_for_the_due_ones(self):
        spy = Spy({"schedules": []})
        client(spy).schedules.list(due_only=True)
        self.assertEqual(spy.calls[0]["query"], {"due": "1"})

    def test_create_sends_camel_case(self):
        spy = Spy(self.summary())
        client(spy).schedules.create(report_id="rep_1", agent_id="agt_1", recurrence="0 9 * * 5")
        self.assertEqual(spy.paths, ["POST /schedules"])
        self.assertEqual(
            spy.calls[0]["body"],
            {"reportId": "rep_1", "agentId": "agt_1", "recurrence": "0 9 * * 5"},
        )

    def test_update_sends_only_what_was_given(self):
        # Sending `recurrence: null` alongside `enabled: false` would be asking
        # the API to clear a cadence the caller never mentioned.
        spy = Spy(self.summary())
        client(spy).schedules.update("sch_1", enabled=False)
        self.assertEqual(spy.paths, ["PATCH /schedules/sch_1"])
        self.assertEqual(spy.calls[0]["body"], {"enabled": False})

    def test_delete_is_a_delete(self):
        spy = Spy({})
        client(spy).schedules.delete("sch_1")
        self.assertEqual(spy.paths, ["DELETE /schedules/sch_1"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class SharingAtALevel(unittest.TestCase):
    """`capability` reaches the wire only when it is asked for.

    Left out, the body is the one every existing caller already sends, so a
    server that predates the field is never handed a key it would refuse.
    """

    def test_sends_the_level_it_is_given(self):
        spy = Spy({"granted": []})
        client(spy).reports.share("finance/weekly", ["sarah@acme.com"], capability="comment")
        self.assertEqual(spy.paths, ["POST /reports/finance/weekly/share"])
        self.assertEqual(
            spy.calls[0]["body"], {"audience": ["sarah@acme.com"], "capability": "comment"}
        )

    def test_sends_no_level_when_none_is_given(self):
        spy = Spy({"granted": []})
        client(spy).reports.share("finance/weekly", ["sarah@acme.com"])
        self.assertEqual(spy.calls[0]["body"], {"audience": ["sarah@acme.com"]})
