# Changelog

## 0.1.2

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

## 0.1.1

No change to the library or the CLI. The first release published to
crates.io from deliverd-dev/deliverd-sdk by trusted publishing rather than
by hand.

## 0.1.0

The first release: Deliverd Screen for Rust, finding what `@deliverd/screen`
and the Python `deliverd-screen` find, held to the same shared cases.
`screen()` and `Screen` with local verdicts, redaction with placeholders that
`restore()` reverses, a `Detector` hook and adapters for a token classifier's
and a Presidio analyzer's output so a model can find people's names, and the
`deliverd-screen` CLI with a local MCP server (`deliverd-screen mcp`).
