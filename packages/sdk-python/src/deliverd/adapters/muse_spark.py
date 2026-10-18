"""Meta's Muse Spark, on the Meta Model API: a person approves the function
calls a response asks for, and only the approved ones run.

Muse Spark has no approval hook of its own. A response lists the calls the
model wants made and your loop makes them, so the loop is where a person comes
in. Hand the calls to Deliverd with the function that runs them::

    import os
    from openai import OpenAI
    from deliverd import Deliverd
    from deliverd.adapters.muse_spark import run_function_calls

    muse = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])
    resp = muse.responses.create(model="muse-spark-1.1", input=prompt, tools=tools)
    results = run_function_calls(
        Deliverd(), resp.output, run_tool,
        when=lambda tool, args: tool == "refund", approvers=["finance"],
    )
    resp = muse.responses.create(
        model="muse-spark-1.1", input=results, tools=tools, previous_response_id=resp.id
    )

``run_function_calls`` reads the Responses API's ``function_call`` items and
returns its ``function_call_output`` items; ``run_tool_calls`` reads a Chat
Completions message's ``tool_calls`` and returns ``role: "tool"`` messages.
``_async`` variants of both take an ``AsyncDeliverd`` and an async ``run``.

Every call gets an answer, because the API will not continue without one:

- **Approved**, it runs, and its result is the output (a string as it is,
  anything else as JSON).
- **Declined**, it is not run, and its output is a sentence telling the model a
  person said no, and why.
- **Approved only with changes**, it is not run as proposed; the output names
  the approved values, so the model can call it again with them.
- **Undecided before** ``timeout``, it is not run and the model is told so. The
  request stays open in Deliverd, keyed ``muse-spark:<call id>``, so the same
  call asked again finds it rather than filing a second one.

``actions`` maps a tool to a gate action, so policy decides it before a person
is asked. The shapes are the OpenAI-compatible ones ``api.meta.ai/v1`` serves;
SDK objects and plain dicts both work. Nothing is imported from either.
"""

from __future__ import annotations

import inspect
import json
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Union

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
    parse_arguments,
)

__all__ = [
    "run_function_calls",
    "run_function_calls_async",
    "run_tool_calls",
    "run_tool_calls_async",
]

PREFIX = "muse-spark:"

#: ``run(tool_name, input)``: makes one call and returns its result.
Runner = Callable[[str, Any], Any]
AsyncRunner = Callable[[str, Any], Union[Any, Awaitable[Any]]]


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


def _tool_calls(message: Any) -> List[Call]:
    calls = []
    for item in field_of(message, "tool_calls") or []:
        fn = field_of(item, "function")
        call_id = str(field_of(item, "id"))
        calls.append(
            Call(
                call_id=call_id,
                tool=str(field_of(fn, "name")),
                input=parse_arguments(field_of(fn, "arguments")),
                external_id=PREFIX + call_id,
            )
        )
    return calls


def _render(result: Any) -> str:
    if isinstance(result, str):
        return result
    return json.dumps(result, default=str)


def _not_run(call: Call, outcome: Outcome) -> str:
    if outcome.pending:
        return (
            "Nobody decided whether to run {} in time, so it was not run. The "
            "request is still open; ask again later to pick up the answer.".format(call.tool)
        )
    return outcome.reason or "{} was not run.".format(call.tool)


def _answer(call: Call, deliverd: Any, run: Runner, options: Options) -> str:
    outcome = decide(call, deliverd, options)
    if not outcome.allowed:
        return _not_run(call, outcome)
    return _render(run(call.tool, call.input))


async def _answer_async(call: Call, deliverd: Any, run: AsyncRunner, options: Options) -> str:
    outcome = await decide_async(call, deliverd, options)
    if not outcome.allowed:
        return _not_run(call, outcome)
    result = run(call.tool, call.input)
    if inspect.isawaitable(result):
        result = await result
    return _render(result)


def _output(call: Call, text: str) -> Dict[str, Any]:
    return {"type": "function_call_output", "call_id": call.call_id, "output": text}


def _message(call: Call, text: str) -> Dict[str, Any]:
    return {"role": "tool", "tool_call_id": call.call_id, "content": text}


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
    """Ask about, and run, every ``function_call`` in a Responses API output.

    Returns the ``function_call_output`` items to send as the next request's
    ``input``, one per call, in order. Other output items are ignored.
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
    """``run_function_calls`` without blocking the event loop."""
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    return [_output(call, await _answer_async(call, deliverd, run, options)) for call in _function_calls(output)]


def run_tool_calls(
    deliverd: Any,
    message: Any,
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
    """Ask about, and run, every tool call on a Chat Completions message.

    Returns the ``role: "tool"`` messages to append, one per call, in order.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    return [_message(call, _answer(call, deliverd, run, options)) for call in _tool_calls(message)]


async def run_tool_calls_async(
    deliverd: Any,
    message: Any,
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
    """``run_tool_calls`` without blocking the event loop."""
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    return [_message(call, await _answer_async(call, deliverd, run, options)) for call in _tool_calls(message)]
