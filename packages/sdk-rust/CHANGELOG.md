# Changelog

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
- **Held to the other SDKs** by `packages/conformance/cases.json`: retries,
  `Retry-After`, idempotency keys, signatures, durations and gating.
