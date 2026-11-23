"""The OpenAI Agents SDK and Claude Agent SDK adapters, for Python.

Neither SDK is installed in CI (the package promises no dependencies), so each
is stood in for by classes with the attributes the adapter reads, named after
the real ones. What matters most: a declined call is never approved on the
run's state, a failure to ask never reads as permission, and a tool mapped to
a registered action is decided by its gate.
"""

import os
import sys
import unittest
from typing import Any, Dict, List

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

import test_adapters as base  # noqa: E402

from deliverd.adapters import claude_agent_sdk as claude  # noqa: E402
from deliverd.adapters import openai_agents as oa  # noqa: E402

FakeDeliverd = base.FakeDeliverd
decision = base.decision
gate_decision = base.gate_decision
timed_out = base.timed_out
run = base.run


# ── OpenAI Agents SDK stand-ins ───────────────────────────────────────────


class ResponseFunctionToolCall:
    def __init__(self, name: str, arguments: str, call_id: str) -> None:
        self.name = name
        self.arguments = arguments
        self.call_id = call_id


class ToolApprovalItem:
    def __init__(self, name: str, arguments: str, call_id: str) -> None:
        self.raw_item = ResponseFunctionToolCall(name, arguments, call_id)


class RunState:
    def __init__(self) -> None:
        self.approved: List[str] = []
        self.rejected: List[str] = []

    def approve(self, item: ToolApprovalItem) -> None:
        self.approved.append(item.raw_item.call_id)

    def reject(self, item: ToolApprovalItem) -> None:
        self.rejected.append(item.raw_item.call_id)


class RunResult:
    def __init__(self, interruptions: List[ToolApprovalItem], state: RunState, final_output: Any = None) -> None:
        self.interruptions = interruptions
        self._state = state
        self.final_output = final_output

    def to_state(self) -> RunState:
        return self._state


class Runner:
    """``agents.Runner``: the first run is interrupted, the resumed one finishes."""

    def __init__(self, items: List[ToolApprovalItem]) -> None:
        self.state = RunState()
        self.items = items
        self.calls: List[Any] = []

    async def run(self, agent: Any, input: Any, **kwargs: Any) -> RunResult:
        self.calls.append(input)
        if isinstance(input, RunState):
            return RunResult([], input, final_output="done")
        return RunResult(self.items, self.state)


REFUND = '{"order_id": "1042", "amount": 420}'


class OpenAIAgents(unittest.TestCase):
    def test_approves_on_a_yes_and_resumes_from_the_state(self) -> None:
        deliverd = FakeDeliverd()
        runner = Runner([ToolApprovalItem("issue_refund", REFUND, "call_1")])
        result = run(oa.run_with_deliverd_approvals("agent", "Refund 1042", deliverd, approvers=["finance"], runner=runner))
        self.assertEqual(result.final_output, "done")
        self.assertEqual(runner.state.approved, ["call_1"])
        self.assertEqual(deliverd.asked[0]["external_id"], "openai-agents:call_1")
        self.assertEqual(deliverd.asked[0]["approvers"], ["finance"])

    def test_rejects_on_a_no_and_keeps_the_reason(self) -> None:
        deliverd = FakeDeliverd(decide=lambda kw: decision(False, "rejected", note="Over budget"))
        runner = Runner([ToolApprovalItem("issue_refund", REFUND, "call_2")])
        state, resolution = run(oa.resolve_interruptions(RunResult(runner.items, runner.state), deliverd))
        self.assertEqual(state.rejected, ["call_2"])
        self.assertEqual(state.approved, [])
        self.assertIn("Over budget", resolution.reasons["call_2"])

    def test_leaves_a_call_nobody_decided_unanswered(self) -> None:
        deliverd = FakeDeliverd(decide=timed_out)
        runner = Runner([ToolApprovalItem("issue_refund", REFUND, "call_3")])
        result = run(oa.run_with_deliverd_approvals("agent", "x", deliverd, timeout="1s", runner=runner))
        self.assertEqual(len(result.interruptions), 1)
        self.assertEqual(runner.state.approved + runner.state.rejected, [])

    def test_a_mapped_tool_goes_to_its_gate(self) -> None:
        deliverd = FakeDeliverd()
        runner = Runner([ToolApprovalItem("issue_refund", REFUND, "call_4")])
        run(oa.run_with_deliverd_approvals("agent", "x", deliverd, actions={"issue_refund": "finance.refund"}, runner=runner))
        self.assertEqual(deliverd.asked, [])
        self.assertEqual(deliverd.gated[0]["action"], "finance.refund")


# ── Claude Agent SDK ──────────────────────────────────────────────────────


def allow(input: Dict[str, Any]) -> Any:
    return ("allow", dict(input))


def deny(message: str) -> Any:
    return ("deny", message)


class ClaudeAgentSdk(unittest.TestCase):
    def callback(self, deliverd: Any, **kwargs: Any) -> Any:
        return claude.deliverd_can_use_tool(deliverd, allow=allow, deny=deny, **kwargs)

    def test_lets_an_unselected_call_through_without_asking(self) -> None:
        deliverd = FakeDeliverd()
        answer = run(self.callback(deliverd, when=lambda tool, input: tool == "Bash")("Read", {"path": "a"}, None))
        self.assertEqual(answer, ("allow", {"path": "a"}))
        self.assertEqual(deliverd.asked, [])

    def test_asks_and_allows_on_a_yes_keyed_by_tool_and_input(self) -> None:
        deliverd = FakeDeliverd()
        cb = self.callback(deliverd, approvers=["ops"])
        self.assertEqual(run(cb("Bash", {"command": "make"}, None)), ("allow", {"command": "make"}))
        run(cb("Bash", {"command": "make"}, None))
        self.assertTrue(deliverd.asked[0]["external_id"].startswith("claude-agent-sdk:Bash:"))
        self.assertEqual(deliverd.asked[0]["external_id"], deliverd.asked[1]["external_id"])

    def test_denies_with_the_reason_and_on_any_failure(self) -> None:
        no = FakeDeliverd(decide=lambda kw: decision(False, "rejected", note="Not today"))
        kind, message = run(self.callback(no)("Bash", {}, None))
        self.assertEqual(kind, "deny")
        self.assertIn("Not today", message)

        def boom(kw: Dict[str, Any]) -> Any:
            raise RuntimeError("network down")

        kind, message = run(self.callback(FakeDeliverd(decide=boom))("Bash", {}, None))
        self.assertEqual(kind, "deny")
        self.assertIn("network down", message)
        kind, _ = run(self.callback(FakeDeliverd(decide=timed_out), timeout="1s")("Bash", {}, None))
        self.assertEqual(kind, "deny")

    def test_a_mapped_tool_goes_to_its_gate(self) -> None:
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(False, reason="Refused by policy"))
        kind, message = run(self.callback(deliverd, actions={"refund": "finance.refund"})("refund", {"amount": 9}, None))
        self.assertEqual(kind, "deny")
        self.assertEqual(deliverd.gated[0]["action"], "finance.refund")
        self.assertEqual(deliverd.asked, [])


if __name__ == "__main__":
    unittest.main()
