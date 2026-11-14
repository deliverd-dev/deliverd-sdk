"""Claude Managed Agents, hosted by Anthropic or self-hosted: a person answers
the tool calls a permission policy holds for confirmation.

Give the agent a toolset with ``permission_policy: {type: always_ask}`` (MCP
toolsets ask by default) and the session pauses on each such call with
``session.status_idle``, ``stop_reason.type == "requires_action"``. These answer
the pause with a person's decision, as ``user.tool_confirmation`` events::

    from anthropic import Anthropic
    from deliverd import Deliverd
    from deliverd.adapters.managed_agents import watch_sessions

    # Self-hosted: ANTHROPIC_BASE_URL is your server, ANTHROPIC_API_KEY its key.
    watch_sessions(Anthropic(), Deliverd(), approvers=["platform-team"])

A self-hosted server sends no webhooks, so something has to look:
``watch_sessions`` polls for idle sessions and answers the ones waiting on a
confirmation; ``follow_session`` follows one session's stream; and
``answer_tool_confirmations`` does one pass over one session, for a loop you
own. Each call is one request in Deliverd keyed by its event id
(``managed-agents:<id>``), so a second pass finds the request it already made
rather than asking twice.

- **Approved**, the call runs.
- **Declined**, it does not, and the person's reason reaches the model as the
  ``deny_message``.
- **Approved only with changes**, it is declined: a confirmation is a yes or a
  no and cannot carry corrected input. The model is told the approved values.
- **Undecided** before ``timeout``, nothing is sent. The session waits
  indefinitely, so a later pass picks the same request up.

Only calls the server marked ``evaluated_permission == "ask"`` are answered. A
call ``auto`` already ran or denied, a worker-run tool on a self-hosted
environment and a custom tool (your own code, where ``deliverd.approve()``
belongs) are left alone. ``actions`` maps a tool to a gate action, so policy
decides it before a person is asked.

Shapes follow ``client.beta.sessions`` in ``anthropic`` 2.8 (beta header
``managed-agents-2026-04-01``), which self-hosted servers serve too. SDK
objects and plain dicts both work. Nothing is imported from it.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable, List, Mapping, Optional, Sequence

from ..duration import Duration, duration_seconds
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
    parse_arguments,
)

__all__ = [
    "answer_tool_confirmations",
    "answer_tool_confirmations_async",
    "follow_session",
    "watch_sessions",
]

PREFIX = "managed-agents:"
TOOL_USE = ["agent.tool_use", "agent.mcp_tool_use"]


def _options(
    approvers: Optional[Sequence[str]],
    when: Optional[When],
    describe: Optional[Describe],
    actions: Optional[Mapping[str, str]],
    expires_in: Optional[Duration],
    timeout: Optional[Duration],
    flow_id: Optional[str],
    metadata: Optional[Mapping[str, Any]],
    session_id: str,
) -> Options:
    return Options(
        approvers=approvers,
        when=when,
        describe=describe,
        actions=actions,
        expires_in=expires_in,
        timeout=timeout,
        flow_id=flow_id,
        metadata={**(metadata or {}), "session": session_id},
    )


def _blocking_ids(client: Any, session_id: str) -> List[str]:
    for event in client.beta.sessions.events.list(session_id, order="desc", types=["session.status_idle"]):
        stop = field_of(event, "stop_reason")
        if stop is not None and field_of(stop, "type") == "requires_action":
            return [str(i) for i in (field_of(stop, "event_ids") or [])]
        return []
    return []


def _tool_uses(client: Any, session_id: str, ids: Sequence[str]) -> List[Any]:
    wanted = set(ids)
    found = {}
    for event in client.beta.sessions.events.list(session_id, order="desc", types=TOOL_USE):
        event_id = field_of(event, "id")
        if event_id in wanted:
            found[event_id] = event
        if len(found) == len(wanted):
            break
    return [found[i] for i in ids if i in found]


def _send(client: Any, session_id: str, events: List[Any]) -> None:
    client.beta.sessions.events.send(session_id, events=events)


def _call_of(event: Any) -> Call:
    event_id = str(field_of(event, "id"))
    return Call(
        call_id=event_id,
        tool=str(field_of(event, "name") or "a tool"),
        input=parse_arguments(field_of(event, "input")),
        external_id=PREFIX + event_id,
        server=field_of(event, "mcp_server_name"),
    )


def _held(events: Sequence[Any]) -> List[Call]:
    return [_call_of(e) for e in events if field_of(e, "evaluated_permission") == "ask"]


def _assemble(calls: Sequence[Call], outcomes: Sequence[Outcome]) -> Resolution:
    resolution: Resolution = Resolution()
    for call, outcome in zip(calls, outcomes):
        if outcome.pending:
            resolution.pending.append(call.call_id)
            continue
        answer = {"type": "user.tool_confirmation", "tool_use_id": call.call_id, "result": "allow"}
        if not outcome.allowed:
            answer["result"] = "deny"
            if outcome.reason:
                answer["deny_message"] = outcome.reason
                resolution.reasons[call.call_id] = outcome.reason
        resolution.responses.append(answer)
    return resolution


def answer_tool_confirmations(
    client: Any,
    session_id: str,
    deliverd: Any,
    *,
    event_ids: Optional[Sequence[str]] = None,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
) -> Resolution:
    """One pass over one session: if it is waiting on confirmations, ask a
    person about each and send the answers that came back.

    ``resolution.responses`` are the ``user.tool_confirmation`` events sent;
    ``resolution.pending`` the event ids nobody decided before ``timeout``.
    Pass ``event_ids`` from a ``requires_action`` you already hold to skip
    looking them up.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata, session_id)
    ids = list(event_ids) if event_ids is not None else _blocking_ids(client, session_id)
    if not ids:
        return Resolution()
    calls = _held(_tool_uses(client, session_id, ids))
    resolution = _assemble(calls, [decide(call, deliverd, options) for call in calls])
    if resolution.responses:
        _send(client, session_id, resolution.responses)
    return resolution


async def answer_tool_confirmations_async(
    client: Any,
    session_id: str,
    deliverd: Any,
    *,
    event_ids: Optional[Sequence[str]] = None,
    approvers: Optional[Sequence[str]] = None,
    when: Optional[When] = None,
    describe: Optional[Describe] = None,
    actions: Optional[Mapping[str, str]] = None,
    expires_in: Optional[Duration] = None,
    timeout: Optional[Duration] = None,
    flow_id: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
) -> Resolution:
    """:func:`answer_tool_confirmations` without blocking the event loop, with
    the calls asked about together.

    Takes the blocking ``Anthropic`` client (its calls run on a worker thread)
    and either Deliverd client.
    """
    options = _options(approvers, when, describe, actions, expires_in, timeout, flow_id, metadata, session_id)
    ids = list(event_ids) if event_ids is not None else await asyncio.to_thread(_blocking_ids, client, session_id)
    if not ids:
        return Resolution()
    calls = _held(await asyncio.to_thread(_tool_uses, client, session_id, ids))
    outcomes = await asyncio.gather(*(decide_async(call, deliverd, options) for call in calls))
    resolution = _assemble(calls, outcomes)
    if resolution.responses:
        await asyncio.to_thread(_send, client, session_id, resolution.responses)
    return resolution


def follow_session(
    client: Any,
    session_id: str,
    deliverd: Any,
    *,
    on_event: Optional[Callable[[Any], None]] = None,
    **options: Any,
) -> None:
    """Follow one session's stream, answering each confirmation it pauses on,
    until its turn ends, it stops for another reason, or it terminates.

    Open it before you send the message that starts the turn: a stream carries
    only what happens after it opens. ``options`` are those of
    :func:`answer_tool_confirmations`.
    """
    stream = client.beta.sessions.events.stream(session_id)
    try:
        for event in stream:
            if on_event is not None:
                on_event(event)
            kind = field_of(event, "type")
            if kind == "session.status_terminated":
                return
            if kind != "session.status_idle":
                continue
            stop = field_of(event, "stop_reason")
            if stop is None or field_of(stop, "type") != "requires_action":
                return
            answer_tool_confirmations(
                client, session_id, deliverd, event_ids=list(field_of(stop, "event_ids") or []), **options
            )
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()


def watch_sessions(
    client: Any,
    deliverd: Any,
    *,
    agent_id: Optional[str] = None,
    interval: Duration = "5s",
    timeout: Duration = "10s",
    stop: Optional[threading.Event] = None,
    on_error: Optional[Callable[[BaseException, str], None]] = None,
    **options: Any,
) -> None:
    """Keep answering, for every idle session the key can see (or one agent's,
    with ``agent_id``), until ``stop`` is set. For a self-hosted server, which
    sends no webhooks; it works the same against Anthropic's API.

    Each pass waits on a person for at most ``timeout`` per call, so one slow
    decision does not hold up another session; an undecided call is picked up
    again next pass, from the same request. A session that fails goes to
    ``on_error`` and the watcher carries on; without one, the error is raised.
    ``options`` are those of :func:`answer_tool_confirmations`.
    """
    pause = duration_seconds(interval)
    while stop is None or not stop.is_set():
        params = {"statuses": ["idle"]}
        if agent_id:
            params["agent_id"] = agent_id
        for session in client.beta.sessions.list(**params):
            session_id = str(field_of(session, "id"))
            try:
                answer_tool_confirmations(client, session_id, deliverd, timeout=timeout, **options)
            except Exception as err:  # noqa: BLE001 — one session must not stop the rest
                if on_error is None:
                    raise
                on_error(err, session_id)
        if stop is not None:
            if stop.wait(pause):
                return
        else:
            time.sleep(pause)
