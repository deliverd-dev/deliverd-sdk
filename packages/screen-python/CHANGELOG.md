# Changelog

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
