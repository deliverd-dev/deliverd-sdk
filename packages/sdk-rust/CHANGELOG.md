# Changelog

> **Published from a public repository. The `deliverd` crate is built and released from [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk), Deliverd's public SDK repository, from 0.1.1 by GitHub Actions with crates.io trusted publishing, so each release comes from a workflow run anyone can inspect. Deliverd is growing and supports open source: the source is public, under the MIT licence.**

## Unreleased

### Added

- **Flows**: `flows()` with `create`, `get`, `list`, `find_by_external_id`,
  `resume`, `complete` and `cancel`, and a `Flow` handle with `refresh`,
  `close`, `cancel` and `evidence`. The app calls a flow a project.
- **Tasks**: `tasks()` with `create`, `get`, `list`, `find_by_external_id`,
  `update`, `complete`, `cancel` and `context`, and a `Task` handle with the
  same plus `reopen`.
- Development mode serves both, and `packages/conformance/cases.json` holds
  all three SDKs to the same restart behaviour for them.

## 0.1.1

A patch, with no change to the API. The README gains the Muse Spark section
the other SDKs already had, and this release is the first to go to crates.io
by trusted publishing from the public mirror rather than with a token.

## 0.1.0

The first release.

### Added

- **The six primitives**, as in the TypeScript and Python SDKs: `gate()`,
  `approve()`, `confirm()`, `review()`, `collect()` and `publish()`, each with
  a `_with` form taking a timeout, a progress callback and, for approvals, a
  question handler.
- **The handles behind them**: `approvals()`, `gates()`, `reviews()`,
  `collections()` and `reports()`, with `create`, `get`, `list`, `wait`,
  `cancel` and, on gates, `record_execution`.
- **Development mode**: `Deliverd::development()`, or `DELIVERD_MODE` and
  `DELIVERD_DEV_OUTCOME`, answers from memory with an imaginary approver.
- **Webhook and callback verification**: `webhooks::construct_event` and
  `webhooks::construct_callback`.
- **Which agent, on which model**: `.agent(DeclaredAgent::named(…))` and
  `.model(…)` on `ApprovalRequest`, `ReviewRequest` and `CollectionRequest`,
  returned as `agent` and `model` on the data. Recorded as declared.
- **Held to the other SDKs** by `packages/conformance/cases.json`: retries,
  `Retry-After`, idempotency keys, signatures, durations and gating.
