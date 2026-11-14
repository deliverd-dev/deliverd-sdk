"""Google Antigravity: the SDK's pre-tool-call decide hook and ``ask_user``
handler, answered by a person through Deliverd.

``google-antigravity`` is not installed in CI — the package promises no
dependencies — so it is stood in for by the shapes the adapter reads, named
after the real ones in ``google.antigravity.hooks.hooks`` and
``google.antigravity.types`` (0.1.23): ``PreToolCallDecideHook``, ``HookResult``
and ``ToolCall`` with ``name``, ``args``, ``id``, ``step_id`` and
``server_name``.

What matters most, in order: a call a person declined never runs; a call
approved only with changes never runs as proposed; a failure to ask never
reads as permission; and the agent is told why a call did not run.
"""

import abc
import os
import sys
import types
import unittest
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src"))
sys.path.insert(0, HERE)

import test_adapters as base  # noqa: E402

from deliverd.adapters import antigravity  # noqa: E402

FakeDeliverd = base.FakeDeliverd
AsyncFakeDeliverd = base.AsyncFakeDeliverd
decision = base.decision
gate_decision = base.gate_decision
timed_out = base.timed_out
run = base.run


@dataclass
class ToolCall:
    name: Any
    args: Dict[str, Any] = field(default_factory=dict)
    id: Optional[str] = None
    step_id: Optional[str] = None
    server_name: Optional[str] = None


@dataclass
class HookResult:
    allow: bool = True
    message: str = ""


def fake_antigravity() -> Dict[str, types.ModuleType]:
    class PreToolCallDecideHook(abc.ABC):
        @abc.abstractmethod
        async def run(self, context: Any, data: Any) -> Any: ...

    root = types.ModuleType("google")
    pkg = types.ModuleType("google.antigravity")
    types_mod = types.ModuleType("google.antigravity.types")
    types_mod.HookResult = HookResult  # type: ignore[attr-defined]
    hooks_pkg = types.ModuleType("google.antigravity.hooks")
    hooks_mod = types.ModuleType("google.antigravity.hooks.hooks")
    hooks_mod.PreToolCallDecideHook = PreToolCallDecideHook  # type: ignore[attr-defined]
    pkg.types = types_mod  # type: ignore[attr-defined]
    hooks_pkg.hooks = hooks_mod  # type: ignore[attr-defined]
    root.antigravity = pkg  # type: ignore[attr-defined]
    return {
        "google": root,
        "google.antigravity": pkg,
        "google.antigravity.types": types_mod,
        "google.antigravity.hooks": hooks_pkg,
        "google.antigravity.hooks.hooks": hooks_mod,
    }


TERRAFORM = ToolCall("run_command", {"CommandLine": "terraform apply", "Cwd": "/w"}, id="call_1")


def hook_run(deliverd: Any, call: ToolCall, **options: Any) -> HookResult:
    with mock.patch.dict(sys.modules, fake_antigravity()):
        hook = antigravity.deliverd_hook(deliverd, **options)
        return run(hook.run(None, call))


class Hook(unittest.TestCase):
    def test_is_the_sdks_decide_hook(self):
        with mock.patch.dict(sys.modules, fake_antigravity()):
            hook = antigravity.deliverd_hook(FakeDeliverd())
            self.assertIsInstance(hook, sys.modules["google.antigravity.hooks.hooks"].PreToolCallDecideHook)

    def test_an_approved_call_runs_and_is_asked_once_by_its_call_id(self):
        deliverd = FakeDeliverd()
        result = hook_run(deliverd, TERRAFORM, approvers=["platform-leads"])
        self.assertTrue(result.allow)
        self.assertEqual(result.message, "")
        asked = deliverd.asked[0]
        self.assertEqual(asked["external_id"], "antigravity:call_1")
        self.assertEqual(asked["approvers"], ["platform-leads"])
        self.assertEqual(asked["input"], {"CommandLine": "terraform apply", "Cwd": "/w"})

    def test_a_declined_call_is_stopped_with_the_persons_reason(self):
        result = hook_run(FakeDeliverd(lambda kw: decision(False, note="Not on a Friday")), TERRAFORM)
        self.assertFalse(result.allow)
        self.assertIn("Not on a Friday", result.message)
        self.assertIn("Dana", result.message)

    def test_approved_only_with_changes_is_stopped(self):
        changes = [{"field": "CommandLine", "from": "terraform apply", "to": "terraform plan"}]
        result = hook_run(FakeDeliverd(lambda kw: decision(True, changes=changes)), TERRAFORM)
        self.assertFalse(result.allow)
        self.assertIn("terraform plan", result.message)

    def test_a_wait_that_runs_out_stops_the_call_and_says_it_is_still_open(self):
        result = hook_run(FakeDeliverd(timed_out), TERRAFORM, timeout=1)
        self.assertFalse(result.allow)
        self.assertIn("Nobody has decided yet", result.message)

    def test_a_failure_to_ask_is_not_permission(self):
        def unreachable(kw: Dict[str, Any]) -> Any:
            raise ConnectionError("Deliverd is unreachable")

        result = hook_run(FakeDeliverd(unreachable), TERRAFORM)
        self.assertFalse(result.allow)
        self.assertIn("could not be asked for", result.message)

    def test_when_picks_the_calls_that_need_a_person(self):
        deliverd = FakeDeliverd(lambda kw: decision(False))
        result = hook_run(deliverd, ToolCall("view_file", {"AbsolutePath": "/w/a"}, id="c2"), when=lambda tool, args: tool == "run_command")
        self.assertTrue(result.allow)
        self.assertEqual(deliverd.asked, [])

    def test_a_gate_decides_when_the_tool_has_an_action(self):
        deliverd = FakeDeliverd(gate=lambda kw: gate_decision(False, reason="Production is frozen"))
        result = hook_run(deliverd, TERRAFORM, actions={"run_command": "infra.apply"})
        self.assertFalse(result.allow)
        self.assertIn("Production is frozen", result.message)
        self.assertEqual(deliverd.gated[0]["action"], "infra.apply")
        self.assertEqual(deliverd.gated[0]["external_id"], "antigravity:call_1")

    def test_an_async_client_is_awaited(self):
        deliverd = AsyncFakeDeliverd()
        self.assertTrue(hook_run(deliverd, TERRAFORM).allow)
        self.assertEqual(len(deliverd.asked), 1)


class CallShape(unittest.TestCase):
    def test_an_mcp_tool_carries_its_server(self):
        call = antigravity.call_of(ToolCall("create_refund", {"amount": 420}, id="c3", server_name="stripe"))
        self.assertEqual(call.tool, "create_refund")
        self.assertEqual(call.server, "stripe")

    def test_a_builtin_name_enum_reads_as_its_value(self):
        class Builtin(str):
            value = "run_command"

        self.assertEqual(antigravity.call_of(ToolCall(Builtin("BuiltinTools.RUN_COMMAND"), {}, id="c")).tool, "run_command")

    def test_without_an_id_the_step_then_the_call_itself_is_the_key(self):
        self.assertEqual(antigravity.call_of(ToolCall("run_command", {}, step_id="t:4")).external_id, "antigravity:t:4")
        a = antigravity.call_of(ToolCall("run_command", {"CommandLine": "ls"}))
        b = antigravity.call_of({"name": "run_command", "args": {"CommandLine": "ls"}})
        self.assertEqual(a.external_id, b.external_id)


class Handler(unittest.TestCase):
    def test_answers_only_yes_or_no(self):
        yes = antigravity.approval_handler(FakeDeliverd())
        no = antigravity.approval_handler(FakeDeliverd(lambda kw: decision(False)))
        self.assertIs(run(yes(TERRAFORM, "")), True)
        self.assertIs(run(no(TERRAFORM)), False)


class NoDependency(unittest.TestCase):
    def test_importing_the_adapter_imports_no_antigravity(self):
        import subprocess

        code = "import sys\nsys.modules['google'] = None\nimport deliverd.adapters.antigravity\nprint('imported')\n"
        env = dict(os.environ, PYTHONPATH=os.path.abspath(os.path.join(HERE, "..", "src")))
        done = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("imported", done.stdout)


if __name__ == "__main__":
    unittest.main()
