# Deliverd Screen

**A pre-send check for every prompt.** Find and redact personal data, secrets
and your own confidential terms before text goes to an AI model.

- **Local.** No account, no key, no network call. The text never leaves your
  process.
- **Reversible.** Values become placeholders such as `[EMAIL_1]` (the same
  value gets the same placeholder throughout), and `restore()` puts them back
  in the model's answer.
- **Bring your own model for names.** Patterns can't find people's names, but a
  model can. Plug in a Hugging Face token classifier, Presidio, or any model
  with the same output.
- **No dependencies.** MIT.

```bash
npm install @deliverd/screen
```

```ts
import { screen } from "@deliverd/screen";

const checked = await screen("Reply to mary.byrne@example.ie about IBAN IE29AIBK93115212345678");
checked.verdict; // "redact"
checked.text;    // "Reply to [EMAIL_1] about IBAN [IBAN_1]"

const answer = await model.generate(checked.text);
checked.restore(answer); // the real values, back in the answer
```

## What it finds

Email addresses, phone numbers, IBANs, payment card numbers (Luhn-checked),
UK National Insurance numbers, Irish PPS numbers (check character), US Social
Security numbers, IP addresses, dates of birth, API keys and tokens
(AWS, GitHub, Slack, Stripe, Anthropic, OpenAI, Google, JWTs and more), words
that mark special-category data such as health or religion, and your own
`terms`.

## The four answers

By default the model may receive internal data and no personal data. Pass
`allow: { personalData: true, classification: "confidential" }` for a model you
have approved for more.

| Verdict | What to do |
|---|---|
| `allow` | Send `text`, which is the original. |
| `redact` | Send `text`, which has placeholders in place of what the model may not receive. |
| `ask` | A person has to decide (special-category data, by default). `allowed` is false. |
| `deny` | Send nothing. Secrets are refused by default. |

## Names: plug in a model

```ts
import { pipeline } from "@huggingface/transformers";
import { tokenClassifier, presidio } from "@deliverd/screen/adapters";

const ner = await pipeline("token-classification", "Xenova/bert-base-NER");
const checked = await screen(prompt, { detectors: [tokenClassifier((t) => ner(t))] });

// or a Presidio analyzer you run yourself:
// docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer
await screen(prompt, { detectors: [presidio({ url: "http://localhost:5002" })] });
```

A detector is a function from the text to `{ kind, start, end }` spans, so any
model works, including Perplexity's PII-Tracer and GLiNER. Check a model's
licence before you ship it. Run it where the text already is: a detector that
sends the text to a hosted service has already sent it.

## Vercel AI SDK

```ts
import { generateText, wrapLanguageModel } from "ai";
import { screenMiddleware } from "@deliverd/screen/ai-sdk";

const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: screenMiddleware() });
const { text } = await generateText({ model, prompt });
```

The middleware screens the whole conversation at once, so one value keeps one
placeholder across messages. It restores the answer, including a streamed one where a
placeholder arrives split across chunks. On a `deny` or an `ask` it throws
`ScreenBlockedError` and the model is never called. It works with AI SDK 7 by
default; pass `specificationVersion: "v3"` for AI SDK 6.

## CLI, pre-commit and CI

```bash
cat prompt.txt | npx @deliverd/screen --redact   # the redacted text
npx @deliverd/screen --json notes.txt            # kinds and offsets, never values
npx @deliverd/screen --fail evals/*.jsonl        # exit 1 if anything is found
npx @deliverd/screen --terms clients.txt doc.md  # your own words, one per line
```

## MCP

```bash
claude mcp add deliverd-screen -- npx -y @deliverd/screen mcp
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

A library can only tell you to stop. [Deliverd](https://deliverd.dev/docs/developers/screen?utm_source=npm&utm_medium=package&utm_campaign=screen&utm_content=readme)'s
Data Gate makes the call. `deliverd.screen()` in `@deliverd/sdk` runs these
same detectors on your machine and sends Deliverd only the counts ("two email
addresses, one IBAN"). The verdict comes back from your organisation's policy and from what
its AI register approves each model to receive. On an `ask` it puts the
question to the right person in Slack, Teams or on their phone, and every check is
recorded. It takes the same `detectors`.

## Licence

MIT. The detectors are shared with Deliverd's SDKs and held to one set of test
vectors, `packages/conformance/screening.json`.
