"""Generate `deliverd/aio.py` from the synchronous client.

Sixty-odd methods mirrored by hand is sixty-odd chances to mistype a default,
so they are generated from `inspect` and the result is committed. The parity
guard in the Deliverd repository then holds the committed file to this script's
output, which is what stops the two drifting after somebody edits one.

Run: `PYTHONPATH=src python3 scripts/gen_async.py > src/deliverd/aio.py`
"""

from __future__ import annotations

import inspect
import re
from typing import Any, Dict, List

from deliverd import Deliverd
from deliverd.approvals import Approval, Approvals, DecisionSessions
from deliverd.collections import Collection, Collections
from deliverd.comments import Comments
from deliverd.flows import Flow, Flows
from deliverd.gates import Gate, Gates
from deliverd.governance import AiGovernance, AiSystems, Incidents
from deliverd.reports import Reports
from deliverd.reviews import Review, Reviews
from deliverd.schedules import Schedules
from deliverd.tasks import Task, Tasks
from deliverd.webhook_endpoints import WebhookEndpoints

NAMESPACES = [
    ("approvals", Approvals),
    ("decision_sessions", DecisionSessions),
    ("gates", Gates),
    ("reviews", Reviews),
    ("collections", Collections),
    ("reports", Reports),
    ("comments", Comments),
    ("schedules", Schedules),
    ("flows", Flows),
    ("tasks", Tasks),
    ("webhook_endpoints", WebhookEndpoints),
    ("governance", AiGovernance),
]
#: Namespaces inside a namespace: `deliverd.governance.ai_systems`.
SUB_NAMESPACES = {AiGovernance: [("ai_systems", AiSystems), ("incidents", Incidents)]}
HANDLES = [Approval, Gate, Review, Collection, Flow, Task]
HANDLE_NAMES = {h.__name__ for h in HANDLES}
VERBS = ["approve", "gate", "confirm", "review", "collect", "publish"]


#: The only methods that make no request. Everything else is awaited.
#:
#: Named explicitly rather than sniffed, because the first version of this
#: script looked for `self._http` in a method's own source and therefore
#: decided `wait()` was pure — it is a poll loop that calls `refresh()`, which
#: is what touches the transport. `wait()` is the *most* important method to
#: await: it is the one that blocks for minutes. Guessing here fails towards
#: blocking the event loop, so the default is async and the exceptions are
#: written down.
PURE = {"to_decision", "to_outcome", "to_collected"}


def does_io(func: Any) -> bool:
    if func.__name__ not in PURE:
        return True
    # A named pure method that starts making requests must not stay pure by
    # having been named once.
    src = inspect.getsource(func)
    assert "self._http" not in src and "self._client" not in src, (
        "%s is in PURE and touches the transport" % func.__name__
    )
    assert "self.refresh" not in src and "self.wait" not in src, (
        "%s is in PURE and calls something that does" % func.__name__
    )
    return False


def public_methods(cls: type) -> List[str]:
    return sorted(
        name
        for name, member in vars(cls).items()
        if not name.startswith("_") and callable(member) and not isinstance(member, property)
    )


def public_props(cls: type) -> List[str]:
    return sorted(
        name for name, member in vars(cls).items()
        if not name.startswith("_") and isinstance(member, property)
    )


def render_params(func: Any) -> tuple[str, str]:
    """(declaration, call-through) for everything after `self`."""
    sig = inspect.signature(func)
    decl: List[str] = []
    call: List[str] = []
    for p in list(sig.parameters.values())[1:]:
        ann = "" if p.annotation is inspect.Parameter.empty else ": %s" % p.annotation
        if p.kind is inspect.Parameter.VAR_KEYWORD:
            decl.append("**%s%s" % (p.name, ann))
            call.append("**%s" % p.name)
        elif p.kind is inspect.Parameter.VAR_POSITIONAL:
            decl.append("*%s%s" % (p.name, ann))
            call.append("*%s" % p.name)
        else:
            default = "" if p.default is inspect.Parameter.empty else " = %r" % (p.default,)
            decl.append("%s%s%s" % (p.name, ann, default))
            call.append("%s=%s" % (p.name, p.name))
    return ", ".join(decl), ", ".join(call)


def return_annotation(func: Any) -> str:
    sig = inspect.signature(func)
    if sig.return_annotation is inspect.Signature.empty:
        return "Any"
    return str(sig.return_annotation).strip("'\"")


def wrap_return(ret: str) -> str:
    """A handle handed back from an async call must be an async handle.

    Otherwise `(await client.approvals.create(...)).wait()` blocks the event
    loop — the one trap this whole module exists to remove.
    """
    bare = ret.replace("Optional[", "").replace("]", "").replace("List[", "").strip()
    return bare if bare in HANDLE_NAMES else ""


def emit_method(owner: str, name: str, func: Any) -> List[str]:
    decl, call = render_params(func)
    ret = return_annotation(func)
    handle = wrap_return(ret)
    # Whole names only. A plain substring replace turned `GateDecision` into
    # `AsyncGateDecision`, a class that does not exist, and with `Task` among
    # the handles it would have reached `TaskContext` and `AppliedSideTask`.
    async_ret = re.sub(
        r"\b(%s)\b" % "|".join(sorted(HANDLE_NAMES)), lambda m: "Async" + m.group(1), ret
    )
    doc = inspect.getdoc(func) or ""
    first = doc.split("\n")[0] if doc else ""

    out = ["    async def %s(self%s) -> %s:" % (name, (", " + decl) if decl else "", async_ret)]
    if first:
        out.append('        """%s"""' % first.replace('"""', "'''"))
    # `to_thread` runs a callable with no arguments, so the call is bound first.
    args = (", " + call) if call else ""
    inner = "await asyncio.to_thread(partial(self._sync.%s%s))" % (name, args)
    if handle:
        if ret.startswith("Optional["):
            out.append("        found = %s" % inner)
            out.append("        return Async%s(found) if found is not None else None" % handle)
        elif ret.startswith("List["):
            out.append("        return [Async%s(x) for x in %s]" % (handle, inner))
        else:
            out.append("        return Async%s(%s)" % (handle, inner))
    else:
        out.append("        return %s" % inner)
    return out


HEADER = '''"""`async`/`await` for the same client, with the same names.

**Every call here runs the synchronous one on a worker thread.** There is no
native async transport and there deliberately is not going to be one: this
package has no dependencies — that is checked, and it is most of why anyone
trusts it — and the standard library has no async HTTP client. Writing HTTP/1.1
and TLS over `asyncio` streams by hand would be several hundred lines of
protocol in a package whose whole pitch is that there is nothing to audit.

So what this buys you is *ergonomics and concurrency*, not fewer threads. Ten
approvals awaited together really do wait together. What it costs is one thread
per call in flight, parked on a poll — fine for the tens of concurrent asks an
agent makes, wrong for thousands. If you are running thousands, call the REST
API directly.

Generated by `scripts/gen_async.py` from the synchronous classes, so a method
cannot appear on one and not the other. Do not edit by hand; a guard in the
Deliverd repository holds this file to that script's output.
"""

from __future__ import annotations

import asyncio
from functools import partial
from typing import Any, Dict, List, Mapping, Optional, Sequence

from . import Deliverd
from .approvals import Approval, Approvals, DecisionSessions
from .collections import Collection, Collections
from .comments import Comments
from .duration import Duration
from .flows import Flow, Flows
from .gates import Gate, Gates
from .governance import AiGovernance, AiSystems, Incidents
from .reports import Reports
from .reviews import Review, Reviews
from .schedules import Schedules
from .tasks import Task, Tasks
from .types import *  # noqa: F401,F403 - the response types, same names as the sync client
from .webhook_endpoints import WebhookEndpoints
from .webhooks import Webhooks

__all__ = ["AsyncDeliverd"]
'''


def render() -> str:
    lines: List[str] = [HEADER]

    for handle in HANDLES:
        name = handle.__name__
        lines.append("\n\nclass Async%s:" % name)
        lines.append('    """%s, awaited."""' % name)
        lines.append("")
        lines.append("    def __init__(self, sync: %s) -> None:" % name)
        lines.append("        self._sync = sync")
        lines.append("")
        lines.append("    @property")
        lines.append("    def sync(self) -> %s:" % name)
        lines.append('        """The blocking handle underneath, for anything not mirrored here."""')
        lines.append("        return self._sync")
        for prop in public_props(handle):
            lines.append("")
            lines.append("    @property")
            lines.append("    def %s(self) -> Any:" % prop)
            lines.append("        return self._sync.%s" % prop)
        for m in public_methods(handle):
            func = getattr(handle, m)
            lines.append("")
            if does_io(func):
                lines.extend(emit_method(name, m, func))
            else:
                decl, call = render_params(func)
                ret = return_annotation(func)
                lines.append("    def %s(self%s) -> %s:" % (m, (", " + decl) if decl else "", ret))
                lines.append('        """Pure: no request, so no await."""')
                lines.append("        return self._sync.%s(%s)" % (m, call))

    subs = [(parent, attr, cls) for parent, children in SUB_NAMESPACES.items() for attr, cls in children]
    parent_attr = {cls: attr for attr, cls in NAMESPACES}
    for parent, attr, cls in subs + [(None, attr, cls) for attr, cls in NAMESPACES]:
        name = cls.__name__
        where = "%s.%s" % (parent_attr[parent], attr) if parent else attr
        lines.append("\n\nclass Async%s:" % name)
        lines.append('    """`deliverd.%s`, awaited."""' % where)
        lines.append("")
        lines.append("    def __init__(self, sync: %s) -> None:" % name)
        lines.append("        self._sync = sync")
        for sub_attr, sub_cls in SUB_NAMESPACES.get(cls, []):
            lines.append("        self.%s = Async%s(sync.%s)" % (sub_attr, sub_cls.__name__, sub_attr))
        for m in public_methods(cls):
            lines.append("")
            lines.extend(emit_method(name, m, getattr(cls, m)))

    lines.append("\n\nclass AsyncDeliverd:")
    lines.append('    """The client, awaited. Takes exactly what `Deliverd` takes."""')
    lines.append("")
    lines.append("    def __init__(self, **kwargs: Any) -> None:")
    lines.append("        self._sync = Deliverd(**kwargs)")
    for attr, cls in NAMESPACES:
        lines.append("        self.%s = Async%s(self._sync.%s)" % (attr, cls.__name__, attr))
    lines.append("        # Pure functions: verification does no I/O, so it is not awaited.")
    lines.append("        self.webhooks: Webhooks = self._sync.webhooks")
    lines.append("        self.development: bool = self._sync.development")
    lines.append("")
    lines.append("    @property")
    lines.append("    def sync(self) -> Deliverd:")
    lines.append('        """The blocking client underneath."""')
    lines.append("        return self._sync")
    for verb in VERBS:
        lines.append("")
        lines.extend(emit_method("Deliverd", verb, getattr(Deliverd, verb)))

    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print(render(), end="")
