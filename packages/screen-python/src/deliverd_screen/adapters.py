"""Detectors to plug in beside the patterns, for what patterns cannot find:
people's names above all.

Each adapter returns a callable from the text to spans, for
``screen(text, detectors=[...])`` here or ``deliverd.screen(text,
detectors=[...])`` in the ``deliverd`` SDK. This package depends on none of
them: you install the model or the analyzer and pass it in.

Run the model where the text already is. A detector that sends the text to a
hosted service has sent it somewhere, which is what this check exists to
prevent.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Sequence

from .data_screen import DATA_KINDS, DetectedSpan

LabelMap = Callable[[str], Optional[str]]


def default_labels(label: str) -> Optional[str]:
    """What the common label sets mean; None to ignore a label."""
    l = label.lower()
    if re.fullmatch(r"per|person|private_person|name|full_?name|first_?name|last_?name|given_?name|surname|username", l):
        return "person_name"
    if "email" in l:
        return "email"
    if "phone" in l or "telephone" in l:
        return "phone"
    if "iban" in l:
        return "iban"
    if re.search(r"credit_?card|card_?number", l):
        return "payment_card"
    if re.fullmatch(r"ip(_?address)?", l):
        return "ip_address"
    return None


def _field(t: Any, name: str) -> Any:
    return t.get(name) if isinstance(t, dict) else getattr(t, name, None)


def token_classifier(
    classify: Callable[[str], Sequence[Any]],
    min_score: float = 0.5,
    labels: LabelMap = default_labels,
) -> Callable[[str], List[DetectedSpan]]:
    """A Hugging Face token-classification pipeline as a detector.

        from transformers import pipeline
        ner = pipeline("token-classification", model="dslim/bert-base-NER", aggregation_strategy="simple")
        names = token_classifier(ner)

    Works with anything returning the same dicts (``entity_group`` or
    ``entity``, ``score``, ``start``, ``end``, ``word``), such as Perplexity's
    PII-Tracer or a GLiNER model. Check the model's licence before you ship it.
    Adjacent tokens of one kind become one span.
    """

    def detect(text: str) -> List[DetectedSpan]:
        spans: List[DetectedSpan] = []
        cursor = 0
        for t in classify(text):
            raw = _field(t, "entity_group") or _field(t, "entity") or _field(t, "label")
            score = _field(t, "score")
            if not raw or (score is not None and score < min_score):
                continue
            kind = labels(re.sub(r"^[BIESL]-", "", str(raw)))
            start, end = _field(t, "start"), _field(t, "end")
            if not isinstance(start, int) or not isinstance(end, int) or end <= start:
                word = re.sub(r"^(##|▁|Ġ)", "", str(_field(t, "word") or "")).strip()
                if not word:
                    continue
                start = text.find(word, cursor)
                if start < 0:
                    continue
                end = start + len(word)
            cursor = end
            if not kind or kind not in DATA_KINDS:
                continue
            last = spans[-1] if spans else None
            if last and last.kind == kind and re.fullmatch(r"[\s-]?", text[last.end : start]):
                last.end = end
            else:
                spans.append(DetectedSpan(kind=kind, start=start, end=end))
        return spans

    return detect


_PRESIDIO: Dict[str, str] = {
    "PERSON": "person_name",
    "EMAIL_ADDRESS": "email",
    "PHONE_NUMBER": "phone",
    "IBAN_CODE": "iban",
    "CREDIT_CARD": "payment_card",
    "IP_ADDRESS": "ip_address",
    "US_SSN": "us_ssn",
    "UK_NINO": "uk_national_insurance",
    "US_ITIN": "us_itin",
    "US_PASSPORT": "passport",
    "US_BANK_NUMBER": "bank_account",
    "ES_NIF": "es_dni",
    "ES_NIE": "es_dni",
    "IT_FISCAL_CODE": "it_fiscal_code",
    "PL_PESEL": "pl_pesel",
}


def presidio(analyzer: Any, language: str = "en", min_score: float = 0.5) -> Callable[[str], List[DetectedSpan]]:
    """A Presidio ``AnalyzerEngine`` as a detector, in process.

        from presidio_analyzer import AnalyzerEngine
        names = presidio(AnalyzerEngine())
    """

    def detect(text: str) -> List[DetectedSpan]:
        results = analyzer.analyze(text=text, language=language, entities=list(_PRESIDIO))
        return [
            DetectedSpan(kind=_PRESIDIO[r.entity_type], start=r.start, end=r.end)
            for r in results
            if r.entity_type in _PRESIDIO and r.score >= min_score
        ]

    return detect


#: The name model :func:`names` uses unless told otherwise: BERT fine-tuned for named entities, MIT licence.
DEFAULT_NAME_MODEL = "dslim/bert-base-NER"


def names(
    model: str = DEFAULT_NAME_MODEL,
    min_score: float = 0.5,
    on_load: Optional[Callable[[str], None]] = None,
) -> Callable[[str], List[DetectedSpan]]:
    """People's names, found by a small model that runs on this machine. Opt in.

        # pip install transformers torch
        from deliverd_screen import screen
        from deliverd_screen.adapters import names

        detectors = [names()]
        checked = screen("Ask Mary Byrne about it", detectors=detectors)
        checked.text  # "Ask [NAME_1] about it"

    The first call downloads the model from Hugging Face once and caches it;
    after that nothing leaves the machine. Text is never sent anywhere: the
    model runs in this process. It finds names as well as the model does,
    which is well for English and worse for other languages and for names that
    are also ordinary words. Organisations and places are ignored.
    """
    state: Dict[str, Any] = {"detect": None}

    def detect(text: str) -> List[DetectedSpan]:
        if state["detect"] is None:
            try:
                from transformers import pipeline  # type: ignore[import-not-found]
            except ImportError as error:
                raise RuntimeError("names() runs a model with Hugging Face transformers: pip install transformers torch") from error
            if on_load is not None:
                on_load(model)
            ner = pipeline("token-classification", model=model, aggregation_strategy="simple")
            state["detect"] = token_classifier(ner, min_score=min_score)
        return state["detect"](text)

    return detect
