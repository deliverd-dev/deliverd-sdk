"""Strands Agents: a person approves tool calls, through Deliverd.

Strands is AWS's open-source agent SDK, and what an agent on Amazon Bedrock
AgentCore Runtime is most often built with. Its hooks run before every tool
call, and a hook that sets ``cancel_tool`` stops the call. Add this to the
agent's hooks and the tools that matter wait for a person::

    from strands import Agent
    from deliverd import Deliverd
    from deliverd.adapters.strands import DeliverdApprovals

    agent = Agent(
        tools=[issue_refund, lookup_order],
        hooks=[DeliverdApprovals(Deliverd(), approvers=["finance"],
                                 when=lambda tool, args: tool == "issue_refund")],
    )
    agent("Refund order 1042")

The hook asks Deliverd and waits, on the thread the run is on. An approved call
runs unchanged. Anything else is cancelled with ``cancel_tool`` set to why —
the person's words, or the policy's — which Strands hands the model as the
tool's error result, so the agent reads a reason it can act on.

Each call is one request, keyed by Strands' tool use id
(``strands:<toolUseId>``). **A wait that runs out cancels the call**: Strands
cannot park a tool call and resume it later, so a call nobody decided before
``timeout`` is not run, and the agent is told it is still waiting. The request
stays open in Deliverd. Leave ``timeout`` unset to wait as long as the request
is open (``expires_in``, an hour unless you say).

**It fails closed.** Any error asking — Deliverd unreachable, a gate that
cannot be asked, a ``describe`` that raised — cancels the call with that
reason rather than letting a failure to ask read as permission.

Shapes follow ``strands.hooks``: ``HookProvider.register_hooks``,
``HookRegistry.add_callback`` and ``BeforeToolCallEvent`` (``tool_use`` with
``toolUseId``, ``name`` and ``input``, and ``cancel_tool``), in
``strands-agents`` 1.x. Nothing from Strands is imported until the hook is
registered on an agent.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import Call, Describe, Options, When, decide, failed_reason, field_of, fingerprint, parse_arguments, waiting_reason

__all__ = ["DeliverdApprovals"]

PREFIX = "strands:"


def _before_tool_call_event() -> Any:
    try:
        from strands.hooks import BeforeToolCallEvent
    except ImportError:  # releases before the hooks left ``experimental``
        from strands.experimental.hooks import BeforeToolCallEvent  # type: ignore[no-redef]
    return BeforeToolCallEvent


def _call_of(tool_use: Any) -> Call:
    tool = str(field_of(tool_use, "name") or "a tool")
    args = parse_arguments(field_of(tool_use, "input"))
    call_id = str(field_of(tool_use, "toolUseId") or "{}:{}".format(tool, fingerprint(args)))
    return Call(call_id=call_id, tool=tool, input=args, external_id=PREFIX + call_id)


class DeliverdApprovals:
    """A Strands ``HookProvider``: pass it in an agent's ``hooks``.

    - ``when(tool, input)`` picks the calls that need a person; the rest run
      without asking. Every call when omitted. A plain function.
    - ``actions`` maps a tool to a Deliverd action, whose gate decides instead:
      by policy, or by a person when a rule says so.
    - ``deliverd`` is a ``Deliverd``, or an ``AsyncDeliverd``, whose blocking
      client is used.
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

    def register_hooks(self, registry: Any, **kwargs: Any) -> None:
        registry.add_callback(_before_tool_call_event(), self.before_tool_call)

    def before_tool_call(self, event: Any) -> None:
        """Ask, wait, and cancel the call unless it was approved as proposed."""
        tool_use = getattr(event, "tool_use", None) or {}
        tool = str(field_of(tool_use, "name") or "a tool")
        try:
            call = _call_of(tool_use)
            outcome = decide(call, self.deliverd, self.options)
        except Exception as error:  # noqa: BLE001 — a failure to ask is not permission
            event.cancel_tool = failed_reason(tool, error)
            return
        if outcome.allowed:
            return
        event.cancel_tool = (
            waiting_reason(tool)
            if outcome.pending
            else outcome.reason or "A person did not approve running {}.".format(tool)
        )
