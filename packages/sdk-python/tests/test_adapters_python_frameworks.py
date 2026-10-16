"""The Pydantic AI and CrewAI adapters: tool calls answered by a person through
Deliverd.

Neither framework is installed in CI — Pydantic AI needs Python 3.11, CrewAI
3.10, and the package promises no dependencies — so each is stood in for by
classes with the attributes the adapter reads, named after the real ones. The
shapes are held to the installed packages by ``RealPydanticAI`` and
``RealCrewAI`` at the bottom, which run wherever those are installed and say
plainly that they skipped where they are not.

What matters most, in order: a call a person declined never runs; a call
approved only with changes never runs as proposed; a failure to ask never
reads as permission (CrewAI runs the tool when a hook raises); and the model is
told why a call did not run.
"""

import asyncio
import importlib.util
import os
import sys
import threading
import types
import unittest
from typing import Any, Dict, List, Optional
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

# The stand-ins for Deliverd's answers. A module import, not ``from ... import``,
# so its test classes are not collected a second time from here.
import test_adapters as base  # noqa: E402

from deliverd.adapters import crewai as crew  # noqa: E402
from deliverd.adapters import pydantic_ai as pai  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402
from deliverd.errors import DeliverdError  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
gate_decision = base.gate_decision
timed_out = base.timed_out
development = base.development
run = base.run

REFUND = {"order_id": "1042", "amount": 420}


# ── Pydantic AI stand-ins ─────────────────────────────────────────────────


class ToolCallPart:
    """``pydantic_ai.messages.ToolCallPart``: ``args`` is a dict, a JSON string or None."""

    def __init__(self, tool_name: str, args: Any = None, tool_call_id: str = "call_1") -> None:
        self.tool_name = tool_name
        self.args = args
        self.tool_call_id = tool_call_id


class DeferredToolRequests:
    def __init__(self, approvals: Optional[List[ToolCallPart]] = None, calls: Optional[List[ToolCallPart]] = None) -> None:
        self.approvals = list(approvals or [])
        self.calls = list(calls or [])
        self.metadata: Dict[str, Any] = {}


class DeferredToolResults:
    def __init__(self, *, approvals: Optional[Dict[str, Any]] = None, calls: Optional[Dict[str, Any]] = None) -> None:
        self.approvals = dict(approvals or {})
        self.calls = dict(calls or {})


class ToolApproved:
    def __init__(self, *, override_args: Optional[Dict[str, Any]] = None) -> None:
        self.override_args = override_args
        self.kind = "tool-approved"


class ToolDenied:
    def __init__(self, message: str = "The tool call was denied.") -> None:
        self.message = message
        self.kind = "tool-denied"


class HandleDeferredToolCalls:
    def __init__(self, handler: Any) -> None:
        self.handler = handler


def fake_pydantic_ai() -> Dict[str, types.ModuleType]:
    root = types.ModuleType("pydantic_ai")
    tools = types.ModuleType("pydantic_ai.tools")
    tools.DeferredToolResults = DeferredToolResults  # type: ignore[attr-defined]
    tools.ToolApproved = ToolApproved  # type: ignore[attr-defined]
    tools.ToolDenied = ToolDenied  # type: ignore[attr-defined]
    capabilities = types.ModuleType("pydantic_ai.capabilities")
    capabilities.HandleDeferredToolCalls = HandleDeferredToolCalls  # type: ignore[attr-defined]
    root.tools = tools  # type: ignore[attr-defined]
    root.capabilities = capabilities  # type: ignore[attr-defined]
    return {"pydantic_ai": root, "pydantic_ai.tools": tools, "pydantic_ai.capabilities": capabilities}


class WithFakePydanticAI(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(sys.modules, fake_pydantic_ai())
        patcher.start()
        self.addCleanup(patcher.stop)


def kinds(results: Any) -> Dict[str, Any]:
    return {k: (v.kind, getattr(v, "message", None)) for k, v in results.approvals.items()}


class PydanticAIResolve(WithFakePydanticAI):
    def test_an_approved_call_is_approved_as_proposed_and_asked_once_by_its_id(self):
        deliverd = FakeDeliverd()
        results = run(
            pai.resolve_deferred_tool_requests(
                DeferredToolRequests([ToolCallPart("refund", REFUND, "call_1")]),
                deliverd,
                approvers=["finance"],
                flow_id="flw_1",
                metadata={"run": "nightly"},
            )
        )
        self.assertEqual(kinds(results), {"call_1": ("tool-approved", None)})
        self.assertIsNone(results.approvals["call_1"].override_args)
        asked = deliverd.asked[0]
        self.assertEqual(asked["external_id"], "pydantic-ai:call_1")
        self.assertEqual(asked["approvers"], ["finance"])
        self.assertEqual(asked["flow_id"], "flw_1")
        self.assertEqual(asked["metadata"], {"run": "nightly", "tool": "refund"})
        self.assertEqual(asked["title"], "Allow the agent to run refund")
        self.assertEqual(asked["input"], REFUND)
        self.assertEqual(asked["expires_in"], "1h")
        self.assertNotIn("editable_fields", asked)

    def test_json_string_and_missing_args_are_read(self):
        deliverd = FakeDeliverd()
        run(
            pai.resolve_deferred_tool_requests(
                DeferredToolRequests(
                    [ToolCallPart("refund", '{"order_id": "1042", "amount": 420}', "a"), ToolCallPart("ping", None, "b")]
                ),
                deliverd,
            )
        )
        self.assertEqual([a["input"] for a in deliverd.asked], [REFUND, {}])

    def test_a_declined_call_is_denied_with_the_persons_reason_for_the_model(self):
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Over the limit"))
        results = run(pai.resolve_deferred_tool_requests(DeferredToolRequests([ToolCallPart("refund", REFUND)]), deliverd))
        kind, message = kinds(results)["call_1"]
        self.assertEqual(kind, "tool-denied")
        self.assertIn("A person declined running refund by Dana.", message)
        self.assertIn("Their reason: Over the limit.", message)

    def test_every_ending_that_is_not_a_yes_is_a_denial(self):
        for status, words in [
            ("rejected", "declined"),
            ("changes_requested", "sent refund back"),
            ("expired", "before the request expired"),
            ("cancelled", "withdrawn"),
        ]:
            deliverd = FakeDeliverd(lambda kw, s=status: decision(False, status=s))
            results = run(pai.resolve_deferred_tool_requests(DeferredToolRequests([ToolCallPart("refund", REFUND)]), deliverd))
            kind, message = kinds(results)["call_1"]
            self.assertEqual(kind, "tool-denied", status)
            self.assertIn(words, message, status)

    def test_a_call_approved_only_with_changes_does_not_run_as_proposed(self):
        changes = [{"field": "amount", "from": 420, "to": 400}]
        deliverd = FakeDeliverd(lambda kw: decision(True, changes=changes))
        results = run(pai.resolve_deferred_tool_requests(DeferredToolRequests([ToolCallPart("refund", REFUND)]), deliverd))
        kind, message = kinds(results)["call_1"]
        self.assertEqual(kind, "tool-denied")
        self.assertIn("only with changes: amount from 420 to 400", message)

    def test_a_wait_that_runs_out_leaves_the_call_unanswered(self):
        deliverd = FakeDeliverd(timed_out)
        results = run(
            pai.resolve_deferred_tool_requests(DeferredToolRequests([ToolCallPart("refund", REFUND)]), deliverd, timeout="5m")
        )
        self.assertEqual(results.approvals, {}, "an answer was built for a call nobody decided")
        self.assertEqual(deliverd.asked[0]["timeout"], "5m")

    def test_external_calls_are_not_a_persons_to_approve(self):
        deliverd = FakeDeliverd()
        results = run(
            pai.resolve_deferred_tool_requests(DeferredToolRequests(calls=[ToolCallPart("long_job", {}, "ext")]), deliverd)
        )
        self.assertEqual((results.approvals, deliverd.asked), ({}, []))

    def test_when_and_actions(self):
        deliverd = FakeDeliverd(lambda kw: decision(False), gate=lambda kw: gate_decision(False, reason="Not on weekends."))
        results = run(
            pai.resolve_deferred_tool_requests(
                DeferredToolRequests(
                    [
                        ToolCallPart("lookup", {"order_id": "1"}, "a"),
                        ToolCallPart("refund", REFUND, "b"),
                        ToolCallPart("delete_account", {"id": 9}, "c"),
                    ]
                ),
                deliverd,
                when=lambda tool, args: tool != "lookup",
                actions={"delete_account": "accounts.delete"},
            )
        )
        self.assertEqual([k for k, _ in (kinds(results)[i] for i in "abc")], ["tool-approved", "tool-denied", "tool-denied"])
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["pydantic-ai:b"])
        self.assertEqual(deliverd.gated[0]["action"], "accounts.delete")
        self.assertEqual(deliverd.gated[0]["external_id"], "pydantic-ai:c")
        self.assertIn("Why: Not on weekends.", kinds(results)["c"][1])

    def test_the_calls_are_asked_together(self):
        started: List[str] = []

        async def go() -> Any:
            both = asyncio.Event()

            class Together(AsyncFakeDeliverd):
                async def approve(self, **kwargs: Any) -> Any:  # type: ignore[override]
                    started.append(kwargs["external_id"])
                    if len(started) == 2:
                        both.set()
                    await asyncio.wait_for(both.wait(), 2)
                    return decision(True)

            return await pai.resolve_deferred_tool_requests(
                DeferredToolRequests([ToolCallPart("refund", REFUND, "a"), ToolCallPart("refund", REFUND, "b")]), Together()
            )

        self.assertEqual(len(run(go()).approvals), 2)

    def test_the_blocking_variant(self):
        deliverd = FakeDeliverd(lambda kw: decision(kw["external_id"].endswith("a")))
        results = pai.resolve_deferred_tool_requests_sync(
            DeferredToolRequests([ToolCallPart("refund", REFUND, "a"), ToolCallPart("refund", REFUND, "b")]), deliverd
        )
        self.assertEqual([kinds(results)[i][0] for i in "ab"], ["tool-approved", "tool-denied"])


class PydanticAICapability(WithFakePydanticAI):
    def test_is_a_handle_deferred_tool_calls_around_the_handler(self):
        deliverd = FakeDeliverd(lambda kw: decision(False, note="No"))
        capability = pai.deliverd_approvals(deliverd, approvers=["finance"])
        self.assertIsInstance(capability, HandleDeferredToolCalls)
        results = run(capability.handler(object(), DeferredToolRequests([ToolCallPart("refund", REFUND)])))
        self.assertEqual(kinds(results)["call_1"][0], "tool-denied")
        self.assertEqual(deliverd.asked[0]["approvers"], ["finance"])

    def test_declines_to_handle_what_it_has_no_answer_for(self):
        """``None`` is "not handled": the calls go on to the next capability or
        the run's output, where they can be resolved later."""
        handler = pai.deliverd_deferred_tool_handler(FakeDeliverd(timed_out), timeout=1)
        self.assertIsNone(run(handler(object(), DeferredToolRequests([ToolCallPart("refund", REFUND)]))))
        nothing = pai.deliverd_deferred_tool_handler(FakeDeliverd())
        self.assertIsNone(run(nothing(object(), DeferredToolRequests(calls=[ToolCallPart("job", {}, "x")]))))

    def test_the_real_client_offline_asks_once(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        handler = pai.deliverd_deferred_tool_handler(deliverd)
        requests = DeferredToolRequests([ToolCallPart("refund", REFUND, "call_7")])
        first = run(handler(object(), requests))
        second = run(handler(object(), requests))
        self.assertEqual([kinds(r)["call_7"][0] for r in (first, second)], ["tool-approved", "tool-approved"])
        filed = deliverd.sync.approvals.list(external_id="pydantic-ai:call_7")
        self.assertEqual(len(filed), 1, "asking twice filed a second request")

    def test_offline_refusal_and_wait(self):
        refused = pai.resolve_deferred_tool_requests_sync(
            DeferredToolRequests([ToolCallPart("refund", REFUND)]), development("rejected")
        )
        self.assertEqual(kinds(refused)["call_1"][0], "tool-denied")
        waiting = pai.resolve_deferred_tool_requests_sync(
            DeferredToolRequests([ToolCallPart("refund", REFUND)]), development("question"), timeout=0.05
        )
        self.assertEqual(waiting.approvals, {})


# ── CrewAI stand-ins ──────────────────────────────────────────────────────


class Owner:
    def __init__(self, ident: str) -> None:
        self.id = ident


class ToolCallHookContext:
    """``crewai.hooks.ToolCallHookContext``: the same ``tool_input`` dict goes to
    the before hook, the tool and the after hook."""

    def __init__(
        self,
        tool_name: str,
        tool_input: Dict[str, Any],
        task: Optional[Owner] = None,
        agent: Optional[Owner] = None,
        tool_result: Optional[str] = None,
    ) -> None:
        self.tool_name = tool_name
        self.tool_input = tool_input
        self.tool = None
        self.agent = agent
        self.task = task
        self.crew = None
        self.tool_result = tool_result
        self.raw_tool_result = tool_result


class FakeCrew:
    """What ``crewai.utilities.agent_utils.execute_single_native_tool_call`` does
    around a tool: the before hooks (``False`` blocks; any other exception is
    swallowed and the tool runs), the tool or the fixed blocked message, then
    the after hooks (a string replaces the result), on a blocked call too."""

    def __init__(self) -> None:
        self.before: List[Any] = []
        self.after: List[Any] = []
        self.ran: List[Dict[str, Any]] = []

    def call(self, tool_name: str, tool_input: Dict[str, Any], task: Optional[Owner] = Owner("task-1")) -> str:
        context = ToolCallHookContext(tool_name, tool_input, task=task)
        blocked = False
        for hook in self.before:
            try:
                if hook(context) is False:
                    blocked = True
                    break
            except Exception:  # noqa: BLE001 — CrewAI fails open
                continue
        if blocked:
            result = "Tool execution blocked by hook. Tool: {}".format(tool_name)
        else:
            self.ran.append(dict(tool_input))
            result = "ran " + tool_name
        after = ToolCallHookContext(tool_name, tool_input, task=task, tool_result=result)
        for hook in self.after:
            replaced = hook(after)
            if isinstance(replaced, str):
                after.tool_result = replaced
        return after.tool_result  # type: ignore[return-value]


def crew_with(deliverd: Any, **options: Any) -> FakeCrew:
    hooks = crew.deliverd_tool_hooks(deliverd, **options)
    fake = FakeCrew()
    fake.before.append(hooks.before)
    fake.after.append(hooks.after)
    return fake


class CrewAIHooks(unittest.TestCase):
    def test_an_approved_call_runs_unchanged_and_the_result_is_left_alone(self):
        deliverd = FakeDeliverd()
        fake = crew_with(deliverd, approvers=["finance"], flow_id="flw_1")
        self.assertEqual(fake.call("issue_refund", dict(REFUND)), "ran issue_refund")
        self.assertEqual(fake.ran, [REFUND])
        asked = deliverd.asked[0]
        self.assertTrue(asked["external_id"].startswith("crewai:task-1:"), asked["external_id"])
        self.assertEqual(asked["input"], REFUND)
        self.assertEqual(asked["approvers"], ["finance"])
        self.assertEqual(asked["flow_id"], "flw_1")
        self.assertEqual(asked["metadata"], {"tool": "issue_refund"})
        self.assertNotIn("editable_fields", asked)

    def test_a_declined_call_does_not_run_and_the_agent_reads_why(self):
        fake = crew_with(FakeDeliverd(lambda kw: decision(False, note="Over the limit")))
        result = fake.call("issue_refund", dict(REFUND))
        self.assertEqual(fake.ran, [])
        self.assertIn("A person declined running issue_refund by Dana.", result)
        self.assertIn("Their reason: Over the limit.", result)
        self.assertNotIn("blocked by hook", result)

    def test_a_call_approved_only_with_changes_does_not_run(self):
        changes = [{"field": "amount", "from": 420, "to": 400}]
        fake = crew_with(FakeDeliverd(lambda kw: decision(True, changes=changes)))
        result = fake.call("issue_refund", dict(REFUND))
        self.assertEqual(fake.ran, [])
        self.assertIn("only with changes: amount from 420 to 400", result)

    def test_a_wait_that_runs_out_blocks_and_says_it_is_still_waiting(self):
        deliverd = FakeDeliverd(timed_out)
        fake = crew_with(deliverd, timeout="5m")
        result = fake.call("issue_refund", dict(REFUND))
        self.assertEqual(fake.ran, [])
        self.assertIn("Nobody has decided yet whether to run issue_refund", result)
        self.assertEqual(deliverd.asked[0]["timeout"], "5m")

    def test_a_failure_to_ask_blocks_rather_than_letting_the_tool_run(self):
        """CrewAI swallows a hook's exception and runs the tool. The hook must
        not raise: an unreachable Deliverd is not permission."""

        def down(kw: Dict[str, Any]) -> Any:
            raise DeliverdError(503, "unavailable", "Deliverd is down.")

        def broken_describe(tool: str, args: Any) -> Any:
            raise ValueError("describe broke")

        async def async_when(tool: str, args: Any) -> bool:
            return True

        for name, deliverd, options in [
            ("unreachable", FakeDeliverd(down), {}),
            ("gate", FakeDeliverd(gate=down), {"actions": {"issue_refund": "finance.refund"}}),
            ("describe", FakeDeliverd(), {"describe": broken_describe}),
            ("async when", FakeDeliverd(), {"when": async_when}),
        ]:
            fake = crew_with(deliverd, **options)
            result = fake.call("issue_refund", dict(REFUND))
            self.assertEqual(fake.ran, [], name)
            self.assertIn("issue_refund was not run because approval could not be asked for", result, name)

    def test_when_and_actions(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(False, reason="Not on weekends."))
        fake = crew_with(deliverd, when=lambda tool, args: tool != "lookup", actions={"delete_account": "accounts.delete"})
        self.assertEqual(fake.call("lookup", {"order_id": "1"}), "ran lookup")
        self.assertIn("Why: Not on weekends.", fake.call("delete_account", {"id": 9}))
        self.assertEqual(deliverd.asked, [])
        self.assertEqual(deliverd.gated[0]["action"], "accounts.delete")
        self.assertTrue(deliverd.gated[0]["external_id"].startswith("crewai:task-1:"))

    def test_the_key_is_the_task_and_the_input(self):
        deliverd = FakeDeliverd()
        fake = crew_with(deliverd)
        fake.call("issue_refund", dict(REFUND))
        fake.call("issue_refund", dict(REFUND))
        fake.call("issue_refund", dict(REFUND, amount=421))
        fake.call("issue_refund", dict(REFUND), task=Owner("task-2"))
        fake.call("issue_refund", dict(REFUND), task=None)
        ids = [a["external_id"] for a in deliverd.asked]
        self.assertEqual(ids[0], ids[1], "the same call in the same task is not the same request")
        self.assertEqual(len(set(ids)), 4, ids)
        self.assertTrue(ids[3].startswith("crewai:task-2:"))
        self.assertTrue(ids[4].startswith("crewai:run:"))

    def test_a_block_by_another_hook_is_left_alone(self):
        fake = crew_with(FakeDeliverd())
        fake.before.insert(0, lambda context: False)
        self.assertEqual(fake.call("issue_refund", dict(REFUND)), "Tool execution blocked by hook. Tool: issue_refund")

    def test_parallel_calls_keep_their_own_reasons(self):
        """CrewAI runs parallel native tool calls on a thread pool; a reason
        from one call must not land on another. Both calls are decided, then
        both wait before their after hooks, so a reason kept anywhere but per
        thread is overwritten by the other call's."""
        decided = threading.Barrier(2, timeout=5)
        between = threading.Barrier(2, timeout=5)

        def decide(kw: Dict[str, Any]) -> Any:
            decided.wait()
            return decision(False, note="Not {}".format(kw["input"]["amount"]))

        fake = crew_with(FakeDeliverd(decide))
        fake.after.insert(0, lambda context: between.wait() and None)
        out: Dict[int, str] = {}

        def call(amount: int) -> None:
            out[amount] = fake.call("issue_refund", {"order_id": "1", "amount": amount})

        threads = [threading.Thread(target=call, args=(a,)) for a in (40, 420)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertIn("Their reason: Not 40.", out[40])
        self.assertIn("Their reason: Not 420.", out[420])

    def test_the_async_client_is_used_through_its_blocking_twin(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        fake = crew_with(deliverd)
        fake.call("issue_refund", dict(REFUND))
        fake.call("issue_refund", dict(REFUND))
        self.assertEqual(len(fake.ran), 2)
        filed = deliverd.sync.approvals.list()
        self.assertEqual(len(filed), 1, "the same call in the same task filed twice")
        self.assertTrue(filed[0].data.external_id.startswith("crewai:task-1:"))

    def test_offline_refusal(self):
        fake = crew_with(development("rejected"))
        self.assertIn("declined running issue_refund", fake.call("issue_refund", dict(REFUND)))
        self.assertEqual(fake.ran, [])


class CrewAIRegistration(unittest.TestCase):
    def test_registers_and_unregisters_both_hooks(self):
        before: List[Any] = []
        after: List[Any] = []
        hooks_module = types.ModuleType("crewai.hooks")
        hooks_module.register_before_tool_call_hook = before.append  # type: ignore[attr-defined]
        hooks_module.register_after_tool_call_hook = after.append  # type: ignore[attr-defined]
        hooks_module.unregister_before_tool_call_hook = before.remove  # type: ignore[attr-defined]
        hooks_module.unregister_after_tool_call_hook = after.remove  # type: ignore[attr-defined]
        root = types.ModuleType("crewai")
        root.hooks = hooks_module  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"crewai": root, "crewai.hooks": hooks_module}):
            hooks = crew.register_deliverd_approvals(FakeDeliverd())
            self.assertEqual((before, after), ([hooks.before], [hooks.after]))
            hooks.unregister()
            self.assertEqual((before, after), ([], []))


# ── the real frameworks, wherever they are installed ──────────────────────


@unittest.skipUnless(
    importlib.util.find_spec("pydantic_ai") is not None,
    "pydantic-ai is not installed (it needs Python 3.11+); the shapes were not checked here",
)
class RealPydanticAI(unittest.TestCase):
    def test_an_agent_run_with_the_capability(self):
        from pydantic_ai import Agent, DeferredToolRequests as RealRequests
        from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart as RealPart, ToolReturnPart
        from pydantic_ai.models.function import FunctionModel

        def model(messages: Any, info: Any) -> Any:
            returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
            if not returns:
                return ModelResponse(parts=[RealPart("refund", dict(REFUND), tool_call_id="call_1")])
            return ModelResponse(parts=[TextPart("tool said: " + str(returns[-1].content))])

        ran: List[Any] = []

        def agent(deliverd: Any, **options: Any) -> Any:
            built = Agent(FunctionModel(model), capabilities=[pai.deliverd_approvals(deliverd, **options)], output_type=[str, RealRequests])

            @built.tool_plain(requires_approval=True)
            def refund(order_id: str, amount: int) -> str:
                ran.append(amount)
                return "refunded {}".format(amount)

            return built

        approved = agent(FakeDeliverd()).run_sync("go")
        self.assertEqual((approved.output, ran), ("tool said: refunded 420", [420]))
        declined = agent(FakeDeliverd(lambda kw: decision(False, note="Over the limit"))).run_sync("go")
        self.assertEqual(ran, [420], "a declined call ran")
        self.assertIn("Their reason: Over the limit.", declined.output)
        waiting = agent(FakeDeliverd(timed_out), timeout=1).run_sync("go")
        self.assertIsInstance(waiting.output, RealRequests)
        self.assertEqual([p.tool_call_id for p in waiting.output.approvals], ["call_1"])


@unittest.skipUnless(
    importlib.util.find_spec("crewai") is not None,
    "crewai is not installed (it needs Python 3.10+); the shapes were not checked here",
)
class RealCrewAI(unittest.TestCase):
    def test_a_native_tool_call_through_the_registered_hooks(self):
        import json

        from crewai.hooks import get_after_tool_call_hooks, get_before_tool_call_hooks
        from crewai.tools import tool
        from crewai.tools.structured_tool import CrewStructuredTool
        from crewai.utilities.agent_utils import execute_single_native_tool_call

        ran: List[Any] = []

        @tool("issue_refund")
        def issue_refund(order_id: str, amount: int) -> str:
            """Refund an order."""
            ran.append(amount)
            return "refunded {}".format(amount)

        def call(deliverd: Any) -> str:
            hooks = crew.register_deliverd_approvals(deliverd)
            try:
                return execute_single_native_tool_call(
                    types.SimpleNamespace(
                        id="call_9", function=types.SimpleNamespace(name="issue_refund", arguments=json.dumps(REFUND))
                    ),
                    available_functions={"issue_refund": issue_refund.run},
                    original_tools=[issue_refund],
                    structured_tools=[
                        CrewStructuredTool.from_function(issue_refund.func, name="issue_refund", description="Refund an order.")
                    ],
                    tools_handler=None,
                    agent=None,
                    task=None,
                    crew=None,
                    event_source=object(),
                ).result
            finally:
                hooks.unregister()
                self.assertNotIn(hooks.before, get_before_tool_call_hooks())
                self.assertNotIn(hooks.after, get_after_tool_call_hooks())

        self.assertEqual(call(FakeDeliverd()), "refunded 420")
        self.assertIn("Their reason: Over the limit.", call(FakeDeliverd(lambda kw: decision(False, note="Over the limit"))))
        self.assertIn("could not be asked for", call(FakeDeliverd(lambda kw: (_ for _ in ()).throw(DeliverdError(503, "x", "down")))))
        self.assertEqual(ran, [420], "a refused call ran")


if __name__ == "__main__":
    unittest.main()
