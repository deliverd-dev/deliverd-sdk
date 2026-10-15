"""Task Graph: the wire, and the loop an agent runs, offline.

The first half watches requests go out, because the names are the Python ones
and the routes are not: ``create_side_task`` has to reach ``/side-tasks`` and
``expected_version`` has to arrive as ``expectedVersion``, and only the body on
the wire can prove either. The second half runs the README's loop in
development mode, where what matters is what comes back — the objective at the
top of every context, and the result reaching the parent.
"""

import asyncio
import os
import sys
import unittest
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd import Deliverd, DeliverdError  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402
from test_namespaces import Spy, client  # noqa: E402

NOW = "2026-10-07T12:00:00Z"
QUIET = DevelopmentOptions(log=False)


def task(status: str = "open", **over: Any) -> Dict[str, Any]:
    row = {
        "id": "tsk_1",
        "kind": "objective",
        "status": status,
        "url": "https://deliverd.dev/tasks/tsk_1",
        "title": "Ship SSO",
        "objective": "Customers can sign in with SSO.",
        "rootTaskId": "tsk_1",
        "parentTaskId": None,
        "depth": 0,
        "workspaceId": None,
        "flowId": None,
        "state": {
            "currentState": None,
            "openQuestions": [],
            "constraints": [],
            "blockedBy": [],
            "nextAction": None,
        },
        "snapshot": None,
        "result": None,
        "previousResults": [],
        "outcome": None,
        "origin": "manual",
        "externalId": None,
        "sessionUrl": None,
        "version": 1,
        "startedBy": "Agent",
        "createdAt": NOW,
        "updatedAt": NOW,
        "completedAt": None,
    }
    row.update(over)
    return row


class TheWire(unittest.TestCase):
    def test_create_sends_the_wire_names_and_reads_resumed(self):
        spy = Spy(dict(task(), resumed=True))
        got = client(spy).tasks.create(
            title="Ship SSO",
            objective="Customers can sign in with SSO.",
            external_id="sso",
            state={"open_questions": ["Which IdPs?"], "next_action": "Ask"},
        )
        sent = spy.calls[0]
        self.assertEqual(spy.paths, ["POST /tasks"])
        self.assertEqual(sent["body"]["externalId"], "sso")
        # The state patch is ours, not the caller's free-form data, so its keys
        # are converted like every other declared field.
        self.assertEqual(sent["body"]["state"], {"openQuestions": ["Which IdPs?"], "nextAction": "Ask"})
        self.assertTrue(got.resumed)
        self.assertEqual(got.data.state.open_questions, [])

    def test_update_is_a_patch_carrying_the_version_it_read(self):
        spy = Spy(task(status="blocked", version=3))
        got = client(spy).tasks.update("tsk_1", status="blocked", expected_version=2)
        self.assertEqual(spy.paths, ["PATCH /tasks/tsk_1"])
        self.assertEqual(spy.calls[0]["body"], {"status": "blocked", "expectedVersion": 2})
        self.assertEqual(got.version, 3)

    def test_every_nested_route_is_spelled_the_way_the_api_spells_it(self):
        side = task(id="tsk_2", kind="debug", parentTaskId="tsk_1", depth=1)
        finding = {
            "id": "fnd_1", "taskId": "tsk_1", "kind": "decision", "title": "d", "body": "",
            "evidence": [], "decisionStatus": "suggested", "decidedBy": None, "decidedAt": None,
            "approvalId": None, "approvalStatus": None, "sourceTaskId": None,
            "createdBy": "Agent", "createdAt": NOW,
        }
        spy = Spy(
            task(), side, finding,
            {"finding": finding, "approvalId": "apr_1", "approvalUrl": "https://deliverd.dev/approve/apr_1"},
            {"linked": True, "sourceTaskId": "tsk_1", "targetTaskId": "tsk_9", "kind": "blocks", "created": True},
            task(status="cancelled"),
        )
        handle = client(spy).tasks.get("tsk_1")
        handle.create_side_task(title="Token", goal="Why refused", kind="debug")
        handle.add_finding(kind="decision", title="d")
        approval = handle.request_decision_approval("fnd_1", approvers=["Security"])
        link = handle.link("tsk_9", "blocks")
        handle.cancel(reason="Replanned")
        self.assertEqual(
            spy.paths,
            [
                "GET /tasks/tsk_1",
                "POST /tasks/tsk_1/side-tasks",
                "POST /tasks/tsk_1/findings",
                "POST /tasks/tsk_1/findings/fnd_1/approval",
                "POST /tasks/tsk_1/links",
                "POST /tasks/tsk_1/cancel",
            ],
        )
        self.assertEqual(spy.calls[4]["body"], {"targetTaskId": "tsk_9", "kind": "blocks"})
        self.assertEqual(approval.approval_id, "apr_1")
        self.assertEqual(approval.finding.decision_status, "suggested")
        self.assertTrue(link.created)
        self.assertTrue(handle.cancelled)

    def test_list_follows_the_cursor_and_passes_the_filters(self):
        spy = Spy(
            {"tasks": [task()], "nextCursor": "c1"},
            {"tasks": [task(id="tsk_2")], "nextCursor": None},
        )
        got = client(spy).tasks.list(status="active", q="sso")
        self.assertEqual([t.id for t in got], ["tsk_1", "tsk_2"])
        self.assertEqual(spy.calls[0]["query"], {"status": "active", "q": "sso"})
        self.assertEqual(spy.calls[1]["query"]["cursor"], "c1")


class TheLoopOffline(unittest.TestCase):
    def client(self) -> Deliverd:
        return Deliverd(mode="development", development=QUIET)

    def test_resumes_the_open_objective_instead_of_starting_a_second(self):
        c = self.client()
        first = c.tasks.create(title="Ship SSO", objective="x", external_id="sso")
        again = c.tasks.create(title="Ship SSO", objective="x", external_id="sso")
        self.assertEqual(again.id, first.id)
        self.assertTrue(again.resumed)
        first.cancel()
        self.assertNotEqual(c.tasks.create(title="t", objective="x", external_id="sso").id, first.id)

    def test_a_side_task_result_reaches_the_parent_when_applied(self):
        c = self.client()
        objective = c.tasks.create(
            title="Ship SSO",
            objective="Customers can sign in with SSO.",
            state={"open_questions": ["Why is the token refused?"]},
        )
        side = objective.create_side_task(
            title="Token audience",
            goal="Find why the token is refused.",
            kind="debug",
            resolves_question="Why is the token refused?",
        )
        context = side.context()
        self.assertEqual(context.root_objective, "Customers can sign in with SSO.")
        self.assertTrue(context.task.is_side_task)
        self.assertEqual([p.id for p in context.path], [objective.id, side.id])
        # The API's shape: development mode publishes nothing, so the list is there and empty.
        self.assertEqual(context.reports, [])

        side.complete(
            summary="The access token is issued for the wrong audience.",
            findings=[{"title": "Audience mismatch", "description": "aud is the SPA."}],
            suggested_next_action="Request the token for the API audience.",
        )
        self.assertTrue(side.completed)
        self.assertEqual(
            [a.id for a in objective.context().side_tasks.awaiting_outcome], [side.id]
        )

        applied = side.apply()
        self.assertEqual(side.data.outcome, "applied")
        self.assertEqual(applied.context.next_action, "Request the token for the API audience.")
        self.assertNotIn("Why is the token refused?", applied.context.open_questions)
        self.assertIn("Audience mismatch", [f.title for f in applied.context.relevant_findings])

        with self.assertRaises(DeliverdError) as caught:
            side.apply()
        self.assertEqual(caught.exception.code, "already_applied")

    def test_refuses_a_stale_update(self):
        c = self.client()
        t = c.tasks.create(title="t", objective="o")
        read = t.version
        c.tasks.update(t.id, state={"current_state": "Halfway"})
        with self.assertRaises(DeliverdError) as caught:
            t.update(status="blocked", expected_version=read)
        self.assertEqual(caught.exception.code, "version_conflict")

    def test_keeps_the_earlier_result_when_reopened(self):
        t = self.client().tasks.create(title="t", objective="o")
        t.complete(summary="First answer.")
        t.reopen()
        self.assertTrue(t.active)
        self.assertEqual([r.summary for r in t.data.previous_results], ["First answer."])

    def test_lists_objectives_with_their_side_tasks_counted(self):
        c = self.client()
        t = c.tasks.create(title="t", objective="o")
        t.create_side_task(title="s", goal="g")
        listed = c.tasks.list(status="active")
        self.assertEqual([x.id for x in listed], [t.id])
        self.assertEqual(listed[0].data.side_tasks.open, 1)
        self.assertEqual(c.tasks.graph(t.id).root.id, t.id)

    def test_runs_awaited_too(self):
        async def go():
            c = AsyncDeliverd(mode="development", development=QUIET)
            t = await c.tasks.create(title="t", objective="o")
            side = await t.create_side_task(title="s", goal="g")
            await side.complete(summary="done")
            applied = await side.apply()
            return applied.parent.id == t.id

        self.assertTrue(asyncio.run(go()))


class TheReportsATaskKeeps(unittest.TestCase):
    """A report written for a task names it, and the task's context names the report."""

    def published(self, task_id: Any = "tsk_1") -> Dict[str, Any]:
        return {
            "status": "published",
            "report": {
                "id": "rep_1", "slug": "q3-status", "title": "Q3 status", "url": "https://c/acme/q3-status",
                "status": "active", "currentVersion": 1, "taskId": task_id,
            },
            "version": {"id": "v1", "versionNumber": 1},
            "warnings": [],
        }

    def test_publish_and_update_send_the_task_and_the_flow(self):
        spy = Spy(self.published(), self.published("tsk_2"))
        c = client(spy)
        result = c.reports.publish(title="Q3 status", content="<h1>Q3</h1>", task_id="tsk_1", flow_id="flw_1")
        c.reports.update("q3-status", content="<h1>Q3, revised</h1>", task_id="tsk_2")
        self.assertEqual(spy.calls[0]["path"], "/reports")
        self.assertEqual(spy.calls[0]["body"]["taskId"], "tsk_1")
        self.assertEqual(spy.calls[0]["body"]["flowId"], "flw_1")
        self.assertEqual(spy.calls[1]["path"], "/reports/q3-status/versions")
        self.assertEqual(spy.calls[1]["body"]["taskId"], "tsk_2")
        self.assertEqual(result.report.task_id, "tsk_1")

    def test_leaving_the_task_out_sends_nothing_for_it(self):
        # The API reads an absent taskId as "keep the link"; a null would be a statement.
        spy = Spy(self.published())
        client(spy).reports.update("q3-status", content="<h1>Q3</h1>")
        self.assertNotIn("taskId", spy.calls[0]["body"])

    def test_awaited_too(self):
        spy = Spy(self.published())

        async def go():
            c = AsyncDeliverd(api_key="dlv_t", transport=spy)
            await c.reports.publish(title="Q3 status", content="<h1>Q3</h1>", task_id="tsk_1", flow_id="flw_1")

        asyncio.run(go())
        self.assertEqual(spy.calls[0]["body"]["taskId"], "tsk_1")
        self.assertEqual(spy.calls[0]["body"]["flowId"], "flw_1")

    def test_the_context_names_the_reports(self):
        spy = Spy(
            {
                "rootObjective": "Close Q3.", "task": {"id": "tsk_1", "kind": "objective", "title": "Q3",
                "objective": "Close Q3.", "status": "in_progress", "isSideTask": False},
                "path": [], "currentState": None, "nextAction": None, "openQuestions": [], "constraints": [],
                "blockedBy": [], "decisions": {"confirmed": [], "suggested": []}, "snapshot": None,
                "relevantFindings": [], "sideTasks": {"active": [], "awaitingOutcome": [], "completed": []},
                "reports": [{"id": "rep_1", "title": "Q3 status", "url": "https://c/acme/q3-status",
                             "version": 2, "publishedAt": NOW}],
                "reanchor": "Objective: Close Q3.",
            }
        )
        context = client(spy).tasks.context("tsk_1")
        self.assertEqual(spy.calls[0]["path"], "/tasks/tsk_1/context")
        self.assertEqual(context.reports[0].url, "https://c/acme/q3-status")
        self.assertEqual(context.reports[0].version, 2)
        self.assertEqual(context.reports[0].published_at, NOW)


if __name__ == "__main__":
    unittest.main()
