"""Amazon Bedrock Agents: a person confirms an action group's calls, through
Deliverd.

Turn on user confirmation for the functions that matter —
``requireConfirmation: "ENABLED"`` on the action group's function, or
``x-requireConfirmation: ENABLED`` on an API operation — and Bedrock stops
before each call and hands control back. Let this answer it instead of a
prompt of your own::

    import boto3
    from deliverd import Deliverd
    from deliverd.adapters.bedrock import invoke_with_deliverd_approvals

    runtime = boto3.client("bedrock-agent-runtime")
    run = invoke_with_deliverd_approvals(
        runtime,
        Deliverd(),
        invoke_kwargs={
            "agentId": AGENT_ID,
            "agentAliasId": AGENT_ALIAS_ID,
            "sessionId": "ticket-1042",
            "inputText": "Refund order 1042",
        },
        approvers=["finance"],
    )
    print(run.text)

Each call becomes a request in Deliverd, keyed by the return of control it
came in and its place there (``bedrock:<invocationId>:<n>``), so a retried
round finds the request it already made. The answers go back on the same
session as ``sessionState.returnControlInvocationResults``, with the
``invocationId`` they answer, until the agent asks for nothing more.
``confirmation_results_for`` does one round, for a loop you own.

**A declined call carries the person's reason.** Bedrock's ``FunctionResult``
and ``ApiResult`` take a ``responseBody`` beside ``confirmationState``, so a
``DENY`` goes back with why, and the agent reads it rather than only that it
was refused. Pass ``send_reason=False`` to send the bare ``DENY``.

**Return of control without confirmation needs ``run_action``.** An action
group whose executor is ``RETURN_CONTROL`` hands every call back for your code
to run (``actionInvocationType`` ``RESULT``, or
``USER_CONFIRMATION_AND_RESULT`` with confirmation on). Give
``run_action(call)`` and those calls are asked about first and run only when
approved; its return value is the result the agent reads. Without it, a return
of control holding such a call is left for you: the round is not complete,
and the loop stops with it in ``run.return_control``.

Shapes follow ``InvokeAgent`` in the Agents for Amazon Bedrock Runtime API —
the ``returnControl`` event's ``invocationId`` and ``invocationInputs``
(``functionInvocationInput``, ``apiInvocationInput``), and ``SessionState``'s
``returnControlInvocationResults`` — as boto3's ``bedrock-agent-runtime``
client returns and takes them. Nothing from boto3 is imported.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

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
)

__all__ = [
    "BedrockResolution",
    "BedrockRun",
    "confirmation_results_for",
    "confirmation_results_for_async",
    "invoke_with_deliverd_approvals",
]

PREFIX = "bedrock:"

#: Calls Bedrock runs itself once confirmed: the answer is a yes or a no.
CONFIRM_ONLY = "USER_CONFIRMATION"
#: Calls your code runs: the answer is the result.
NEEDS_RESULT = ("RESULT", "USER_CONFIRMATION_AND_RESULT")

#: ``run_action(call)``: run an approved call and return what the agent reads —
#: text, or anything JSON can write.
RunAction = Callable[[Call], Any]

#: What a follow-up invocation does not repeat from the first: the text was the
#: question, and the state is the answers.
NOT_CARRIED = ("inputText", "sessionState")


@dataclass
class BedrockResolution(Resolution[Dict[str, Any]]):
    """One return of control, answered.

    ``responses`` are ``returnControlInvocationResults`` entries.
    ``session_state`` is the whole ``sessionState`` to send them in.
    """

    invocation_id: Optional[str] = None
    #: Calls this could not answer, by position in ``invocationInputs``: return
    #: of control with no ``run_action`` given.
    unanswered: List[int] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        """Every call has an answer. Bedrock takes the results of one return
        of control together, so a partial set is not sent."""
        return not self.pending and not self.unanswered

    @property
    def session_state(self) -> Dict[str, Any]:
        return {"invocationId": self.invocation_id, "returnControlInvocationResults": list(self.responses)}


@dataclass
class BedrockRun:
    """What :func:`invoke_with_deliverd_approvals` came to."""

    #: The agent's text, every chunk of every round, in order.
    text: str
    session_id: Optional[str]
    #: The ``returnControl`` payload still open when the loop stopped early —
    #: somebody had not decided, or a call needs ``run_action``. ``None`` when
    #: the agent finished.
    return_control: Optional[Dict[str, Any]] = None
    #: The last round's answers, ``None`` if the agent never asked.
    resolution: Optional[BedrockResolution] = None


# ── reading a return of control ───────────────────────────────────────────


def _named_values(entries: Any) -> Dict[str, Any]:
    """Bedrock's ``[{"name", "type", "value"}]`` as a plain object. Values
    arrive as strings; they are shown as sent."""
    values: Dict[str, Any] = {}
    for entry in entries or []:
        name = field_of(entry, "name")
        if name:
            values[str(name)] = field_of(entry, "value")
    return values


def _input_of(item: Mapping[str, Any]) -> Tuple[str, Any, Dict[str, Any]]:
    """``(kind, invocation input, what the person is shown)``."""
    function = field_of(item, "functionInvocationInput")
    if function:
        return "function", function, _named_values(field_of(function, "parameters"))
    api = field_of(item, "apiInvocationInput")
    args = _named_values(field_of(api, "parameters"))
    content = field_of(field_of(api, "requestBody"), "content") or {}
    for body in content.values() if isinstance(content, Mapping) else []:
        args.update(_named_values(field_of(body, "properties")))
    return "api", api, args


def _tool_of(kind: str, invocation: Any) -> str:
    if kind == "function":
        return str(field_of(invocation, "function") or "a function")
    return "{} {}".format(field_of(invocation, "httpMethod") or "", field_of(invocation, "apiPath") or "").strip() or "an API"


@dataclass
class _Item:
    index: int
    kind: str
    invocation: Any
    call: Call

    @property
    def invocation_type(self) -> str:
        return str(field_of(self.invocation, "actionInvocationType") or CONFIRM_ONLY)


def _items(return_control: Any) -> List[_Item]:
    invocation_id = str(field_of(return_control, "invocationId") or "")
    items = []
    for index, raw in enumerate(field_of(return_control, "invocationInputs") or []):
        kind, invocation, args = _input_of(raw)
        if not invocation:
            continue
        tool = _tool_of(kind, invocation)
        call_id = "{}:{}".format(invocation_id, index)
        items.append(
            _Item(
                index,
                kind,
                invocation,
                Call(
                    call_id=call_id,
                    tool=tool,
                    input=args,
                    external_id=PREFIX + call_id,
                    # The action group, so the request reads "on BillingActions".
                    server=field_of(invocation, "actionGroup"),
                ),
            )
        )
    return items


# ── what an answer becomes ────────────────────────────────────────────────


def _body_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


def _result(item: _Item, *, confirmation: Optional[str], body: Optional[str], status: int = 200) -> Dict[str, Any]:
    inv = item.invocation
    if item.kind == "function":
        answer: Dict[str, Any] = {"actionGroup": field_of(inv, "actionGroup"), "function": field_of(inv, "function")}
        if body is not None:
            answer["responseBody"] = {"TEXT": {"body": body}}
    else:
        answer = {
            "actionGroup": field_of(inv, "actionGroup"),
            "apiPath": field_of(inv, "apiPath"),
            "httpMethod": field_of(inv, "httpMethod"),
            "httpStatusCode": status,
        }
        if body is not None:
            answer["responseBody"] = {"application/json": {"body": body}}
    if confirmation is not None:
        answer["confirmationState"] = confirmation
    # A collaborator's call, in a multi-agent team, is answered to that agent.
    if field_of(inv, "agentId"):
        answer["agentId"] = field_of(inv, "agentId")
    return {"functionResult" if item.kind == "function" else "apiResult": answer}


def _answer(item: _Item, outcome: Outcome, run_action: Optional[RunAction], send_reason: bool) -> Dict[str, Any]:
    confirms = item.invocation_type != "RESULT"
    if outcome.allowed:
        body = _body_text(run_action(item.call)) if item.invocation_type in NEEDS_RESULT and run_action else None
        return _result(item, confirmation="CONFIRM" if confirms else None, body=body)
    reason = outcome.reason or "A person did not approve running {}.".format(item.call.tool)
    if not confirms:
        # Nothing to deny: the call is simply not run, and the result says why.
        return _result(item, confirmation=None, body=reason, status=403)
    return _result(item, confirmation="DENY", body=reason if send_reason else None, status=403)


def _assemble(
    return_control: Any,
    items: Sequence[_Item],
    outcomes: Sequence[Optional[Outcome]],
    run_action: Optional[RunAction],
    send_reason: bool,
) -> BedrockResolution:
    resolution = BedrockResolution(invocation_id=field_of(return_control, "invocationId"))
    for item, outcome in zip(items, outcomes):
        if outcome is None:
            resolution.unanswered.append(item.index)
            continue
        if outcome.pending:
            resolution.pending.append(item.call.call_id)
            continue
        if not outcome.allowed and outcome.reason:
            resolution.reasons[item.call.call_id] = outcome.reason
        resolution.responses.append(_answer(item, outcome, run_action, send_reason))
    return resolution


def _answerable(item: _Item, run_action: Optional[RunAction]) -> bool:
    return item.invocation_type not in NEEDS_RESULT or run_action is not None


def confirmation_results_for(
    return_control: Any,
    deliverd: Any,
    *,
    run_action: Optional[RunAction] = None,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    send_reason: bool = True,
) -> BedrockResolution:
    """Ask about every call in a ``returnControl`` event, and build the answers.

    ``resolution.session_state`` is the ``sessionState`` for the next
    ``invoke_agent`` on the same session::

        resolution = confirmation_results_for(event["returnControl"], deliverd, approvers=["finance"])
        if resolution.complete:
            runtime.invoke_agent(agentId=..., agentAliasId=..., sessionId=session_id,
                                 sessionState=resolution.session_state)

    ``when(tool, input)`` picks the calls that need a person (every call when
    omitted) — the tool is the function's name, or ``"POST /refunds"`` for an
    API operation; ``actions`` maps a tool to a Deliverd action whose gate
    decides instead. A call nobody decided before ``timeout`` is in
    ``resolution.pending``; the session stays open on that return of control,
    and resolving it again later finds the same requests.
    """
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    items = _items(return_control)
    outcomes = [decide(item.call, deliverd, options) if _answerable(item, run_action) else None for item in items]
    return _assemble(return_control, items, outcomes, run_action, send_reason)


async def confirmation_results_for_async(
    return_control: Any,
    deliverd: Any,
    *,
    run_action: Optional[RunAction] = None,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    send_reason: bool = True,
) -> BedrockResolution:
    """:func:`confirmation_results_for`, awaited, with the calls asked together.
    ``run_action`` stays a plain function, called once a call is approved."""
    options = Options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata)
    items = _items(return_control)

    async def one(item: _Item) -> Optional[Outcome]:
        return await decide_async(item.call, deliverd, options) if _answerable(item, run_action) else None

    outcomes = await asyncio.gather(*(one(item) for item in items))
    return _assemble(return_control, items, outcomes, run_action, send_reason)


# ── the loop ──────────────────────────────────────────────────────────────


def _drain(response: Any) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Read an ``invoke_agent`` stream: its text, and its return of control."""
    text: List[str] = []
    return_control = None
    for event in field_of(response, "completion") or []:
        chunk = field_of(event, "chunk")
        if chunk is not None:
            data = field_of(chunk, "bytes")
            text.append(data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else str(data or ""))
        if field_of(event, "returnControl") is not None:
            return_control = field_of(event, "returnControl")
    return "".join(text), return_control


def invoke_with_deliverd_approvals(
    client: Any,
    deliverd: Any,
    *,
    invoke_kwargs: Mapping[str, Any],
    run_action: Optional[RunAction] = None,
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
) -> BedrockRun:
    """Invoke an agent, and keep answering its returns of control until there are none.

    ``client.invoke_agent(**invoke_kwargs)`` first; then, after each round of
    decisions, an invocation on the same ``sessionId`` with the answers as
    ``sessionState``, carrying everything else in ``invoke_kwargs``
    (``agentId``, ``agentAliasId``, ``enableTrace``) but not ``inputText``.
    ``invoke_kwargs`` is a dict of its own because ``metadata`` means different
    things to the two calls. Pass a ``sessionId``: the answers are bound to it.

    Returns early, with the open payload in ``return_control``, when ``timeout``
    ran out before somebody decided or a call needs ``run_action``.
    """
    response = client.invoke_agent(**invoke_kwargs)
    text, return_control = _drain(response)
    session_id = field_of(response, "sessionId") or invoke_kwargs.get("sessionId")
    texts = [text]
    resolution: Optional[BedrockResolution] = None
    rounds = 0
    while return_control is not None:
        if rounds >= max_rounds:
            raise max_rounds_error(max_rounds)
        rounds += 1
        resolution = confirmation_results_for(
            return_control,
            deliverd,
            run_action=run_action,
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
            return BedrockRun("".join(texts), session_id, return_control, resolution)
        follow_up = {k: v for k, v in invoke_kwargs.items() if k not in NOT_CARRIED}
        follow_up["sessionId"] = session_id
        follow_up["sessionState"] = resolution.session_state
        text, return_control = _drain(client.invoke_agent(**follow_up))
        texts.append(text)
    return BedrockRun("".join(texts), session_id, None, resolution)
