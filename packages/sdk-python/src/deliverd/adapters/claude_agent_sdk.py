"""The Claude Agent SDK for Python: a person approves tool calls, through Deliverd.

::

    from claude_agent_sdk import ClaudeAgentOptions, query
    from deliverd import Deliverd
    from deliverd.adapters.claude_agent_sdk import deliverd_can_use_tool

    options = ClaudeAgentOptions(
        can_use_tool=deliverd_can_use_tool(
            Deliverd(),
            approvers=["release-managers"],
            when=lambda tool, input: tool == "Bash" or tool.startswith("mcp__"),
        ),
    )
    async for message in query(prompt="Tidy the release notes and publish them", options=options):
        ...

A call that needs no person is allowed with its input unchanged. One that does
waits for the decision, from the page, the email link, Slack or Teams, and is
allowed or denied with the reason the model reads. ``actions`` maps a tool to a
registered Deliverd action, whose gate decides instead: the organisation's
rules, or a person they name. A wait that runs out, or any error asking, denies
the call: a failure to ask is never permission.

The Python SDK passes no tool-use id to ``can_use_tool``, so each request is
keyed by the tool and its input (``claude-agent-sdk:<tool>:<fingerprint>``):
the same call asked again finds the request it already made.

Shapes follow ``CanUseTool``, ``ToolPermissionContext``,
``PermissionResultAllow`` and ``PermissionResultDeny`` in ``claude-agent-sdk``.
The result types are imported when a call is answered, so importing this
module needs nothing installed.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence

from ..duration import Duration
from ._shared import Call, Describe, Options, Outcome, When, decide_async, fingerprint

__all__ = ["deliverd_can_use_tool"]

PREFIX = "claude-agent-sdk:"

CanUseTool = Callable[[str, Mapping[str, Any], Any], Awaitable[Any]]


def _allow(input: Mapping[str, Any]) -> Any:
    from claude_agent_sdk import PermissionResultAllow

    return PermissionResultAllow(updated_input=dict(input))


def _deny(message: str) -> Any:
    from claude_agent_sdk import PermissionResultDeny

    return PermissionResultDeny(message=message)


def deliverd_can_use_tool(
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
    allow: Callable[[Mapping[str, Any]], Any] = _allow,
    deny: Callable[[str], Any] = _deny,
) -> CanUseTool:
    """A ``can_use_tool`` callback that asks Deliverd and waits.

    ``deliverd`` is a ``Deliverd`` (its calls run on worker threads, so the
    event loop is not held) or an ``AsyncDeliverd``. ``allow`` and ``deny``
    build the SDK's answers; they are for tests.
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

    async def can_use_tool(tool_name: str, input: Mapping[str, Any], context: Any) -> Any:
        key = "{}:{}".format(tool_name, fingerprint(input))
        call = Call(call_id=key, tool=tool_name, input=dict(input), external_id=PREFIX + key)
        try:
            outcome: Outcome = await decide_async(call, deliverd, options)
        except Exception as err:  # noqa: BLE001 - a failure to ask is never permission
            return deny("Deliverd could not be asked about {}, so it was not run: {}".format(tool_name, err))
        if outcome.allowed:
            return allow(input)
        if outcome.pending:
            return deny("Nobody decided whether to run {} in time, so it was not run.".format(tool_name))
        return deny(outcome.reason or "{} was not allowed.".format(tool_name))

    return can_use_tool
