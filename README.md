# Deliverd SDKs and CLI

**You build the action. Deliverd handles the human.**

Your AI agent asks a person for an approval, a review, an answer or a decision,
and carries on when they respond. This repository is the source of the three
packages that do the asking:

| Package | Install | Source |
|---|---|---|
| TypeScript SDK | `npm install @deliverd/sdk` | [`packages/sdk`](packages/sdk) |
| Python SDK | `pip install deliverd` | [`packages/sdk-python`](packages/sdk-python) |
| CLI | `npx deliverd` | [`packages/cli`](packages/cli) |

All three are MIT, and none has a runtime dependency except the CLI, which has
two. The Deliverd service they talk to is a separate, proprietary product.

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme).
   The Free plan needs no card.
2. Name your organisation. The next page hands you a key: set it as
   `DELIVERD_API_KEY`.
3. Ask a person. Leave `approvers` out and the request goes to your
   organisation's owners and admins.

```ts
import { deliverd } from "@deliverd/sdk";

const decision = await deliverd.approve({ title: "Deploy to production" });
if (decision.approved) await deploy();
```

```python
from deliverd import deliverd

decision = deliverd.approve(title="Deploy to production")
if decision.approved:
    deploy()
```

```bash
npx deliverd login
npx deliverd ask "Deploy to production?" --wait
```

The approver gets an email and a notification, opens a page that works on a
phone, and approves, rejects with a reason, or asks your agent a question.
Every step is on the record.

## Before you have an account

Development mode needs no key and no network. It prints what the approver would
have seen and answers at once:

```ts
import { Deliverd } from "@deliverd/sdk";

const deliverd = new Deliverd({ mode: "development" });
```

```python
from deliverd import Deliverd

deliverd = Deliverd(mode="development")
```

## What is here

- **[`packages/sdk`](packages/sdk)**: `@deliverd/sdk` on npm. Node 20 and up.
- **[`packages/sdk-python`](packages/sdk-python)**: `deliverd` on PyPI. Python
  3.9 and up, standard library only, blocking or `asyncio`.
- **[`packages/cli`](packages/cli)**: `deliverd` on npm. For build steps,
  pipelines, scripts and connecting your AI tools over MCP.
- **[`packages/conformance`](packages/conformance)**: one table of behaviour
  both SDKs must share: retries, idempotency, webhook signatures, durations
  and gating.
  Each SDK's test suite reads it, so a case added there fails in whichever
  language has not implemented it.

Each package's README is the page you see on npm or PyPI, and covers the
package in full. The [developer docs](https://deliverd.dev/docs/developers/sdk?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme)
cover the API behind them.

## Running the tests

```bash
pnpm install
pnpm --filter @deliverd/sdk build   # release.test.ts reads dist/
pnpm vitest run

cd packages/sdk-python
PYTHONPATH=src python -m unittest discover -s tests
```

## How this repository works

The packages are developed in Deliverd's own repository, beside the API they
call, and copied here after every change. The checks that hold them to that API
and to its documentation run there, on every change, before anything arrives
here; the tests in this repository are the ones that need nothing else.

So a pull request here is not merged here. Open one anyway, or an issue: we
carry the change across, credit you in the commit, and it comes back in the
next copy. Releases are published from this repository, by GitHub Actions with
npm's and PyPI's trusted publishing, so each release on npm carries provenance
linking it to the commit and workflow that built it.

## Security

Please report a vulnerability privately through the
[contact page](https://deliverd.dev/contact?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme)
rather than in an issue. How the service handles data is on
[deliverd.dev/security](https://deliverd.dev/security?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme).

## Licence

[MIT](LICENSE). It covers the code in this repository only.
