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

0.1.1 was not published to PyPI; its changes are in this release.

## 0.1.1

- **Counts read properly.** Reasons said "2 IP addresss", "2 date of births"
  and "1 irish pps number"; they now say "2 IP addresses", "2 dates of birth"
  and "1 Irish PPS number". The same wording is now a shared test case for the
  TypeScript, Python and Rust packages.
- **A no-break space counts as a space**, as it does in the TypeScript
  package: "born on" followed by a no-break space and a date is now found as a
  date of birth, and the same for `password = "..."`.

## 0.1.0

The first release. The detectors Deliverd's SDKs already ran, published on
their own to run with no account and no network: `screen()` with local
verdicts, redaction with placeholders that `restore()` reverses, adapters for
a Hugging Face token classifier and for Presidio so a model can find people's
names, and a CLI for pre-commit hooks and CI.
