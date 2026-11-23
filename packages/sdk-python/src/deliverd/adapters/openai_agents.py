"""The OpenAI Agents SDK for Python: a person resolves the run's approval
interruptions, through Deliverd.

Mark the tools that need a person as usual — ``@function_tool(needs_approval=True)``
— and a run stops with ``result.interruptions``. Instead of answering them
yourself::

    from agents import Agent, Runner
    from deliverd import Deliverd
    from deliverd.adapters.openai_agents import run_with_deliverd_approvals

    result = await run_with_deliverd_approvals(
        agent, "Refund order 1042", Deliverd(), approvers=["finance"]
    )
    print(result.final_output)

Each interruption becomes a request in Deliverd, keyed by its call id
(``openai-agents:<call_id>``) so a retried round finds the request it already
made. Approved calls are ``state.approve(item)``, declined ones
``state.reject(item)``, and the run resumes from its state until nothing is
waiting. ``actions`` maps a tool to a registered Deliverd action, whose gate
decides instead: the organisation's rules, or a person they name.

The person's reason for a no is in ``Resolution.reasons``, for your logs or
your next turn. ``resolve_interruptions`` does one round, for a loop you own.

Shapes follow ``RunResult.interruptions``, ``RunResult.to_state``,
``RunState.approve`` / ``reject`` and ``ToolApprovalItem`` in the
``openai-agents`` package. Nothing from it is imported here.
"""

from __future__ import annotations

import asyncio
from typing import Any, List, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import (
    Call,
    Describe,
    Options,
    Outcome,
    Resolution,
    When,
    decide_async,
    field_of,
    fingerprint,
    max_rounds_error,
    parse_arguments,
)

__all__ = ["resolve_interruptions", "run_with_deliverd_approvals"]

PREFIX = "openai-agents:"


def _call_of(item: Any) -> Call:
    """A ``ToolApprovalItem``, as the adapters read one."""
    raw = getattr(item, "raw_item", None)
    tool = getattr(item, "tool_name", None) or getattr(item, "name", None) or field_of(raw, "name") or "a tool"
    arguments = getattr(item, "arguments", None)
    if arguments is None:
        arguments = field_of(raw, "arguments")
    args = parse_arguments(arguments)
    call_id = field_of(raw, "call_id") or field_of(raw, "id") or "{}:{}".format(tool, fingerprint(args))
    return Call(call_id=str(call_id), tool=str(tool), input=args, external_id=PREFIX + str(call_id))


async def resolve_interruptions(
    result: Any,
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
) -> "tuple[Any, Resolution[Any]]":
    """Ask about every interruption in a result, and mark each on its state.

    Returns the state to resume from and what the round came to; resume with
    ``Runner.run(agent, state)`` when ``resolution.complete``. A call nobody
    decided before ``timeout`` is left unanswered on the state, in
    ``resolution.pending``.
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
    items: List[Any] = list(getattr(result, "interruptions", None) or [])
    state = result.to_state()
    calls = [_call_of(item) for item in items]
    outcomes: List[Outcome] = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    resolution: Resolution[Any] = Resolution()
    for item, call, outcome in zip(items, calls, outcomes):
        if outcome.pending:
            resolution.pending.append(call.call_id)
            continue
        if outcome.allowed:
            state.approve(item)
        else:
            state.reject(item)
            if outcome.reason:
                resolution.reasons[call.call_id] = outcome.reason
        resolution.responses.append(item)
    return state, resolution


async def run_with_deliverd_approvals(
    agent: Any,
    input: Any,
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
    max_rounds: int = 10,
    runner: Any = None,
    **run_kwargs: Any,
) -> Any:
    """Run until nothing is waiting on a person, and return the last result.

    ``Runner.run(agent, input, **run_kwargs)`` first, then, after each round of
    decisions, ``Runner.run(agent, state, **run_kwargs)``. Returns early, with
    the interruptions still on the result, when ``timeout`` ran out before
    somebody decided. ``runner`` is for tests; it defaults to ``agents.Runner``.
    """
    if runner is None:
        from agents import Runner  # imported here so this module needs nothing installed

        runner = Runner
    result = await runner.run(agent, input, **run_kwargs)
    rounds = 0
    while getattr(result, "interruptions", None):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        state, resolution = await resolve_interruptions(
            result,
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
        if not resolution.complete:
            return result
        result = await runner.run(agent, state, **run_kwargs)
    return result
