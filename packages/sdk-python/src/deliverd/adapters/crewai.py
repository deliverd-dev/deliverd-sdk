"""CrewAI: a person approves tool calls, through Deliverd.

CrewAI's tool hooks run before every tool call an agent makes, and a hook that
returns ``False`` stops the call. Register the pair this builds and the tools
that matter wait for a person::

    from crewai import Agent, Crew, Task
    from deliverd import Deliverd
    from deliverd.adapters.crewai import register_deliverd_approvals

    approvals = register_deliverd_approvals(
        Deliverd(),
        approvers=["finance"],
        when=lambda tool, args: tool == "issue_refund",
    )
    crew.kickoff()
    approvals.unregister()   # when the hooks should stop applying

The before hook asks Deliverd and waits — CrewAI's hooks are synchronous, and
its own approval example blocks the same way, on ``input()``. An approved call
runs unchanged. Anything else is blocked, and the after hook, which CrewAI runs
on a blocked call too, replaces the framework's fixed "Tool execution blocked
by hook" with why: the person's words, or the policy's. So the agent reads a
reason it can act on rather than only that it was stopped.

**A call is keyed by its task and its input, not by a call id.** CrewAI's hook
context carries no id for the call, so the request is filed as
``crewai:<task or agent id>:<digest of tool and input>``. The same call made
again in the same task — a retry after a wait ran out — finds the request it
already made instead of asking twice, and a decision does not carry over to
another task.

**A wait that runs out blocks the call.** Unlike Agent Framework or Pydantic
AI, CrewAI cannot park a tool call and resume it later, so a call nobody
decided before ``timeout`` is not run, and the agent is told it is still
waiting; the request stays open in Deliverd, and the same call in the same
task finds it, and its answer, once somebody decides.

**It fails closed.** CrewAI swallows any exception a hook raises other than its
own ``HookAborted`` and runs the tool anyway. So the before hook catches every
error — Deliverd unreachable, a gate that cannot be asked, a ``describe`` that
raised — and blocks the call with that reason, rather than let a failure to ask
read as permission.

Shapes follow ``crewai.hooks``: ``ToolCallHookContext`` (``tool_name``,
``tool_input``, ``agent``, ``task``, ``tool_result``),
``register_before_tool_call_hook`` and ``register_after_tool_call_hook`` and
their ``unregister_*`` twins, in ``crewai.hooks.tool_hooks``; the "return
``False`` blocks" convention of ``before_tool_call_reducer``; and the blocked
message and after-hook replacement in ``crewai.utilities.tool_utils``,
``crewai.utilities.agent_utils`` and ``crewai.agents.crew_agent_executor``, in
``crewai`` 1.x. Nothing from CrewAI is imported until
``register_deliverd_approvals`` registers the hooks; ``deliverd_tool_hooks``
imports nothing at all.
"""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any, Callable, Mapping, NamedTuple, Optional, Sequence

from ..duration import Duration
from ._shared import Call, Describe, Options, When, decide, failed_reason, parse_arguments, waiting_reason

__all__ = [
    "DeliverdToolHooks",
    "deliverd_tool_hooks",
    "register_deliverd_approvals",
]

PREFIX = "crewai:"

#: What CrewAI tells the model about a call a before hook blocked, up to the
#: tool's name. The after hook replaces it only when it starts with this.
BLOCKED = "Tool execution blocked by hook."


class DeliverdToolHooks(NamedTuple):
    """The two hooks, for CrewAI's ``register_before_tool_call_hook`` and
    ``register_after_tool_call_hook`` — or for ``@before_tool_call`` and
    ``@after_tool_call`` methods on a ``@CrewBase`` class, to scope them to one
    crew."""

    #: Asks Deliverd and waits; returns ``False`` to block, ``None`` to allow.
    before: Callable[[Any], Optional[bool]]
    #: Replaces the fixed blocked message with the reason; ``None`` otherwise.
    after: Callable[[Any], Optional[str]]

    def unregister(self) -> None:
        """Remove both hooks from CrewAI's global registry."""
        from crewai.hooks import unregister_after_tool_call_hook, unregister_before_tool_call_hook

        unregister_before_tool_call_hook(self.before)
        unregister_after_tool_call_hook(self.after)


def _scope(context: Any) -> str:
    """Whose call it is: the task's id, else the agent's, else nobody's."""
    for owner in (getattr(context, "task", None), getattr(context, "agent", None)):
        ident = getattr(owner, "id", None) if owner is not None else None
        if ident:
            return str(ident)
    return "run"


def _call_of(context: Any) -> Call:
    tool = str(getattr(context, "tool_name", None) or "a tool")
    args = parse_arguments(getattr(context, "tool_input", None))
    try:
        text = json.dumps([tool, args], sort_keys=True, default=str)
    except (TypeError, ValueError):
        text = repr([tool, args])
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
    scope = _scope(context)
    call_id = "{}:{}".format(scope, digest)
    return Call(call_id=call_id, tool=tool, input=args, external_id=PREFIX + call_id)


def deliverd_tool_hooks(
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
) -> DeliverdToolHooks:
    """The before and after tool hooks, unregistered.

    - ``when(tool, input)`` picks the calls that need a person; the rest run
      without asking. Every call when omitted. A plain function: CrewAI's hooks
      are synchronous.
    - ``actions`` maps a tool to a Deliverd action, whose gate decides instead:
      by policy, or by a person when a rule says so.
    - ``timeout`` stops waiting; the call is then blocked, and the same call
      later in the same task finds the same request.
    - ``deliverd`` is a ``Deliverd``, or an ``AsyncDeliverd``, whose blocking
      client is used.

    The pair share what the before hook decided, per thread: CrewAI runs a
    call's before and after hooks one after the other on the thread that makes
    the call, and runs parallel calls on threads of their own.
    """
    options = Options(
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata=metadata,
    )
    refused = threading.local()

    def before(context: Any) -> Optional[bool]:
        refused.last = None
        tool = str(getattr(context, "tool_name", None) or "a tool")
        try:
            call = _call_of(context)
            outcome = decide(call, deliverd, options)
        except Exception as error:  # noqa: BLE001 — CrewAI would swallow it and run the tool
            refused.last = (tool, failed_reason(tool, error))
            return False
        if outcome.allowed:
            return None
        reason = waiting_reason(call.tool) if outcome.pending else outcome.reason
        refused.last = (tool, reason or "A person did not approve running {}.".format(tool))
        return False

    def after(context: Any) -> Optional[str]:
        last = getattr(refused, "last", None)
        if last is None:
            return None
        result = getattr(context, "tool_result", None)
        if not isinstance(result, str) or not result.startswith(BLOCKED):
            return None
        refused.last = None
        tool, reason = last
        if str(getattr(context, "tool_name", None) or "a tool") != tool:
            return None
        return reason

    return DeliverdToolHooks(before, after)


def register_deliverd_approvals(
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
) -> DeliverdToolHooks:
    """Register :func:`deliverd_tool_hooks` globally, for every crew and agent.

    Returns the hooks; ``.unregister()`` removes them. Takes the same options.
    """
    from crewai.hooks import register_after_tool_call_hook, register_before_tool_call_hook

    hooks = deliverd_tool_hooks(
        deliverd,
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata=metadata,
    )
    register_before_tool_call_hook(hooks.before)
    register_after_tool_call_hook(hooks.after)
    return hooks
