# Deliverd SDKs and CLI

**You build the action. Deliverd handles the human.**

Your AI agent asks a person for an approval, a review, an answer or a decision,
and carries on when they respond. This repository is the source of the four
packages that do the asking:

| Package | Install | Source |
|---|---|---|
| TypeScript SDK | `npm install @deliverd/sdk` | [`packages/sdk`](packages/sdk) |
| Python SDK | `pip install deliverd` | [`packages/sdk-python`](packages/sdk-python) |
| Rust SDK | `cargo add deliverd` | [`packages/sdk-rust`](packages/sdk-rust) |
| CLI | `npx deliverd` | [`packages/cli`](packages/cli) |

All four are MIT. The TypeScript and Python SDKs have no runtime dependency,
the CLI has two, and the Rust SDK uses reqwest, serde and tokio rather than
writing its own HTTP client. The Deliverd service every package here talks to
is a separate, proprietary product.

### .NET and Microsoft Agent Framework

| Package | Install | Source |
|---|---|---|
| .NET client | `dotnet add package Deliverd` | [`packages/sdk-dotnet`](packages/sdk-dotnet) |
| Agent Framework adapter | `dotnet add package Deliverd.AgentFramework` | [`packages/sdk-dotnet`](packages/sdk-dotnet) |

Both MIT. The client needs nothing beyond .NET; the adapter adds
`Microsoft.Agents.AI`, and answers Agent Framework's tool approvals with a
person's decision.

### Deliverd Screen: a pre-send check for every prompt

It finds personal data, secrets and your own confidential terms in text
before the text goes to an AI model, and redacts them. Everything runs on your machine,
with no account and no network call, so it works whether or not you use
Deliverd.

| Package | Install | Source |
|---|---|---|
| Deliverd Screen for TypeScript | `npm install @deliverd/screen` | [`packages/screen`](packages/screen) |
| Deliverd Screen for Python | `pip install deliverd-screen` | [`packages/screen-python`](packages/screen-python) |
| Deliverd Screen for Rust | `cargo add deliverd-screen` | [`packages/screen-rust`](packages/screen-rust) |

```ts
import { screen } from "@deliverd/screen";

const checked = await screen(prompt);
if (checked.allowed) return checked.restore(await model.generate(checked.text));
```

All three are MIT. The TypeScript and Python packages have no runtime
dependency, and the Rust crate's library has one, regex. They find the same
things as the SDKs, held to one set of test cases. You can plug in a model for
people's names, a CLI for pre-commit hooks and CI, and a local MCP server, and
in TypeScript a Vercel AI SDK middleware. When a person has to
decide whether something may be sent, Deliverd's Data Gate asks them and keeps
the record.

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
- **[`packages/sdk-rust`](packages/sdk-rust)**: `deliverd` on crates.io. Rust
  1.89 and up, async on tokio.
- **[`packages/sdk-dotnet`](packages/sdk-dotnet)**: `Deliverd` and
  `Deliverd.AgentFramework` on NuGet. .NET 8 and up.
- **[`packages/cli`](packages/cli)**: `deliverd` on npm. For build steps,
  pipelines, scripts and connecting your AI tools over MCP.
- **[`packages/screen`](packages/screen)**,
  **[`packages/screen-python`](packages/screen-python)** and
  **[`packages/screen-rust`](packages/screen-rust)**: Deliverd Screen,
  `@deliverd/screen` on npm and `deliverd-screen` on PyPI and crates.io.
- **[`packages/conformance`](packages/conformance)**: one table of behaviour
  every SDK must share: retries, idempotency, webhook signatures, durations,
  gating and data screening.
  Each SDK's test suite reads it, so a case added there fails in whichever
  language has not implemented it.

Each package's README is the page you see on npm, PyPI or crates.io, and covers
the package in full. The [developer docs](https://deliverd.dev/docs/developers/sdk?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme)
cover the API behind them.

## Running the tests

```bash
pnpm install
pnpm --filter @deliverd/sdk build   # release.test.ts reads dist/
pnpm vitest run

cd packages/sdk-python
PYTHONPATH=src python -m unittest discover -s tests

cd ../screen-python
PYTHONPATH=src python -m unittest discover -s tests

cd ../sdk-rust
cargo test

cd ../screen-rust
cargo test

cd ../sdk-dotnet
dotnet test Deliverd.slnx
```

## How this repository works

The packages are developed in Deliverd's own repository, beside the API they
call, and copied here after every change. The checks that hold them to that API
and to its documentation run there, on every change, before anything arrives
here; the tests in this repository are the ones that need nothing else.

So a pull request here is not merged here. Open one anyway, or an issue: we
carry the change across, credit you in the commit, and it comes back in the
next copy. Releases are published from this repository, by GitHub Actions with
npm's, PyPI's, crates.io's and NuGet's trusted publishing, so each release on npm
carries provenance linking it to the commit and workflow that built it.

## Security

Please report a vulnerability privately through the
[contact page](https://deliverd.dev/contact?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme)
rather than in an issue. How the service handles data is on
[deliverd.dev/security](https://deliverd.dev/security?utm_source=github&utm_medium=repository&utm_campaign=sdk-repo&utm_content=readme).

## Licence

[MIT](LICENSE). It covers the code in this repository only.
