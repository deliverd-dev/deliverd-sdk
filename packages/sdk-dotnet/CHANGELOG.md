# Changelog

> **Published from a public repository. `Deliverd` and `Deliverd.AgentFramework` are built and released from [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk), Deliverd's public SDK repository, since their first release, by GitHub Actions with NuGet trusted publishing, so each release comes from a workflow run anyone can inspect. Deliverd is growing and supports open source: the source is public, under the MIT licence.**

## 0.1.0 (unreleased)

The first release, as two packages.

### Added

- **`Deliverd`**: `DeliverdClient` with `ApproveAsync` and `GateAsync`,
  `Approvals` (create, get, find by external id, cancel, wait) and `Gates`
  (create, get, wait), `Webhooks.VerifySignature`, `DeliverdDuration.Parse`,
  and `Http` for every other route. Retries, `Retry-After` and idempotency
  keys are held to `packages/conformance/cases.json` with the other SDKs.
- **`Deliverd.AgentFramework`**: Microsoft Agent Framework tool approvals,
  decided by a person. `RunWithDeliverdApprovalsAsync` runs an agent until
  nothing waits on a person; `ResolveToolApprovalsAsync` does one round;
  `DeliverdToolApprovals.AutoApprovalRule` lets `ToolApprovalAgent` pass a
  call the organisation's policy already allows. Built against
  `Microsoft.Agents.AI` 1.25.0.
