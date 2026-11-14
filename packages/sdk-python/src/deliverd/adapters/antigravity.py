"""Google Antigravity: a person approves an agent's tool calls, through Deliverd.

The Antigravity SDK (``pip install google-antigravity``) runs every tool call
through its hooks, and a ``PreToolCallDecideHook`` that answers
``HookResult(allow=False, message=...)`` stops the call and hands the agent
the message. ``deliverd_hook`` builds that hook: the calls you pick wait for a
named person in Deliverd, from their inbox, Slack or Teams, and the rest run
as before::

    from google.antigravity import Agent, LocalAgentConfig
    from google.antigravity.hooks import policy
    from deliverd.aio import AsyncDeliverd
    from deliverd.adapters.antigravity import deliverd_hook

    config = LocalAgentConfig(
        # Antigravity's default policy refuses run_command outright; let the
        # hook decide instead.
        policies=[policy.allow_all()],
        hooks=[deliverd_hook(AsyncDeliverd(), approvers=["platform-leads"],
                             when=lambda tool, args: tool == "run_command")],
    )
    async with Agent(config) as agent:
        await agent.chat("Apply the Terraform plan in infra/prod")

An approved call runs unchanged. Anything else is stopped with the reason as
the message — the person's words, or the policy's — so the agent reads why
and can say so.

``approval_handler`` is the same question as an ``ask_user`` handler, for a
policy list you already have::

    policies = [
        policy.allow_all(),
        policy.ask_user("run_command", handler=approval_handler(AsyncDeliverd(),
                                                                approvers=["platform-leads"])),
    ]

A handler answers only yes or no, so there the agent is not told the
person's reason; prefer the hook when it should be.

Each call is one request, keyed by Antigravity's call id
(``antigravity:<id>``, or the step id, or the tool and its arguments when the
call carries neither), so asking again finds the same request. **A wait that
runs out stops the call**: an Antigravity hook cannot park a call and resume
it later, so a call nobody decided before ``timeout`` is not run and the agent
is told it is still waiting; the request stays open in Deliverd. Leave
``timeout`` unset to wait as long as the request is open (``expires_in``, an
hour unless you say).

**It fails closed.** Any error asking — Deliverd unreachable, a gate that
cannot be asked, a ``describe`` that raised — stops the call with that reason.

Shapes follow ``google-antigravity`` 0.1.x: ``hooks.PreToolCallDecideHook``,
``types.HookResult`` and ``types.ToolCall`` (``name``, ``args``, ``id``,
``step_id``, ``server_name`` for an MCP tool). Nothing from Antigravity is
imported until ``deliverd_hook`` is called.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence, Tuple

from ..duration import Duration
from ._shared import (
    Call,
    Describe,
    Options,
    When,
    decide_async,
    failed_reason,
    field_of,
    fingerprint,
    parse_arguments,
    waiting_reason,
)

__all__ = ["DeliverdApprovals", "deliverd_hook", "approval_handler"]

PREFIX = "antigravity:"


def _name(value: Any) -> str:
    # A built-in tool's name arrives as a ``BuiltinTools`` member, a str enum.
    return str(getattr(value, "value", value) or "a tool")


def call_of(tool_call: Any) -> Call:
    """One Antigravity ``ToolCall`` (or the same as a dict) as a Deliverd call."""
    tool = _name(field_of(tool_call, "name"))
    args = parse_arguments(field_of(tool_call, "args"))
    server = field_of(tool_call, "server_name") or None
    call_id = field_of(tool_call, "id") or field_of(tool_call, "step_id") or "{}:{}".format(tool, fingerprint(args))
    return Call(call_id=str(call_id), tool=tool, input=args, external_id=PREFIX + str(call_id), server=server)


class DeliverdApprovals:
    """What the hook and the handler share: ask about one call, and say why not.

    - ``when(tool, args)`` picks the calls that need a person; the rest run
      without asking. Every call when omitted.
    - ``actions`` maps a tool to a Deliverd action, whose gate decides instead:
      by policy, or by a person when a rule says so.
    - ``deliverd`` is an ``AsyncDeliverd``, or a ``Deliverd``, whose blocking
      calls run on a worker thread so the agent's event loop is not held.
    """

    def __init__(
        self,
        deliverd: Any,
        *,
        approvers: Optional[Sequence[str]] = None,
        when: Optional[When] = None,
        describe: Optional[Describe] = None,
        actions: Optional[Mapping[str, str]] = None,
        expires_in: Optional[Duration] = None,
        timeout: Optional[Duration] = None,
        flow_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self.deliverd = deliverd
        self.options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)

    async def check(self, tool_call: Any) -> Tuple[bool, str]:
        """``(True, "")`` to run the call; ``(False, why)`` to stop it."""
        tool = _name(field_of(tool_call, "name"))
        try:
            outcome = await decide_async(call_of(tool_call), self.deliverd, self.options)
        except Exception as error:  # noqa: BLE001 — a failure to ask is not permission
            return False, failed_reason(tool, error)
        if outcome.allowed:
            return True, ""
        if outcome.pending:
            return False, waiting_reason(tool)
        return False, outcome.reason or "A person did not approve running {}.".format(tool)


def deliverd_hook(deliverd: Any, **options: Any) -> Any:
    """An Antigravity ``PreToolCallDecideHook``: pass it in ``LocalAgentConfig(hooks=[...])``.

    Takes the options of :class:`DeliverdApprovals`. Imports
    ``google.antigravity`` here, so importing this module does not.
    """
    from google.antigravity import types  # type: ignore[import-not-found]
    from google.antigravity.hooks import hooks  # type: ignore[import-not-found]

    approvals = DeliverdApprovals(deliverd, **options)

    class DeliverdPreToolCallHook(hooks.PreToolCallDecideHook):  # type: ignore[misc,name-defined]
        """Asks Deliverd before the calls ``when`` picks, and stops the ones not approved."""

        async def run(self, context: Any, data: Any) -> Any:
            allowed, message = await approvals.check(data)
            return types.HookResult(allow=allowed, message=message)

    return DeliverdPreToolCallHook()


def approval_handler(deliverd: Any, **options: Any) -> Callable[..., Awaitable[bool]]:
    """An ``ask_user`` handler for ``policy.ask_user(tool, handler=...)``.

    Answers ``True`` only when the call was approved as proposed. Takes the
    options of :class:`DeliverdApprovals`.
    """
    approvals = DeliverdApprovals(deliverd, **options)

    async def handler(tool_call: Any, reason: Optional[str] = None) -> bool:
        allowed, _ = await approvals.check(tool_call)
        return allowed

    return handler
