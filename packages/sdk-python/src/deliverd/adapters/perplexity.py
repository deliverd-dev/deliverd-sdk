"""Perplexity's Agent API: a person decides the tool calls a run asks to make.

The Agent API (``POST https://api.perplexity.ai/v1/agent``, also served at
``/v1/responses`` for the OpenAI SDK) runs the agent loop itself: search,
fetch, any model through one key, remote MCP servers and the connectors a
Project administrator set up. It stops for a person in two places, and this
answers both:

- **MCP servers and connectors with** ``require_approval``. The call does not
  run; the response's ``output`` carries an ``mcp_approval_request``, and the
  next request answers it with an ``mcp_approval_response``. Perplexity runs
  MCP and connector calls without asking unless ``require_approval`` is set,
  unlike OpenAI's default, so set it on every server that can change something.
- **Your own functions.** A ``function_call`` is a call your code makes, so
  your code is where a person comes in: only approved calls run, and a declined
  one answers the model with the person's reason.

::

    from perplexity import Perplexity
    from deliverd import Deliverd
    from deliverd.adapters.perplexity import run_with_deliverd_approvals

    response = run_with_deliverd_approvals(
        Perplexity(),
        Deliverd(),
        create_kwargs={
            "model": "openai/gpt-5.6-sol",
            "input": "Close the stale issues in our tracker",
            "tools": [{
                "type": "connector",
                "id": "connector_linear",
                "server_label": "linear",
                "require_approval": "always",
            }],
        },
        approvers=["platform-team"],
    )
    print(response.output_text)

Each call is one request in Deliverd keyed ``perplexity:<id>``, so a retried
round finds the request it already made. Follow-ups chain with
``previous_response_id``; ``replay=True`` resends the conversation instead, for
accounts under zero data retention. ``approval_responses_for`` and
``run_function_calls`` do one round, for a loop you own. Shapes follow
Perplexity's Agent API reference and the ``perplexityai`` package; nothing is
imported from it, and the OpenAI client pointed at
``https://api.perplexity.ai/v1`` works the same.
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
from .muse_spark import AsyncRunner, Runner, _answer, _answer_async, _output

__all__ = [
    "approval_responses_for",
    "approval_responses_for_async",
    "run_function_calls",
    "run_function_calls_async",
    "run_with_deliverd_approvals",
    "run_with_deliverd_approvals_async",
]

PREFIX = "perplexity:"


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


def _approval_calls(output: Any) -> List[Call]:
    calls = []
    for item in output or []:
        if field_of(item, "type") != "mcp_approval_request" or not field_of(item, "id"):
            continue
        request_id = str(field_of(item, "id"))
        calls.append(
            Call(
                call_id=request_id,
                tool=str(field_of(item, "name") or "a tool"),
                input=parse_arguments(field_of(item, "arguments")),
                external_id=PREFIX + request_id,
                server=field_of(item, "server_label"),
            )
        )
    return calls


def _function_calls(output: Any) -> List[Call]:
    calls = []
    for item in output or []:
        if field_of(item, "type") != "function_call":
            continue
        call_id = str(field_of(item, "call_id"))
        calls.append(
            Call(
                call_id=call_id,
                tool=str(field_of(item, "name")),
                input=parse_arguments(field_of(item, "arguments")),
                external_id=PREFIX + call_id,
            )
        )
    return calls


def _assemble(calls: Sequence[Call], outcomes: Sequence[Outcome], send_reason: bool) -> Resolution:
    resolution: Resolution = Resolution()
    for call, outcome in zip(calls, outcomes):
        if outcome.pending:
            resolution.pending.append(call.call_id)
            continue
        answer: Dict[str, Any] = {
            "type": "mcp_approval_response",
            "approval_request_id": call.call_id,
            "approve": outcome.allowed,
        }
        if not outcome.allowed and outcome.reason:
            resolution.reasons[call.call_id] = outcome.reason
            if send_reason:
                answer["reason"] = outcome.reason
        resolution.responses.append(answer)
    return resolution


def approval_responses_for(
    output: Any,
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
    """Ask about every ``mcp_approval_request`` in a response's ``output``.

    ``resolution.responses`` are the ``mcp_approval_response`` items for the
    next request's ``input``. A call ``when`` does not select is approved
    without asking; ``actions`` maps a tool to a gate action so policy decides
    first. A call nobody decided before ``timeout`` is in
    ``resolution.pending`` with no answer built; asking again later finds the
    same request.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    calls = _approval_calls(output)
    return _assemble(calls, [decide(call, deliverd, options) for call in calls], send_reason)


async def approval_responses_for_async(
    output: Any,
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
    calls = _approval_calls(output)
    outcomes = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    return _assemble(calls, outcomes, send_reason)


def run_function_calls(
    deliverd: Any,
    output: Any,
    run: Runner,
    *,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Ask about, and run, every ``function_call`` in a response's ``output``.

    Returns one ``function_call_output`` per call, in order. A declined call is
    not run; its output tells the model a person said no, and why.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    return [_output(call, _answer(call, deliverd, run, options)) for call in _function_calls(output)]


async def run_function_calls_async(
    deliverd: Any,
    output: Any,
    run: AsyncRunner,
    *,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """:func:`run_function_calls` without blocking the event loop."""
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    return [_output(call, await _answer_async(call, deliverd, run, options)) for call in _function_calls(output)]


def _as_items(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        return [{"type": "message", "role": "user", "content": value}]
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def _plain(item: Any) -> Any:
    """An SDK model as the dict it was sent as, so it can be sent back unchanged."""
    dump = getattr(item, "model_dump", None)
    return dump(exclude_none=True) if callable(dump) else item


class _Chain:
    """What the next request carries: the answers, chained or with the history resent."""

    def __init__(self, create_kwargs: Mapping[str, Any], replay: bool) -> None:
        self.carried = {k: v for k, v in create_kwargs.items() if k not in ("input", "previous_response_id")}
        self.replay = replay
        self.history = _as_items(create_kwargs.get("input"))

    def next(self, response: Any, answers: List[Any]) -> Dict[str, Any]:
        kwargs = dict(self.carried)
        if self.replay:
            self.history = self.history + [_plain(i) for i in field_of(response, "output") or []] + answers
            kwargs["input"] = list(self.history)
        else:
            kwargs["input"] = answers
            kwargs["previous_response_id"] = field_of(response, "id")
        return kwargs


def _waiting(response: Any, run: Any) -> bool:
    output = field_of(response, "output") or []
    if _approval_calls(output):
        return True
    return run is not None and bool(_function_calls(output))


def run_with_deliverd_approvals(
    client: Any,
    deliverd: Any,
    *,
    create_kwargs: Mapping[str, Any],
    run: Optional[Runner] = None,
    replay: bool = False,
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
    """Create a response, and keep answering it until it asks for nothing more.

    ``client.responses.create(**create_kwargs)`` first; then, after each round,
    a request with the approval answers and (given ``run``) the function call
    outputs, carrying ``model``, ``tools`` and everything else unchanged.
    Without ``run``, a response asking for a function call is returned as it
    is. Returns early, with the requests still in ``output``, when ``timeout``
    ran out before somebody decided. Non-streaming, foreground responses only.
    """
    keywords = dict(
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata=metadata,
    )
    chain = _Chain(create_kwargs, replay)
    response = client.responses.create(**create_kwargs)
    rounds = 0
    while _waiting(response, run):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        output = field_of(response, "output")
        resolution = approval_responses_for(output, deliverd, send_reason=send_reason, **keywords)
        if not resolution.complete:
            return response
        results = run_function_calls(deliverd, output, run, **keywords) if run is not None else []
        response = client.responses.create(**chain.next(response, resolution.responses + results))
    return response


async def run_with_deliverd_approvals_async(
    client: Any,
    deliverd: Any,
    *,
    create_kwargs: Mapping[str, Any],
    run: Optional[AsyncRunner] = None,
    replay: bool = False,
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
    """:func:`run_with_deliverd_approvals` for ``AsyncPerplexity`` and an ``AsyncDeliverd``."""
    keywords = dict(
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata=metadata,
    )
    chain = _Chain(create_kwargs, replay)
    response = await client.responses.create(**create_kwargs)
    rounds = 0
    while _waiting(response, run):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        output = field_of(response, "output")
        resolution = await approval_responses_for_async(output, deliverd, send_reason=send_reason, **keywords)
        if not resolution.complete:
            return response
        results = await run_function_calls_async(deliverd, output, run, **keywords) if run is not None else []
        response = await client.responses.create(**chain.next(response, resolution.responses + results))
    return response
