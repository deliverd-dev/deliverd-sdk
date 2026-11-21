# Changelog

## Unreleased

- **A password written out in words is a secret.** "My banking password is
  Tr0ub4dor&3", "password: hunter2" and "passcode is 482913" are found and
  denied like any other credential, in TypeScript, Python and Rust, with new
  shared test cases. The value has to hold a digit or a symbol, so "the
  password is required" is not one, and masks (`********`), placeholders
  (`<your-password>`, `[REDACTED]`) and variables (`${DB_PASS}`) are left alone.
  Before this, only a quoted `password = "..."`, a `.env` line or a connection
  string was found.

## 0.3.0

- **More national and bank identifiers, each with its check digit.** US
  ITINs; Canadian Social Insurance numbers (Luhn-checked, in groups of three or
  after "SIN"); French social security numbers (NIR, with their key); Spanish
  DNI and NIE numbers and Italian fiscal codes (check letters); Dutch BSNs
  (eleven test), Polish PESEL numbers and German tax IDs (Steuer-ID, ISO 7064)
  after the word for them, because nine or eleven bare digits are too often
  something else; passport numbers and VAT numbers after the word; and bank
  details after the word: US routing numbers (ABA checksum), UK sort codes and
  account numbers. New kinds: `us_itin`, `ca_sin`, `fr_nir`, `es_dni`,
  `it_fiscal_code`, `nl_bsn`, `pl_pesel`, `de_tax_id`, `passport`,
  `vat_number` and `bank_account`, in the shared test cases for all three
  languages. Presidio's `US_ITIN`, `US_PASSPORT`, `US_BANK_NUMBER`, `ES_NIF`,
  `ES_NIE`, `IT_FISCAL_CODE` and `PL_PESEL` map to them.
- **Names, with a model on your machine, if you want it.** `names()` in
  `@deliverd/screen/adapters` runs a small named-entity model with
  transformers.js in this process (install `@huggingface/transformers`
  yourself). It is downloaded once from Hugging Face, then nothing leaves the
  machine. `--names` on the command line, and `DELIVERD_SCREEN_NAMES=1` for
  the MCP server.
- **A local screening proxy.** `deliverd-screen proxy --upstream
  https://api.openai.com` listens on localhost; point a tool's base URL at it
  and every request is screened before it leaves: allowed as it is, redacted
  (with the values put back in the answer, streamed answers included), or
  refused with a 403 that says why. OpenAI, Anthropic, OpenRouter and local
  model servers alike. Also `startProxy()` and `proxyHandler()` from
  `@deliverd/screen/proxy`.
- **What you already pasted into ChatGPT or Claude.** `deliverd-screen
  history export.zip` reads the data export either assistant gives you and
  reports how many email addresses, card numbers, keys and the rest went into
  your messages, and in which conversations, without printing a value.
  `--assistant` reads the answers too; `--json` for the report as data.

## 0.2.0

- **More secrets and numbers found.** A private key is now redacted whole,
  from `-----BEGIN` to `-----END` (only the first line was before), or the
  header and the key lines under it when the end was cut off. The user and
  password in a connection string (`postgres://admin:hunter2@db/prod`) are a
  secret, where before the password was taken for part of an email address.
  Credentials in `.env` lines are found quoted or not (`DB_PASSWORD=...`,
  `OPENAI_API_KEY="..."`), leaving placeholders such as `your-api-key-here` and
  references such as `${DB_PASS}` alone. North American phone numbers written
  `(415) 555-0132` or `415-555-0132`, and IPv6 addresses, are found.
- **Fewer false alarms.** A version such as `v1.2.3.4`, `version 1.2.3.4` or
  `1.2.3.4.5` is no longer an IP address, and neither is a time such as
  `10:30:00` or a MAC address.
- **Microsoft Purview, if you want it.** `screen(text, { purview })` also
  asks your organisation's Purview DLP policies about the text, through
  Microsoft Graph with your own Entra app, and the stricter answer wins: a
  Purview block denies, a warn is an ask. `purviewCheck()` makes the check
  and `entraAppToken()` gets it a token for an app acting as itself. The
  text goes to Microsoft for this and nowhere else; without `purview`,
  nothing is sent anywhere, as before. `screenMiddleware()` takes the same
  option. The MCP server turns it on from `DELIVERD_PURVIEW_*` environment
  variables (see the README).
- **Counts read properly.** Reasons said "2 IP addresss", "2 date of births"
  and "1 irish pps number"; they now say "2 IP addresses", "2 dates of birth"
  and "1 Irish PPS number". The same wording is now a shared test case for the
  TypeScript, Python and Rust packages.

## 0.1.0

The first release. The detectors Deliverd's SDKs already ran, published on
their own to run with no account and no network: `screen()` with local
verdicts, redaction with placeholders that `restore()` reverses, adapters for
a Hugging Face token classifier and for Presidio so a model can find people's
names, and a CLI for pre-commit hooks and CI.
This package also includes Vercel AI SDK middleware (`@deliverd/screen/ai-sdk`) and a local
MCP server (`npx @deliverd/screen mcp`, one tool: `screen_text`).
