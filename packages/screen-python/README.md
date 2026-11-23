# Deliverd Screen for Python

**A pre-send check for every prompt.** Find and redact personal data, secrets
and your own confidential terms before text goes to an AI model.

It runs locally, with no account, no key and no network call (unless you turn
on the optional Microsoft Purview check, which goes to your own tenant). It needs no dependencies
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

## What it finds

Email addresses, phone numbers, IBANs, payment card numbers (Luhn-checked),
UK National Insurance numbers, Irish PPS numbers (check character), US Social
Security numbers and ITINs, Canadian Social Insurance numbers (Luhn), French
NIRs, Spanish DNI and NIE numbers, Italian fiscal codes, Dutch BSNs, Polish
PESEL numbers and German tax IDs (each with its check digit), passport and VAT
numbers, bank details (US routing numbers with their checksum, UK sort codes,
account numbers), IP addresses (v4 and v6), dates of birth, API keys and tokens
(AWS, GitHub, Slack, Stripe, Anthropic, OpenAI, Google, JWTs and more), private
keys, passwords in connection strings and `.env` files, words that mark
special-category data such as health or religion, and your own `terms`.

## Names: a model on your machine

```bash
pip install transformers torch
```

```python
from deliverd_screen.adapters import names

checked = screen(prompt, detectors=[names()])
```

`names()` runs a named-entity model (`dslim/bert-base-NER` by default, or pass
`model=`) in this process. It is downloaded from Hugging Face the first time,
then nothing leaves the machine. On the command line, add `--names`.

Or bring your own:

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
deliverd-screen --names notes.txt
```

## Microsoft Purview

If your organisation writes its data loss prevention rules in Microsoft
Purview, the same rules can apply here. Pass a Purview check and the stricter
answer wins: a Purview block denies, and a warn is an ask.

```python
from deliverd_screen import entra_app_token, purview_check, screen

purview = purview_check(
    token=entra_app_token(tenant_id, client_id, client_secret),
    app={"name": "Claims assistant", "entra_app_id": client_id},
    user_id=entra_object_id_of_the_person,
)
checked = screen(prompt, purview=purview)
checked.purview  # Purview's answer, beside the screen's own
```

Only the standard library is used. The text goes to Microsoft Graph
(`processContent`) in your own tenant, and nowhere else. The Entra app needs
`ProtectionScopes.Compute.All` and `Content.Process.All`, and the DLP rule must be created with
`New-DlpComplianceRule`. `purview_from_env()` builds the check from
`DELIVERD_PURVIEW_TENANT_ID`, `DELIVERD_PURVIEW_CLIENT_ID`,
`DELIVERD_PURVIEW_CLIENT_SECRET` and `DELIVERD_PURVIEW_USER_ID`.

## A net, not a certificate

Structured identifiers are found well. Names are found only when you add a
model, and only as well as that model. Redacted text about a person is still
personal data under GDPR.

When a person has to decide, [Deliverd](https://deliverd.dev/docs/developers/screen?utm_source=pypi&utm_medium=package&utm_campaign=screen&utm_content=readme)'s
Data Gate asks them. `deliverd.screen()` in the `deliverd` SDK runs these
same detectors and sends only counts. It takes the same `detectors`.
