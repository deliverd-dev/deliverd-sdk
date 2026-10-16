"""Pydantic AI: a person approves tool calls, through Deliverd.

Mark the tools that need a person as Pydantic AI already has you do —
``@agent.tool(requires_approval=True)``, a tool that raises
``ApprovalRequired``, or an ``ApprovalRequiredToolset`` — and give the agent
this capability, which answers those calls inside the run::

    from pydantic_ai import Agent
    from deliverd import Deliverd
    from deliverd.adapters.pydantic_ai import deliverd_approvals

    agent = Agent("openai:gpt-5", capabilities=[deliverd_approvals(Deliverd(), approvers=["finance"])])

    @agent.tool_plain(requires_approval=True)
    def refund(order_id: str, amount: int) -> str:
        ...

    result = await agent.run("Refund order 1042")

Each call waiting for approval becomes a request in Deliverd, keyed by its tool
call id (``pydantic-ai:<tool_call_id>``) so asking again finds the request it
already made. An approved call runs as the model proposed it. A declined one
does not, and the model reads why: ``ToolDenied`` carries a message back to
it, so the person's reason, or the policy's, is what the model sees.

**A wait that runs out leaves the call pending.** A call nobody decided before
``timeout`` gets no answer, so Pydantic AI ends the run with it in a
``DeferredToolRequests`` output — give the agent
``output_type=[str, DeferredToolRequests]`` when you set a ``timeout``. Resolve
those requests later with :func:`resolve_deferred_tool_requests` and pass the
results to the next run, and the same request in Deliverd is found again.

**A call approved only with changes is declined**, with the approved values in
the message, as in the other adapters. ``ToolApproved(override_args=...)``
could run a corrected call, but the adapters never offer editable fields, and a
correction that arrives anyway — a gate's action can allow one — is not what
the person was shown.

Shapes follow ``pydantic_ai.capabilities.HandleDeferredToolCalls`` (its
``handler(ctx, requests)``), ``DeferredToolRequests.approvals`` (a list of
``ToolCallPart`` with ``tool_name``, ``args`` and ``tool_call_id``),
``DeferredToolResults(approvals=...)``, ``ToolApproved`` and
``ToolDenied(message)``, all in ``pydantic_ai.tools`` / ``pydantic_ai._deferred``
and ``pydantic_ai.capabilities.deferred_tool_handler`` in ``pydantic-ai-slim``
2.x. Nothing from it is imported until an answer is built.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import (
    Call,
    Describe,
    Options,
    Outcome,
    When,
    decide,
    decide_async,
    field_of,
    fingerprint,
    parse_arguments,
)

__all__ = [
    "deliverd_approvals",
    "deliverd_deferred_tool_handler",
    "resolve_deferred_tool_requests",
    "resolve_deferred_tool_requests_sync",
]

PREFIX = "pydantic-ai:"


def _call_of(part: Any) -> Call:
    """A ``ToolCallPart``, as the adapters read one."""
    tool = str(field_of(part, "tool_name") or "a tool")
    args = parse_arguments(field_of(part, "args"))
    call_id = field_of(part, "tool_call_id") or "{}:{}".format(tool, fingerprint(args))
    return Call(call_id=str(call_id), tool=tool, input=args, external_id=PREFIX + str(call_id))


def _approvals(requests: Any) -> List[Any]:
    """The calls waiting for approval. ``requests.calls`` are for external
    execution, which is not a person's to approve, so they are left alone."""
    return list(field_of(requests, "approvals") or [])


def _results(calls: Sequence[Call], outcomes: Sequence[Outcome]) -> Any:
    # Imported here, not at the top: importing this module must not need
    # Pydantic AI installed (it needs Python 3.11; this package runs on 3.9).
    from pydantic_ai.tools import DeferredToolResults, ToolApproved, ToolDenied

    approvals: Dict[str, Any] = {}
    for call, outcome in zip(calls, outcomes):
        if outcome.pending:
            continue  # no answer: the call stays deferred, and the run hands it back
        if outcome.allowed:
            approvals[call.call_id] = ToolApproved()
        else:
            approvals[call.call_id] = ToolDenied(
                outcome.reason or "A person did not approve running {}.".format(call.tool)
            )
    return DeferredToolResults(approvals=approvals)


def _options(
    approvers: Optional[Sequence[str]],
    when: Optional[When],
    describe: Optional[Describe],
    actions: Optional[Mapping[str, str]],
    expires_in: Optional[Duration],
    timeout: Optional[Duration],
    flow_id: Optional[str],
    metadata: Optional[Mapping[str, Any]],
) -> Options:
    return Options(
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata=metadata,
    )


async def resolve_deferred_tool_requests(
    requests: Any,
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
) -> Any:
    """Ask about every call in a ``DeferredToolRequests``, and build the
    ``DeferredToolResults`` that answer them.

    For a run that ended with the requests as its output::

        results = await resolve_deferred_tool_requests(result.output, deliverd, approvers=["finance"])
        result = await agent.run(message_history=result.all_messages(), deferred_tool_results=results)

    The calls are asked together. A call nobody decided before ``timeout`` has
    no entry in ``results.approvals`` — ``result.output.remaining(results)``
    names them — and resolving the same requests later finds the same requests
    in Deliverd. ``when``, ``actions`` and ``describe`` are as in the other
    adapters; ``deliverd`` is a ``Deliverd`` (run on worker threads) or an
    ``AsyncDeliverd``.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    calls = [_call_of(part) for part in _approvals(requests)]
    outcomes = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    return _results(calls, outcomes)


def resolve_deferred_tool_requests_sync(
    requests: Any,
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
) -> Any:
    """:func:`resolve_deferred_tool_requests`, blocking, for ``agent.run_sync``:
    the calls are asked one after another, and ``when`` must be a plain function."""
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    calls = [_call_of(part) for part in _approvals(requests)]
    return _results(calls, [decide(call, deliverd, options) for call in calls])


def deliverd_deferred_tool_handler(
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
) -> Callable[[Any, Any], Any]:
    """The handler for ``HandleDeferredToolCalls(handler=...)``.

    Returns ``None`` — "not handled", so the next capability or the run's output
    gets the calls — when there was nothing to approve or nobody decided in time.
    """

    async def handler(ctx: Any, requests: Any) -> Any:
        if not _approvals(requests):
            return None
        results = await resolve_deferred_tool_requests(
            requests,
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
        return results if results.approvals else None

    return handler


def deliverd_approvals(
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
) -> Any:
    """A capability for ``Agent(capabilities=[...])`` that has a person approve,
    through Deliverd, every tool call the agent defers for approval.

    ``HandleDeferredToolCalls`` around :func:`deliverd_deferred_tool_handler`;
    takes the same options as :func:`resolve_deferred_tool_requests`.
    """
    from pydantic_ai.capabilities import HandleDeferredToolCalls

    return HandleDeferredToolCalls(
        handler=deliverd_deferred_tool_handler(
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
    )
