# Changelog

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
