# deliverd-screen

**A pre-send check for every prompt.** Find and redact personal data, secrets
and your own confidential terms before text goes to an AI model.

- **Local.** No account, no key, no network call. The text never leaves your
  process.
- **Reversible.** Values become placeholders such as `[EMAIL_1]` (the same
  value gets the same placeholder throughout), and `restore()` puts them back
  in the model's answer.
- **Bring your own model for names.** Patterns can't find people's names, but a
  model can. Any function from the text to spans is a detector.
- **One dependency.** The library needs only `regex`, which matches in time
  linear in the text, so no prompt can make a check slow. MIT.

```bash
cargo add deliverd-screen
```

```rust
let checked = deliverd_screen::screen("Reply to mary.byrne@example.ie about IBAN IE29AIBK93115212345678");
assert_eq!(checked.text.as_deref(), Some("Reply to [EMAIL_1] about IBAN [IBAN_1]"));

let answer = model.generate(checked.text.as_deref().unwrap())?;
let answer = checked.restore(&answer); // the real values, back in the answer
```

## What it finds

Email addresses, phone numbers, IBANs, payment card numbers (Luhn-checked),
UK National Insurance numbers, Irish PPS numbers (check character), US Social
Security numbers, IP addresses, dates of birth, API keys and tokens
(AWS, GitHub, Slack, Stripe, Anthropic, OpenAI, Google, JWTs and more), words
that mark special-category data such as health or religion, and your own
terms.

It finds exactly what `@deliverd/screen` on npm and `deliverd-screen` on PyPI
find. All three are tested against one shared set of cases,
[`packages/conformance/screening.json`](https://github.com/deliverd-dev/deliverd-sdk/blob/main/packages/conformance/screening.json).

Offsets are byte offsets, so `&text[f.start..f.end]` is the value a finding
points at.

## The four answers

By default the model may receive internal data and no personal data. Say
otherwise for a model you have approved for more:

```rust
use deliverd_screen::{Classification, Screen, Term};

let screen = Screen::new()
    .model("the summariser")
    .allow(Classification::Confidential, true)
    .term(Term::new("Project Kestrel").labelled("Code name"));
let checked = screen.check(prompt);
```

| Verdict | What to do |
|---|---|
| `Allow` | Send `text`, which is the original. |
| `Redact` | Send `text`, which has placeholders in place of what the model may not receive. |
| `Ask` | A person has to decide (special-category data, by default). `allowed` is false. |
| `Deny` | Send nothing. Secrets are refused by default. |

## Names: plug in a model

A detector is anything from the text to `DetectedSpan`s, so a closure is one:

```rust
use deliverd_screen::{adapters, DetectedSpan, Screen};

let names = |text: &str| -> Vec<DetectedSpan> {
    let tokens = my_ner_model(text); // candle, ort, a local GLiNER server...
    adapters::token_spans(text, &tokens, 0.5, adapters::default_labels)
};
let checked = Screen::new().detector(names).check(prompt);
```

`adapters::token_spans` joins a token classifier's pieces ("Mary", "Byrne")
into one name. `adapters::presidio_spans` reads a Presidio analyzer's
`/analyze` results, which count characters rather than bytes. For a model you
call asynchronously, await it first and pass its spans to
`Screen::check_with_spans`.

Check a model's licence before you ship it. Run it where the text already is:
a detector that sends the text to a hosted service has already sent it.

## CLI, pre-commit and CI

```bash
cargo install deliverd-screen
cat prompt.txt | deliverd-screen --redact   # the redacted text
deliverd-screen --json notes.txt            # kinds and offsets, never values
deliverd-screen --fail evals/*.jsonl        # exit 1 if anything is found
deliverd-screen --terms clients.txt doc.md  # your own words, one per line
```

For the library alone, without the CLI and its JSON dependency:
`deliverd-screen = { version = "0.1", default-features = false }`.

## MCP

```bash
claude mcp add deliverd-screen -- deliverd-screen mcp
```

This gives an agent in Claude Code, Cursor or Codex one tool, `screen_text`.
It returns the verdict and the redacted text, and never the values it
replaced, so they don't enter the agent's context through the tool.

## A net, not a certificate

Structured identifiers are found well. Names are found only as well as the
model you plug in. Redacted text about a person is still personal data under
GDPR. Use this to send fewer identifiers, never as proof that a prompt was
clean.

## When a person has to decide

A library can only tell you to stop. [Deliverd](https://deliverd.dev/docs/developers/screen?utm_source=crates&utm_medium=package&utm_campaign=screen&utm_content=readme)'s
Data Gate makes the call: the same detectors on your machine, only the counts
sent to Deliverd ("two email addresses, one IBAN"), and a verdict from your
organisation's policy and from what its AI register approves each model to
receive. On an `Ask` it puts the question to the right person in Slack, Teams
or on their phone, and every check is recorded.

## Licence

MIT.
