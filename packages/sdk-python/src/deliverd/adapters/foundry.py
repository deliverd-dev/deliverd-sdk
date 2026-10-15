"""Microsoft Foundry Agent Service: a person approves MCP tool calls, through
Deliverd.

Give the agent an MCP tool that asks first — ``require_approval="always"``, or
``{"always": [...]}`` for the tools that matter — and let this answer the
``mcp_approval_request`` items instead of a prompt of your own::

    from azure.ai.projects import AIProjectClient
    from azure.identity import DefaultAzureCredential
    from deliverd import Deliverd
    from deliverd.adapters.foundry import run_with_deliverd_approvals

    project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=DefaultAzureCredential())
    openai = project.get_openai_client()

    response = run_with_deliverd_approvals(
        openai,
        Deliverd(),
        create_kwargs={
            "input": "Close the stale issues in the tracker",
            "extra_body": {"agent_reference": {"name": agent.name, "type": "agent_reference"}},
        },
        approvers=["platform-team"],
    )
    print(response.output_text)

Each request becomes a request in Deliverd, keyed by its id
(``foundry:<id>``) so a retried round finds the request it already made. The
answers go back as ``mcp_approval_response`` input items on a new response with
``previous_response_id``, until the agent asks for nothing more.
``approval_responses_for`` does one round, for a loop you own.

A declined item carries the person's reason in ``reason``, the optional field
on ``McpApprovalResponse`` in ``openai.types.responses`` (and on Foundry's own
``RealtimeMCPApprovalResponse``), so the model reads why rather than only that
it was refused. Foundry's MCP guide does not show the field; pass
``send_reason=False`` if a service rejects it.

Shapes follow the MCP tool guide for Foundry Agent Service and
``azure-ai-projects`` 2.x, whose ``get_openai_client()`` returns the OpenAI
client this calls ``responses.create`` on. Nothing from either is imported.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import (
    Call,
    Describe,
    Options,
    Outcome,
    Resolution,
    When,
    decide,
    decide_async,
    field_of,
    max_rounds_error,
    parse_arguments,
)

__all__ = [
    "approval_responses_for",
    "approval_responses_for_async",
    "run_with_deliverd_approvals",
    "run_with_deliverd_approvals_async",
]

PREFIX = "foundry:"

#: What a follow-up response does not repeat from the first request: the input
#: is the answers, and the chain is ``previous_response_id`` — as in Foundry's
#: own sample, which starts on a conversation and continues by response id.
NOT_CARRIED = ("input", "conversation", "previous_response_id")


def _approval_requests(response: Any) -> List[Any]:
    return [
        item
        for item in (field_of(response, "output") or [])
        if field_of(item, "type") == "mcp_approval_request" and field_of(item, "id")
    ]


def _call_of(item: Any) -> Call:
    request_id = str(field_of(item, "id"))
    return Call(
        call_id=request_id,
        tool=str(field_of(item, "name") or "a tool"),
        # A JSON string on the wire.
        input=parse_arguments(field_of(item, "arguments")),
        external_id=PREFIX + request_id,
        server=field_of(item, "server_label"),
    )


def _assemble(calls: Sequence[Call], outcomes: Sequence[Outcome], send_reason: bool) -> Resolution:
    resolution: Resolution = Resolution()
    for call, outcome in zip(calls, outcomes):
        if outcome.pending:
            resolution.pending.append(call.call_id)
            continue
        answer: Dict[str, Any] = {
            "type": "mcp_approval_response",
            "approve": outcome.allowed,
            "approval_request_id": call.call_id,
        }
        if not outcome.allowed and outcome.reason:
            resolution.reasons[call.call_id] = outcome.reason
            if send_reason:
                answer["reason"] = outcome.reason
        resolution.responses.append(answer)
    return resolution


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


def approval_responses_for(
    response: Any,
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
    send_reason: bool = True,
) -> Resolution:
    """Ask about every ``mcp_approval_request`` in a response, and build the answers.

    ``resolution.responses`` are the input items for the next response::

        resolution = approval_responses_for(response, deliverd, approvers=["platform-team"])
        if resolution.complete:
            response = openai.responses.create(
                input=resolution.responses,
                previous_response_id=response.id,
                extra_body={"agent_reference": {"name": agent.name, "type": "agent_reference"}},
            )

    ``when(tool, input)`` picks the calls that need a person (every call when
    omitted); ``actions`` maps a tool to a Deliverd action whose gate decides
    instead. A call nobody decided before ``timeout`` is in
    ``resolution.pending``, with no answer built; the response stays
    answerable, and resolving it again later finds the same request.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    calls = [_call_of(item) for item in _approval_requests(response)]
    return _assemble(calls, [decide(call, deliverd, options) for call in calls], send_reason)


async def approval_responses_for_async(
    response: Any,
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
    send_reason: bool = True,
) -> Resolution:
    """:func:`approval_responses_for`, awaited, with the requests asked together."""
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    calls = [_call_of(item) for item in _approval_requests(response)]
    outcomes = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    return _assemble(calls, outcomes, send_reason)


def _follow_up(create_kwargs: Mapping[str, Any], response: Any, answers: List[Any]) -> Dict[str, Any]:
    carried = {k: v for k, v in create_kwargs.items() if k not in NOT_CARRIED}
    carried["input"] = answers
    carried["previous_response_id"] = field_of(response, "id")
    return carried


def run_with_deliverd_approvals(
    client: Any,
    deliverd: Any,
    *,
    create_kwargs: Mapping[str, Any],
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    send_reason: bool = True,
    max_rounds: int = 10,
) -> Any:
    """Create a response, and keep answering its approval requests until there are none.

    ``client.responses.create(**create_kwargs)`` first; then, after each round
    of decisions, a response with the answers as ``input`` and the last one's id
    as ``previous_response_id``, carrying everything else in ``create_kwargs``
    (``extra_body`` with the agent reference, ``model``, ``tools``) but not
    ``input`` or ``conversation``. ``create_kwargs`` is a dict of its own rather
    than keyword arguments here because ``metadata`` and ``timeout`` mean
    different things to the two calls.

    Returns early, with the requests still in ``output``, when ``timeout`` ran
    out before somebody decided. Non-streaming responses only.
    """
    response = client.responses.create(**create_kwargs)
    rounds = 0
    while _approval_requests(response):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        resolution = approval_responses_for(
            response,
            deliverd,
            approvers=approvers,
            when=when,
            describe=describe,
            actions=actions,
            expires_in=expires_in,
            timeout=timeout,
            flow_id=flow_id,
            metadata=metadata,
            send_reason=send_reason,
        )
        if not resolution.complete:
            return response
        response = client.responses.create(**_follow_up(create_kwargs, response, resolution.responses))
    return response


async def run_with_deliverd_approvals_async(
    client: Any,
    deliverd: Any,
    *,
    create_kwargs: Mapping[str, Any],
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    send_reason: bool = True,
    max_rounds: int = 10,
) -> Any:
    """:func:`run_with_deliverd_approvals` for the async client —
    ``azure.ai.projects.aio.AIProjectClient.get_openai_client()``."""
    response = await client.responses.create(**create_kwargs)
    rounds = 0
    while _approval_requests(response):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        resolution = await approval_responses_for_async(
            response,
            deliverd,
            approvers=approvers,
            when=when,
            describe=describe,
            actions=actions,
            expires_in=expires_in,
            timeout=timeout,
            flow_id=flow_id,
            metadata=metadata,
            send_reason=send_reason,
        )
        if not resolution.complete:
            return response
        response = await client.responses.create(**_follow_up(create_kwargs, response, resolution.responses))
    return response
