"""Microsoft Agent Framework: a person approves tool calls, through Deliverd.

Mark the tools that need a person as usual — ``@tool(approval_mode="always_require")``,
or ``approval_mode=`` on ``MCPStreamableHTTPTool`` — and run the agent through
this instead of building your own prompt::

    from deliverd import Deliverd
    from deliverd.adapters.agent_framework import run_with_deliverd_approvals

    session = agent.create_session()
    result = await run_with_deliverd_approvals(
        agent,
        "Refund order 1042",
        session,
        Deliverd(),
        approvers=["finance"],
    )
    print(result.text)

Each ``function_approval_request`` in ``result.user_input_requests`` becomes a
request in Deliverd, keyed by its call id (``agent-framework:<call_id>``) so a
retried round finds the request it already made. Approved calls run; declined
ones do not. The run continues on the same session, which is where Agent
Framework binds an answer to the request it issued — pass the session, or an
answer cannot resume anything. ``resolve_approval_requests`` does one round,
for a loop you own.

**The model is told a call was declined, not why.** Agent Framework answers a
declined call with a fixed result ("rejected by user") and its approval
response has no field for a reason. A message carrying the reason cannot ride
along either: the framework places the tool results it builds from the answers
after any message sent with them, which leaves a tool result that no longer
follows its call. The person's reason is in ``Resolution.reasons`` instead,
for your logs or your next turn.

``deliverd_approval_rule`` is for the harness: an ``auto_approval_rules``
entry for ``ToolApprovalMiddleware`` or ``create_harness_agent`` that lets a
call through without a prompt when it needs no person — ``when`` does not
select it, or the organisation's policy (a Deliverd gate) already allows it.

Shapes follow ``Content.to_function_approval_response``,
``AgentResponse.user_input_requests``, ``Message``, ``Agent.run(..., session=)``
and ``ToolApprovalRuleCallback`` in ``agent-framework-core`` 1.x. Nothing from
it is imported until ``run_with_deliverd_approvals`` builds the ``Message``
it sends.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, List, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import (
    Call,
    Describe,
    Options,
    Outcome,
    Resolution,
    When,
    allowed_by_policy,
    decide,
    decide_async,
    field_of,
    fingerprint,
    max_rounds_error,
    parse_arguments,
    selected_async,
)

__all__ = [
    "deliverd_approval_rule",
    "resolve_approval_requests",
    "resolve_approval_requests_sync",
    "run_with_deliverd_approvals",
]

PREFIX = "agent-framework:"


def _call_of(function_call: Any, request_id: Optional[str] = None) -> Call:
    """A ``function_call`` content, as the adapters read one."""
    tool = getattr(function_call, "name", None) or "a tool"
    args = parse_arguments(getattr(function_call, "arguments", None))
    properties = getattr(function_call, "additional_properties", None)
    # A hosted MCP call — Foundry's or OpenAI's, surfaced through a chat
    # client — names its server here.
    server = field_of(properties, "server_label") if isinstance(properties, Mapping) else None
    call_id = (
        getattr(function_call, "call_id", None)
        or request_id
        or "{}:{}".format(tool, fingerprint(args))
    )
    return Call(
        call_id=str(call_id),
        tool=str(tool),
        input=args,
        external_id=PREFIX + str(call_id),
        server=server,
    )


def _approval_requests(result: Any) -> List[Any]:
    """The tool approvals among a result's user input requests.

    ``user_input_requests`` also carries requests this adapter cannot answer,
    such as an OAuth consent link, so it is filtered by type.
    """
    return [
        request
        for request in (getattr(result, "user_input_requests", None) or [])
        if getattr(request, "type", None) == "function_approval_request"
        and getattr(request, "function_call", None) is not None
    ]


def _assemble(requests: Sequence[Any], calls: Sequence[Call], outcomes: Sequence[Outcome]) -> Resolution:
    resolution: Resolution = Resolution()
    for request, call, outcome in zip(requests, calls, outcomes):
        if outcome.pending:
            resolution.pending.append(call.call_id)
            continue
        resolution.responses.append(request.to_function_approval_response(approved=outcome.allowed))
        if not outcome.allowed and outcome.reason:
            resolution.reasons[call.call_id] = outcome.reason
    return resolution


def deliverd_approval_rule(
    deliverd: Any,
    *,
    when: Optional[When] = None,
    actions: Optional[Mapping[str, str]] = None,
    flow_id: Optional[str] = None,
) -> Callable[[Any], Awaitable[bool]]:
    """An auto-approval rule: ``True`` only for a call that needs no person.

    For ``ToolApprovalMiddleware(auto_approval_rules=[...])`` or
    ``create_harness_agent(..., auto_approval_rules=[...])``, which call it with
    the ``function_call`` content and skip the prompt when it returns ``True``.

    A tool named in ``actions`` is the organisation's to decide: it is put to
    that Deliverd action's gate without waiting, and passes only when a rule
    allowed it as proposed. Any other tool passes when ``when`` does not select
    it. With neither, nothing passes — every call goes to a person, through
    :func:`resolve_approval_requests`, which finds the same gate by the same
    ``external_id`` rather than asking twice.
    """
    options = Options(when=when)

    async def rule(function_call: Any) -> bool:
        call = _call_of(function_call)
        action = (actions or {}).get(call.tool)
        if action is not None:
            return await allowed_by_policy(call, deliverd, action, flow_id)
        if when is None:
            return False
        return not await selected_async(call, options)

    return rule


async def resolve_approval_requests(
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
) -> Resolution:
    """Ask about every tool approval in a result, and build the answers.

    Send ``resolution.responses`` back on the same session, in one user
    message::

        resolution = await resolve_approval_requests(result, deliverd, approvers=["finance"])
        if resolution.complete:
            result = await agent.run(Message("user", resolution.responses), session=session)

    The requests are asked together, so their approvers hear about all of them
    at once. ``deliverd`` is a ``Deliverd`` (its calls run on worker threads) or
    an ``AsyncDeliverd``.

    - ``when(tool, input)`` picks the calls that need a person; the rest are
      approved without asking. Every call when omitted.
    - ``actions`` maps a tool to a Deliverd action, whose gate decides instead:
      by policy, or by a person when a rule says so.
    - ``timeout`` stops waiting. A call nobody decided by then is in
      ``resolution.pending`` with no answer built; resolve the same result again
      later and the same request is found.
    - Why each declined call was declined is in ``resolution.reasons``: the
      person's own words, which Agent Framework has no field to pass on.
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
    requests = _approval_requests(result)
    calls = [_call_of(r.function_call, getattr(r, "id", None)) for r in requests]
    outcomes = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    return _assemble(requests, calls, outcomes)


def resolve_approval_requests_sync(
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
) -> Resolution:
    """:func:`resolve_approval_requests`, blocking: for a worker with no event loop.

    The calls are asked one after another rather than together, and ``when``
    must be a plain function.
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
    requests = _approval_requests(result)
    calls = [_call_of(r.function_call, getattr(r, "id", None)) for r in requests]
    outcomes = [decide(call, deliverd, options) for call in calls]
    return _assemble(requests, calls, outcomes)


def _message(role: str, contents: List[Any]) -> Any:
    # Imported here, not at the top: importing this module must not need
    # Agent Framework installed, and nothing else in it constructs its types.
    from agent_framework import Message

    return Message(role, contents)


async def run_with_deliverd_approvals(
    agent: Any,
    messages: Any,
    session: Any,
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
    **run_kwargs: Any,
) -> Any:
    """Run until nothing is waiting on a person, and return the last result.

    ``agent.run(messages, session=session, **run_kwargs)`` first, then, after
    each round of decisions, the answers in one user message on the same
    session. ``run_kwargs`` go to every run, so ``options=`` reaches them all.

    Returns early, with the requests still in ``result.user_input_requests``,
    when ``timeout`` ran out before somebody decided — keep the session and
    call :func:`resolve_approval_requests` on that result later — and when the
    result asks for input this adapter cannot give, such as an OAuth consent.
    A cap on rounds stops an agent that keeps asking from waiting forever.
    """
    result = await agent.run(messages, session=session, **run_kwargs)
    rounds = 0
    while True:
        requests = _approval_requests(result)
        others = len(getattr(result, "user_input_requests", None) or []) - len(requests)
        if not requests or others:
            return result
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        resolution = await resolve_approval_requests(
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
        result = await agent.run(_message("user", resolution.responses), session=session, **run_kwargs)
