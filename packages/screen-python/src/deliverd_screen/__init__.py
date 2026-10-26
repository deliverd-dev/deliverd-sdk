"""Deliverd Screen: a pre-send check for every prompt.

    from deliverd_screen import screen

    checked = screen(prompt)
    if not checked.allowed:
        raise RuntimeError(" ".join(checked.reasons))
    answer = model.generate(checked.text)
    return checked.restore(answer)

Everything runs here. Nothing is sent anywhere: no account, no key, no network
call. The detectors are the same rules Deliverd's servers and SDKs run, held to
the shared vectors in ``packages/conformance``.

Patterns find structured identifiers well and people's names hardly at all.
Plug in a model for names with ``detectors``; :mod:`deliverd_screen.adapters`
turns a Hugging Face pipeline or a Presidio analyzer into one.

A net, not a guarantee. Never tell anyone a text is clean because this allowed
it; pseudonymised text is still personal data in law.

When a person has to decide (``ask``), nobody here can: Deliverd's Data Gate
takes the policy from your AI register, asks the right person and keeps the
record. ``deliverd.screen()`` in the ``deliverd`` package takes the same
``detectors``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional, Sequence

from .data_screen import (
    DATA_KIND_KEYS,
    DATA_KINDS,
    DEFAULT_SCREEN_POLICY,
    SCREEN_CLASSIFICATIONS,
    DetectedSpan,
    Redaction,
    ScreenFinding,
    ScreenTarget,
    ScreenTerm,
    assess_counts,
    describe_counts,
    redact,
    redact_for,
    restore,
    screen_text,
    summarise,
    term_classification_of,
)

__version__ = "0.1.2"

#: A detector: a callable from the text to spans (``DetectedSpan`` or dicts of kind, start, end).
SpanDetector = Callable[[str], Sequence[object]]

_ASK_REASON = (
    "A person has to decide whether this may be sent, and nobody can be asked from here. "
    "Deliverd's Data Gate routes the question to one: https://deliverd.dev/docs/developers/screen"
)


@dataclass
class Screened:
    """What may be sent, and why."""

    verdict: str
    #: Whether to send ``text``. False for a deny, and for an ask: nobody here can say yes.
    allowed: bool
    #: The original, the redacted text, or None when nothing may be sent.
    text: Optional[str]
    #: The redacted text, also for an ask, to show whoever decides. None for a deny.
    redacted: Optional[str]
    findings: List[ScreenFinding]
    #: How many of each kind: all Deliverd's Data Gate is ever sent.
    counts: Dict[str, int]
    reasons: List[str]
    #: Placeholder to original value. Yours alone; never sent anywhere.
    replacements: Dict[str, str] = field(default_factory=dict)

    def restore(self, answer: str) -> str:
        """Put the original values back into text a model wrote using the placeholders."""
        return restore(answer, self.replacements)

    def __bool__(self) -> bool:
        return self.allowed


def detect(
    text: str,
    terms: Sequence[object] = (),
    detectors: Sequence[SpanDetector] = (),
    spans: Sequence[object] = (),
) -> "tuple[List[ScreenFinding], Dict[str, int]]":
    """Find what is in a text: the findings and their counts, no verdict."""
    found = list(spans)
    for d in detectors:
        found.extend(d(text))
    findings = screen_text(text, terms, found)
    return findings, summarise(findings)


def screen(
    text: str,
    *,
    model: str = "the model",
    classification: str = "internal",
    personal_data: bool = False,
    policy: Optional[Mapping[str, object]] = None,
    terms: Sequence[object] = (),
    detectors: Sequence[SpanDetector] = (),
    spans: Sequence[object] = (),
) -> Screened:
    """Check text before it goes to a model, and decide what may be sent.

    ``classification`` and ``personal_data`` say what the model may receive.
    ``allow`` sends it as it is; ``redact`` replaces what it may not receive
    with placeholders, and :meth:`Screened.restore` puts them back in the
    answer; ``ask`` needs a person; ``deny`` sends nothing.
    """
    findings, counts = detect(text, terms, detectors, spans)
    p = dict(policy or {})
    p.pop("unregistered", None)
    a = assess_counts(
        counts,
        ScreenTarget(name=model, approved_classification=classification, personal_data=personal_data),
        p,
        term_classification_of(findings),
    )
    redaction = redact_for(text, findings, a.verdict, a.offending)
    if a.verdict == "allow":
        sent: Optional[str] = text
    elif a.verdict == "redact":
        sent = redaction.text if redaction else None
    else:
        sent = None
    return Screened(
        verdict=a.verdict,
        allowed=sent is not None,
        text=sent,
        redacted=text if a.verdict == "allow" else (redaction.text if redaction else None),
        findings=findings,
        counts=counts,
        reasons=a.reasons + [_ASK_REASON] if a.verdict == "ask" else a.reasons,
        replacements=dict(redaction.replacements) if redaction and a.verdict == "redact" else {},
    )


__all__ = [
    "screen",
    "detect",
    "Screened",
    "SpanDetector",
    "DetectedSpan",
    "ScreenFinding",
    "ScreenTerm",
    "Redaction",
    "screen_text",
    "summarise",
    "redact",
    "restore",
    "describe_counts",
    "DATA_KINDS",
    "DATA_KIND_KEYS",
    "SCREEN_CLASSIFICATIONS",
    "DEFAULT_SCREEN_POLICY",
]
