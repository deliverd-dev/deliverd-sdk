# Changelog

## 0.2.1

- **Microsoft Purview now applies its DLP rules to your app.** `purview_check()`
  computes the app's protection scope first
  (`protectionScopes/compute`, once an hour) and sends its ETag with each
  `processContent` call, as Microsoft requires; without it Purview answered
  with no actions even when a rule matched. When Purview says the policy
  changed, it computes again and asks once more. Add the Graph permission
  `ProtectionScopes.Compute.All` (or `.User`) beside `Content.Process.All`; if
  it is missing, the text is still asked about as before and compute is tried
  again after 15 minutes. Tested against a real DLP policy in a Microsoft 365
  E5 tenant: a card number with its expiry was blocked.

## 0.2.0

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
- **Microsoft Purview, if you want it.** `screen(text, purview=...)` also asks
  your organisation's Purview DLP policies about the text, through Microsoft
  Graph with your own Entra app, and the stricter answer wins: a Purview block
  denies, a warn is an ask. `purview_check()` makes the check,
  `entra_app_token()` gets it a token, and `purview_from_env()` builds one from
  the same `DELIVERD_PURVIEW_*` variables as the TypeScript package. Only the
  standard library; without `purview`, nothing is sent anywhere, as before.
- **Names, with a model on your machine, if you want it.** `names()` in
  `deliverd_screen.adapters` runs a named-entity model with Hugging Face
  `transformers` in this process (install it yourself). `--names` on the
  command line.

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
