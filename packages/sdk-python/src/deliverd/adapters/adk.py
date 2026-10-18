"""Google's Agent Development Kit, and agents on Vertex AI Agent Engine: a
person approves tool calls, through Deliverd.

Two ways in, for the two places an ADK agent's tool calls can be decided.

**In the agent: a before-tool callback.** ADK runs ``before_tool_callback``
before every tool call, and a dict it returns is used as the tool's result
instead of running it. This one asks Deliverd and waits; it works wherever the
agent runs, Agent Engine included::

    from google.adk.agents import LlmAgent
    from deliverd import Deliverd
    from deliverd.adapters.adk import deliverd_before_tool_callback

    agent = LlmAgent(
        model="gemini-2.5-flash",
        name="billing",
        tools=[issue_refund, lookup_order],
        before_tool_callback=deliverd_before_tool_callback(
            Deliverd(), approvers=["finance"], when=lambda tool, args: tool == "issue_refund"
        ),
    )

An approved call runs unchanged. Anything else does not run, and the model
reads ``{"error": ...}`` with why — the person's words, or the policy's. Each
call is one request keyed by ADK's function call id (``adk:<id>``). ADK awaits
an async callback, so ``deliverd_before_tool_callback_async`` waits without
holding the event loop. A wait that runs out does not run the call, and the
model is told it is still waiting; any error asking does not run it either.

**Outside the agent: ADK's tool confirmation.** A tool built with
``FunctionTool(fn, require_confirmation=True)`` pauses the run with an
``adk_request_confirmation`` function call, and the run resumes when a
``function_response`` to it arrives. For an agent deployed to Agent Engine,
let this answer them from the client::

    from vertexai import agent_engines
    from deliverd.adapters.adk import run_with_deliverd_confirmations

    app = agent_engines.get(RESOURCE_NAME)
    events = run_with_deliverd_confirmations(
        app, Deliverd(), user_id="u-1", session_id=session["id"],
        message="Refund order 1042", approvers=["finance"],
    )

Each confirmation is a request keyed by the call it confirms (``adk:<id>`` of
the original function call, the same key the callback uses). ADK's answer is a
yes or a no: a declined call is told only that it was rejected, so the
person's reason is in ``Resolution.reasons``. ``confirmation_responses_for``
does one round over a list of events, for a loop you own; its responses are
``function_response`` parts, to send as one user message.

Shapes follow ``google.adk``'s ``before_tool_callback`` (``tool``, ``args``,
``tool_context`` with ``function_call_id``), the tool confirmation guide's
``adk_request_confirmation`` call (``originalFunctionCall``,
``toolConfirmation`` with ``hint``) and its ``{"confirmed": bool}`` response,
and Agent Engine's ``AdkApp.stream_query(message=, user_id=, session_id=)``,
whose events are plain dicts. Event keys are read in either case
(``function_call`` or ``functionCall``). Nothing from Google is imported.
"""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import (
    Call,
    CallDescription,
    Describe,
    Options,
    Outcome,
    Resolution,
    When,
    decide,
    decide_async,
    default_description,
    failed_reason,
    field_of,
    fingerprint,
    max_rounds_error,
    parse_arguments,
    waiting_reason,
)

__all__ = [
    "CONFIRMATION_FUNCTION",
    "confirmation_responses_for",
    "confirmation_responses_for_async",
    "deliverd_before_tool_callback",
    "deliverd_before_tool_callback_async",
    "run_with_deliverd_confirmations",
]

PREFIX = "adk:"

#: The function call ADK makes when a tool asks for confirmation.
CONFIRMATION_FUNCTION = "adk_request_confirmation"

BeforeToolCallback = Callable[..., Optional[Dict[str, Any]]]


def _either(obj: Any, snake: str, camel: str) -> Any:
    value = field_of(obj, snake)
    return value if value is not None else field_of(obj, camel)


# ── the before-tool callback ──────────────────────────────────────────────


def _callback_call(tool: Any, args: Any, tool_context: Any) -> Call:
    name = str(getattr(tool, "name", None) or "a tool")
    value = parse_arguments(args)
    call_id = getattr(tool_context, "function_call_id", None)
    if not call_id:
        invocation = getattr(tool_context, "invocation_id", None) or "run"
        call_id = "{}:{}:{}".format(invocation, name, fingerprint(value))
    return Call(call_id=str(call_id), tool=name, input=value, external_id=PREFIX + str(call_id))


def _refusal(tool: str, outcome: Outcome) -> Optional[Dict[str, Any]]:
    if outcome.allowed:
        return None
    if outcome.pending:
        return {"error": waiting_reason(tool)}
    return {"error": outcome.reason or "A person did not approve running {}.".format(tool)}


def deliverd_before_tool_callback(
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
) -> BeforeToolCallback:
    """A ``before_tool_callback`` that asks a person and waits.

    Returns ``None`` to let an approved call run, or ``{"error": reason}``,
    which ADK hands the model as the tool's result, for anything else.
    ``when(tool, input)`` picks the calls that need a person (every call when
    omitted); ``actions`` maps a tool to a Deliverd action whose gate decides
    instead.
    """
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)

    def before_tool_callback(tool: Any, args: Dict[str, Any], tool_context: Any) -> Optional[Dict[str, Any]]:
        name = str(getattr(tool, "name", None) or "a tool")
        try:
            outcome = decide(_callback_call(tool, args, tool_context), deliverd, options)
        except Exception as error:  # noqa: BLE001 — a failure to ask is not permission
            return {"error": failed_reason(name, error)}
        return _refusal(name, outcome)

    return before_tool_callback


def deliverd_before_tool_callback_async(
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
) -> Callable[..., Awaitable[Optional[Dict[str, Any]]]]:
    """:func:`deliverd_before_tool_callback`, awaited: the event loop runs on
    while a person decides. ``when`` may be async."""
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)

    async def before_tool_callback(tool: Any, args: Dict[str, Any], tool_context: Any) -> Optional[Dict[str, Any]]:
        name = str(getattr(tool, "name", None) or "a tool")
        try:
            outcome = await decide_async(_callback_call(tool, args, tool_context), deliverd, options)
        except Exception as error:  # noqa: BLE001 — a failure to ask is not permission
            return {"error": failed_reason(name, error)}
        return _refusal(name, outcome)

    return before_tool_callback


# ── tool confirmation ─────────────────────────────────────────────────────


@dataclasses.dataclass
class _Confirmation:
    #: The id of the ``adk_request_confirmation`` call: what the response answers.
    request_id: str
    call: Call
    hint: Optional[str]


def _parts(event: Any) -> List[Any]:
    return list(field_of(field_of(event, "content"), "parts") or [])


def _confirmations(events: Iterable[Any]) -> List[_Confirmation]:
    found: List[_Confirmation] = []
    answered = set()
    for event in events:
        for part in _parts(event):
            response = _either(part, "function_response", "functionResponse")
            if response is not None and field_of(response, "name") == CONFIRMATION_FUNCTION:
                answered.add(field_of(response, "id"))
            function_call = _either(part, "function_call", "functionCall")
            if function_call is None or field_of(function_call, "name") != CONFIRMATION_FUNCTION:
                continue
            args = field_of(function_call, "args") or {}
            original = _either(args, "originalFunctionCall", "original_function_call") or {}
            confirmation = _either(args, "toolConfirmation", "tool_confirmation") or {}
            tool = str(field_of(original, "name") or "a tool")
            value = parse_arguments(field_of(original, "args"))
            original_id = field_of(original, "id") or field_of(function_call, "id")
            found.append(
                _Confirmation(
                    request_id=str(field_of(function_call, "id")),
                    call=Call(call_id=str(original_id), tool=tool, input=value, external_id=PREFIX + str(original_id)),
                    hint=field_of(confirmation, "hint"),
                )
            )
    return [c for c in found if c.request_id not in answered]


def _with_hint(options: Options, confirmation: _Confirmation) -> Options:
    """The tool's own hint, at the top of what the approver reads."""
    if options.describe is not None or not confirmation.hint:
        return options
    hint = str(confirmation.hint)

    def describe(tool: str, value: Any) -> CallDescription:
        base = default_description(tool, value)
        return dataclasses.replace(base, description="{}\n\n{}".format(hint, base.description or "").strip())

    return dataclasses.replace(options, describe=describe)


def _response(confirmation: _Confirmation, outcome: Outcome) -> Dict[str, Any]:
    return {
        "function_response": {
            "id": confirmation.request_id,
            "name": CONFIRMATION_FUNCTION,
            "response": {"confirmed": outcome.allowed},
        }
    }


def _assemble(confirmations: Sequence[_Confirmation], outcomes: Sequence[Outcome]) -> Resolution[Dict[str, Any]]:
    resolution: Resolution[Dict[str, Any]] = Resolution()
    for confirmation, outcome in zip(confirmations, outcomes):
        if outcome.pending:
            resolution.pending.append(confirmation.request_id)
            continue
        if not outcome.allowed and outcome.reason:
            resolution.reasons[confirmation.request_id] = outcome.reason
        resolution.responses.append(_response(confirmation, outcome))
    return resolution


def confirmation_responses_for(
    events: Iterable[Any],
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
) -> Resolution[Dict[str, Any]]:
    """Ask about every unanswered ``adk_request_confirmation`` in the events.

    ``resolution.responses`` are the parts of the next user message::

        resolution = confirmation_responses_for(events, deliverd, approvers=["finance"])
        if resolution.complete:
            app.stream_query(user_id=user_id, session_id=session_id,
                             message={"role": "user", "parts": resolution.responses})

    ``when`` and ``actions`` read the confirmed tool's own name and arguments.
    A confirmation nobody decided before ``timeout`` is in
    ``resolution.pending``; the run waits on it, and resolving the same events
    later finds the same request.
    """
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    confirmations = _confirmations(events)
    outcomes = [decide(c.call, deliverd, _with_hint(options, c)) for c in confirmations]
    return _assemble(confirmations, outcomes)


async def confirmation_responses_for_async(
    events: Iterable[Any],
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
) -> Resolution[Dict[str, Any]]:
    """:func:`confirmation_responses_for`, awaited, with the requests asked together."""
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    confirmations = _confirmations(events)
    outcomes = await asyncio.gather(*(decide_async(c.call, deliverd, _with_hint(options, c)) for c in confirmations))
    return _assemble(confirmations, outcomes)


def run_with_deliverd_confirmations(
    app: Any,
    deliverd: Any,
    *,
    user_id: str,
    session_id: str,
    message: Any,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    max_rounds: int = 10,
) -> List[Any]:
    """Send a message to a deployed ADK agent, and answer its confirmations until there are none.

    ``app.stream_query(user_id=, session_id=, message=)`` — an Agent Engine
    ``AdkApp``, local or deployed — and then, after each round of decisions,
    the answers as one user message on the same session. Returns every event,
    in order. Stops early, with the confirmations still unanswered at the end
    of the events, when ``timeout`` ran out before somebody decided.
    """
    events: List[Any] = list(app.stream_query(user_id=user_id, session_id=session_id, message=message))
    round_events = events
    rounds = 0
    while _confirmations(round_events):
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        resolution = confirmation_responses_for(
            round_events,
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
            return events
        answer = {"role": "user", "parts": resolution.responses}
        round_events = list(app.stream_query(user_id=user_id, session_id=session_id, message=answer))
        events.extend(round_events)
    return events
