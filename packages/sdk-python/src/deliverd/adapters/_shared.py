"""What the framework adapters share: how a tool call becomes a request, and
what the answer becomes.

The Python twin of ``packages/sdk/src/adapters/shared.ts``. The adapters are
written against each framework's own pause — Microsoft Agent Framework's
``function_approval_request`` and Foundry Agent Service's
``mcp_approval_request`` — by shape rather than by import, so this package
keeps its promise of no dependencies. Neither framework is imported when a
module here is: the one name an adapter has to construct, Agent Framework's
``Message``, is imported inside the function that builds it.

Two decisions differ from the TypeScript file, both on purpose.

**A wait that runs out leaves the call pending rather than refusing it.**
Both frameworks keep an unanswered approval request open — Agent Framework in
the session that issued it, Foundry on the stored response — so an agent that
stops waiting can answer later, and the request it already filed in Deliverd
is found again by its ``external_id`` instead of being asked twice. Refusing
would throw away a decision a person may be about to make.

**A call approved with changes is declined, and the model is told the
approved values.** Neither framework can run a corrected call: Agent Framework
rebuilds an approved call from the one it recorded when it asked, and an MCP
approval response carries a yes or a no and nothing else. So the adapters never
offer editable fields, and if a decision still arrives with changes — a gate's
action can allow them — the proposal is not run, because it is not what the
person agreed to.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass, field
from functools import partial
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Generic,
    List,
    Mapping,
    Optional,
    Sequence,
    TypeVar,
    Union,
)

from ..duration import Duration
from ..errors import DeliverdError, DeliverdTimeoutError

#: How long a tool call's request stays open unless you say. An hour, not the
#: SDK's day: an agent is waiting on it.
DEFAULT_TOOL_EXPIRY: Duration = "1h"

#: The input shown field by field on the approval page, when it is a plain
#: object of a sensible size. Larger input is still in the description.
INPUT_MAX = 8000
INPUT_PREVIEW_MAX = 3000

R = TypeVar("R")

#: ``when(tool_name, input)``: whether this call needs a person.
When = Callable[[str, Any], Union[bool, Awaitable[bool]]]


@dataclass
class CallDescription:
    """What a person is shown about one tool call.

    ``describe`` may return one of these or a plain dict with the same keys.
    """

    title: str
    description: Optional[str] = None
    #: ``low`` | ``medium`` | ``high`` | ``critical``
    risk: Optional[str] = None
    factors: Optional[Sequence[Any]] = None


Describe = Callable[[str, Any], Union[CallDescription, Mapping[str, Any]]]


@dataclass
class Resolution(Generic[R]):
    """What one round of decisions came to.

    Three fields rather than a list, because "nothing to send" and "nothing
    decided yet" are different instructions and a list cannot tell them apart.
    """

    #: The answers to hand back to the framework, one per decided call, in the
    #: order the calls were asked about.
    responses: List[R] = field(default_factory=list)
    #: The calls nobody decided before ``timeout``, by call id. Still open in
    #: Deliverd and still waiting in the run; resolving the same result again
    #: later finds the same requests rather than filing new ones.
    pending: List[str] = field(default_factory=list)
    #: Why each declined call was declined, by call id, as a sentence the model
    #: can act on. Foundry's answer carries it; Agent Framework's has no field
    #: for it, so there it is for your logs or your next turn.
    reasons: Dict[str, str] = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        """Every call has an answer, so ``responses`` is the whole reply."""
        return not self.pending


@dataclass
class Call:
    """One tool call, whichever framework it came from."""

    call_id: str
    tool: str
    input: Any
    external_id: str
    #: The MCP server it would run on, when it is an MCP tool.
    server: Optional[str] = None


@dataclass
class Options:
    approvers: Optional[Sequence[str]] = None
    when: Optional[When] = None
    describe: Optional[Describe] = None
    actions: Optional[Mapping[str, str]] = None
    expires_in: Optional[Duration] = None
    timeout: Optional[Duration] = None
    flow_id: Optional[str] = None
    metadata: Optional[Mapping[str, Any]] = None


@dataclass
class Outcome:
    allowed: bool
    pending: bool = False
    reason: Optional[str] = None


# ── reading a call ────────────────────────────────────────────────────────


def parse_arguments(raw: Any) -> Any:
    """A tool call's arguments as a value: JSON text parsed, a mapping copied."""
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    if isinstance(raw, Mapping):
        return dict(raw)
    return raw


def field_of(obj: Any, name: str) -> Any:
    """``obj.name`` or ``obj["name"]``: SDK models and raw JSON both arrive."""
    if isinstance(obj, Mapping):
        return obj.get(name)
    return getattr(obj, name, None)


def fingerprint(value: Any) -> str:
    """A short, stable fingerprint of an input, for a call that carries no id."""
    try:
        text = json.dumps(value, sort_keys=True, default=str)
    except (TypeError, ValueError):
        text = repr(value)
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "x")


def structured_input(value: Any) -> Optional[Dict[str, Any]]:
    """The input as the approval page shows it, field by field — or ``None``."""
    if not isinstance(value, Mapping):
        return None
    try:
        return dict(value) if len(json.dumps(value, default=str)) <= INPUT_MAX else None
    except (TypeError, ValueError):
        return None


def default_description(tool_name: str, input: Any, server: Optional[str] = None) -> CallDescription:
    """A plain account of a call, for when the caller did not write one."""
    try:
        rendered = input if isinstance(input, str) else json.dumps(input, indent=2, default=str)
    except (TypeError, ValueError):
        rendered = str(input)
    if rendered and len(rendered) > INPUT_PREVIEW_MAX:
        rendered = rendered[: INPUT_PREVIEW_MAX - 1] + "…"
    where = " on {}".format(server) if server else ""
    return CallDescription(
        title="Allow the agent to run {}{}".format(tool_name, where),
        description="With this input:\n\n{}".format(rendered) if rendered else None,
        risk="medium",
    )


def _described(value: Union[CallDescription, Mapping[str, Any]]) -> CallDescription:
    if isinstance(value, CallDescription):
        return value
    if isinstance(value, Mapping) and value.get("title"):
        return CallDescription(
            title=str(value["title"]),
            description=value.get("description"),
            risk=value.get("risk"),
            factors=value.get("factors"),
        )
    raise TypeError("describe() must return a CallDescription or a dict with a title.")


# ── what an answer becomes ────────────────────────────────────────────────


def _sentence(text: str) -> str:
    text = text.strip()
    return text if text.endswith((".", "!", "?")) else text + "."


def refusal_reason(
    tool_name: str,
    status: str,
    note: Optional[str] = None,
    decided_by: Optional[str] = None,
) -> str:
    """Why a call was not run, as a sentence the model can read and act on."""
    who = " by {}".format(decided_by) if decided_by else ""
    if status == "rejected":
        why = " Their reason: {}".format(_sentence(note)) if note else ""
        return (
            "A person declined running {}{}.{} Do not retry it; change course or "
            "ask how to proceed.".format(tool_name, who, why)
        )
    if status == "changes_requested":
        why = " Their note: {}".format(_sentence(note)) if note else ""
        return (
            "A person sent {} back{} rather than approve it.{} Do not run it as "
            "proposed; change it or ask how to proceed.".format(tool_name, who, why)
        )
    if status == "denied":
        why = " Why: {}".format(_sentence(note)) if note else ""
        return (
            "The organisation's policy does not allow running {}.{} Do not retry it; "
            "change course or ask how to proceed.".format(tool_name, why)
        )
    if status == "expired":
        return (
            "Nobody decided whether to run {} before the request expired, so it "
            "was not run.".format(tool_name)
        )
    return "The request to run {} was withdrawn, so it was not run.".format(tool_name)


def changed_reason(tool_name: str, changes: Sequence[Mapping[str, Any]]) -> str:
    """A call approved only with corrections: the proposal must not run."""
    parts = []
    for change in changes:
        parts.append(
            "{} from {} to {}".format(
                change.get("field"),
                json.dumps(change.get("from"), default=str),
                json.dumps(change.get("to"), default=str),
            )
        )
    return (
        "A person approved {} only with changes: {}. It was not run as proposed. "
        "If it is still needed, call it again with those values.".format(
            tool_name, "; ".join(parts)
        )
    )


def _from_decision(call: Call, decision: Any) -> Outcome:
    if decision.approved:
        if decision.changes:
            return Outcome(False, reason=changed_reason(call.tool, decision.changes))
        return Outcome(True)
    return Outcome(
        False, reason=refusal_reason(call.tool, decision.status, decision.note, decision.decided_by)
    )


def _from_gate(call: Call, decision: Any) -> Outcome:
    if decision.allowed:
        if decision.changes:
            return Outcome(False, reason=changed_reason(call.tool, decision.changes))
        return Outcome(True)
    if decision.status == "pending":
        return Outcome(False, pending=True)
    return Outcome(False, reason=refusal_reason(call.tool, decision.status, decision.reason))


# ── asking ────────────────────────────────────────────────────────────────


def gate_input(value: Any) -> Dict[str, Any]:
    """A gate validates an object against its action's schema."""
    return dict(value) if isinstance(value, Mapping) else {"input": value}


def _approve_args(call: Call, options: Options) -> Dict[str, Any]:
    if options.describe is not None:
        described = _described(options.describe(call.tool, call.input))
    else:
        described = default_description(call.tool, call.input, call.server)
    metadata: Dict[str, Any] = dict(options.metadata or {})
    metadata["tool"] = call.tool
    if call.server:
        metadata["mcp_server"] = call.server
    args: Dict[str, Any] = {
        "title": described.title,
        "description": described.description,
        "risk": described.risk,
        "factors": described.factors,
        "approvers": options.approvers,
        # The idempotency: a retried round, or a restarted process, finds the
        # request this call already made instead of asking a second time.
        "external_id": call.external_id,
        "flow_id": options.flow_id,
        "metadata": metadata,
        "expires_in": options.expires_in if options.expires_in is not None else DEFAULT_TOOL_EXPIRY,
        "timeout": options.timeout,
    }
    structured = structured_input(call.input)
    if structured is not None:
        # Shown field by field. No ``editable_fields``: neither framework can
        # run a corrected call, so a person is not offered the chance to make one.
        args["input"] = structured
    return args


def _gate_args(call: Call, action: str, options: Options) -> Dict[str, Any]:
    return {
        "action": action,
        "input": gate_input(call.input),
        "external_id": call.external_id,
        "flow_id": options.flow_id,
        "timeout": options.timeout,
    }


def _action_for(call: Call, options: Options) -> Optional[str]:
    return (options.actions or {}).get(call.tool)


def blocking(deliverd: Any) -> Any:
    """The client to call from synchronous code: ``Deliverd`` itself, or what
    an ``AsyncDeliverd`` wraps."""
    if inspect.iscoroutinefunction(getattr(deliverd, "approve", None)):
        sync = getattr(deliverd, "sync", None)
        if sync is None:
            raise TypeError(
                "This is the blocking variant and the client given is async. "
                "Pass a Deliverd, or use the async variant."
            )
        return sync
    return deliverd


async def call_async(fn: Callable[..., Any], **kwargs: Any) -> Any:
    """Await an async client's method, or run a blocking one on a worker thread.

    The same trade ``deliverd.aio`` makes, for the same reason: this package has
    no async transport, and a blocking ``approve()`` on the event loop would
    stall every other task for as long as a person takes to decide.
    """
    if inspect.iscoroutinefunction(fn):
        return await fn(**kwargs)
    result = await asyncio.to_thread(partial(fn, **kwargs))
    if inspect.isawaitable(result):
        return await result
    return result


def selected(call: Call, options: Options) -> bool:
    if options.when is None:
        return True
    answer = options.when(call.tool, call.input)
    if inspect.isawaitable(answer):
        if hasattr(answer, "close"):
            answer.close()  # type: ignore[union-attr]
        raise TypeError("when() returned an awaitable; use the async variant, or make it a plain function.")
    return bool(answer)


async def selected_async(call: Call, options: Options) -> bool:
    if options.when is None:
        return True
    answer = options.when(call.tool, call.input)
    if inspect.isawaitable(answer):
        answer = await answer
    return bool(answer)


def decide(call: Call, deliverd: Any, options: Options) -> Outcome:
    """Ask about one call and wait: the blocking half."""
    client = blocking(deliverd)
    action = _action_for(call, options)
    try:
        if action is not None:
            return _from_gate(call, client.gate(**_gate_args(call, action, options)))
        if not selected(call, options):
            return Outcome(True)
        return _from_decision(call, client.approve(**_approve_args(call, options)))
    except DeliverdTimeoutError:
        return Outcome(False, pending=True)


async def decide_async(call: Call, deliverd: Any, options: Options) -> Outcome:
    """Ask about one call and wait, without blocking the event loop."""
    action = _action_for(call, options)
    try:
        if action is not None:
            return _from_gate(call, await call_async(deliverd.gate, **_gate_args(call, action, options)))
        if not await selected_async(call, options):
            return Outcome(True)
        return _from_decision(call, await call_async(deliverd.approve, **_approve_args(call, options)))
    except DeliverdTimeoutError:
        return Outcome(False, pending=True)


async def allowed_by_policy(call: Call, deliverd: Any, action: str, flow_id: Optional[str]) -> bool:
    """Whether a rule already allows this call, asked without waiting on anyone.

    Fails closed: a gate that cannot be asked — an unknown action, input its
    schema refuses, an unreachable API — is not permission, so the call goes to
    a person, where resolving it raises the same error loudly.
    """
    try:
        decision = await call_async(
            deliverd.gate,
            action=action,
            input=gate_input(call.input),
            external_id=call.external_id,
            flow_id=flow_id,
            wait=False,
        )
    except DeliverdError:
        return False
    return bool(decision.allowed) and not decision.changes


def max_rounds_error(max_rounds: int) -> RuntimeError:
    return RuntimeError(
        "The run was still waiting for approval after {} rounds; stopping rather "
        "than asking forever.".format(max_rounds)
    )
