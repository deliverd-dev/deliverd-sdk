"""Where ``decidedById`` becomes ``decided_by_id`` and back again.

The API speaks camelCase because it was written for JavaScript. Python does
not, and an SDK that made people write ``externalId`` in Python would be
handing them the wire format and calling it an interface.

**The conversion is field-driven, never blanket.** A recursive walk that
camelised every key it found would be shorter and would corrupt three things
this API carries on purpose:

- ``metadata`` — whatever the caller put there, returned unchanged. A caller
  who stored ``{"order_id": 4821}`` must get ``order_id`` back.
- a collection's ``answers`` — keyed by the *question* as it was asked, so
  ``{"Headcount at 30 September": 42}`` is a key written by a person.
- the free-form tail of a report object, which the API documents as open.

So each model declares its fields, converts exactly those, and leaves
everything else alone. That also makes the models checkable: the parity guard
camelises the declared field names and holds them to the TypeScript interface,
which is only possible because the list is declared rather than inferred at run
time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, fields, is_dataclass
from typing import Any, ClassVar, Dict, List, Mapping, Optional, Type, TypeVar

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def to_camel(name: str) -> str:
    """``decided_by_id`` → ``decidedById``."""
    head, *rest = name.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)


def to_snake(name: str) -> str:
    """``decidedById`` → ``decided_by_id``."""
    return _CAMEL_BOUNDARY.sub("_", name).lower()


T = TypeVar("T", bound="Model")


@dataclass
class Model:
    """A thing the API returned, with its own fields named the Python way.

    ``raw`` keeps the payload exactly as it arrived. Two reasons: a field the
    API adds tomorrow is reachable today without an upgrade, and anything this
    class converted can be checked against what it was converted from.
    """

    raw: Dict[str, Any]

    # ClassVar, not a field: an annotated class attribute inside a dataclass
    # becomes a field, and a field whose default is a dict is a TypeError at
    # class-definition time. These are configuration, not data.
    #
    #: Field name → the model to build for it. Values absent here stay as they
    #: arrived, which is what makes ``metadata`` and friends safe.
    _NESTED: ClassVar[Dict[str, Any]] = {}
    #: Fields whose value is a list of the nested model rather than one of it.
    _NESTED_LISTS: ClassVar[Dict[str, Any]] = {}

    @classmethod
    def field_names(cls) -> List[str]:
        """Every declared field except ``raw``, in declaration order."""
        return [f.name for f in fields(cls) if f.name != "raw"]

    @classmethod
    def from_wire(cls: Type[T], payload: Mapping[str, Any]) -> T:
        values: Dict[str, Any] = {"raw": dict(payload)}
        for name in cls.field_names():
            value = payload.get(to_camel(name))
            nested = cls._NESTED.get(name)
            nested_list = cls._NESTED_LISTS.get(name)
            if nested_list is not None and isinstance(value, list):
                value = [build(nested_list, item) for item in value]
            elif nested is not None and isinstance(value, Mapping):
                value = build(nested, value)
            values[name] = value
        return cls(**values)  # type: ignore[arg-type]

    def to_wire(self) -> Dict[str, Any]:
        """Back to the shape the API sends, for round-tripping and tests."""
        out: Dict[str, Any] = {}
        for name in self.field_names():
            value = getattr(self, name)
            if isinstance(value, Model):
                value = value.to_wire()
            elif isinstance(value, list):
                value = [v.to_wire() if isinstance(v, Model) else v for v in value]
            out[to_camel(name)] = value
        return out


def build(cls: Any, payload: Mapping[str, Any]) -> Any:
    """One of ``cls`` from a wire payload, whichever kind of class it is.

    Response-only shapes are :class:`Model` subclasses and keep the payload they
    came from. The handful that travel in *both* directions — a factor, a link —
    are plain dataclasses, because a caller builds those to send and should not
    have to invent the ``raw`` a Model carries. Both arrive here.
    """
    if isinstance(cls, type) and issubclass(cls, Model):
        return cls.from_wire(payload)
    names = {f.name for f in fields(cls)}
    return cls(**{name: payload.get(to_camel(name)) for name in names if to_camel(name) in payload})


def body_from(values: Mapping[str, Any], *, passthrough: "tuple[str, ...]" = ()) -> Dict[str, Any]:
    """A request body from snake_case keyword arguments.

    ``None`` is dropped rather than sent: the API distinguishes "not given" from
    "given as null" on several fields, and a client that sent every unset
    argument as null would be making a statement the caller never made.

    ``passthrough`` names the arguments whose *contents* are the caller's own —
    ``metadata`` above all — so their keys are left exactly as written.
    """
    out: Dict[str, Any] = {}
    for key, value in values.items():
        if value is None:
            continue
        if key in passthrough:
            out[to_camel(key)] = value
            continue
        out[to_camel(key)] = _convert(value)
    return out


def _convert(value: Any) -> Any:
    """Convert a value bound for the wire, one level of structure at a time."""
    if isinstance(value, Model):
        return value.to_wire()
    if is_dataclass(value) and not isinstance(value, type):
        return {
            to_camel(f.name): _convert(getattr(value, f.name))
            for f in fields(value)
            if getattr(value, f.name) is not None
        }
    if isinstance(value, Mapping):
        # A dict the caller built by hand for a declared field — `factors`,
        # `links`, `questions`. Its keys are ours, so they convert; its values
        # may not be, so they recurse through the same rules.
        return {to_camel(str(k)): _convert(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_convert(v) for v in value]
    return value


def optional_str(value: Any) -> Optional[str]:
    """A string or None, for the fields the API documents as nullable."""
    return None if value is None else str(value)
