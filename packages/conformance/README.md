# One table, two SDKs

`cases.json` is the behaviour `@deliverd/sdk` and `deliverd` (Python) are
supposed to share. Both test suites read this file:

- `packages/sdk/src/conformance.test.ts`
- `packages/sdk-python/tests/test_conformance.py`

A case added here fails in whichever language has not implemented it. That is
the whole point, and it exists because everything else comparing the two
packages compares **shapes** — exported names, namespaces, every field of every
type — and both SDKs drifted in **behaviour** anyway, in opposite directions,
with every check green:

- the Python development transport had never been taught the flow routes, so
  `flows.resume()` worked in TypeScript and raised in Python;
- Python's development mode faked a publish and TypeScript's refused one;
- TypeScript retried a `501` three times after Python had stopped, because that
  fix was made in one language and never carried back.

All three were found by installing a package and running its own README, which
is not a test strategy.

## Editing it

**Add the case before the fix.** A case that goes in green has proved nothing;
the point is to watch it fail in the language that is wrong.

**A divergence must say why, in over forty characters.** A bare number is
milliseconds in TypeScript and seconds in Python because that is what each
language's own timers take — that is a reason. "They differ" is not, and the
guard in `apps/web/src/lib/api/python-sdk-parity.test.ts` refuses it.

**Prefer fixed vectors to round trips.** The signature cases carry real
precomputed HMACs rather than signing and then verifying, because a round trip
passes even when both ends are wrong in the same way — and what is at stake is
somebody's receiver, written against one SDK and verified by the other.

**Every section must be read by both suites.** The guard checks that by the
access (`CASES.retries`, `CASES["retries"]`) rather than by the section's name,
since the name appears in the prose of both files and would answer a search for
itself.

## What is deliberately not here

Error class names. They follow each language's own conventions and the
code-to-status mapping is already held to the server's table by
`apps/web/src/lib/api/` — a second copy here would drift from that one rather
than from anything a caller sees.
