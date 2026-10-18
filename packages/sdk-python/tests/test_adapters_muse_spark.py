"""The Muse Spark adapter: the function calls in a Meta Model API response,
answered by a person through Deliverd before any of them runs.

What matters most: a declined call never runs, every call gets an output the
API will accept, and the model is told why a call did not run.
"""

import os
import sys
import unittest
from typing import Any, List, Tuple

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

import test_adapters as base  # noqa: E402

from deliverd.adapters import muse_spark as muse  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
gate_decision = base.gate_decision
timed_out = base.timed_out
run = base.run


class FunctionCall:
    """``openai.types.responses.ResponseFunctionToolCall``, as Meta's API returns it."""

    def __init__(self, call_id: str, name: str, arguments: str) -> None:
        self.type = "function_call"
        self.call_id = call_id
        self.name = name
        self.arguments = arguments


OUTPUT = [
    {"type": "reasoning", "id": "rs_1"},
    FunctionCall("call_1", "refund", '{"order": "1042", "amount": 420}'),
    {"type": "function_call", "call_id": "call_2", "name": "lookup", "arguments": '{"order": "1042"}'},
]


def recorder() -> Tuple[List[Tuple[str, Any]], Any]:
    ran: List[Tuple[str, Any]] = []

    def run_tool(tool: str, args: Any) -> Any:
        ran.append((tool, args))
        return {"refunded": True} if tool == "refund" else "found it"

    return ran, run_tool


class ResponsesApi(unittest.TestCase):
    def test_asks_only_about_what_needs_a_person_and_answers_every_call(self):
        deliverd = FakeDeliverd()
        ran, run_tool = recorder()
        results = muse.run_function_calls(
            deliverd, OUTPUT, run_tool, when=lambda tool, args: tool == "refund", approvers=["finance"]
        )
        self.assertEqual(len(deliverd.asked), 1)
        self.assertEqual(deliverd.asked[0]["external_id"], "muse-spark:call_1")
        self.assertEqual(deliverd.asked[0]["approvers"], ["finance"])
        self.assertEqual(deliverd.asked[0]["input"], {"order": "1042", "amount": 420})
        self.assertEqual(ran, [("refund", {"order": "1042", "amount": 420}), ("lookup", {"order": "1042"})])
        self.assertEqual(
            results,
            [
                {"type": "function_call_output", "call_id": "call_1", "output": '{"refunded": true}'},
                {"type": "function_call_output", "call_id": "call_2", "output": "found it"},
            ],
        )

    def test_a_declined_call_never_runs_and_the_model_reads_why(self):
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Over the limit"))
        ran, run_tool = recorder()
        [result] = muse.run_function_calls(deliverd, OUTPUT[:2], run_tool)
        self.assertEqual(ran, [])
        self.assertIn("A person declined running refund by Dana", result["output"])
        self.assertIn("Over the limit", result["output"])

    def test_a_call_approved_only_with_changes_is_not_run_as_proposed(self):
        changes = [{"field": "amount", "from": 420, "to": 200}]
        deliverd = FakeDeliverd(lambda kw: decision(True, changes=changes))
        ran, run_tool = recorder()
        [result] = muse.run_function_calls(deliverd, OUTPUT[:2], run_tool)
        self.assertEqual(ran, [])
        self.assertIn("amount from 420 to 200", result["output"])

    def test_an_undecided_call_is_answered_not_run_and_left_open(self):
        deliverd = FakeDeliverd(timed_out)
        ran, run_tool = recorder()
        [result] = muse.run_function_calls(deliverd, OUTPUT[:2], run_tool, timeout="1m")
        self.assertEqual(ran, [])
        self.assertIn("Nobody decided whether to run refund in time", result["output"])

    def test_policy_decides_a_mapped_tool_before_anyone_is_asked(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(True))
        ran, run_tool = recorder()
        muse.run_function_calls(deliverd, OUTPUT[:2], run_tool, actions={"refund": "payments.refund"})
        self.assertEqual(deliverd.gated[0]["action"], "payments.refund")
        self.assertEqual(deliverd.asked, [])
        self.assertEqual(len(ran), 1)

    def test_the_async_variant_awaits_the_client_and_the_tool(self):
        deliverd = AsyncFakeDeliverd()

        async def run_tool(tool: str, args: Any) -> Any:
            return {"ok": tool}

        results = run(muse.run_function_calls_async(deliverd, OUTPUT, run_tool))
        self.assertEqual([r["output"] for r in results], ['{"ok": "refund"}', '{"ok": "lookup"}'])
        self.assertEqual(len(deliverd.asked), 2)


class ChatCompletions(unittest.TestCase):
    def test_tool_calls_are_answered_with_tool_messages(self):
        deliverd = FakeDeliverd()
        message = {
            "role": "assistant",
            "tool_calls": [
                {"id": "call_9", "type": "function", "function": {"name": "send_email", "arguments": '{"to": "a@b.test"}'}}
            ],
        }
        results = muse.run_tool_calls(deliverd, message, lambda tool, args: {"sent": args["to"]})
        self.assertEqual(deliverd.asked[0]["external_id"], "muse-spark:call_9")
        self.assertEqual(results, [{"role": "tool", "tool_call_id": "call_9", "content": '{"sent": "a@b.test"}'}])

    def test_a_message_with_no_tool_calls_needs_nothing(self):
        self.assertEqual(muse.run_tool_calls(FakeDeliverd(), {"tool_calls": None}, lambda t, a: "x"), [])


if __name__ == "__main__":
    unittest.main()
