"""The Perplexity adapter: Agent API approval requests and function calls,
answered by a person through Deliverd.

What matters most: a declined call never runs, the model reads why, every
request is keyed by its id so it is asked once, and the follow-up carries the
tools unchanged, as Perplexity requires.
"""

import os
import sys
import unittest
from typing import Any, Dict, List

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

import test_adapters as base  # noqa: E402

from deliverd.adapters import perplexity  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
timed_out = base.timed_out
run = base.run

REQUEST = {
    "type": "mcp_approval_request",
    "id": "mcpr_1",
    "server_label": "linear",
    "connector_id": "connector_linear",
    "name": "update_issue",
    "arguments": '{"id": "LIN-12", "state": "Done"}',
}
CALL = {"type": "function_call", "call_id": "fc_1", "name": "refund", "arguments": '{"amount": 900}'}
TOOLS = [{"type": "connector", "id": "connector_linear", "server_label": "linear", "require_approval": "always"}]


class Response:
    def __init__(self, id: str, output: List[Any]) -> None:
        self.id = id
        self.output = output


class Client:
    def __init__(self, script: List[Response]) -> None:
        self.sent: List[Dict[str, Any]] = []
        self._script = script
        self.responses = self

    def create(self, **kwargs: Any) -> Response:
        self.sent.append(kwargs)
        return self._script.pop(0)


class AsyncClient(Client):
    async def create(self, **kwargs: Any) -> Response:  # type: ignore[override]
        return Client.create(self, **kwargs)


class ApprovalRequests(unittest.TestCase):
    def test_a_yes_is_answered_and_asked_once_by_id(self):
        deliverd = FakeDeliverd()
        resolution = perplexity.approval_responses_for([{"type": "mcp_list_tools"}, REQUEST], deliverd, approvers=["platform"])
        self.assertEqual(len(deliverd.asked), 1)
        self.assertEqual(deliverd.asked[0]["external_id"], "perplexity:mcpr_1")
        self.assertEqual(
            resolution.responses,
            [{"type": "mcp_approval_response", "approval_request_id": "mcpr_1", "approve": True}],
        )
        self.assertTrue(resolution.complete)

    def test_a_no_carries_the_persons_reason(self):
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Not before the release"))
        resolution = perplexity.approval_responses_for([REQUEST], deliverd)
        answer = resolution.responses[0]
        self.assertFalse(answer["approve"])
        self.assertIn("Not before the release", answer["reason"])
        quiet = perplexity.approval_responses_for([REQUEST], deliverd, send_reason=False)
        self.assertNotIn("reason", quiet.responses[0])

    def test_undecided_is_pending_with_no_answer(self):
        resolution = perplexity.approval_responses_for([REQUEST], FakeDeliverd(timed_out))
        self.assertEqual(resolution.pending, ["mcpr_1"])
        self.assertEqual(resolution.responses, [])


class FunctionCalls(unittest.TestCase):
    def test_a_declined_call_never_runs(self):
        ran: List[str] = []
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Too much"))
        results = perplexity.run_function_calls(deliverd, [CALL], lambda tool, args: ran.append(tool))
        self.assertEqual(ran, [])
        self.assertEqual(deliverd.asked[0]["external_id"], "perplexity:fc_1")
        self.assertEqual(results[0]["type"], "function_call_output")
        self.assertIn("Too much", results[0]["output"])


class Loop(unittest.TestCase):
    def test_answers_until_nothing_is_asked_chained_by_response_id(self):
        client = Client([Response("resp_1", [REQUEST, CALL]), Response("resp_2", [{"type": "message"}])])
        final = perplexity.run_with_deliverd_approvals(
            client,
            FakeDeliverd(),
            create_kwargs={"model": "openai/gpt-5.6-sol", "input": "Close LIN-12", "tools": TOOLS},
            run=lambda tool, args: {"refunded": True},
        )
        self.assertEqual(final.id, "resp_2")
        self.assertEqual(
            client.sent[1],
            {
                "model": "openai/gpt-5.6-sol",
                "tools": TOOLS,
                "input": [
                    {"type": "mcp_approval_response", "approval_request_id": "mcpr_1", "approve": True},
                    {"type": "function_call_output", "call_id": "fc_1", "output": '{"refunded": true}'},
                ],
                "previous_response_id": "resp_1",
            },
        )

    def test_replay_resends_the_conversation(self):
        client = Client([Response("resp_1", [REQUEST]), Response("resp_2", [])])
        perplexity.run_with_deliverd_approvals(
            client, FakeDeliverd(), create_kwargs={"model": "m", "input": "Close LIN-12"}, replay=True
        )
        self.assertNotIn("previous_response_id", client.sent[1])
        self.assertEqual(
            client.sent[1]["input"],
            [
                {"type": "message", "role": "user", "content": "Close LIN-12"},
                REQUEST,
                {"type": "mcp_approval_response", "approval_request_id": "mcpr_1", "approve": True},
            ],
        )

    def test_returns_early_while_somebody_is_still_deciding(self):
        client = Client([Response("resp_1", [REQUEST])])
        final = perplexity.run_with_deliverd_approvals(
            client, FakeDeliverd(timed_out), create_kwargs={"model": "m", "input": "x"}
        )
        self.assertEqual(final.id, "resp_1")
        self.assertEqual(len(client.sent), 1)

    def test_a_function_call_with_nothing_to_run_it_is_handed_back(self):
        client = Client([Response("resp_1", [CALL])])
        final = perplexity.run_with_deliverd_approvals(client, FakeDeliverd(), create_kwargs={"model": "m", "input": "x"})
        self.assertEqual(final.id, "resp_1")

    def test_stops_after_max_rounds(self):
        client = Client([Response("r%d" % i, [dict(REQUEST, id="m%d" % i)]) for i in range(4)])
        with self.assertRaises(RuntimeError):
            perplexity.run_with_deliverd_approvals(
                client, FakeDeliverd(), create_kwargs={"model": "m", "input": "x"}, max_rounds=2
            )

    def test_async(self):
        client = AsyncClient([Response("resp_1", [REQUEST, CALL]), Response("resp_2", [])])

        async def refund(tool: str, args: Any) -> str:
            return "ok"

        final = run(
            perplexity.run_with_deliverd_approvals_async(
                client, AsyncFakeDeliverd(), create_kwargs={"model": "m", "input": "x"}, run=refund
            )
        )
        self.assertEqual(final.id, "resp_2")
        self.assertEqual(client.sent[1]["input"][1]["output"], "ok")


if __name__ == "__main__":
    unittest.main()
