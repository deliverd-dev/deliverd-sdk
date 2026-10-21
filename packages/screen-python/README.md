# Deliverd Screen for Python

**A pre-send check for every prompt.** Find and redact personal data, secrets
and your own confidential terms before text goes to an AI model.

It runs locally, with no account, no key and no network call. It needs no dependencies
and works on Python 3.9 and up. MIT.

```bash
pip install deliverd-screen
```

```python
from deliverd_screen import screen

checked = screen("Reply to mary.byrne@example.ie about IBAN IE29AIBK93115212345678")
checked.verdict  # "redact"
checked.text     # "Reply to [EMAIL_1] about IBAN [IBAN_1]"

answer = model.generate(checked.text)
checked.restore(answer)  # the real values, back in the answer
```

`allow` sends the original; `redact` sends placeholders in place of what the
model may not receive; `ask` means a person has to decide; `deny` sends nothing.
By default a model may receive internal data and no personal data. Pass
`personal_data=True, classification="confidential"` for one approved for more.

## Names: plug in a model

```python
from transformers import pipeline
from deliverd_screen.adapters import token_classifier, presidio

ner = pipeline("token-classification", model="dslim/bert-base-NER", aggregation_strategy="simple")
checked = screen(prompt, detectors=[token_classifier(ner)])

# or Presidio, in process:
from presidio_analyzer import AnalyzerEngine
checked = screen(prompt, detectors=[presidio(AnalyzerEngine())])
```

Any model with the same output works, including Perplexity's PII-Tracer and
GLiNER. Check its licence before you ship it.

## CLI

```bash
cat prompt.txt | deliverd-screen --redact
deliverd-screen --fail --json fixtures/*.json
```

## A net, not a certificate

Structured identifiers are found well. Names are found only as well as the
model you plug in, and redacted text about a person is still personal data
under GDPR.

When a person has to decide, [Deliverd](https://deliverd.dev/docs/developers/screen?utm_source=pypi&utm_medium=package&utm_campaign=screen&utm_content=readme)'s
Data Gate asks them. `deliverd.screen()` in the `deliverd` SDK runs these
same detectors and sends only counts. It takes the same `detectors`.
