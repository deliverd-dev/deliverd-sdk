# Changelog

## 0.26.0

A minor, for an addition. 0.25.1 went to npm on 15 October 2026 from 4c58d4e;
this was opened as 0.25.2.

### Added

- **A Mastra adapter** in `@deliverd/sdk/adapters`. Mark tools
  `requireApproval: true` (or pass `requireToolApproval`) as Mastra already
  has you do, and `generateWithDeliverdApprovals(agent, agent.generate(…),
  { deliverd })` turns each call the run suspends on into a Deliverd request:
  approved, it is `agent.approveToolCallGenerate({ runId, toolCallId })`;
  declined, `agent.declineToolCallGenerate({ runId, toolCallId, reason })`,
  so the model reads the person's reason. The run resumes until nothing waits
  on a person. `resolveMastraApproval` does one round and
  `pendingMastraApproval` reads which call a suspended output waits on; a
  tool's own `suspend()`, waiting on data rather than a decision, is left
  alone. No dependency on Mastra: the shapes follow `@mastra/core` 1.78.0's
  type definitions.
- **A Muse Spark adapter** in `@deliverd/sdk/adapters`, for Meta's model on
  the Meta Model API. `runMuseFunctionCalls(resp.output, runTool, { deliverd })`
  asks a person about each Responses API `function_call` and returns the
  `function_call_output` items for the next request; `runMuseToolCalls` does
  the same for a Chat Completions message's `tool_calls`. Only approved calls
  run, with the approver's corrections where `editable` allows them; a
  declined call's result is the person's reason. The shapes are the
  OpenAI-compatible ones `api.meta.ai/v1` serves.

### Changed

- **`WebhookEndpointFormat` takes `"discord"`**: an endpoint that posts each
  event to a Discord channel webhook as an embed with a link button.
- **The source is public.** The package is published from
  [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk),
  so the npm page's Repository link opens the code rather than a 404, and the
  release carries npm provenance: the commit and the workflow that built it.

## 0.25.1

A patch. 0.25.0 went to npm on 14 October 2026 from e914335. The API is
unchanged.

### Changed

- **The npm page says how to start.** The README opens with the three steps
  from install to a first request: a free account, an API key, the five
  lines. Its links to deliverd.dev, and the homepage and support links in
  `package.json`, carry `utm_source=npm&utm_medium=package&utm_campaign=sdk`,
  so a sign-up from this page is counted against it.
- **`no_api_key` says where an account comes from.** The hint ends with the
  free sign-up link and where the key is made, for the person who installed
  the package before they had either.

## 0.25.0

A minor, for an addition. 0.24.1 went to npm on 14 October 2026 from ae28b1c;
this was opened as 0.24.2.

### Added

- **The release a run tested** (`EvidenceRun.release`, or `release` beside
  `results`, a `report` or a `pull` in `SubmitEvidenceInput`): any of
  `provider`, `model`, `modelVersion`, `promptHash` and `guardrailsHash` —
  digests, never the text, as `deliverd governance release` records them.
  Evidence that names a release other than the one the AI system now runs
  does not count towards a control, so results of an old prompt cannot open
  the gate for a new one. Evidence that names none counts as before.
- **`otherRelease`** on a governed task's controls (how many pieces of
  evidence tested another release) and on each piece of evidence (how its
  release differs, in a sentence).

## 0.24.1

A patch. 0.24.0 went to npm on 14 October 2026 from 75da897, and the working
version has to be one the registry has not served. The code is unchanged.

### Fixed

- **The npm page's links open.** The homepage is the SDK's documentation,
  <https://deliverd.dev/docs/developers/sdk>, not an address that redirects
  there; issues go to <https://deliverd.dev/contact>, not to a repository
  nobody outside it can open; and the README's MCP link is
  <https://deliverd.dev/docs/developers/mcp>, not a page that asks a reader to
  sign in.

## 0.24.0

A minor, for an addition. 0.23.0 went to npm on 14 October 2026 from 9aa2d17;
this was opened as 0.23.1.

### Added

- **Weave as a pull source** (`EvidencePull.source: "weave"`): name an
  evaluation in the W&B project the organisation connected — the name its
  `Evaluation` was given or its run's, `{ source: "weave", experiment:
  "credit-memo-v12" }`, or the run's call id — and the server reads what its
  newest finished run returned with the organisation's key, mapped as a report
  sent as the dict `evaluate()` returns is, so one threshold meets either.
  Each case whose model or scorer raised is listed with a link to it. An owner
  or an administrator connects Weave in Admin → Integrations.

## 0.23.0

A minor, for an addition. 0.22.0 went to npm on 14 October 2026 from 5bdd3a4;
this was opened as 0.22.1.

### Added

- **Braintrust as a pull source** (`EvidencePull.source: "braintrust"`): name
  an experiment in the project the organisation connected in Braintrust —
  `{ source: "braintrust", experiment: "credit-memo-v12" }`, or its id — and
  the server reads Braintrust's summary of its scores with the organisation's
  key, mapped as a report sent with `braintrust eval --jsonl` is, so one
  threshold meets either. Each case that errored is listed with a link to
  it. An owner or an administrator connects Braintrust in Admin →
  Integrations.

## 0.22.0

A minor, for an addition. 0.21.0 went to npm on 14 October 2026 from fdba5f5;
this was opened as 0.21.1.

### Added

- **LangSmith as a pull source** (`EvidencePull.source: "langsmith"`): name an
  experiment in the organisation's connected LangSmith —
  `{ source: "langsmith", experiment: "credit-memo-v12" }`, its name or the
  prefix `evaluate()` was given, or `experimentId` — and the server reads its
  scores with the organisation's key, in the workspace it was connected for.
  Each evaluator becomes one result under its own key, and each run that
  failed is listed with a link to it. An owner or an administrator connects
  LangSmith in Admin → Integrations.

## 0.21.0

A minor, for an addition. 0.20.0 went to npm on 14 October 2026 from 0ff304d;
this was opened as 0.20.1.

### Added

- **An organisation's default thresholds on each governance control**
  (`GovernanceControl.thresholdsSource`, `GovernanceControl.defaultThresholds`).
  An owner or an administrator sets a default bar for an evidence control in
  Admin → Agent governance → Frameworks, and every governed task whose control
  has no thresholds of its own is judged against it. `thresholds` is now the
  bar that applies, `thresholdsSource` says whose it is (`task` or
  `organisation`), and `defaultThresholds` is the organisation's default
  whether or not the task has its own. A person sets both; no key does.

## 0.20.0

A minor, for an addition. 0.19.0 went to npm on 13 October 2026 from c055960;
this was opened as 0.19.1.

### Added

- **`pull` on `tasks.submitEvidence` and `task.submitEvidence`**
  (`EvidencePull`): name an experiment in the organisation's connected
  Langfuse — `{ source: "langfuse", experiment: "credit-memo-v12" }`, or
  `experimentId`, and `since` — instead of sending `results` or a `report`.
  The server reads it with the organisation's keys, which the caller never
  holds; an owner or an administrator connects Langfuse in Admin →
  Integrations. Each score becomes one result under its own name, and each
  failed item is listed with a link to its trace.

## 0.19.0

A minor, for an addition. 0.18.0 went to npm on 13 October 2026 from 3e504e2;
this was opened as 0.18.1.

### Added

- **`criticalFunction` on the governance profile** (`GovernanceProfileInput`,
  and so `Governance.profile`): whether the work supports a critical or
  important function under DORA (Art. 3(22)) — `true`, `false`, or `null`
  until classified, when production use stands in. DORA 2026.10.1 asks for a
  continuity policy, advanced testing, an exit strategy and the Art. 30(3)
  contract terms only of critical work. Set it when you govern a task; an
  agent may raise it to `true`, and only a person lowers or clears it.

## 0.18.0

A minor, for a removal. 0.17.0 went to npm on 13 October 2026 from 29fa0bb;
this was opened as 0.17.1.

### Removed

- **`tasks.setThresholds` and `task.setThresholds`.** Thresholds are set by a
  person, on the task's page in the app, and no key sets them — an agent's,
  or a person's own, which an agent may be holding — because whatever submits
  the results must not also decide what passes. The server refused the call
  to every key, so it never worked; the route behind it is gone too. Reading
  a control's `thresholds` and `scores` is unchanged.

## 0.17.0

A minor: Compliance Mode on tasks, with scored evidence. 0.16.0 went to npm on
12 October 2026 from 8d8877b; this was opened as 0.16.1 and renamed when the
surface grew.

### Added

- **`tasks.governance(id)`** — a governed task's controls (with their
  `thresholds` and `scores`), evidence, readiness and gate.
- **`tasks.submitEvidence(id, input)`** — evidence for the controls it speaks
  to: a link, what a run measured as `results`, or a tool's own `report`
  (`promptfoo`, `inspect`, `garak`, `weave`, `braintrust`, `junit` or
  `deliverd`), read by the server. A control with thresholds is met only when
  its newest scored evidence meets them.
- **`tasks.checkGovernanceGate(id, { action? })`** — `allowed`, what is
  missing, what blocks it, and the `scores` of each control with thresholds.
- **`tasks.setThresholds(id, control, thresholds | null)`** — what a control's
  scored evidence must meet. A person's key only; an agent's is refused with
  `not_permitted`.
- The same four on a `Task`, and the types: `EvidenceResult`, `EvidenceRun`,
  `EvidenceReport`, `SubmitEvidenceInput`, `ControlThresholds`, `Governance`,
  `GovernanceGateCheck` and the rest.

## 0.16.0

A minor: a share can let its audience comment. 0.15.0 went to npm on 9
October 2026 from 6d6ba5e; this was opened as 0.15.1 and renamed when the
surface grew.

### Added

- **`reports.share(idOrSlug, audience, { capability })`** — `"view"` (the
  default) or `"comment"`, sent as `capability` on
  `POST /reports/{idOrSlug}/share`. Leave it out and the request is the same
  as before.
- The shapes: `ShareOptions` and `ShareCapability`.

### Worth knowing

- "Can manage", which lets someone share a report on, is not offered: it is a
  person's decision, made in the app, and the API refuses it from a key.
- A signal passed third, `share(id, audience, signal)`, still works.

## 0.15.0

A minor: an approver decides inside your product, and an organisation's
webhook endpoints are managed from code. 0.14.0 went to npm on 8 October
2026 from 87414b1; this was opened as 0.14.1 and renamed when the surface
grew.

### Added

- **`approvals.createSession(approvalId, { approver, mode, origin, returnUrl, expiresIn })`**
  — a decision session: a page on which one approver decides one request.
  `mode: "hosted"` returns a `url` to send them to, and `returnUrl` brings
  them back with `deliverd_session` and `deliverd_decision` added.
  `mode: "embedded"` returns a `clientSecret` to mount with
  `Deliverd.mountDecision` from `https://deliverd.dev/elements/v1.js`, framed
  only by `origin`. `url` and `clientSecret` are returned once. Neither
  decides anything: the approver signs in, or confirms a code sent to their
  own address, first.
- **`decisionSessions.get(id)` and `decisionSessions.expire(id)`** — where a
  session stands (`open`, `verified`, `complete`, `expired`, with the
  approver's decision) and ending one early.
- **`ListApprovalsInput.approver`** — `approvals.list({ approver, status: "pending" })`
  is one person's inbox: a member's id or email, or an admitted guest's email.
- **`deliverd.webhookEndpoints`**, over `/api/v1/webhook-endpoints`:
  `list()` / `listPage()`, `create()`, `get()`, `update()`, `delete()` and
  `test()`. `create()` returns the endpoint with its signing `secret` — the
  only call that ever does. `test()` sends one event now and returns what the
  endpoint answered.
- The shapes: `WebhookEndpoint`, `CreatedWebhookEndpoint` (with `secret`),
  `WebhookTestResult`, `WebhookEndpointFormat`, and the inputs
  `CreateWebhookEndpointInput`, `UpdateWebhookEndpointInput`,
  `TestWebhookEndpointInput` and `ListWebhookEndpointsInput`.
- The `WebhookEndpoints` class.

### Worth knowing

- Every webhook endpoint call needs the `webhooks:manage` scope **and** a key
  held by an owner or an administrator, checked on every call
  (`not_permitted` otherwise). An agent key is refused, reads included
  (`agent_not_permitted`). A key issued before the scope existed does not
  have it: reissue it.
- Development mode simulates neither decision sessions nor webhook endpoints:
  they answer `not_in_development_mode`.
- No new webhook events.

## 0.14.0

A minor: a task keeps its reports.

### Added

- `taskId` on `PublishReportInput` and `UpdateReportInput`: the task (an
  objective or a side task) a report is written for. It is then listed on the
  task and returned in its context. A later publish naming another task moves
  it there; leaving `taskId` out keeps it where it is. Naming a task needs
  `tasks:read` on the key, and the Tasks feature on the plan
  (`feature_unavailable` otherwise).
- `flowId` on `PublishReportInput`, which the API has accepted since flows
  shipped and the type could not send.
- `reports` on `TaskContext`, typed as `TaskContextReport` (`id`, `title`,
  `url`, `version`, `publishedAt`): up to ten live reports published for the
  task, newest first. Empty in development mode, which publishes nothing.
- `taskId` on `ReportData`.

## 0.13.0

A minor: Compliance Mode.

### Added

- `governance` on `CreateTaskInput`, typed as `GovernanceProfileInput`, to
  govern an objective from the start: the AI system, purpose, owners, risk,
  data classification and oversight. Business and Enterprise only; other
  plans are refused with `feature_unavailable`.

## 0.12.0

A minor: Task Graph. What the work is for, kept apart from the conversation
doing it.

### Added

- **`deliverd.tasks`**: `create()` (an objective; with `externalId`, an open
  one you already started comes back instead, `resumed: true`), `get()`,
  `list()` / `listPage()`, `context()`, `graph()`, `update()`,
  `createSideTask()`, `addFinding()`, `requestDecisionApproval()`,
  `complete()`, `apply()`, `reopen()`, `cancel()` and `link()`.
- **`Task`**, the handle those return: the same calls without the id, plus
  `refresh()`, and `active`, `completed`, `cancelled`, `isSideTask` and
  `resumed` to branch on.
- The shapes: `TaskData`, `TaskState`, `TaskStatePatch`, `TaskSnapshot`,
  `TaskResult`, `TaskNode`, `TaskFinding`, `TaskContext`, `TaskGraph`,
  `AppliedSideTask`, `DecisionApproval`, `TaskLinkResult` and their parts,
  and an input type for each call.
- Development mode serves the Task Graph offline, except
  `requestDecisionApproval()`, which needs the real API.
- Errors for the Task Graph's refusals (`version_conflict`, `not_completed`,
  `already_applied`) carry a `hint` naming the call that comes next.
- Webhook event names `task.completed`, `task.blocked` and
  `side_task.completed`. The last two reach only an endpoint that names them.

### Worth knowing

- A decision recorded as a finding is a suggestion until a person confirms
  it. `requestDecisionApproval()` is how one is put to somebody; it needs the
  `approvals:write` scope as well as `tasks:write`.
- Only a person changes what a task is for: `update({ objective })` from an
  agent is refused. Record the change you propose as a finding.
- No new webhook events.

## 0.11.1

No change to the API: the same surface as 0.11.0, republished from 82161f5.

## 0.11.0

A minor: agent governance. A gate's answer becomes a scoped permission, and
what an agent does with it is recorded.

### Added

- **The scope of the act.** `CreateGateInput` takes `destination`,
  `classification`, `risk` and `artifact` (a Deliverd report version, or the
  sha256 of a file you hold). An approval covers exactly that scope and nothing
  else. Also `description`, `agent` (who you are when you ask through a
  person's connector), `execution` (the run it belongs to, found by its id or
  started), `supersedesGateId` (the request this revises after a person asked
  for changes), `callbackUrl` and `metadata`.
- **`canExecute`** on `GateData` and `Gate`: whether you may act on it *now* —
  authorised, inside its window, with a use left, not revoked. Branch on this
  rather than `allowed`. With it, `decision` (`ALLOW`, `APPROVAL_REQUIRED`,
  `REVIEW_REQUIRED`, `DENY`), `blockedBecause`, `scope`, `authorisation`
  (`validUntil`, `maxUses`, `usesRemaining`), `actionId`, `agentId`, `flowId`,
  `supersedesGateId`, `description`, `requestedBy`, `createdAt`, and on a
  single read `executions`.
- **`deliverd.gates.check()`**, the same call as `create()` named for what it
  does; **`recordExecution()`**, **`cancel()`**, **`release()`** and
  **`evidence()`**, and `Gate#recordExecution()` / `Gate#cancel()`.
- Statuses `changes_requested`, `revoked` and `used` on a gate, and
  `changes_requested` on an approval.
- Webhook and callback events: `approval.changes_requested`, and a gate's
  whole life — `gate.created`, `gate.approved`, `gate.rejected`,
  `gate.changes_requested`, `gate.expired`, `gate.cancelled`, `gate.revoked`,
  `gate.executed`. The gate events are sent only to an endpoint that names them.

### Fixed

- The timeout message from `Gate#wait()` named an input field called `action`
  where it meant the action id.

### Worth knowing

- `canExecute: true` is your organisation's authorisation only. The platform
  your agent runs on may still require its user's confirmation, or refuse.
- Reporting execution spends a use. A different artifact hash is refused as
  `approval_invalidated`; a different destination as `destination_mismatch`.

## 0.10.0

A minor: approvals and gate results gain `concerns`.

### Added

- **`concerns`** on `ApprovalData` and `GateData`: what the organisation's
  ethics rules asked whoever decides to weigh, as `{ principle, rule, concern }`,
  as the rules read when the request was made. Empty when nothing matched.

### Worth knowing

- A request with concerns is approved with a written reason, and never from
  the sign-in-free link in an approval email. Expect it to take longer.
- At the gate, a concern turns a policy's `allow` into a person. A refusal by
  an ethics rule is a `denied` whose `reason` is the rule's concern.

## 0.9.0

A minor: callbacks, framework adapters and approve-with-changes add to the public surface.

### Added

- **Be called back instead of polling.** `CreateApprovalInput`,
  `CreateReviewInput` and `CreateCollectionInput` take `callbackUrl`. When a
  person answers, Deliverd POSTs the outcome there, signed, and retries if
  your endpoint is down. The handle `create()` returns carries
  `callbackSecret`, handed over once; keep it with whatever receives the
  callback.
- **`constructCallback(callbackSecret, rawBody, signature)`**, also as
  `deliverd.webhooks.constructCallback`, verifies and parses one into a
  `CallbackEnvelope` (`event`, `sentAt`, `requestType`, `requestId`, `data`).
  `approval.question` means the approver asked something and is waiting on
  your answer; every other event is the request settling.
- **`@deliverd/sdk/adapters`: a person approves tool calls inside the agent
  framework you already use.** No new dependencies; each adapter matches its
  framework's own approval hook.
  - Claude Agent SDK: `canUseTool: deliverdCanUseTool({ deliverd, when })`.
  - Vercel AI SDK: `toolApproval: deliverdToolApproval({ deliverd, when })`.
  - OpenAI Agents SDK: `runWithDeliverdApprovals((input) => run(agent, input), input, { deliverd })`,
    or `resolveInterruptions(result, { deliverd })` for a loop you own.
  - LangGraph: `approveInGraph(deliverd, { interrupt, threadId, step, title, callbackUrl })`
    pauses the graph, and `resumeFromCallback(envelope)` says which thread to
    resume when the callback lands. The decision is read from Deliverd, never
    from the resume value, so a stray resume cannot approve anything.

  Each tool call is one request, keyed by its call id, so a retried call does
  not ask twice. A decline reaches the model as the person's reason; a
  timeout is a decline, not a crash.
- **Approve with changes.** `approve()` and `approvals.create()` take `input`
  — the arguments you will run with — and `editableFields`, the ones a person
  may correct. The approver sees the values and can change those fields before
  approving; the `Decision` carries `input`, what to run with, and `changes`,
  what they changed. `input` is null for anything but an approval, so run with
  `decision.input`, never with what you proposed. A gate's approval offers the
  fields its action registered as editable, and `GateDecision.input` is the
  corrected input, with `changes` beside it. Development mode applies
  `edits` from its options, so the path runs offline.

### Not changed

`wait()` still polls. A callback is for code that should not hold a process
open while a person decides: a serverless function, a durable workflow.

## 0.8.2

A patch, and it has to be one: nothing was added to the public surface. No new
export, no new method, no change to `DeliverdError` or to the four predicates
you branch on. What changed is what the errors *say* — ten codes that used to
arrive as the server's sentence and no next step now carry one.

### Changed

- **The gate and its policy explain themselves.** `unknown_action`,
  `invalid_input`, `invalid_rules`, `duplicate` and `superseded` had no entry
  at all: the newest surface in the API and the one a reader is least likely
  to recognise. The first two are met through `gate()`; the last three come
  from authoring policy, which no namespace covers, so you reach them through
  `deliverd.http`.

- **Five 404s say which kind of "not there" they mean.** `not_found`,
  `agent_not_found`, `upload_not_found`, `question_not_found` and
  `quote_not_found`. Two of these carry a fact the server's message cannot,
  and they are the reason this entry is worth reading:

  - **A 404 is also what this API says when the thing exists and is not
    yours.** It does not say which, deliberately — saying would tell you
    whether the id exists for somebody else. So "it was deleted" is a guess,
    and a retry cannot turn it into anything else.

  - **A publish consumes the bundle it reads.** `upload_not_found` is what a
    *second* publish with the same `uploadId` gets, which usually means the
    first one worked. Look at the report before uploading again, or you will
    publish it twice.

- **`insufficient_scope` says the part that stops a wasted retry:** nothing is
  wrong with the credential, so replacing it with another carrying the same
  scopes fails identically. The key has to be reissued with the scope named.

### Not changed

`auth_error`'s hint is back to what it was in 0.8.1 after briefly carrying
scope advice in development. A missing scope is `insufficient_scope`, which
the API has answered separately since 21 September 2026; before that the two
shared a code, so an older server answers `auth_error` for both and the
credential hint is the right one to read.

## 0.8.1

No change any caller can see. The two tarballs were downloaded from npm and
diffed: 0.8.1 differs from 0.8.0 in `src/released.ts` and in the version field
of `package.json`, and in nothing else. It is the ledger that records 0.8.0,
published.

It has an entry because it exists. A version on the registry with no line here
is how this changelog started disagreeing with npm in the first place, and
"nothing changed" is a fact worth being able to look up — somebody comparing
0.8.0 with 0.8.1 should find out in one place that the answer is nothing,
rather than diffing two tarballs to prove it.

## 0.8.0

A minor, not a patch: `gate()` and its namespace are new API, and everything
you wrote against 0.7.1 still compiles.

### Added

- **`gate()`** — ask whether to act, before acting. The other five primitives
  ask a named person something; this one asks your **organisation's policy**
  whether the action may happen at all, and the answer comes from rules an
  administrator wrote and your code does not see.

  ```ts
  const decision = await deliverd.gate({
    action: "finance.refund",
    externalId: `refund:${order.id}`,
    input: { customer_id: order.customerId, amount: 1240, currency: "GBP" },
  });
  if (!decision.allowed) return;
  await stripe.refunds.create(decision.input);
  ```

  Three answers, one field to branch on: a rule permitted it, a rule refused it
  (`reason` and `rule` say which — do not retry it under another name), or no
  rule settled it and a person was asked, in which case `gate()` waited for
  them. `wait: false` returns as soon as the decision is raised.

  **Execute with `decision.input`, not the object you passed.** It is what the
  action's schema validated and what an approver actually saw. Passing your
  original works right up until somebody edits a value before approving, and
  then it spends an approval for £1200 on a refund of £1240.

  **`externalId` is required**, which no other call here is. A random
  per-attempt idempotency key guards a retried *request*; this guards a retried
  *decision*. A crashed agent re-running its refund step must re-read the
  answer it already got rather than ask a second person about the same money —
  and no id this library could invent would know which two calls are the same
  attempt. A retry with the same id returns the same decision, `reused: true`.

- **`deliverd.gates`** — `create()` and `get()`, plus the `Gate` handle with
  `wait()`, `refresh()` and `toDecision()`, for work that resumes on a webhook
  rather than inside the call.

- **`CreateGateInput`, `GateData`, `GateDecision`, `GateStatus`,
  `GateOutcomeName`, `GateOptions`, `GateWaitOptions`** and the `gate.denied`
  webhook event.

- **`denied` as a development outcome.** `DELIVERD_DEV_OUTCOME=denied`
  rehearses a *policy* refusal — the one ending nothing else here can have, and
  the branch agents most often forget to write. The other four mean what they
  always did, and `denied` on an approval is treated as `rejected`.

## 0.7.1

Behaviour only. Nothing was added, removed or renamed, so nothing you wrote
against 0.7.0 changes.

### Fixed

- **A `501 Not Implemented` is no longer retried.** It was asked three times,
  with backoff, before the error reached you — so a call the server does not
  implement took about two and a half seconds to say so. "Not implemented" is
  a fact about the server rather than about this moment, which is the same
  argument that has always excluded 4xx.

  The Python SDK fixed this months ago and the fix was never carried back
  here. It was found by a new shared table — `packages/conformance/cases.json`
  in the Deliverd repository — that both SDKs' test suites now read, so a
  retry policy that differs between the two languages fails in whichever one
  is wrong. This is the first thing it caught, on its first run.

  429 and every other 5xx retry exactly as before.

## 0.7.0

Everything below shipped in the repository between 0.6.2 and now, under a
version number npm had already served — so if you are on 0.6.2, you have none
of it. Fifty-four additions to the public surface and nothing removed, so
nothing you wrote against 0.6.2 stops compiling.

### One correction worth reading first

**`decidedBy` is now a person's name, not their user id.**

It was documented as the decider and returned a uuid, so the flagship call
handed you a key you could not log or put in a message without a second lookup.
Every other primitive already named the person — a review verdict's `by`, a
collection reply's `respondent` — and `requestedBy` on the same approval object
was already a label.

```ts
const decision = await deliverd.approve({ title: "Refund £1,240" });

decision.decidedBy;    // was "8f3c…-…"   →  now "Sarah Chen"
decision.decidedById;  // new             →  "8f3c…-…"
```

**If you compared `decidedBy` to a user id, read `decidedById` instead.** The
same change applies to `ApprovalData`, the webhook payload and development
mode, which previously settled to an email-shaped string and so taught an
offline loop a shape production never delivered.

### Added

- **`decidedById`** on `Decision` and `ApprovalData` — see above.
- **`deliverd.schedules`** — create, update and delete a recurring publish.
  Read-only before this.
- **Analytics** — `reports.analytics(id)` and `reports.orgAnalytics()`, with
  `ReportAnalytics` and `OrgAnalytics`. The half worth having is
  `inactiveReports`: the live reports nobody has opened, which no per-report
  call can surface because it is an absence.
  *These endpoints returned zeros for every caller until the server fix that
  shipped alongside this — if you built on those figures, you built on zeros.*
- **`comments.open()`** — every open thread across the organisation, with
  `OpenThread`. "Is anything waiting on me?" without naming a report first.
- **`reports.send()`** — up to fifty addresses and a covering note, with
  `SendResult`. `alreadyHadAccess` names the recipients who could already open
  it and were emailed again anyway, which is the point when somebody says they
  never got the first one.
- **`cursor` on every list input**, completing the paging convention: a `limit`
  means one page, no `limit` means all of them.
- **`approval.escalated`** webhook event. A request nobody answers now reaches
  more people — a standing rule can hold its approvers back and bring them in
  after a deadline, and anybody already asked can bring somebody in by hand.
  Escalation only ever widens.

### Fixed

- `reports.archive(id, false)` archived the report. The route ignored its body
  while the SDK had been sending `{ archived: false }` since it shipped.
- `reports.rollback()` could not succeed at all — the route accepted only
  `versionId` while the SDK sent `{ version }`.
- OAuth (`dlvo_`) access tokens now reach the REST API. Completing a consent
  and then getting "Invalid API key format" from all forty-eight routes was
  the whole flow failing at the last step.

### Note

Requests are idempotent across the client's own retries, and
`idempotencyKey` is accepted if you want to own the key. A POST that arrived
and lost its response on the way back is no longer a second approval request
with two people asked to authorise one act.

---

## 0.6.2 and earlier

Not recorded here. This changelog starts where the release ledger does — see
`src/released.ts` for why reconstructing them would be a guess dressed as a
fact.
