"""Check text before it goes to an AI model.

::

    screened = deliverd.screen(prompt, ai_system_id=CLAIMS_MODEL)
    if not screened.allowed:
        return screened.reasons
    answer = model.generate(screened.text)
    return screened.restore(answer)

**The text does not leave your machine.** The detectors run here — the same
rules the server runs — and Deliverd is sent only what was found, by kind. It
answers from what the organisation's AI register approves that model to
receive:

- ``allow``: send it as it is.
- ``redact``: ``screened.text`` has the findings replaced by placeholders such
  as ``[EMAIL_1]``; send that, and :meth:`Screened.restore` puts the values back
  in the model's answer.
- ``ask``: a person decides, through an ordinary approval, and this waits.
  Approved, ``screened.text`` is the original.
- ``deny``: nothing may be sent; ``screened.text`` is ``None``.

**A net, not a guarantee.** Names in particular are not reliably found.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from .data_screen import redact_for, restore, screen_text, summarise, term_classification_of
from .types import ScreenData


class Screened:
    """The answer to :meth:`deliverd.Deliverd.screen`."""

    def __init__(
        self,
        data: ScreenData,
        text: Optional[str],
        allowed: bool,
        replacements: Mapping[str, str],
        approval: Any = None,
    ) -> None:
        #: What the server answered.
        self.data = data
        #: What may be sent: the original, the redacted text, or ``None`` when nothing may be.
        self.text = text
        #: Whether to send :attr:`text`. False for a deny, and for an ask a person did not approve.
        self.allowed = allowed
        #: The approval a person decided, for an ``ask``.
        self.approval = approval
        self._replacements: Dict[str, str] = dict(replacements)

    @property
    def verdict(self) -> str:
        return self.data.verdict

    @property
    def reasons(self) -> List[str]:
        """One sentence each: why, for logging or for telling the person."""
        return self.data.reasons

    def restore(self, answer: str) -> str:
        """Put the original values back into text a model wrote using the placeholders."""
        return restore(answer, self._replacements)

    def __bool__(self) -> bool:
        """``if screened:`` means ``if screened.allowed:`` — never merely that it exists."""
        return self.allowed

    def __repr__(self) -> str:
        return "Screened(verdict={!r}, allowed={!r})".format(self.verdict, self.allowed)


def request_body(
    text: str,
    terms: Any,
    ai_system_id: Optional[str],
    purpose: Optional[str],
    external_id: Optional[str],
) -> "tuple[Dict[str, Any], list]":
    """What is sent: counts by kind, never the text. Returns the body and the findings."""
    findings = screen_text(text, terms or ())
    body: Dict[str, Any] = {
        "counts": summarise(findings),
        "termClassification": term_classification_of(findings),
    }
    if ai_system_id:
        body["aiSystemId"] = ai_system_id
    if purpose:
        body["purpose"] = purpose
    if external_id:
        body["externalId"] = external_id
    return body, findings


def settle(data: ScreenData, text: str, findings: list) -> Optional[Screened]:
    """The answer for every verdict but an ``ask``, which needs a wait; ``None`` for that."""
    if data.verdict == "allow":
        return Screened(data, text, True, {})
    if data.verdict == "deny":
        return Screened(data, None, False, {})
    if data.verdict == "redact":
        redacted = redact_for(text, findings, data.verdict, data.offending)
        return Screened(data, redacted.text if redacted else None, True, redacted.replacements if redacted else {})
    return None
