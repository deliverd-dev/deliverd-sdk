# Changelog

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
