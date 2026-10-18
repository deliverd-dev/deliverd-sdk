"""The AWS and Google adapters: Bedrock Agents' return of control, Strands'
tool hooks, and ADK's before-tool callback and tool confirmation, answered by
a person through Deliverd.

None of boto3, Strands or ADK is installed in CI — the package promises no
dependencies — so each is stood in for by the shapes the adapter reads, named
after the real ones and taken from each service's API reference.

What matters most, in order: a call a person declined never runs; a call
approved only with changes never runs as proposed; a failure to ask never
reads as permission; and the agent is told why a call did not run.
"""

import json
import os
import sys
import types
import unittest
from typing import Any, Dict, List, Optional
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

# A module import, not ``from ... import``, so its test classes are not
# collected a second time from here.
import test_adapters as base  # noqa: E402

from deliverd.adapters import adk  # noqa: E402
from deliverd.adapters import bedrock  # noqa: E402
from deliverd.adapters import strands  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
gate_decision = base.gate_decision
timed_out = base.timed_out
development = base.development
run = base.run


# ── Amazon Bedrock Agents ─────────────────────────────────────────────────


def function_input(
    function: str = "issue_refund",
    invocation_type: str = "USER_CONFIRMATION",
    group: str = "BillingActions",
    **extra: Any,
) -> Dict[str, Any]:
    fields = {
        "actionGroup": group,
        "function": function,
        "actionInvocationType": invocation_type,
        "parameters": [
            {"name": "order_id", "type": "string", "value": "1042"},
            {"name": "amount", "type": "number", "value": "420"},
        ],
    }
    fields.update(extra)
    return {"functionInvocationInput": fields}


def api_input(invocation_type: str = "USER_CONFIRMATION") -> Dict[str, Any]:
    return {
        "apiInvocationInput": {
            "actionGroup": "RefundsApi",
            "apiPath": "/refunds",
            "httpMethod": "POST",
            "actionInvocationType": invocation_type,
            "parameters": [{"name": "dry_run", "type": "boolean", "value": "false"}],
            "requestBody": {
                "content": {"application/json": {"properties": [{"name": "order_id", "type": "string", "value": "1042"}]}}
            },
        }
    }


def return_control(*inputs: Dict[str, Any], invocation_id: str = "inv-1") -> Dict[str, Any]:
    return {"invocationId": invocation_id, "invocationInputs": list(inputs)}


class BedrockResolve(unittest.TestCase):
    def test_a_confirmed_function_is_answered_confirm_and_asked_once_by_its_place(self):
        deliverd = FakeDeliverd()
        resolution = bedrock.confirmation_results_for(return_control(function_input()), deliverd, approvers=["finance"])
        self.assertTrue(resolution.complete)
        self.assertEqual(
            resolution.session_state,
            {
                "invocationId": "inv-1",
                "returnControlInvocationResults": [
                    {"functionResult": {"actionGroup": "BillingActions", "function": "issue_refund", "confirmationState": "CONFIRM"}}
                ],
            },
        )
        asked = deliverd.asked[0]
        self.assertEqual(asked["external_id"], "bedrock:inv-1:0")
        self.assertEqual(asked["input"], {"order_id": "1042", "amount": "420"})
        self.assertEqual(asked["title"], "Allow the agent to run issue_refund on BillingActions")
        self.assertEqual(asked["approvers"], ["finance"])

    def test_a_declined_call_is_denied_with_the_persons_reason(self):
        resolution = bedrock.confirmation_results_for(return_control(function_input()), FakeDeliverd(lambda kw: decision(False)))
        result = resolution.responses[0]["functionResult"]
        self.assertEqual(result["confirmationState"], "DENY")
        self.assertIn("A person declined running issue_refund by Dana.", result["responseBody"]["TEXT"]["body"])
        self.assertEqual(resolution.reasons["inv-1:0"], result["responseBody"]["TEXT"]["body"])

    def test_the_reason_can_be_left_off(self):
        resolution = bedrock.confirmation_results_for(
            return_control(function_input()), FakeDeliverd(lambda kw: decision(False)), send_reason=False
        )
        self.assertNotIn("responseBody", resolution.responses[0]["functionResult"])
        self.assertEqual(resolution.responses[0]["functionResult"]["confirmationState"], "DENY")

    def test_approved_only_with_changes_is_denied(self):
        changes = [{"field": "amount", "from": "420", "to": "42"}]
        resolution = bedrock.confirmation_results_for(
            return_control(function_input()), FakeDeliverd(lambda kw: decision(True, changes=changes))
        )
        result = resolution.responses[0]["functionResult"]
        self.assertEqual(result["confirmationState"], "DENY")
        self.assertIn('amount from "420" to "42"', result["responseBody"]["TEXT"]["body"])

    def test_an_api_operation_is_read_and_answered_as_one(self):
        deliverd = FakeDeliverd(lambda kw: decision(False))
        resolution = bedrock.confirmation_results_for(return_control(api_input()), deliverd)
        self.assertEqual(deliverd.asked[0]["input"], {"dry_run": "false", "order_id": "1042"})
        self.assertEqual(deliverd.asked[0]["metadata"]["tool"], "POST /refunds")
        result = resolution.responses[0]["apiResult"]
        self.assertEqual(
            {k: result[k] for k in ("actionGroup", "apiPath", "httpMethod", "httpStatusCode", "confirmationState")},
            {"actionGroup": "RefundsApi", "apiPath": "/refunds", "httpMethod": "POST", "httpStatusCode": 403, "confirmationState": "DENY"},
        )
        self.assertIn("declined", result["responseBody"]["application/json"]["body"])

    def test_a_wait_that_runs_out_is_pending_and_nothing_is_sent(self):
        resolution = bedrock.confirmation_results_for(return_control(function_input()), FakeDeliverd(timed_out), timeout=1)
        self.assertEqual((resolution.responses, resolution.pending, resolution.complete), ([], ["inv-1:0"], False))

    def test_return_of_control_without_run_action_is_left_for_the_caller_unasked(self):
        deliverd = FakeDeliverd()
        resolution = bedrock.confirmation_results_for(
            return_control(function_input(), function_input("lookup_order", "RESULT")), deliverd
        )
        self.assertEqual(resolution.unanswered, [1])
        self.assertFalse(resolution.complete)
        self.assertEqual(len(deliverd.asked), 1, "a call it could not answer was asked about anyway")

    def test_return_of_control_runs_only_what_was_approved(self):
        ran: List[str] = []

        def run_action(call: Any) -> Any:
            ran.append(call.tool)
            return {"status": "refunded", "order": call.input["order_id"]}

        deliverd = FakeDeliverd(lambda kw: decision(kw["metadata"]["tool"] == "issue_refund"))
        resolution = bedrock.confirmation_results_for(
            return_control(
                function_input("issue_refund", "RESULT"),
                function_input("close_account", "USER_CONFIRMATION_AND_RESULT"),
            ),
            deliverd,
            run_action=run_action,
        )
        self.assertEqual(ran, ["issue_refund"])
        approved, declined = [r["functionResult"] for r in resolution.responses]
        self.assertNotIn("confirmationState", approved, "a RESULT call has nothing to confirm")
        self.assertEqual(json.loads(approved["responseBody"]["TEXT"]["body"]), {"status": "refunded", "order": "1042"})
        self.assertEqual(declined["confirmationState"], "DENY")
        self.assertIn("declined", declined["responseBody"]["TEXT"]["body"])

    def test_a_collaborators_call_is_answered_to_that_agent(self):
        resolution = bedrock.confirmation_results_for(
            return_control(function_input(agentId="AGENT2")), FakeDeliverd()
        )
        self.assertEqual(resolution.responses[0]["functionResult"]["agentId"], "AGENT2")

    def test_when_and_actions(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(False, status="denied", reason="Over the limit"))
        resolution = bedrock.confirmation_results_for(
            return_control(function_input("lookup_order"), function_input("issue_refund"), function_input("close_account")),
            deliverd,
            when=lambda tool, args: tool != "lookup_order",
            actions={"close_account": "billing.close_account"},
        )
        self.assertEqual(
            [r["functionResult"]["confirmationState"] for r in resolution.responses], ["CONFIRM", "CONFIRM", "DENY"]
        )
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["bedrock:inv-1:1"])
        self.assertEqual(deliverd.gated[0]["action"], "billing.close_account")
        self.assertIn("Over the limit", resolution.reasons["inv-1:2"])

    def test_the_async_variant_with_the_real_client_offline(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        payload = return_control(function_input(), invocation_id="inv-7")
        first = run(bedrock.confirmation_results_for_async(payload, deliverd))
        second = run(bedrock.confirmation_results_for_async(payload, deliverd))
        self.assertEqual(
            [r["functionResult"]["confirmationState"] for r in first.responses + second.responses], ["CONFIRM", "CONFIRM"]
        )
        self.assertEqual(len(deliverd.sync.approvals.list(external_id="bedrock:inv-7:0")), 1)


class Runtime:
    """``boto3.client("bedrock-agent-runtime")``: ``invoke_agent`` returns a
    dict whose ``completion`` is an event stream of ``chunk`` and
    ``returnControl`` events."""

    def __init__(self, *streams: List[Dict[str, Any]]) -> None:
        self._streams = list(streams)
        self.calls: List[Dict[str, Any]] = []

    def invoke_agent(self, **kwargs: Any) -> Dict[str, Any]:
        self.calls.append(kwargs)
        return {"sessionId": kwargs.get("sessionId"), "completion": iter(self._streams.pop(0))}


def chunk(text: str) -> Dict[str, Any]:
    return {"chunk": {"bytes": text.encode("utf-8")}}


class BedrockLoop(unittest.TestCase):
    INVOKE = {"agentId": "A1", "agentAliasId": "TSTALIASID", "sessionId": "s-1", "inputText": "Refund 1042", "enableTrace": False}

    def test_answers_on_the_same_session_and_returns_the_text(self):
        runtime = Runtime(
            [chunk("Checking. "), {"returnControl": return_control(function_input())}],
            [chunk("Refunded.")],
        )
        result = bedrock.invoke_with_deliverd_approvals(runtime, FakeDeliverd(), invoke_kwargs=self.INVOKE)
        self.assertEqual(result.text, "Checking. Refunded.")
        self.assertIsNone(result.return_control)
        first, second = runtime.calls
        self.assertEqual(first, self.INVOKE)
        self.assertEqual(
            second,
            {
                "agentId": "A1",
                "agentAliasId": "TSTALIASID",
                "sessionId": "s-1",
                "enableTrace": False,
                "sessionState": {
                    "invocationId": "inv-1",
                    "returnControlInvocationResults": [
                        {"functionResult": {"actionGroup": "BillingActions", "function": "issue_refund", "confirmationState": "CONFIRM"}}
                    ],
                },
            },
        )

    def test_stops_with_the_open_return_of_control_when_somebody_has_not_decided(self):
        payload = return_control(function_input())
        runtime = Runtime([{"returnControl": payload}])
        result = bedrock.invoke_with_deliverd_approvals(runtime, FakeDeliverd(timed_out), invoke_kwargs=self.INVOKE, timeout=1)
        self.assertEqual((result.return_control, len(runtime.calls)), (payload, 1))
        self.assertEqual(result.resolution.pending, ["inv-1:0"])

    def test_stops_an_agent_that_keeps_asking(self):
        runtime = Runtime(*[[{"returnControl": return_control(function_input(), invocation_id="i%d" % i)}] for i in range(4)])
        with self.assertRaises(RuntimeError):
            bedrock.invoke_with_deliverd_approvals(runtime, FakeDeliverd(), invoke_kwargs=self.INVOKE, max_rounds=2)


# ── Strands Agents ────────────────────────────────────────────────────────


class BeforeToolCallEvent:
    """``strands.hooks.BeforeToolCallEvent``: ``tool_use`` and ``cancel_tool``."""

    def __init__(self, name: str = "issue_refund", tool_input: Any = None, tool_use_id: str = "tooluse_1") -> None:
        self.tool_use = {"toolUseId": tool_use_id, "name": name, "input": {"order_id": "1042"} if tool_input is None else tool_input}
        self.cancel_tool: Any = False


class HookRegistry:
    def __init__(self) -> None:
        self.callbacks: List[Any] = []

    def add_callback(self, event_type: Any, callback: Any) -> None:
        self.callbacks.append((event_type, callback))


def fake_strands() -> Dict[str, types.ModuleType]:
    root = types.ModuleType("strands")
    hooks = types.ModuleType("strands.hooks")
    hooks.BeforeToolCallEvent = BeforeToolCallEvent  # type: ignore[attr-defined]
    root.hooks = hooks  # type: ignore[attr-defined]
    return {"strands": root, "strands.hooks": hooks}


class StrandsHooks(unittest.TestCase):
    def test_registers_for_the_before_tool_call_event(self):
        approvals = strands.DeliverdApprovals(FakeDeliverd())
        registry = HookRegistry()
        with mock.patch.dict(sys.modules, fake_strands()):
            approvals.register_hooks(registry)
        self.assertEqual(registry.callbacks, [(BeforeToolCallEvent, approvals.before_tool_call)])

    def test_an_approved_call_runs_and_is_asked_once_by_its_tool_use_id(self):
        deliverd = FakeDeliverd()
        event = BeforeToolCallEvent()
        strands.DeliverdApprovals(deliverd, approvers=["finance"]).before_tool_call(event)
        self.assertIs(event.cancel_tool, False)
        self.assertEqual(deliverd.asked[0]["external_id"], "strands:tooluse_1")
        self.assertEqual(deliverd.asked[0]["input"], {"order_id": "1042"})

    def test_a_declined_call_is_cancelled_with_the_persons_reason(self):
        event = BeforeToolCallEvent()
        strands.DeliverdApprovals(FakeDeliverd(lambda kw: decision(False))).before_tool_call(event)
        self.assertIn("A person declined running issue_refund by Dana.", event.cancel_tool)

    def test_approved_only_with_changes_is_cancelled(self):
        event = BeforeToolCallEvent()
        changes = [{"field": "order_id", "from": "1042", "to": "1043"}]
        strands.DeliverdApprovals(FakeDeliverd(lambda kw: decision(True, changes=changes))).before_tool_call(event)
        self.assertIn("only with changes", event.cancel_tool)

    def test_a_wait_that_runs_out_cancels_and_says_it_is_still_waiting(self):
        event = BeforeToolCallEvent()
        strands.DeliverdApprovals(FakeDeliverd(timed_out), timeout=1).before_tool_call(event)
        self.assertIn("Nobody has decided yet", event.cancel_tool)

    def test_a_failure_to_ask_cancels_rather_than_letting_the_tool_run(self):
        def unreachable(kwargs: Dict[str, Any]) -> Any:
            raise ConnectionError("Deliverd could not be reached.")

        event = BeforeToolCallEvent()
        strands.DeliverdApprovals(FakeDeliverd(unreachable)).before_tool_call(event)
        self.assertIn("approval could not be asked for: Deliverd could not be reached.", event.cancel_tool)

    def test_when_and_actions(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(True))
        approvals = strands.DeliverdApprovals(
            deliverd, when=lambda tool, args: tool == "issue_refund", actions={"close_account": "billing.close_account"}
        )
        events = [BeforeToolCallEvent(name) for name in ("lookup_order", "issue_refund", "close_account")]
        for event in events:
            approvals.before_tool_call(event)
        self.assertEqual([e.cancel_tool for e in events], [False, False, False])
        self.assertEqual([a["metadata"]["tool"] for a in deliverd.asked], ["issue_refund"])
        self.assertEqual([g["action"] for g in deliverd.gated], ["billing.close_account"])

    def test_the_async_client_is_used_through_its_blocking_twin_and_asks_once(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        approvals = strands.DeliverdApprovals(deliverd)
        for _ in range(2):
            approvals.before_tool_call(BeforeToolCallEvent(tool_use_id="tooluse_9"))
        self.assertEqual(len(deliverd.sync.approvals.list(external_id="strands:tooluse_9")), 1)


# ── Google ADK ────────────────────────────────────────────────────────────


class Tool:
    def __init__(self, name: str) -> None:
        self.name = name


class ToolContext:
    def __init__(self, function_call_id: Optional[str] = "adk-call-1", invocation_id: str = "e-1") -> None:
        self.function_call_id = function_call_id
        self.invocation_id = invocation_id


ARGS = {"order_id": "1042", "amount": 420}


class AdkCallback(unittest.TestCase):
    def test_an_approved_call_runs_and_is_asked_once_by_its_function_call_id(self):
        deliverd = FakeDeliverd()
        callback = adk.deliverd_before_tool_callback(deliverd, approvers=["finance"])
        self.assertIsNone(callback(tool=Tool("issue_refund"), args=ARGS, tool_context=ToolContext()))
        self.assertEqual(deliverd.asked[0]["external_id"], "adk:adk-call-1")
        self.assertEqual(deliverd.asked[0]["input"], ARGS)

    def test_a_declined_call_does_not_run_and_the_model_reads_why(self):
        callback = adk.deliverd_before_tool_callback(FakeDeliverd(lambda kw: decision(False)))
        result = callback(tool=Tool("issue_refund"), args=ARGS, tool_context=ToolContext())
        self.assertIn("A person declined running issue_refund by Dana.", result["error"])

    def test_approved_only_with_changes_does_not_run(self):
        changes = [{"field": "amount", "from": 420, "to": 42}]
        callback = adk.deliverd_before_tool_callback(FakeDeliverd(lambda kw: decision(True, changes=changes)))
        self.assertIn("only with changes", callback(tool=Tool("issue_refund"), args=ARGS, tool_context=ToolContext())["error"])

    def test_a_wait_that_runs_out_and_a_failure_to_ask_both_stop_the_call(self):
        def unreachable(kwargs: Dict[str, Any]) -> Any:
            raise ConnectionError("Deliverd could not be reached.")

        waited = adk.deliverd_before_tool_callback(FakeDeliverd(timed_out), timeout=1)
        failed = adk.deliverd_before_tool_callback(FakeDeliverd(unreachable))
        self.assertIn("Nobody has decided yet", waited(Tool("t"), ARGS, ToolContext())["error"])
        self.assertIn("could not be asked for", failed(Tool("t"), ARGS, ToolContext())["error"])

    def test_a_call_with_no_id_is_keyed_by_its_invocation_and_input(self):
        deliverd = FakeDeliverd()
        adk.deliverd_before_tool_callback(deliverd)(Tool("issue_refund"), ARGS, ToolContext(function_call_id=None))
        self.assertRegex(deliverd.asked[0]["external_id"], r"^adk:e-1:issue_refund:[0-9a-f]+$")

    def test_the_async_callback_and_an_async_when(self):
        async def when(tool: str, args: Any) -> bool:
            return tool == "issue_refund"

        deliverd = AsyncFakeDeliverd(lambda kw: decision(False))
        callback = adk.deliverd_before_tool_callback_async(deliverd, when=when)
        self.assertIsNone(run(callback(tool=Tool("lookup_order"), args={}, tool_context=ToolContext("a"))))
        self.assertIn("declined", run(callback(tool=Tool("issue_refund"), args=ARGS, tool_context=ToolContext("b")))["error"])
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["adk:b"])


def confirmation_event(request_id: str = "adk-confirm-1", original_id: str = "adk-call-1", camel: bool = False, hint: Optional[str] = "Refunds over €100 need finance.") -> Dict[str, Any]:
    call = {
        "id": request_id,
        "name": "adk_request_confirmation",
        "args": {
            "originalFunctionCall": {"id": original_id, "name": "issue_refund", "args": ARGS},
            "toolConfirmation": {"hint": hint, "confirmed": False},
        },
    }
    return {"author": "billing", "content": {"role": "model", "parts": [{"functionCall" if camel else "function_call": call}]}}


class AdkConfirmation(unittest.TestCase):
    def test_each_confirmation_is_asked_by_the_call_it_confirms_and_answered_by_its_own_id(self):
        deliverd = FakeDeliverd(lambda kw: decision(kw["external_id"] == "adk:adk-call-1"))
        events = [
            {"content": {"role": "model", "parts": [{"text": "Let me check."}]}},
            confirmation_event(),
            confirmation_event("adk-confirm-2", "adk-call-2", camel=True),
        ]
        resolution = adk.confirmation_responses_for(events, deliverd, approvers=["finance"])
        self.assertEqual(
            resolution.responses,
            [
                {"function_response": {"id": "adk-confirm-1", "name": "adk_request_confirmation", "response": {"confirmed": True}}},
                {"function_response": {"id": "adk-confirm-2", "name": "adk_request_confirmation", "response": {"confirmed": False}}},
            ],
        )
        self.assertIn("declined", resolution.reasons["adk-confirm-2"])
        asked = deliverd.asked[0]
        self.assertEqual((asked["input"], asked["metadata"]["tool"]), (ARGS, "issue_refund"))
        self.assertTrue(asked["description"].startswith("Refunds over €100 need finance."), asked["description"])

    def test_one_already_answered_is_not_asked_again(self):
        answered = {"content": {"role": "user", "parts": [{"function_response": {"id": "adk-confirm-1", "name": "adk_request_confirmation", "response": {"confirmed": True}}}]}}
        deliverd = FakeDeliverd()
        resolution = adk.confirmation_responses_for([confirmation_event(), answered], deliverd)
        self.assertEqual((resolution.responses, deliverd.asked), ([], []))

    def test_approved_only_with_changes_is_not_confirmed(self):
        changes = [{"field": "amount", "from": 420, "to": 42}]
        resolution = adk.confirmation_responses_for([confirmation_event()], FakeDeliverd(lambda kw: decision(True, changes=changes)))
        self.assertFalse(resolution.responses[0]["function_response"]["response"]["confirmed"])

    def test_a_wait_that_runs_out_is_pending(self):
        resolution = adk.confirmation_responses_for([confirmation_event()], FakeDeliverd(timed_out), timeout=1)
        self.assertEqual((resolution.responses, resolution.pending), ([], ["adk-confirm-1"]))

    def test_the_async_variant_with_the_real_client_offline_asks_once(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        for _ in range(2):
            resolution = run(adk.confirmation_responses_for_async([confirmation_event(original_id="adk-call-7")], deliverd))
            self.assertTrue(resolution.responses[0]["function_response"]["response"]["confirmed"])
        self.assertEqual(len(deliverd.sync.approvals.list(external_id="adk:adk-call-7")), 1)


class AdkApp:
    """Agent Engine's ``AdkApp``: ``stream_query`` yields event dicts."""

    def __init__(self, *rounds: List[Dict[str, Any]]) -> None:
        self._rounds = list(rounds)
        self.calls: List[Dict[str, Any]] = []

    def stream_query(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return iter(self._rounds.pop(0))


class AdkLoop(unittest.TestCase):
    def test_answers_on_the_same_session_and_returns_every_event(self):
        done = {"content": {"role": "model", "parts": [{"text": "Refunded."}]}}
        app = AdkApp([confirmation_event()], [done])
        events = adk.run_with_deliverd_confirmations(app, FakeDeliverd(), user_id="u-1", session_id="s-1", message="Refund 1042")
        self.assertEqual(events[-1], done)
        first, second = app.calls
        self.assertEqual(first, {"user_id": "u-1", "session_id": "s-1", "message": "Refund 1042"})
        self.assertEqual(second["session_id"], "s-1")
        self.assertEqual(second["message"]["role"], "user")
        self.assertEqual(second["message"]["parts"][0]["function_response"]["id"], "adk-confirm-1")

    def test_stops_when_somebody_has_not_decided(self):
        app = AdkApp([confirmation_event()])
        events = adk.run_with_deliverd_confirmations(app, FakeDeliverd(timed_out), user_id="u", session_id="s", message="x", timeout=1)
        self.assertEqual((len(events), len(app.calls)), (1, 1))

    def test_stops_an_agent_that_keeps_asking(self):
        app = AdkApp(*[[confirmation_event("c%d" % i, "o%d" % i)] for i in range(4)])
        with self.assertRaises(RuntimeError):
            adk.run_with_deliverd_confirmations(app, FakeDeliverd(), user_id="u", session_id="s", message="x", max_rounds=2)


class NoDependency(unittest.TestCase):
    def test_importing_these_adapters_imports_no_cloud_sdk(self):
        import subprocess

        code = (
            "import sys\n"
            "for name in ('boto3', 'botocore', 'strands', 'google', 'vertexai'):\n"
            "    sys.modules[name] = None\n"
            "import deliverd.adapters.bedrock, deliverd.adapters.strands, deliverd.adapters.adk\n"
            "print('imported')\n"
        )
        env = dict(os.environ, PYTHONPATH=os.path.abspath(os.path.join(HERE, "..", "src")))
        done = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("imported", done.stdout)


if __name__ == "__main__":
    unittest.main()
