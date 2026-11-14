"""The Claude Managed Agents adapter: a session paused on ``requires_action``
gets a person's answer as ``user.tool_confirmation``, hosted or self-hosted.

What matters: only calls the server holds for confirmation are answered, a no
never runs and the model reads why, a correction is not run as proposed, a
slow decision leaves the session waiting, and a second pass never asks twice.
"""

import os
import sys
import threading
import unittest
from types import SimpleNamespace
from typing import Any, Dict, List

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

import test_adapters as base  # noqa: E402

from deliverd.adapters import managed_agents as ma  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
timed_out = base.timed_out
run = base.run

IDLE = {
    "id": "sevt_idle",
    "type": "session.status_idle",
    "stop_reason": {"type": "requires_action", "event_ids": ["sevt_bash", "sevt_mcp", "sevt_worker"]},
}
# An SDK object, the way ``anthropic`` returns it.
BASH = SimpleNamespace(
    id="sevt_bash",
    type="agent.tool_use",
    name="bash",
    input={"command": "rm -rf /workspace/reports"},
    evaluated_permission="ask",
    mcp_server_name=None,
)
MCP = {
    "id": "sevt_mcp",
    "type": "agent.mcp_tool_use",
    "name": "create_issue",
    "mcp_server_name": "github",
    "input": {"repo": "acme/api", "title": "Rotate keys"},
    "evaluated_permission": "ask",
}
# A worker-run tool on a self-hosted environment: blocking, but not ours to answer.
WORKER = {"id": "sevt_worker", "type": "agent.tool_use", "name": "read", "input": {}, "evaluated_permission": "allow"}


class FakeClient:
    def __init__(self, events: List[Any], sessions: List[str] = (), stream: List[Any] = ()) -> None:
        self.sent: List[Dict[str, Any]] = []
        self._events = events
        self._stream = list(stream)
        outer = self

        class Events:
            def list(self, session_id: str, order: str = "asc", types: Any = None) -> Any:
                picked = [e for e in outer._events if types is None or ma.field_of(e, "type") in types]
                return list(reversed(picked)) if order == "desc" else picked

            def send(self, session_id: str, events: Any) -> None:
                outer.sent.append({"session": session_id, "events": list(events)})

            def stream(self, session_id: str) -> Any:
                return iter(outer._stream)

        class Sessions:
            events = Events()

            def list(self, **params: Any) -> Any:
                assert params["statuses"] == ["idle"]
                return [{"id": s} for s in sessions]

        self.beta = SimpleNamespace(sessions=Sessions())


class AnswerConfirmations(unittest.TestCase):
    def test_answers_only_held_calls_once_each_and_sends_a_yes(self):
        client, deliverd = FakeClient([BASH, MCP, WORKER, IDLE]), FakeDeliverd()
        resolution = ma.answer_tool_confirmations(client, "sesn_1", deliverd, approvers=["platform-team"])
        self.assertEqual(
            [a["external_id"] for a in deliverd.asked], ["managed-agents:sevt_bash", "managed-agents:sevt_mcp"]
        )
        self.assertEqual(deliverd.asked[0]["approvers"], ["platform-team"])
        self.assertEqual(deliverd.asked[1]["title"], "Allow the agent to run create_issue on github")
        self.assertEqual(deliverd.asked[1]["metadata"]["session"], "sesn_1")
        self.assertEqual(
            client.sent,
            [
                {
                    "session": "sesn_1",
                    "events": [
                        {"type": "user.tool_confirmation", "tool_use_id": "sevt_bash", "result": "allow"},
                        {"type": "user.tool_confirmation", "tool_use_id": "sevt_mcp", "result": "allow"},
                    ],
                }
            ],
        )
        self.assertTrue(resolution.complete)

    def test_a_no_carries_the_persons_reason(self):
        client = FakeClient([BASH, IDLE])
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Those reports are the audit trail"))
        resolution = ma.answer_tool_confirmations(client, "sesn_1", deliverd)
        [answer] = client.sent[0]["events"]
        self.assertEqual(answer["result"], "deny")
        self.assertIn("Their reason: Those reports are the audit trail.", answer["deny_message"])
        self.assertEqual(resolution.reasons["sevt_bash"], answer["deny_message"])

    def test_a_correction_is_not_run_as_proposed(self):
        client = FakeClient([MCP, IDLE])
        deliverd = FakeDeliverd(
            lambda kw: decision(True, changes=[{"field": "repo", "from": "acme/api", "to": "acme/staging"}])
        )
        ma.answer_tool_confirmations(client, "sesn_1", deliverd)
        [answer] = client.sent[0]["events"]
        self.assertEqual(answer["result"], "deny")
        self.assertIn('repo from "acme/api" to "acme/staging"', answer["deny_message"])

    def test_an_undecided_call_is_left_waiting(self):
        client = FakeClient([BASH, MCP, IDLE])
        deliverd = FakeDeliverd(lambda kw: timed_out(kw) if kw["external_id"].endswith("bash") else decision(True))
        resolution = ma.answer_tool_confirmations(client, "sesn_1", deliverd, timeout="10s")
        self.assertEqual(resolution.pending, ["sevt_bash"])
        self.assertEqual([e["tool_use_id"] for e in client.sent[0]["events"]], ["sevt_mcp"])

    def test_nothing_for_a_session_that_is_not_waiting(self):
        done = {"id": "sevt_done", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}}
        client, deliverd = FakeClient([BASH, done]), FakeDeliverd()
        ma.answer_tool_confirmations(client, "sesn_1", deliverd)
        self.assertEqual(deliverd.asked, [])
        self.assertEqual(client.sent, [])

    def test_a_gate_action_decides_before_a_person(self):
        client, deliverd = FakeClient([BASH, MCP, IDLE]), FakeDeliverd()
        ma.answer_tool_confirmations(client, "sesn_1", deliverd, actions={"bash": "shell.run"})
        self.assertEqual([g["action"] for g in deliverd.gated], ["shell.run"])
        self.assertEqual(len(deliverd.asked), 1)

    def test_async_with_either_client(self):
        client = FakeClient([BASH, MCP, IDLE])
        resolution = run(ma.answer_tool_confirmations_async(client, "sesn_1", AsyncFakeDeliverd()))
        self.assertEqual(len(resolution.responses), 2)
        self.assertEqual(len(client.sent), 1)


class FollowAndWatch(unittest.TestCase):
    def test_follow_answers_each_pause_and_stops_when_the_turn_ends(self):
        end = {"id": "e", "type": "session.status_idle", "stop_reason": {"type": "end_turn"}}
        never = {"id": "n", "type": "session.status_idle", "stop_reason": {"type": "requires_action", "event_ids": ["x"]}}
        client = FakeClient([BASH, MCP, WORKER], stream=[{"type": "event_start"}, BASH, IDLE, end, never])
        deliverd, seen = FakeDeliverd(), []
        ma.follow_session(client, "sesn_1", deliverd, on_event=seen.append)
        self.assertEqual(len(deliverd.asked), 2)
        self.assertEqual(len(client.sent), 1)
        self.assertEqual(len(seen), 4)

    def test_watch_answers_idle_sessions_and_carries_on_past_a_failure(self):
        client = FakeClient([BASH, IDLE], sessions=["sesn_1", "sesn_2"])
        stop, failed = threading.Event(), []
        original = client.beta.sessions.events.list

        def flaky(session_id: str, **kw: Any) -> Any:
            if session_id == "sesn_2":
                stop.set()
                raise RuntimeError("gone")
            return original(session_id, **kw)

        client.beta.sessions.events.list = flaky
        ma.watch_sessions(
            client, FakeDeliverd(), stop=stop, interval=0.01, on_error=lambda err, sid: failed.append(sid)
        )
        self.assertEqual([s["session"] for s in client.sent], ["sesn_1"])
        self.assertEqual(failed, ["sesn_2"])


if __name__ == "__main__":
    unittest.main()
