"""The Microsoft adapters: Agent Framework's tool approvals and Foundry's MCP
approvals, answered by a person through Deliverd.

Neither framework is installed here — CI runs Python 3.9 with no dependencies,
and Agent Framework needs 3.10 — so each is stood in for by a class with the
attributes the adapter reads, named after the real one. The shapes themselves
are held to the installed packages by ``ShapesOfTheRealThing`` at the bottom,
which runs wherever they are installed and says plainly that it skipped where
they are not.

What matters most, in order: a call a person declined never comes back
approved; a call approved only with changes never runs as proposed; a wait that
ran out leaves the call pending rather than refused; and a call asked about
twice is one request in Deliverd, not two.
"""

import ast
import asyncio
import importlib
import importlib.util
import os
import re
import subprocess
import sys
import types
import unittest
from typing import Any, Callable, Dict, List, Optional
from unittest import mock

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "..", "src")
sys.path.insert(0, SRC)

from deliverd import Deliverd  # noqa: E402
from deliverd.adapters import CallDescription, Resolution  # noqa: E402
from deliverd.adapters import agent_framework as af  # noqa: E402
from deliverd.adapters import foundry  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402
from deliverd.errors import DeliverdError, DeliverdTimeoutError  # noqa: E402
from deliverd.types import Decision, GateDecision  # noqa: E402


# ── stand-ins ─────────────────────────────────────────────────────────────


def decision(
    approved: bool,
    status: Optional[str] = None,
    note: Optional[str] = None,
    by: Optional[str] = "Dana",
    changes: Optional[List[Dict[str, Any]]] = None,
) -> Decision:
    return Decision(
        approved=approved,
        status=status or ("approved" if approved else "rejected"),
        note=note,
        decided_by=by,
        decided_by_id=None,
        decided_at=None,
        id="apr_1",
        url="https://example.test/approve/apr_1",
        input=None,
        changes=list(changes or []),
        approval=None,
    )


def gate_decision(
    allowed: bool,
    status: Optional[str] = None,
    reason: Optional[str] = None,
    changes: Optional[List[Dict[str, Any]]] = None,
) -> GateDecision:
    return GateDecision(
        allowed=allowed,
        status=status or ("allowed" if allowed else "denied"),
        reason=reason,
        rule="Refunds under £100" if allowed else None,
        input={},
        changes=list(changes or []),
        id="gat_1",
        approval_url=None,
        gate=None,
    )


class FakeDeliverd:
    """``approve()`` and ``gate()``, recorded, answering however the test says."""

    def __init__(
        self,
        decide: Optional[Callable[[Dict[str, Any]], Decision]] = None,
        gate: Optional[Callable[[Dict[str, Any]], GateDecision]] = None,
    ) -> None:
        self.asked: List[Dict[str, Any]] = []
        self.gated: List[Dict[str, Any]] = []
        self._decide = decide or (lambda kw: decision(True))
        self._gate = gate or (lambda kw: gate_decision(True))

    def approve(self, **kwargs: Any) -> Decision:
        self.asked.append(kwargs)
        return self._decide(kwargs)

    def gate(self, **kwargs: Any) -> GateDecision:
        self.gated.append(kwargs)
        return self._gate(kwargs)


class AsyncFakeDeliverd(FakeDeliverd):
    async def approve(self, **kwargs: Any) -> Decision:  # type: ignore[override]
        return FakeDeliverd.approve(self, **kwargs)

    async def gate(self, **kwargs: Any) -> GateDecision:  # type: ignore[override]
        return FakeDeliverd.gate(self, **kwargs)


def timed_out(kwargs: Dict[str, Any]) -> Decision:
    raise DeliverdTimeoutError("Nobody decided within the timeout.")


class Content:
    """The parts of ``agent_framework.Content`` the adapter reads."""

    def __init__(self, type: str, **fields: Any) -> None:
        self.type = type
        self.id = fields.get("id")
        self.call_id = fields.get("call_id")
        self.name = fields.get("name")
        self.arguments = fields.get("arguments")
        self.function_call = fields.get("function_call")
        self.approved = fields.get("approved")
        self.additional_properties = fields.get("additional_properties") or {}
        self.user_input_request = type in ("function_approval_request", "oauth_consent_request")

    def to_function_approval_response(self, approved: bool) -> "Content":
        if self.type != "function_approval_request":
            raise ValueError("only an approval request has a response")
        return Content(
            "function_approval_response", id=self.id, function_call=self.function_call, approved=approved
        )


def approval_request(call_id: str, name: str, arguments: Any, server: Optional[str] = None) -> Content:
    call = Content(
        "function_call",
        id="fc_" + call_id,
        call_id=call_id,
        name=name,
        arguments=arguments,
        additional_properties={"server_label": server} if server else {},
    )
    return Content("function_approval_request", id="fc_" + call_id, function_call=call)


class Result:
    """``AgentResponse``: what the adapter reads is ``user_input_requests``."""

    def __init__(self, *requests: Content, text: str = "") -> None:
        self.user_input_requests = list(requests)
        self.text = text


class Agent:
    def __init__(self, *results: Result) -> None:
        self._results = list(results)
        self.runs: List[Dict[str, Any]] = []

    async def run(self, messages: Any, *, session: Any = None, **kwargs: Any) -> Result:
        self.runs.append(dict(kwargs, messages=messages, session=session))
        return self._results.pop(0)


class Message:
    def __init__(self, role: str, contents: List[Any]) -> None:
        self.role = role
        self.contents = contents


def fake_agent_framework() -> types.ModuleType:
    module = types.ModuleType("agent_framework")
    module.Message = Message  # type: ignore[attr-defined]
    return module


def development(outcome: str = "approved") -> Deliverd:
    return Deliverd(mode="development", development=DevelopmentOptions(outcome=outcome, log=False, delay=0.0))


def run(coro: Any) -> Any:
    return asyncio.run(coro)


REFUND = '{"order_id": "1042", "amount": 420}'


# ── Agent Framework ───────────────────────────────────────────────────────


class AgentFrameworkResolve(unittest.TestCase):
    def test_an_approved_call_is_answered_yes_and_asked_once_by_its_call_id(self):
        deliverd = FakeDeliverd()
        resolution = run(
            af.resolve_approval_requests(
                Result(approval_request("call_1", "refund", REFUND)),
                deliverd,
                approvers=["finance"],
                flow_id="flw_1",
                metadata={"run": "nightly"},
            )
        )
        self.assertTrue(resolution.complete)
        self.assertEqual([r.approved for r in resolution.responses], [True])
        self.assertEqual(resolution.responses[0].type, "function_approval_response")
        self.assertEqual(len(deliverd.asked), 1)
        asked = deliverd.asked[0]
        self.assertEqual(asked["external_id"], "agent-framework:call_1")
        self.assertEqual(asked["approvers"], ["finance"])
        self.assertEqual(asked["flow_id"], "flw_1")
        self.assertEqual(asked["metadata"], {"run": "nightly", "tool": "refund"})
        self.assertEqual(asked["expires_in"], "1h")
        self.assertEqual(asked["title"], "Allow the agent to run refund")
        # Shown field by field, and offered for nothing else: the framework
        # cannot run a corrected call, so a person is not invited to make one.
        self.assertEqual(asked["input"], {"order_id": "1042", "amount": 420})
        self.assertNotIn("editable_fields", asked)

    def test_a_declined_call_is_answered_no_with_the_persons_reason(self):
        deliverd = FakeDeliverd(lambda kw: decision(False, note="Over the limit"))
        resolution = run(af.resolve_approval_requests(Result(approval_request("call_1", "refund", REFUND)), deliverd))
        self.assertEqual([r.approved for r in resolution.responses], [False])
        reason = resolution.reasons["call_1"]
        self.assertIn("A person declined running refund by Dana.", reason)
        self.assertIn("Their reason: Over the limit.", reason)
        self.assertIn("Do not retry it", reason)

    def test_every_ending_that_is_not_a_yes_is_a_no(self):
        for status, words in [
            ("rejected", "declined"),
            ("changes_requested", "sent refund back"),
            ("expired", "before the request expired"),
            ("cancelled", "withdrawn"),
        ]:
            deliverd = FakeDeliverd(lambda kw, s=status: decision(False, status=s))
            resolution = run(af.resolve_approval_requests(Result(approval_request("c", "refund", REFUND)), deliverd))
            self.assertEqual([r.approved for r in resolution.responses], [False], status)
            self.assertIn(words, resolution.reasons["c"], status)

    def test_a_call_approved_only_with_changes_does_not_run_as_proposed(self):
        """The person agreed to £400. Running the proposal would spend their
        approval on £420, so the call is declined and the model is told the
        values they did agree to."""
        changes = [{"field": "amount", "from": 420, "to": 400}]
        deliverd = FakeDeliverd(lambda kw: decision(True, changes=changes))
        resolution = run(af.resolve_approval_requests(Result(approval_request("c", "refund", REFUND)), deliverd))
        self.assertEqual([r.approved for r in resolution.responses], [False])
        self.assertIn("only with changes: amount from 420 to 400", resolution.reasons["c"])

    def test_a_wait_that_runs_out_leaves_the_call_pending_not_refused(self):
        deliverd = FakeDeliverd(timed_out)
        resolution = run(
            af.resolve_approval_requests(
                Result(approval_request("c1", "refund", REFUND)), deliverd, timeout="5m"
            )
        )
        self.assertFalse(resolution.complete)
        self.assertEqual(resolution.pending, ["c1"])
        self.assertEqual(resolution.responses, [], "an answer was built for a call nobody decided")
        self.assertEqual(deliverd.asked[0]["timeout"], "5m")

    def test_when_picks_the_calls_that_need_a_person(self):
        deliverd = FakeDeliverd(lambda kw: decision(False))
        resolution = run(
            af.resolve_approval_requests(
                Result(
                    approval_request("c_lookup", "lookup", '{"order_id": "1042"}'),
                    approval_request("c_refund", "refund", REFUND),
                ),
                deliverd,
                when=lambda tool, args: tool == "refund" and args["amount"] > 100,
            )
        )
        self.assertEqual([r.approved for r in resolution.responses], [True, False])
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["agent-framework:c_refund"])

    def test_when_may_be_async(self):
        async def needs_person(tool: str, args: Any) -> bool:
            return tool == "refund"

        deliverd = AsyncFakeDeliverd()
        run(
            af.resolve_approval_requests(
                Result(approval_request("a", "lookup", "{}"), approval_request("b", "refund", REFUND)),
                deliverd,
                when=needs_person,
            )
        )
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["agent-framework:b"])

    def test_describe_writes_what_the_approver_reads(self):
        deliverd = FakeDeliverd()
        for described in (
            {"title": "Refund £420 to Acme", "risk": "high"},
            CallDescription(title="Refund £420 to Acme", risk="high"),
        ):
            run(
                af.resolve_approval_requests(
                    Result(approval_request("c", "refund", REFUND)),
                    deliverd,
                    describe=lambda tool, args, d=described: d,
                )
            )
            self.assertEqual(deliverd.asked[-1]["title"], "Refund £420 to Acme")
            self.assertEqual(deliverd.asked[-1]["risk"], "high")

    def test_a_hosted_mcp_call_names_its_server(self):
        deliverd = FakeDeliverd()
        run(af.resolve_approval_requests(Result(approval_request("mcpr_1", "close_issue", '{"n": 1}', server="github")), deliverd))
        self.assertEqual(deliverd.asked[0]["title"], "Allow the agent to run close_issue on github")
        self.assertEqual(deliverd.asked[0]["metadata"]["mcp_server"], "github")

    def test_requests_it_cannot_answer_are_left_alone(self):
        consent = Content("oauth_consent_request")
        resolution = run(af.resolve_approval_requests(Result(consent), FakeDeliverd()))
        self.assertEqual((resolution.responses, resolution.pending), ([], []))

    def test_an_action_is_decided_by_its_gate_rather_than_an_approval(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(False, reason="Refunds over £100 need finance."))
        resolution = run(
            af.resolve_approval_requests(
                Result(approval_request("c", "refund", REFUND)), deliverd, actions={"refund": "finance.refund"}, timeout=30
            )
        )
        self.assertEqual(deliverd.asked, [])
        self.assertEqual(deliverd.gated[0]["action"], "finance.refund")
        self.assertEqual(deliverd.gated[0]["external_id"], "agent-framework:c")
        self.assertEqual(deliverd.gated[0]["input"], {"order_id": "1042", "amount": 420})
        self.assertNotIn("wait", deliverd.gated[0], "resolving waits on the person a gate went to")
        self.assertEqual([r.approved for r in resolution.responses], [False])
        self.assertIn("policy does not allow running refund. Why: Refunds over £100 need finance.", resolution.reasons["c"])

    def test_the_requests_are_asked_together(self):
        """Approvers hear about every call at once, not one per decision.

        Each ask waits until both have started, so asking in turn times out.
        """
        started: List[str] = []

        async def go() -> Resolution:
            # Made inside the loop: on 3.9 an Event binds to the loop current
            # when it is created, and outside one there is none.
            both = asyncio.Event()

            class Together(AsyncFakeDeliverd):
                async def approve(self, **kwargs: Any) -> Decision:  # type: ignore[override]
                    started.append(kwargs["external_id"])
                    if len(started) == 2:
                        both.set()
                    await asyncio.wait_for(both.wait(), 2)
                    return decision(True)

            return await af.resolve_approval_requests(
                Result(approval_request("a", "refund", REFUND), approval_request("b", "refund", REFUND)), Together()
            )

        self.assertEqual(len(run(go()).responses), 2)

    def test_the_blocking_variant_gives_the_same_answers(self):
        deliverd = FakeDeliverd(lambda kw: decision(kw["external_id"].endswith("a")))
        resolution = af.resolve_approval_requests_sync(
            Result(approval_request("a", "refund", REFUND), approval_request("b", "refund", REFUND)), deliverd
        )
        self.assertEqual([r.approved for r in resolution.responses], [True, False])
        with self.assertRaises(TypeError):

            async def later(tool: str, args: Any) -> bool:
                return True

            af.resolve_approval_requests_sync(Result(approval_request("a", "x", "{}")), deliverd, when=later)


class AgentFrameworkAgainstDevelopmentMode(unittest.TestCase):
    """The real client, offline: what the fakes cannot show is that asking twice
    is one request in Deliverd."""

    def test_a_call_resolved_twice_is_one_request(self):
        deliverd = development()
        result = Result(approval_request("call_9", "refund", REFUND))
        first = af.resolve_approval_requests_sync(result, deliverd)
        second = af.resolve_approval_requests_sync(result, deliverd)
        self.assertEqual([r.approved for r in first.responses + second.responses], [True, True])
        filed = deliverd.approvals.list(external_id="agent-framework:call_9")
        self.assertEqual(len(filed), 1, "a retried round filed a second request")
        self.assertEqual(filed[0].data.input, {"order_id": "1042", "amount": 420})

    def test_a_refusal_offline(self):
        resolution = af.resolve_approval_requests_sync(Result(approval_request("c", "refund", REFUND)), development("rejected"))
        self.assertEqual([r.approved for r in resolution.responses], [False])

    def test_an_expiry_offline_is_a_no(self):
        # Development mode's `timeout` ending is the request expiring unanswered.
        resolution = af.resolve_approval_requests_sync(Result(approval_request("c", "refund", REFUND)), development("timeout"))
        self.assertEqual([r.approved for r in resolution.responses], [False])
        self.assertIn("before the request expired", resolution.reasons["c"])

    def test_a_wait_that_runs_out_offline_is_pending(self):
        # `question`: the approver asked something and nobody answered, so the
        # request stays open past the wait.
        resolution = af.resolve_approval_requests_sync(
            Result(approval_request("c", "refund", REFUND)), development("question"), timeout=0.05
        )
        self.assertEqual((resolution.pending, resolution.responses), (["c"], []))

    def test_the_async_client_works_in_both_variants(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        result = Result(approval_request("call_a", "refund", REFUND))
        awaited = run(af.resolve_approval_requests(result, deliverd))
        blocking = af.resolve_approval_requests_sync(result, deliverd)
        self.assertEqual([r.approved for r in awaited.responses + blocking.responses], [True, True])
        self.assertEqual(len(deliverd.sync.approvals.list(external_id="agent-framework:call_a")), 1)


class AgentFrameworkRule(unittest.TestCase):
    def call(self, name: str, arguments: Any, call_id: str = "c") -> Content:
        return approval_request(call_id, name, arguments).function_call

    def test_passes_only_what_when_does_not_select(self):
        rule = af.deliverd_approval_rule(FakeDeliverd(), when=lambda tool, args: tool == "refund")
        self.assertTrue(run(rule(self.call("lookup", "{}"))))
        self.assertFalse(run(rule(self.call("refund", REFUND))))

    def test_with_nothing_to_go_on_nothing_passes(self):
        rule = af.deliverd_approval_rule(FakeDeliverd())
        self.assertFalse(run(rule(self.call("lookup", "{}"))))

    def test_passes_an_action_a_rule_allowed_without_waiting_on_anyone(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(kw["input"]["amount"] < 100, status=None if kw["input"]["amount"] < 100 else "pending"))
        rule = af.deliverd_approval_rule(deliverd, actions={"refund": "finance.refund"}, flow_id="flw_1")
        self.assertTrue(run(rule(self.call("refund", '{"amount": 40}', "small"))))
        self.assertFalse(run(rule(self.call("refund", '{"amount": 420}', "large"))))
        self.assertEqual([g["wait"] for g in deliverd.gated], [False, False])
        self.assertEqual(deliverd.gated[0]["external_id"], "agent-framework:small")
        self.assertEqual(deliverd.gated[0]["flow_id"], "flw_1")
        self.assertEqual(deliverd.asked, [], "the rule asked a person")

    def test_an_allow_with_changes_is_not_a_pass(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(True, status="approved", changes=[{"field": "amount", "from": 420, "to": 400}]))
        rule = af.deliverd_approval_rule(deliverd, actions={"refund": "finance.refund"})
        self.assertFalse(run(rule(self.call("refund", REFUND))))

    def test_fails_closed_when_the_gate_cannot_be_asked(self):
        def broken(kw: Dict[str, Any]) -> GateDecision:
            raise DeliverdError(404, "action_not_found", "No such action.")

        rule = af.deliverd_approval_rule(FakeDeliverd(gate=broken), actions={"refund": "finance.refund"})
        self.assertFalse(run(rule(self.call("refund", REFUND))))


class AgentFrameworkLoop(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(sys.modules, {"agent_framework": fake_agent_framework()})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_runs_answers_on_the_same_session_and_returns_the_last_result(self):
        agent = Agent(
            Result(approval_request("c1", "refund", REFUND)),
            Result(text="Refunded."),
        )
        session = object()
        result = run(
            af.run_with_deliverd_approvals(agent, "Refund order 1042", session, FakeDeliverd(), options={"store": True})
        )
        self.assertEqual(result.text, "Refunded.")
        self.assertEqual(len(agent.runs), 2)
        first, second = agent.runs
        self.assertEqual(first["messages"], "Refund order 1042")
        self.assertIs(second["session"], session, "the answers went to a different session than asked")
        self.assertEqual(second["options"], {"store": True})
        message = second["messages"]
        self.assertEqual(message.role, "user")
        self.assertEqual([(c.type, c.approved) for c in message.contents], [("function_approval_response", True)])

    def test_stops_with_the_result_when_somebody_has_not_decided(self):
        agent = Agent(Result(approval_request("c1", "refund", REFUND)))
        result = run(af.run_with_deliverd_approvals(agent, "go", None, FakeDeliverd(timed_out), timeout=1))
        self.assertEqual(len(agent.runs), 1)
        self.assertEqual(len(result.user_input_requests), 1)

    def test_hands_back_what_it_cannot_answer(self):
        agent = Agent(Result(approval_request("c1", "refund", REFUND), Content("oauth_consent_request")))
        deliverd = FakeDeliverd()
        run(af.run_with_deliverd_approvals(agent, "go", None, deliverd))
        self.assertEqual((len(agent.runs), deliverd.asked), (1, []))

    def test_stops_an_agent_that_keeps_asking(self):
        agent = Agent(*[Result(approval_request("c%d" % i, "refund", REFUND)) for i in range(4)])
        with self.assertRaises(RuntimeError) as raised:
            run(af.run_with_deliverd_approvals(agent, "go", None, FakeDeliverd(), max_rounds=2))
        self.assertIn("after 2 rounds", str(raised.exception))


# ── Foundry ───────────────────────────────────────────────────────────────


class Item:
    """An output item as the OpenAI client parses it: attributes, not keys."""

    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


def mcp_request(request_id: str, name: str = "close_issue", arguments: str = '{"issue": 42}', as_dict: bool = False) -> Any:
    fields = {"type": "mcp_approval_request", "id": request_id, "server_label": "github", "name": name, "arguments": arguments}
    return fields if as_dict else Item(**fields)


class Response:
    def __init__(self, response_id: str, *output: Any, text: str = "") -> None:
        self.id = response_id
        self.output = list(output)
        self.output_text = text


class Responses:
    def __init__(self, *responses: Response) -> None:
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Response:
        self.calls.append(kwargs)
        return self._responses.pop(0)


class AsyncResponses(Responses):
    async def create(self, **kwargs: Any) -> Response:  # type: ignore[override]
        return Responses.create(self, **kwargs)


class Client:
    def __init__(self, responses: Responses) -> None:
        self.responses = responses


class FoundryResolve(unittest.TestCase):
    def test_answers_each_request_by_its_id(self):
        deliverd = FakeDeliverd(lambda kw: decision(kw["external_id"] == "foundry:mcpr_1", note=None))
        resolution = foundry.approval_responses_for(
            Response("resp_1", Item(type="message"), mcp_request("mcpr_1"), mcp_request("mcpr_2", as_dict=True)),
            deliverd,
            approvers=["platform-team"],
        )
        self.assertEqual(
            resolution.responses,
            [
                {"type": "mcp_approval_response", "approve": True, "approval_request_id": "mcpr_1"},
                {
                    "type": "mcp_approval_response",
                    "approve": False,
                    "approval_request_id": "mcpr_2",
                    "reason": resolution.reasons["mcpr_2"],
                },
            ],
        )
        self.assertIn("A person declined running close_issue by Dana.", resolution.reasons["mcpr_2"])
        asked = deliverd.asked[0]
        self.assertEqual(asked["external_id"], "foundry:mcpr_1")
        self.assertEqual(asked["input"], {"issue": 42}, "the JSON-string arguments were not read")
        self.assertEqual(asked["title"], "Allow the agent to run close_issue on github")
        self.assertEqual(asked["metadata"], {"tool": "close_issue", "mcp_server": "github"})
        self.assertEqual(asked["approvers"], ["platform-team"])

    def test_the_reason_can_be_left_off(self):
        resolution = foundry.approval_responses_for(
            Response("r", mcp_request("m")), FakeDeliverd(lambda kw: decision(False)), send_reason=False
        )
        self.assertNotIn("reason", resolution.responses[0])
        self.assertIn("m", resolution.reasons)

    def test_approved_with_changes_is_a_no_that_says_what_was_agreed(self):
        changes = [{"field": "issue", "from": 42, "to": 41}]
        resolution = foundry.approval_responses_for(
            Response("r", mcp_request("m")), FakeDeliverd(lambda kw: decision(True, changes=changes))
        )
        self.assertFalse(resolution.responses[0]["approve"])
        self.assertIn("issue from 42 to 41", resolution.responses[0]["reason"])

    def test_a_wait_that_runs_out_is_pending(self):
        resolution = foundry.approval_responses_for(Response("r", mcp_request("m")), FakeDeliverd(timed_out), timeout=1)
        self.assertEqual((resolution.responses, resolution.pending), ([], ["m"]))

    def test_when_and_actions(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(True))
        resolution = foundry.approval_responses_for(
            Response("r", mcp_request("a", name="search"), mcp_request("b", name="close_issue"), mcp_request("c", name="delete_repo")),
            deliverd,
            when=lambda tool, args: tool != "search",
            actions={"delete_repo": "github.delete_repo"},
        )
        self.assertEqual([r["approve"] for r in resolution.responses], [True, True, True])
        self.assertEqual([a["external_id"] for a in deliverd.asked], ["foundry:b"])
        self.assertEqual([g["action"] for g in deliverd.gated], ["github.delete_repo"])

    def test_the_async_variant_with_the_real_client_offline(self):
        deliverd = AsyncDeliverd(mode="development", development=DevelopmentOptions(log=False, delay=0.0))
        response = Response("r", mcp_request("mcpr_7"))
        first = run(foundry.approval_responses_for_async(response, deliverd))
        second = run(foundry.approval_responses_for_async(response, deliverd))
        self.assertEqual([r["approve"] for r in first.responses + second.responses], [True, True])
        self.assertEqual(len(deliverd.sync.approvals.list(external_id="foundry:mcpr_7")), 1)


class FoundryLoop(unittest.TestCase):
    AGENT = {"agent_reference": {"name": "MyAgent", "type": "agent_reference"}}

    def test_chains_the_answers_by_previous_response_id(self):
        responses = Responses(Response("resp_1", mcp_request("mcpr_1")), Response("resp_2", text="Closed."))
        final = foundry.run_with_deliverd_approvals(
            Client(responses),
            FakeDeliverd(),
            create_kwargs={"conversation": "conv_1", "input": "Close issue 42", "extra_body": self.AGENT, "metadata": {"run": "1"}},
        )
        self.assertEqual(final.output_text, "Closed.")
        first, second = responses.calls
        self.assertEqual(first["conversation"], "conv_1")
        self.assertEqual(
            second,
            {
                "extra_body": self.AGENT,
                "metadata": {"run": "1"},
                "input": [{"type": "mcp_approval_response", "approve": True, "approval_request_id": "mcpr_1"}],
                "previous_response_id": "resp_1",
            },
        )

    def test_returns_early_when_somebody_has_not_decided(self):
        responses = Responses(Response("resp_1", mcp_request("mcpr_1")))
        final = foundry.run_with_deliverd_approvals(
            Client(responses), FakeDeliverd(timed_out), create_kwargs={"input": "x"}, timeout=1
        )
        self.assertEqual((final.id, len(responses.calls)), ("resp_1", 1))

    def test_stops_an_agent_that_keeps_asking(self):
        responses = Responses(*[Response("r%d" % i, mcp_request("m%d" % i)) for i in range(4)])
        with self.assertRaises(RuntimeError):
            foundry.run_with_deliverd_approvals(Client(responses), FakeDeliverd(), create_kwargs={"input": "x"}, max_rounds=2)

    def test_the_async_loop(self):
        responses = AsyncResponses(Response("resp_1", mcp_request("mcpr_1")), Response("resp_2", text="done"))
        final = run(
            foundry.run_with_deliverd_approvals_async(
                Client(responses), AsyncFakeDeliverd(lambda kw: decision(False)), create_kwargs={"input": "x"}
            )
        )
        self.assertEqual(final.output_text, "done")
        self.assertFalse(responses.calls[1]["input"][0]["approve"])
        self.assertEqual(responses.calls[1]["previous_response_id"], "resp_1")


# ── what the package promises about them ──────────────────────────────────


class NoDependency(unittest.TestCase):
    def test_importing_an_adapter_imports_no_framework(self):
        """The package has no dependencies, and that has to survive the one
        module whose whole job is another package's objects. Run in a fresh
        interpreter in which those packages refuse to import."""
        code = (
            "import sys\n"
            "for name in ('agent_framework', 'azure', 'openai', 'crewai', 'pydantic_ai'):\n"
            "    sys.modules[name] = None\n"
            "import deliverd.adapters.agent_framework, deliverd.adapters.foundry\n"
            "import deliverd.adapters.crewai, deliverd.adapters.pydantic_ai\n"
            "print('imported')\n"
        )
        env = dict(os.environ, PYTHONPATH=os.path.abspath(SRC))
        done = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("imported", done.stdout)


class TheReadme(unittest.TestCase):
    """The README's adapter examples import what the adapters export, and parse."""

    def test_examples_name_what_exists(self):
        with open(os.path.join(HERE, "..", "README.md"), encoding="utf-8") as handle:
            readme = handle.read()
        blocks = [b for b in re.findall(r"```python\n(.*?)```", readme, re.S) if "deliverd.adapters" in b]
        self.assertGreaterEqual(len(blocks), 2, "the README shows no adapter example, so this checks nothing")
        imported = 0
        for block in blocks:
            compile(block, "README.md", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)
            for module, grouped, inline in re.findall(
                r"from deliverd\.adapters\.(\w+) import (?:\(([^)]*)\)|([^\n]+))", block
            ):
                names = grouped or inline
                loaded = importlib.import_module("deliverd.adapters." + module)
                for name in [n.strip() for n in names.split(",") if n.strip()]:
                    imported += 1
                    self.assertIn(name, loaded.__all__, "the README imports {}.{}".format(module, name))
        self.assertGreaterEqual(imported, 2)


@unittest.skipUnless(
    importlib.util.find_spec("agent_framework") is not None,
    "agent-framework-core is not installed (it needs Python 3.10+); the shapes were not checked here",
)
class ShapesOfTheRealThing(unittest.TestCase):
    """Run wherever Agent Framework is installed: the names the adapter relies on."""

    def test_agent_framework(self):
        import inspect

        from agent_framework import AgentResponse, Content, Message, ToolApprovalMiddleware, create_harness_agent

        request = Content.from_function_approval_request(
            id="fc_1", function_call=Content.from_function_call(call_id="call_1", name="refund", arguments=REFUND)
        )
        request.function_call.id = "fc_1"
        self.assertTrue(request.user_input_request)
        response = AgentResponse(messages=[Message("assistant", [request])])
        self.assertEqual(af._approval_requests(response), [request])
        answer = request.to_function_approval_response(approved=False)
        self.assertEqual((answer.type, answer.approved), ("function_approval_response", False))
        self.assertIn("auto_approval_rules", inspect.signature(ToolApprovalMiddleware).parameters)
        self.assertIn("auto_approval_rules", inspect.signature(create_harness_agent).parameters)
        resolution = run(af.resolve_approval_requests(response, FakeDeliverd()))
        self.assertEqual(resolution.responses[0].approved, True)

    @unittest.skipUnless(importlib.util.find_spec("openai") is not None, "openai is not installed")
    def test_openai_mcp_approval_response(self):
        from openai.types.responses.response_input_param import McpApprovalResponse

        self.assertLessEqual(
            {"type", "approve", "approval_request_id", "reason"}, set(McpApprovalResponse.__annotations__)
        )


if __name__ == "__main__":
    unittest.main()
