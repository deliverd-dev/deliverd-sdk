# Deliverd Screen

**A pre-send check for every prompt.** Find and redact personal data, secrets
and your own confidential terms before text goes to an AI model.

- **Local.** No account, no key, no network call. The text never leaves your
  process, unless you turn on the optional Microsoft Purview check, which
  sends it to your own Microsoft tenant and nowhere else.
- **Reversible.** Values become placeholders such as `[EMAIL_1]` (the same
  value gets the same placeholder throughout), and `restore()` puts them back
  in the model's answer.
- **Names, if you want them.** Patterns can't find people's names, but a model
  can. `names()` runs one on your machine, or plug in Presidio or any model
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
Security numbers and ITINs, Canadian Social Insurance numbers (Luhn), French
NIRs, Spanish DNI and NIE numbers, Italian fiscal codes, Dutch BSNs, Polish
PESEL numbers and German tax IDs (each with its check digit), passport and VAT
numbers, bank details (US routing numbers with their checksum, UK sort codes,
account numbers), IP addresses (v4 and v6), dates of birth, API keys and tokens
(AWS, GitHub, Slack, Stripe, Anthropic, OpenAI, Google, JWTs and more), private
keys, passwords in connection strings and `.env` files, words
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

Identifiers that are only digits (BSN, PESEL, Steuer-ID, a passport, VAT or
account number, a bare SIN in one block) are found after the word for them,
such as "BSN" or "account no.", because nine or eleven digits alone are too
often something else.

## Names: a model on your machine

```bash
npm install @huggingface/transformers
```

```ts
import { names } from "@deliverd/screen/adapters";

const checked = await screen(prompt, { detectors: [names()] });
```

`names()` runs a small named-entity model (`Xenova/bert-base-NER` by default,
or pass `model`) in this process. It is downloaded from Hugging Face the first
time, then nothing leaves the machine. On the command line, add `--names`; for
the MCP server, set `DELIVERD_SCREEN_NAMES=1`.

Or bring your own:

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
npx @deliverd/screen --names notes.txt           # people's names too, with a local model
```

In GitHub Actions, `uses: deliverd-dev/deliverd-screen@v0` with `paths:` runs
the same check; for pre-commit, the hook id is `deliverd-screen`. Both are in
[deliverd-dev/deliverd-screen](https://github.com/deliverd-dev/deliverd-screen).

## A proxy for any tool

```bash
npx @deliverd/screen proxy --upstream https://api.openai.com
OPENAI_BASE_URL=http://localhost:8787/v1 your-tool
```

Point any tool's model address at the proxy, and every request is screened
before it leaves the machine. It finds the text in the request (`messages`,
`input`, `system` and the rest) and screens it as one. On `redact` it forwards
placeholders and puts the values back in the answer, streamed answers
included. On `ask` or `deny` it sends nothing and answers 403 with the reason.
It works for OpenAI, Anthropic (`--upstream https://api.anthropic.com`),
OpenRouter and local model servers alike. Options: `--port`,
`--personal-data`, `--classification`, `--terms`, `--names`, and Purview from
the `DELIVERD_PURVIEW_*` variables. In code: `startProxy()` from
`@deliverd/screen/proxy`.

## What have you already pasted?

```bash
npx @deliverd/screen history ~/Downloads/chatgpt-export.zip
```

ChatGPT (Settings → Data controls → Export data) and Claude (Settings →
Privacy → Export data) both let you download everything you have said to them.
`history` reads that export, here, and reports how many email addresses, card
numbers, keys and the rest went into your messages, and in which
conversations. It never prints a value. `--assistant` reads the answers too,
and `--json` gives the report as data.

## MCP

```bash
claude mcp add deliverd-screen -- npx -y @deliverd/screen mcp
```

This gives an agent in Claude Code, Cursor or Codex one tool, `screen_text`.
It returns the verdict and the redacted text, and never the values it
replaced, so they don't enter the agent's context through the tool.

## Microsoft Purview

If your organisation writes its data loss prevention rules in Microsoft
Purview, the same rules can apply here, for any model and any tool. Pass a
Purview check and the stricter answer wins: a Purview block denies, and a warn
is an ask.

```ts
import { entraAppToken, purviewCheck, screen } from "@deliverd/screen";

const purview = purviewCheck({
  token: entraAppToken({ tenantId, clientId, clientSecret }),
  userId: entraObjectIdOfThePerson,
  app: { name: "Claims assistant", entraAppId: clientId },
});
const checked = await screen(prompt, { purview });
```

This is the one thing in the package that uses the network, and only when you
pass it: the text goes to Microsoft Graph (`processContent`), in your own
tenant, and nowhere else. The Entra app needs `Content.Process.All`, and the
DLP rule must be created with `New-DlpComplianceRule` (Purview does not apply a
portal-only rule to an Entra-registered app).

For the MCP server, set `DELIVERD_PURVIEW_TENANT_ID`,
`DELIVERD_PURVIEW_CLIENT_ID`, `DELIVERD_PURVIEW_CLIENT_SECRET` and
`DELIVERD_PURVIEW_USER_ID` (and optionally `DELIVERD_PURVIEW_ON_UNAVAILABLE`:
`allow`, `ask` or `deny`).

## A net, not a certificate

Structured identifiers are found well. Names are found only when you add a
model, and only as well as that model. Redacted text about a person is still personal data under
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
