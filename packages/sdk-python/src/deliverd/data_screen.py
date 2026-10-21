"""Screening what an agent is about to send to an AI model.

The Python half of ``packages/core/src/data-screen.ts``, rule for rule. Before
a prompt, a document or a retrieved record goes to a model, this finds the
personal data, secrets and confidential terms in it, and decides — against what
the organisation's AI register approves that model to receive — whether it may
go as it is, go with the findings replaced by placeholders, go only once a
person agrees, or not go.

**The text need not leave the caller.** Everything here is pure, so
:meth:`deliverd.Deliverd.screen` runs it where the agent runs and sends
Deliverd only counts. ``packages/conformance/screening.json`` holds this file
and the TypeScript one to the same findings, redactions and verdicts.

**A net, not a guarantee.** Structured identifiers are found well and names
hardly at all; pseudonymised text is still personal data in law. Never tell
anyone a text is clean because this allowed it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence

#: Ordered: the stricter of two classifications is the later one.
SCREEN_CLASSIFICATIONS = ("public", "internal", "confidential", "restricted")
SCREEN_CATEGORIES = ("personal", "financial", "special", "secret", "confidential")
#: ``allow`` | ``redact`` | ``ask`` | ``deny``
SCREEN_VERDICTS = ("allow", "redact", "ask", "deny")

#: kind → (label, category, placeholder word, whether redacting it removes the concern)
DATA_KINDS: Dict[str, Dict[str, object]] = {
    "email": {"label": "Email address", "category": "personal", "placeholder": "EMAIL", "redactable": True},
    "phone": {"label": "Phone number", "category": "personal", "placeholder": "PHONE", "redactable": True},
    "iban": {"label": "IBAN", "category": "financial", "placeholder": "IBAN", "redactable": True},
    "payment_card": {"label": "Payment card number", "category": "financial", "placeholder": "CARD", "redactable": True},
    "uk_national_insurance": {"label": "UK National Insurance number", "category": "personal", "placeholder": "NINO", "redactable": True},
    "ie_pps": {"label": "Irish PPS number", "category": "personal", "placeholder": "PPS", "redactable": True},
    "us_ssn": {"label": "US Social Security number", "category": "personal", "placeholder": "SSN", "redactable": True},
    "ip_address": {"label": "IP address", "category": "personal", "placeholder": "IP", "redactable": True},
    "date_of_birth": {"label": "Date of birth", "category": "personal", "placeholder": "DOB", "redactable": True},
    "special_category": {"label": "Special-category data", "category": "special", "placeholder": "SPECIAL", "redactable": False},
    "secret": {"label": "Secret or credential", "category": "secret", "placeholder": "SECRET", "redactable": True},
    "term": {"label": "Confidential term", "category": "confidential", "placeholder": "TERM", "redactable": True},
}
DATA_KIND_KEYS = tuple(DATA_KINDS)

_CATEGORY_CLASSIFICATION = {
    "personal": "confidential",
    "financial": "confidential",
    "confidential": "confidential",
    "special": "restricted",
    "secret": "restricted",
}
_PERSONAL_CATEGORIES = {"personal", "financial", "special"}

#: Terms past this are ignored, so a pasted list cannot make every screen slow.
MAX_SCREEN_TERMS = 500


@dataclass
class ScreenTerm:
    """A word or phrase not to send: a client, a code name. Whole-word, any case."""

    term: str
    #: Shown to people and used in the placeholder: ``[CLIENT_1]``.
    label: Optional[str] = None
    #: ``confidential`` (default) or ``restricted``.
    classification: Optional[str] = None


@dataclass
class ScreenFinding:
    """Where one finding is in the screened text. The value is never copied."""

    kind: str
    category: str
    classification: str
    start: int
    end: int
    label: str
    redactable: bool


# ── Detectors ──────────────────────────────────────────────────────────────


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def _luhn(digits: str) -> bool:
    total = 0
    double = False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


def _iban_valid(raw: str) -> bool:
    iban = re.sub(r"\s", "", raw).upper()
    if len(iban) < 15 or len(iban) > 34:
        return False
    moved = iban[4:] + iban[:4]
    remainder = 0
    for ch in moved:
        value = str(ord(ch) - 55) if "A" <= ch <= "Z" else ch
        for digit in value:
            remainder = (remainder * 10 + (ord(digit) - 48)) % 97
    return remainder == 1


def _pps_valid(raw: str) -> bool:
    m = re.fullmatch(r"(\d{7})([A-W])([A-IW]?)", raw.upper())
    if not m:
        return False
    total = sum((ord(m.group(1)[i]) - 48) * (8 - i) for i in range(7))
    if m.group(3):
        total += (0 if m.group(3) == "W" else ord(m.group(3)) - 64) * 9
    r = total % 23
    return m.group(2) == ("W" if r == 0 else chr(64 + r))


def _ipv4_valid(raw: str) -> bool:
    parts = [int(p) for p in raw.split(".")]
    if len(parts) != 4 or any(p > 255 for p in parts):
        return False
    # Loopback and the unspecified address identify nobody.
    return parts[0] != 127 and parts[0] != 0


def _card_valid(m: str) -> bool:
    d = _digits(m)
    return 13 <= len(d) <= 19 and _luhn(d)


def _phone_valid(m: str) -> bool:
    return 9 <= len(_digits(m)) <= 15


_A = re.ASCII
_AI = re.ASCII | re.IGNORECASE

#: The same credential patterns the publish scanner blocks a report for.
_SECRET_PATTERNS = [
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", _A),
    re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----", _A),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", _A),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", _A),
    re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b", _A),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{24,}\b", _A),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b", _A),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b", _A),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", _A),
    re.compile(r"""\b(?:password|passwd|secret_key|api_key|apikey|auth_token)\s*[:=]\s*["'][^"']{8,}["']""", _AI),
    re.compile(r"\b(?:dlv|dlvk)_[A-Za-z0-9]{24,}\b", _A),
]

_SPECIAL_PATTERN = re.compile(
    r"\b(?:diagnos(?:is|ed|es)|medical (?:record|history|condition)s?|mental health|prescri(?:bed|ption)s?|HIV|pregnan(?:t|cy)|disabilit(?:y|ies)|sexual orientation|religious belief|ethnic origin|racial origin|trade union member(?:ship)?|biometric|genetic data|criminal (?:record|conviction|offence)s?)\b",
    _AI,
)

# (kind, pattern, validator, group)
_DETECTORS = [
    *[("secret", p, None, 0) for p in _SECRET_PATTERNS],
    ("iban", re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b", _A), _iban_valid, 0),
    ("payment_card", re.compile(r"\b[2-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b", _A), _card_valid, 0),
    ("us_ssn", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b", _A), None, 0),
    (
        "uk_national_insurance",
        re.compile(r"\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b", _A),
        None,
        0,
    ),
    ("ie_pps", re.compile(r"\b\d{7}[A-W][A-IW]?\b", _A), _pps_valid, 0),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b", _A), None, 0),
    (
        "date_of_birth",
        re.compile(
            r"\b(?:date of birth|d\.?o\.?b\.?|born(?: on)?)\s*[:\-]?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4})",
            _AI,
        ),
        None,
        1,
    ),
    (
        "phone",
        re.compile(r"(?<![\w+])(?:\+\d{1,3}[ .-]?(?:\(0\)[ .-]?)?|\(?0)\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?!\w)", _A),
        _phone_valid,
        0,
    ),
    ("ip_address", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", _A), _ipv4_valid, 0),
    ("special_category", _SPECIAL_PATTERN, None, 0),
]

#: Earlier wins an overlap: a card number is not also a phone number.
_PRIORITY = {
    k: i
    for i, k in enumerate(
        [
            "secret",
            "iban",
            "payment_card",
            "us_ssn",
            "uk_national_insurance",
            "ie_pps",
            "email",
            "date_of_birth",
            "phone",
            "ip_address",
            "term",
            "special_category",
        ]
    )
}


def _term_of(t: object) -> ScreenTerm:
    if isinstance(t, ScreenTerm):
        return t
    if isinstance(t, Mapping):
        return ScreenTerm(term=str(t.get("term", "")), label=t.get("label"), classification=t.get("classification"))
    return ScreenTerm(term=str(t))


def screen_text(text: str, terms: Sequence[object] = ()) -> List[ScreenFinding]:
    """Find what is in a text. Each character belongs to at most one finding.

    ``terms`` are :class:`ScreenTerm`, dicts with the same keys, or strings.
    """
    raw: List[ScreenFinding] = []

    def add(kind: str, start: int, end: int, label: Optional[str] = None, classification: Optional[str] = None) -> None:
        spec = DATA_KINDS[kind]
        raw.append(
            ScreenFinding(
                kind=kind,
                category=str(spec["category"]),
                classification=classification or _CATEGORY_CLASSIFICATION[str(spec["category"])],
                start=start,
                end=end,
                label=label or str(spec["label"]),
                redactable=bool(spec["redactable"]),
            )
        )

    for kind, pattern, valid, group in _DETECTORS:
        for m in pattern.finditer(text):
            value = m.group(group) if group else m.group(0)
            if not value or (valid is not None and not valid(value)):
                continue
            start = m.start() + m.group(0).rfind(value) if group else m.start()
            add(kind, start, start + len(value))

    for t in [_term_of(t) for t in list(terms)[:MAX_SCREEN_TERMS]]:
        term = t.term.strip()
        if len(term) < 2:
            continue
        pattern = re.compile(r"(?<![^\W_])" + re.escape(term) + r"(?![^\W_])", re.IGNORECASE)
        for m in pattern.finditer(text):
            add("term", m.start(), m.end(), (t.label or "").strip() or None, t.classification or "confidential")

    raw.sort(key=lambda f: (_PRIORITY[f.kind], -(f.end - f.start), f.start))
    kept: List[ScreenFinding] = []
    for f in raw:
        if any(f.start < k.end and k.start < f.end for k in kept):
            continue
        kept.append(f)
    return sorted(kept, key=lambda f: f.start)


def summarise(findings: Sequence[ScreenFinding]) -> Dict[str, int]:
    """Counts only: what goes over the wire when the text stays where it is."""
    counts: Dict[str, int] = {}
    for f in findings:
        counts[f.kind] = counts.get(f.kind, 0) + 1
    return counts


# ── Redaction ──────────────────────────────────────────────────────────────


@dataclass
class Redaction:
    text: str
    #: Placeholder → original value. Stays with the caller; never sent anywhere.
    replacements: Dict[str, str] = field(default_factory=dict)


def _placeholder_word(f: ScreenFinding) -> str:
    if f.kind == "term" and f.label != DATA_KINDS["term"]["label"]:
        word = re.sub(r"^_|_$", "", re.sub(r"[^A-Z0-9]+", "_", f.label.upper()))[:24]
        return word or "TERM"
    return str(DATA_KINDS[f.kind]["placeholder"])


def redact(text: str, findings: Sequence[ScreenFinding]) -> Redaction:
    """Replace each redactable finding with a placeholder, one per distinct value."""
    replacements: Dict[str, str] = {}
    by_value: Dict[str, str] = {}
    counters: Dict[str, int] = {}
    out = []
    at = 0
    for f in sorted(findings, key=lambda f: f.start):
        if not f.redactable or f.start < at:
            continue
        value = text[f.start : f.end]
        key = "{}\0{}".format(f.kind, value.lower())
        placeholder = by_value.get(key)
        if placeholder is None:
            word = _placeholder_word(f)
            counters[word] = counters.get(word, 0) + 1
            placeholder = "[{}_{}]".format(word, counters[word])
            by_value[key] = placeholder
            replacements[placeholder] = value
        out.append(text[at : f.start] + placeholder)
        at = f.end
    out.append(text[at:])
    return Redaction(text="".join(out), replacements=replacements)


def restore(text: str, replacements: Mapping[str, str]) -> str:
    """Put the original values back into text a model wrote using the placeholders."""
    keys = sorted(replacements, key=len, reverse=True)
    if not keys:
        return text
    pattern = re.compile("|".join(re.escape(k) for k in keys))
    return pattern.sub(lambda m: replacements.get(m.group(0), m.group(0)), text)


# ── Deciding ───────────────────────────────────────────────────────────────


@dataclass
class ScreenTarget:
    """What the destination model is approved to receive: its AI register record."""

    name: str
    approved_classification: Optional[str]
    personal_data: bool
    active: bool = True


@dataclass
class ScreenAssessment:
    verdict: str
    classification: str
    personal_data: bool
    categories: List[str]
    offending: List[str]
    reasons: List[str]


DEFAULT_SCREEN_POLICY: Dict[str, object] = {
    "secrets": "deny",
    "beyondApproval": "redact",
    "notRedactable": "ask",
    "unregistered": {"approvedClassification": "internal", "personalData": False},
}

_VERDICT_RANK = {"allow": 0, "redact": 1, "ask": 2, "deny": 3}


def _stricter(a: str, b: str) -> str:
    return b if _VERDICT_RANK[b] > _VERDICT_RANK[a] else a


def _rank(c: str) -> int:
    return SCREEN_CLASSIFICATIONS.index(c)


def describe_counts(counts: Mapping[str, int]) -> str:
    """``2 email addresses and 1 IBAN``."""
    parts = []
    for k in DATA_KIND_KEYS:
        n = counts.get(k) or 0
        if n <= 0:
            continue
        label = str(DATA_KINDS[k]["label"])
        s = "" if n == 1 else "s"
        if k == "email":
            parts.append("{} email address{}".format(n, "" if n == 1 else "es"))
        elif k == "special_category":
            parts.append("{} mention{} of special-category data".format(n, s))
        elif k == "secret":
            parts.append("{} secret{} or credential{}".format(n, s, s))
        elif k == "term":
            parts.append("{} confidential term{}".format(n, s))
        elif re.match(r"^[A-Z]{2,}", label):
            parts.append("{} {}{}".format(n, label, s))
        else:
            parts.append("{} {}{}".format(n, label.lower(), s))
    if len(parts) <= 1:
        return parts[0] if parts else "nothing"
    return "{} and {}".format(", ".join(parts[:-1]), parts[-1])


def assess_counts(
    counts: Mapping[str, int],
    target: Optional[ScreenTarget],
    policy: Optional[Mapping[str, object]] = None,
    term_classification: str = "confidential",
) -> ScreenAssessment:
    """Decide from counts alone, the same way the server does."""
    p = dict(DEFAULT_SCREEN_POLICY)
    p.update(policy or {})
    present = [k for k in DATA_KIND_KEYS if (counts.get(k) or 0) > 0]
    categories = [c for c in SCREEN_CATEGORIES if any(DATA_KINDS[k]["category"] == c for k in present)]

    def class_of(k: str) -> str:
        return term_classification if k == "term" else _CATEGORY_CLASSIFICATION[str(DATA_KINDS[k]["category"])]

    classification = "public"
    for k in present:
        if _rank(class_of(k)) > _rank(classification):
            classification = class_of(k)
    personal = any(c in _PERSONAL_CATEGORIES for c in categories)

    if target is not None and not target.active:
        return ScreenAssessment(
            "deny",
            classification,
            personal,
            categories,
            present,
            ["{} is not an active system in the AI register, so nothing should be sent to it.".format(target.name)],
        )
    reasons: List[str] = []
    offending: List[str] = []
    verdict = "allow"
    if not present:
        return ScreenAssessment(verdict, classification, personal, categories, offending, reasons)

    unregistered = p["unregistered"]
    assert isinstance(unregistered, Mapping)
    name = target.name if target is not None else "an AI system that is not in the register"
    approved = (
        (target.approved_classification or str(unregistered["approvedClassification"]))
        if target is not None
        else str(unregistered["approvedClassification"])
    )
    personal_approved = target.personal_data if target is not None else bool(unregistered["personalData"])

    secrets = counts.get("secret") or 0
    if secrets > 0:
        verdict = _stricter(verdict, str(p["secrets"]))
        offending.append("secret")
        reasons.append("It contains {}, which should never be sent to a model.".format(describe_counts({"secret": secrets})))

    for k in present:
        if k == "secret":
            continue
        too_sensitive = _rank(class_of(k)) > _rank(approved)
        personal_not_approved = DATA_KINDS[k]["category"] != "confidential" and not personal_approved
        if not too_sensitive and not personal_not_approved:
            continue
        action = str(p["beyondApproval"] if DATA_KINDS[k]["redactable"] else p["notRedactable"])
        verdict = _stricter(verdict, action)
        offending.append(k)
        why = (
            "which is not approved to receive personal data"
            if personal_not_approved
            else "which is approved for {} data at most".format(approved)
        )
        reasons.append("It contains {}, and goes to {}, {}.".format(describe_counts({k: counts[k]}), name, why))

    return ScreenAssessment(verdict, classification, personal, categories, offending, reasons)


def redact_for(text: str, findings: Sequence[ScreenFinding], verdict: str, offending: Sequence[str]) -> Optional[Redaction]:
    """The text with only the findings behind a verdict replaced. ``None`` for a deny."""
    if verdict == "deny":
        return None
    wanted = set(offending)
    return redact(text, [f for f in findings if f.kind in wanted])


def term_classification_of(findings: Sequence[ScreenFinding]) -> str:
    """The strictest classification among the terms found."""
    return "restricted" if any(f.kind == "term" and f.classification == "restricted" for f in findings) else "confidential"
