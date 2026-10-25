# Changelog

> **Now published from a public repository. From 0.19.0, `deliverd` is built and released from [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk), Deliverd's public SDK repository, by GitHub Actions with PyPI's trusted publishing, so each release carries provenance linking it to the commit and workflow that built it. Versions up to 0.18.1 were published from a private repository under a single developer's account. Deliverd is growing, and as a company that supports open source it no longer made sense to keep it there: the source is now public, under the MIT licence. If PyPI shows a change of provenance or source repository at 0.19.0, this is why.**

## 0.19.2

A patch. 0.19.1 went to PyPI on 21 October 2026 from 9d480e9.

### Added

- **`risk_indicator.breached`** in `WEBHOOK_EVENTS`: an AI risk indicator went
  red for a month, with its figure, limits, owner and a link to the stop
  controls. It never stops anything itself.

## 0.19.1

A patch. 0.19.0 went to PyPI on 21 October 2026 from 80475ec.

### Fixed

- **A no-break space counts as a space in `screen()`**, as it does in the
  TypeScript SDK: "born on" followed by a no-break space and a date is found
  as a date of birth, and the same for `password = "..."`.
- **Reasons read properly**: "2 IP addresses", "2 dates of birth" and
  "1 Irish PPS number", where they said "2 IP addresss", "2 date of births"
  and "1 irish pps number".

## 0.19.0

A minor, for additions. 0.18.1 went to PyPI on 15 October 2026 from 4c58d4e;
this was opened as 0.18.2, and it carries that patch's change too.

### Added

- **Names, from a model you plug in.** `deliverd.screen()` takes
  `detectors`, callables from the text to spans that run on your machine
  beside the patterns, and `spans` already found. A new kind, `person_name`,
  is counted like any other. The open-source `deliverd-screen` has adapters
  for Hugging Face pipelines and Presidio. `DetectedSpan` is exported.

- **`deliverd.governance`, the rest of Compliance Mode**, sync and async, as
  in the TypeScript SDK. `ai_systems.list`, `get`, `register`, `update` and
  `record_model_change`; `check_authority(action)`; `incidents.report`, `get`,
  `list`, `list_page` and `draft_report`; and `frameworks()`,
  `framework_mapping()`, `create_custom_framework()`, `ict_register()` and
  `summary()`, which return the API's own dicts. On tasks, `govern`,
  `update_governance_profile`, `request_control_approval`,
  `trigger_reassessment` and `evidence_pack`. New models: `AiSystem`,
  `AiSystemDetail`, `AuthorityDecision`, `AiIncident`, `AiIncidentDetail`,
  `IncidentReport`, `ReportingSchedule`, `ReportingStep`,
  `DraftedIncidentReport`, `Reassessment`, `ReassessmentResult`,
  `ModelChangeResult` and `ControlApprovalResult`.
- **`deliverd.screen(text, ai_system_id=...)`**, the pre-send check: before
  text goes to an AI model, find the email addresses, phone numbers, IBANs,
  card numbers, national identifiers, secrets, special-category data and your
  own terms in it, and ask Deliverd whether that model may receive them. The
  detectors run in the SDK, so only counts by kind are sent, never the text.
  `allow` sends it as it is; `redact` gives `screened.text` with placeholders
  such as `[EMAIL_1]`, and `screened.restore(answer)` puts the values back;
  `ask` waits for a person's approval; `deny` sends nothing. Every paid
  plan; on Free the call is refused with `feature_unavailable`. The detectors are
  held to the TypeScript SDK's by `packages/conformance/screening.json`.
- **Pydantic AI** (`deliverd.adapters.pydantic_ai`). `deliverd_approvals(deliverd, ...)`
  is a `HandleDeferredToolCalls` capability that answers the tool calls an
  agent defers for approval — `requires_approval=True`, `ApprovalRequired`,
  `ApprovalRequiredToolset` — inside the run. Each is a request keyed
  `pydantic-ai:<tool_call_id>`; a declined call goes back to the model as
  `ToolDenied` with the person's reason. A call nobody decided before `timeout`
  is left in the run's `DeferredToolRequests` output, for
  `resolve_deferred_tool_requests` (and `_sync`) to answer later.
- **CrewAI** (`deliverd.adapters.crewai`). `register_deliverd_approvals(deliverd, ...)`
  registers a before and an after tool-call hook: the before hook asks and
  waits, the after hook replaces CrewAI's "Tool execution blocked by hook" with
  why the call did not run. A call is keyed by its task and input
  (`crewai:<task id>:<digest>`), since CrewAI gives a call no id. A wait that
  runs out blocks the call, and any failure to ask blocks it too, because
  CrewAI runs the tool when a hook raises. `deliverd_tool_hooks` returns the
  pair unregistered, for one crew's `@before_tool_call` and `@after_tool_call`.

- **Amazon Bedrock Agents** (`deliverd.adapters.bedrock`).
  `invoke_with_deliverd_approvals(client, deliverd, invoke_kwargs=...)` invokes
  an agent through boto3's `bedrock-agent-runtime` client and answers each
  return of control on the same session: `CONFIRM`, or `DENY` with the person's
  reason in `responseBody`. Each call is keyed `bedrock:<invocationId>:<n>`.
  Return of control without confirmation (`RESULT`,
  `USER_CONFIRMATION_AND_RESULT`) is answered when `run_action` is given, and
  runs only approved calls. `confirmation_results_for` (and `_async`) does one
  round.
- **Strands Agents** (`deliverd.adapters.strands`), for agents on Amazon
  Bedrock AgentCore. `DeliverdApprovals(deliverd, ...)` is a hook provider whose
  before-tool-call hook asks and waits; anything but an approval sets
  `cancel_tool` to the reason. Keyed `strands:<toolUseId>`; fails closed.
- **Google ADK and Vertex AI Agent Engine** (`deliverd.adapters.adk`).
  `deliverd_before_tool_callback(deliverd, ...)` (and `_async`) is a
  `before_tool_callback` that returns `{"error": reason}` for a call that was
  not approved; `run_with_deliverd_confirmations(app, deliverd, ...)` answers
  `adk_request_confirmation` for an `AdkApp` on Agent Engine, and
  `confirmation_responses_for` (and `_async`) does one round. Both keyed
  `adk:<function call id>`.
- **Muse Spark** (`deliverd.adapters.muse_spark`), for Meta's model on the
  Meta Model API. `run_function_calls(deliverd, resp.output, run_tool, ...)`
  asks about each Responses API `function_call`, runs only the approved ones
  and returns a `function_call_output` for every call: the result, or why it
  did not run. `run_tool_calls` does the same for a Chat Completions message's
  `tool_calls`, and both have `_async` variants. Calls are keyed
  `muse-spark:<call id>`.

None of these frameworks becomes a dependency: the adapters read their objects
by shape and import nothing from them until they build an answer or register a
hook.

- **`agent` and `model` on `approve()`, `review()` and `collect()`** and their
  `create()`s, sync and async. Say which agent is asking
  (`agent={"name": ..., "provider": ..., "external_id": ...}`, each optional)
  and the model it runs on. The API stores them, puts them in the request's
  audit event and shows them on the request and its project, marked as
  declared; nothing is decided on them. `ApprovalData`, `ReviewData` and
  `CollectionData` return them as `agent` (a `DeclaredAgent`) and `model`,
  `None` when unsaid. Development mode echoes them.

### Changed

- **`WEBHOOK_FORMATS` takes `"discord"`**: an endpoint that posts each event
  to a Discord channel webhook as an embed with a link button.

### Changed

- **The source is public.** The package is published from
  [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk),
  and the PyPI page gains Source and Changelog links to it.

## 0.18.1

A patch. 0.18.0 went to PyPI on 14 October 2026 from e914335. The API is
unchanged.

### Changed

- **The PyPI page says how to start.** The README opens with a free-account
  link and the three steps from install to a first request, and the project
  links gain "Free account". Every deliverd.dev link on the page carries
  `utm_source=pypi&utm_medium=package&utm_campaign=python-sdk`, so a sign-up
  from it is counted against this package.
- **`no_api_key` says where an account comes from.** The hint ends with the
  free sign-up link, for the person who installed the package before they had
  an account.

## 0.18.0

A minor, for an addition. 0.17.0 went to PyPI on 14 October 2026 from fdba5f5;
this was opened as 0.17.1.

### Added

- **The release a run tested** (`release=` on `tasks.submit_evidence` and
  `task.submit_evidence`, beside `results`, a `report` or a `pull`, and
  `EvidenceRun.release`, an `EvidenceRelease`): any of `provider`, `model`,
  `model_version`, `prompt_hash` and `guardrails_hash` — digests, never the
  text, as `deliverd governance release` records them. Evidence that names a
  release other than the one the AI system now runs does not count towards a
  control, so results of an old prompt cannot open the gate for a new one.
  Evidence that names none counts as before.
- **`other_release`** on a governed task's controls (how many pieces of
  evidence tested another release) and on each piece of evidence (how its
  release differs, in a sentence).

### Changed

- **`tasks.submit_evidence` and `task.submit_evidence` say that `pull` reads
  LangSmith, Braintrust and Weave too** (`{"source": "langsmith", "experiment":
  "credit-memo-v12"}`, or `"source": "braintrust"` or `"weave"`, whose
  `experiment` is the evaluation's name).
  `pull` is passed as given, so this works with any version that has it; the
  server reads it once LangSmith is connected in Admin → Integrations.

## 0.17.0

A minor, for an addition. 0.16.0 went to PyPI on 14 October 2026 from 0ff304d;
this was opened as 0.16.1.

### Added

- **An organisation's default thresholds on each governance control**
  (`GovernanceControl.thresholds_source`, `GovernanceControl.default_thresholds`).
  An owner or an administrator sets a default bar for an evidence control in
  Admin → Agent governance → Frameworks, and every governed task whose control
  has no thresholds of its own is judged against it. `thresholds` is now the
  bar that applies, `thresholds_source` says whose it is (`task` or
  `organisation`), and `default_thresholds` is the organisation's default
  whether or not the task has its own. A person sets both; no key does.

## 0.16.0

A minor, for an addition. 0.15.0 went to PyPI on 13 October 2026 from 3e504e2;
this was opened as 0.15.1.

### Added

- **`pull` on `tasks.submit_evidence` and `task.submit_evidence`**, sync and
  async: name an experiment in the organisation's connected Langfuse —
  `{"source": "langfuse", "experiment": "credit-memo-v12"}`, with
  `experiment_id` or `since` if needed — instead of sending `results` or a
  `report`. The server reads it with the organisation's keys, which the caller
  never holds; an owner or an administrator connects Langfuse in Admin →
  Integrations.

## 0.15.0

A minor, for a removal, and the PyPI page. 0.14.0 went to PyPI on 13 October
2026 from 29fa0bb; this was opened as 0.14.1.

### Removed

- **`tasks.set_thresholds` and `task.set_thresholds`**, sync and async.
  Thresholds are set by a person, on the task's page in the app, and no key
  sets them — an agent's, or a person's own, which an agent may be holding —
  because whatever submits the results must not also decide what passes. The
  server refused the call to every key, so it never worked; the route behind
  it is gone too. Reading a control's `thresholds` and `scores` is unchanged.

### Changed

- **The README**, which is the PyPI page, now shows sharing with
  `capability="comment"` (0.13.0), Compliance Mode evidence and the governance
  gate (0.14.0), and `confirm()`, none of which it mentioned. The development
  mode example imports `DevelopmentOptions`, which it used without importing.
  In-page links, which PyPI renders without anchors, and the maintainers'
  release steps (now `RELEASING.md`) are gone; the closing links go to public
  pages rather than to paths in this repository.
- **The project links** go to deliverd.dev — the docs, the quickstart, the API
  reference and support — rather than to `/developers`, which only redirects,
  and to Source and Issues links that are 404 for anyone outside this private
  repository.
- **The licence** is the PEP 639 expression `MIT`, so the sidebar says "MIT"
  rather than the whole licence text; the licence classifier it replaces is
  deprecated alongside it.
- **Python 3.14** is listed, and CI now runs the suite on it as well as on 3.9.

## 0.14.0

A minor: Compliance Mode on tasks, with scored evidence. 0.13.0 went to PyPI
on 12 October 2026 from 8d8877b; this was opened as 0.13.1 and renamed when the
surface grew.

### Added

- **`tasks.governance(task_id)`** — a governed task's controls (with their
  `thresholds` and `scores`), evidence, readiness and gate.
- **`tasks.submit_evidence(task_id, type, title, ...)`** — evidence for the
  controls it speaks to: a link, what a run measured as `results`, or a tool's
  own `report` (`promptfoo`, `inspect`, `garak`, `weave`, `braintrust`, `junit`
  or `deliverd`), read by the server. A control with thresholds is met only
  when its newest scored evidence meets them.
- **`tasks.check_governance_gate(task_id, action=None)`** — `allowed`, what is
  missing, what blocks it, and the `scores` of each control with thresholds.
- **`tasks.set_thresholds(task_id, control, thresholds)`** — what a control's
  scored evidence must meet, or `None` to clear. A person's key only; an
  agent's is refused with `not_permitted`.
- The same four on a `Task` and awaited on `AsyncDeliverd`, and the types:
  `Governance`, `GovernanceControl`, `GovernanceGateCheck`, `EvidenceResult`,
  `EvidenceRun`, `ControlThresholds` and the rest.

## 0.13.0

A minor: a share can let its audience comment. 0.12.0 went to PyPI on 9
October 2026 from 6d6ba5e; this was opened as 0.12.1 and renamed because it
adds to the API.

### Added

- **`reports.share(report_id, audience, capability=None)`**, and the same on
  `AsyncDeliverd` — `"view"` (the default) or `"comment"`, sent as
  `capability` on `POST /reports/{idOrSlug}/share`. Leave it out and the
  request is the same as before.

### Worth knowing

- "Can manage", which lets someone share a report on, is not offered: it is a
  person's decision, made in the app, and the API refuses it from a key.

## 0.12.0

A minor: an approver decides inside your product, and an organisation's
webhook endpoints are managed from code. 0.11.0 went to PyPI on 9 October
2026 from f49dba0; this was opened as 0.11.1 and renamed because it adds to
the API.

### Added

- **`approvals.create_session(approval_id, approver, mode="hosted", origin=None, return_url=None, expires_in=None)`**
  — a decision session: a page on which one approver decides one request.
  `mode="hosted"` returns a `url` to send them to; `mode="embedded"` returns a
  `client_secret` to mount with `https://deliverd.dev/elements/v1.js`, framed
  only by `origin`. Both come back once. Neither decides anything: the
  approver signs in, or confirms a code sent to their own address, first.
- **`decision_sessions.get(session_id)` and `decision_sessions.expire(session_id)`**,
  and the `DecisionSession` model.
- **`approvals.list(approver=...)`** — one person's inbox: a member's id or
  email, or an admitted guest's email. On `list_page` too, and on the async client.
- **`deliverd.webhook_endpoints`**, over `/api/v1/webhook-endpoints`:
  `list()` / `list_page()`, `create()`, `get()`, `update()`, `delete()` and
  `test()`, with the same names awaited on `AsyncDeliverd`. `create()` returns
  the endpoint with its signing `secret` — the only call that ever does.
  `test()` sends one event now and returns what the endpoint answered.
- `WebhookEndpoint`, `CreatedWebhookEndpoint` (with `secret`),
  `WebhookTestResult` and `WEBHOOK_FORMATS`.

### Worth knowing

- Every webhook endpoint call needs the `webhooks:manage` scope **and** a key
  held by an owner or an administrator, checked on every call
  (`not_permitted` otherwise). An agent key is refused, reads included
  (`agent_not_permitted`). A key issued before the scope existed does not
  have it: reissue it.
- Development mode simulates neither decision sessions nor webhook endpoints:
  they raise `development_only`.
- `update()` leaves out any argument you do not pass, so `description=None`
  does not clear a description; pass `description=""` for that.

## 0.11.0

A minor: a person approves the tool calls of an agent built on Microsoft's
stack. 0.10.0 went to PyPI on 8 October 2026 from 87414b1.

### Added

- **`deliverd.adapters.agent_framework`**, for Microsoft Agent Framework
  (`agent-framework` 1.x). `run_with_deliverd_approvals(agent, messages,
  session, deliverd, ...)` runs the agent and answers every
  `function_approval_request` with a person's decision, on the same session,
  until nothing is waiting. `resolve_approval_requests()` (awaited) and
  `resolve_approval_requests_sync()` do one round for a loop you own.
  `deliverd_approval_rule()` is an `auto_approval_rules` entry for
  `ToolApprovalMiddleware` and `create_harness_agent` that lets a call through
  without a prompt when it needs no person.
- **`deliverd.adapters.foundry`**, for Microsoft Foundry Agent Service's MCP
  approvals (`azure-ai-projects` 2.x). `run_with_deliverd_approvals(client,
  deliverd, create_kwargs=...)` answers every `mcp_approval_request` with
  `mcp_approval_response` items chained by `previous_response_id`, and
  `approval_responses_for()` does one round. Both have `_async` twins.
- `deliverd.adapters.Resolution`, what a round came to: `responses` to send,
  `pending` call ids, and the `reasons` each declined call was declined for.
  `CallDescription`, `default_description()` and `DEFAULT_TOOL_EXPIRY` (an
  hour) beside it.

Every adapter takes `approvers`, `when(tool, input)`, `describe`, `actions`
(a tool put to a Deliverd action's gate instead of an approval), `expires_in`,
`timeout`, `flow_id` and `metadata`. Each call is one request keyed by its
call id — `agent-framework:<call_id>`, `foundry:<id>` — so a retried round
does not ask twice.

### Worth knowing

- Neither framework is a dependency, and importing an adapter imports neither.
  Agent Framework's `Message` is imported when the loop sends one.
- A wait that runs out leaves the call **pending**, not refused: both
  frameworks keep the request answerable, and the Deliverd request is found
  again by its id.
- A call approved only with changes is **declined**, with the approved values
  in its reason. Neither framework can run a corrected call.
- Agent Framework tells the model that a declined call was rejected and not
  why: its approval response has no field for a reason. Foundry's answer
  carries the reason in `reason`; `send_reason=False` leaves it off.

## 0.10.0

A minor: a task keeps its reports.

### Added

- `task_id=` on `reports.publish()` and `reports.update()`: the task (an
  objective or a side task) a report is written for. It is then listed on the
  task and returned in its context. A later publish naming another task moves
  it there; leaving `task_id` out keeps it where it is. Naming a task needs
  `tasks:read` on the key, and the Tasks feature on the plan
  (`feature_unavailable` otherwise).
- `flow_id=` on `reports.publish()`, which the API has accepted since flows
  shipped and this package could not send.
- `reports` on `TaskContext`, a list of `TaskContextReport` (`id`, `title`,
  `url`, `version`, `published_at`): up to ten live reports published for the
  task, newest first. Empty in development mode, which publishes nothing.
- `task_id` on `ReportData`.

New keyword arguments go after `idempotency_key`, so a call that passes the
existing ones by position still means what it did.

## 0.9.0

A minor: Compliance Mode.

### Added

- `governance=` on `tasks.create()`, a dict with the API's field names, to
  govern an objective from the start: the AI system, purpose, owners, risk,
  data classification and oversight. Business and Enterprise only; other
  plans are refused with `feature_unavailable`.

## 0.8.0

A minor: Task Graph. What the work is for, kept apart from the conversation
doing it.

### Added

- **`deliverd.tasks`**: `create()` (an objective; with `external_id`, an open
  one you already started comes back instead, `task.resumed`), `get()`,
  `list()` / `list_page()`, `context()`, `graph()`, `update()`,
  `create_side_task()`, `add_finding()`, `request_decision_approval()`,
  `complete()`, `apply()`, `reopen()`, `cancel()` and `link()`, awaited in
  `deliverd.aio` as well.
- **`Task`**, the handle those return: the same calls without the id, plus
  `refresh()`, and `active`, `completed`, `cancelled`, `is_side_task` and
  `resumed`.
- `TaskData`, `TaskState`, `TaskSnapshot`, `TaskResult`, `TaskNode`,
  `TaskFinding`, `TaskContext`, `TaskGraph`, `AppliedSideTask`,
  `DecisionApproval`, `TaskLinkResult` and their parts; `TASK_KINDS`,
  `TASK_STATUSES`, `SETTABLE_TASK_STATUSES`, `TASK_OUTCOMES`,
  `FINDING_KINDS`, `DECISION_STATUSES` and `TASK_LINK_KINDS`.
- Development mode serves the Task Graph offline, except
  `request_decision_approval()`, which needs the real API.
- Errors for the Task Graph's refusals (`version_conflict`, `not_completed`,
  `already_applied`) carry a `hint` naming the call that comes next.
- Webhook event names `task.completed`, `task.blocked` and
  `side_task.completed`. The last two reach only an endpoint that names them.

### Fixed

- `deliverd.aio` annotated two return types with class names that do not
  exist (`AsyncGateDecision`, `AsyncReviewOutcome`). They are the plain
  `GateDecision` and `ReviewOutcome` they always returned.

### Worth knowing

- A decision recorded as a finding is a suggestion until a person confirms
  it. Putting one to an approval needs `approvals:write` as well as
  `tasks:write`.
- Only a person changes what a task is for: `update(objective=...)` from an
  agent is refused. Record the change you propose as a finding.

## 0.7.1

No change to the API: the same surface as 0.7.0, republished from 82161f5.

## 0.7.0

A minor: agent governance. Gates say whether you may act *now*, what the
permission covers, and take a report of what you did with it.

### Added

- **`Gate.can_execute`**: authorised, inside its window, with a use left, not
  revoked. Branch on this rather than `allowed`. It is the organisation's
  authorisation only — the platform your agent runs on may still ask its user
  to confirm, or refuse.
- **`Gate.decision`**, **`blocked_because`**, **`scope`**, **`changes_requested`**;
  `GateData` gains `decision`, `can_execute`, `blocked_because`, `scope`,
  `authorisation`, `action_id`, `agent_id`, `flow_id`, `supersedes_gate_id`,
  `description`, `requested_by`, `created_at`, `callback_secret` and
  `executions`.
- **`gates.create()`** takes `description`, `destination`, `classification`,
  `risk`, `artifact`, `agent`, `execution`, `supersedes_gate_id`,
  `callback_url` and `metadata`. **`gates.check()`** is the same call, named
  for what it does.
- **`Gate.record_execution()`** / **`gates.record_execution()`**: report what
  was done. A different artifact hash is refused as `approval_invalidated`, a
  different destination as `destination_mismatch`, a second use as `gate_used`.
- **`Gate.cancel()`** / **`gates.cancel()`**, **`gates.release()`** (Deliverd
  makes a staged report version live, and the receipt is `verified`) and
  **`gates.evidence()`**.
- `ExecutionReceipt`, `GATE_DECISIONS`; `changes_requested`, `revoked` and
  `used` statuses; `approval.changes_requested` and the opt-in `gate.*`
  webhook events.
- The development transport simulates execution and cancellation.

### Fixed

- A gate's `input` is sent with its keys exactly as written. They were
  converted to camelCase, so a policy matching on `amount_gbp` never saw it.
- A development gate's `settledAt` is a timestamp, not a clock reading.

## 0.6.0

A minor: `ApprovalData` and `GateData` gain `concerns`.

### Added

- **`concerns`**: what the organisation's ethics rules asked whoever decides to
  weigh, as `{"principle", "rule", "concern"}` dicts, as the rules read when the
  request was made. Empty when nothing matched. `None` from a server that
  predates it.

### Worth knowing

- A request with concerns is approved with a written reason, and never from
  the sign-in-free link in an approval email.
- At the gate, a concern turns a policy's `allow` into a person.

## 0.5.0

A minor: callbacks and approve-with-changes add to the public surface.

### Added

- **Approve with changes.** `approve()` and `approvals.create()` take `input`
  (the arguments you will run with) and `editable_fields` (the ones a person
  may correct). The `Decision` carries `input`, what to run with, and
  `changes`, what they changed, as `{"field", "from", "to"}` dicts. `input` is
  `None` for anything but an approval, so run with `decision.input`. Gates
  return the corrected input with `changes` too. Development mode applies
  `DevelopmentOptions(edits=...)`, so the path runs offline.
- **Be called back instead of polling.** `approve()`, `review()`, `collect()`
  and their `create()` methods take `callback_url`. When a person answers,
  Deliverd POSTs the outcome there, signed, and retries if your endpoint is
  down. The handle `create()` returns carries `callback_secret`, which is
  handed over once; keep it with whatever receives the callback.
- **`deliverd.webhooks.construct_callback(callback_secret, body, header)`**
  verifies and parses one, returning a `CallbackEnvelope` (`event`,
  `sent_at`, `request_type`, `request_id`, `data`). `approval.question` means
  the approver asked something and is waiting on your answer; every other
  event is the request settling.

### Not changed

`wait()` still polls. A callback is for code that should not hold a process
open while a person decides: a serverless function, a durable workflow.

## 0.4.1

A patch, and it has to be one: nothing was added to the public surface. No new
export, no new method, no change to `DeliverdError` or to the four properties
you branch on — `is_auth`, `is_rate_limit`, `is_not_found`, `is_conflict`.
What changed is what the errors *say*: ten codes that used to arrive as the
server's sentence and no next step now carry one.

### Changed

- **The gate and its policy explain themselves.** `unknown_action`,
  `invalid_input`, `invalid_rules`, `duplicate` and `superseded` had no entry
  at all: the newest surface in the API and the one a reader is least likely
  to recognise. The first two are met through `deliverd.gate()`; the last
  three come from authoring policy, which no namespace covers, so you reach
  them through `deliverd.http`.

- **Five 404s say which kind of "not there" they mean.** `not_found`,
  `agent_not_found`, `upload_not_found`, `question_not_found` and
  `quote_not_found`. Two carry a fact the server's message cannot:

  - **A 404 is also what this API says when the thing exists and is not
    yours.** It does not say which, deliberately — saying would tell you
    whether the id exists for somebody else. So "it was deleted" is a guess,
    and a retry cannot turn it into anything else.

  - **A publish consumes the bundle it reads.** `upload_not_found` is what a
    *second* publish with the same `upload_id` gets, which usually means the
    first one worked. Look at the report before uploading again, or you will
    publish it twice.

- **`insufficient_scope` says the part that stops a wasted retry:** nothing is
  wrong with the credential, so replacing it with another carrying the same
  scopes fails identically. The key has to be reissued with the scope named.

### Not changed

`auth_error`'s hint is back to what it was in 0.4.0 after briefly carrying
scope advice in development. A missing scope is `insufficient_scope`, which
the API has answered separately since 21 September 2026; before that the two
shared a code, so an older server answers `auth_error` for both.

`aio.py` is generated from the synchronous client and needed no regeneration:
the explanations are data, not methods, and `AsyncDeliverd` reads the same
table.

## 0.4.0

### Added

- **`gate()`** — ask whether to act, before acting. The other primitives ask a
  named person something; this one asks your **organisation's policy** whether
  the action may happen at all, and the answer comes from rules an
  administrator wrote and your code does not see.

  ```python
  decision = deliverd.gate(
      action="finance.refund",
      external_id=f"refund:{order.id}",
      input={"customer_id": order.customer_id, "amount": 1240, "currency": "GBP"},
  )
  if not decision.allowed:
      return
  stripe.Refund.create(**decision.input)
  ```

  Three answers, one field to branch on: a rule permitted it, a rule refused it
  (`reason` and `rule` say which — do not retry it under another name), or no
  rule settled it and a person was asked, in which case `gate()` waited for
  them. `wait=False` returns as soon as the decision is raised.

  **Execute with `decision.input`, not the dict you passed.** It is what the
  action's schema validated and what an approver actually saw.

  **`external_id` is required**, which no other call here is. A random
  per-attempt key guards a retried *request*; this guards a retried *decision*.
  A crashed agent re-running its refund step must re-read the answer it already
  got rather than ask a second person about the same money — and no id this
  library could invent would know which two calls are the same attempt.

- **`deliverd.gates`** — `create()` and `get()`, for work that resumes on a
  webhook rather than inside the call. `AsyncDeliverd.gates` mirrors it, and a
  handle that comes back is an async handle.

- **`GateData`, `GateDecision`, `GATE_STATUSES`, `GATE_OUTCOMES`** and the
  `gate.denied` webhook event.

- **`denied` as a development outcome.** `DELIVERD_DEV_OUTCOME=denied`
  rehearses a *policy* refusal — the one ending nothing else here can have, and
  the branch agents most often forget to write. The other four mean what they
  always did.

## 0.3.0

### Added

- **`AsyncDeliverd`** — the same client, awaited. Same names, same arguments,
  same return types, and a handle that comes back is an async handle, so
  `await (await deliverd.approvals.create(...)).wait()` cannot quietly block
  your event loop.

  ```python
  from deliverd.aio import AsyncDeliverd
  deliverd = AsyncDeliverd()
  outcomes = await asyncio.gather(*[deliverd.approve(title=t) for t in titles])
  ```

  **Every call runs the synchronous one on a worker thread**, and that is a
  decision rather than a shortcut. This package has no dependencies — checked,
  and most of why anyone trusts it — and the standard library has no async HTTP
  client, so a native transport would mean hand-written HTTP/1.1 and TLS over
  `asyncio` streams: several hundred lines of protocol in a package whose pitch
  is that there is nothing to audit.

  You get ergonomics and real concurrency; you pay one thread per call in
  flight. Right for the tens of concurrent asks an agent makes, wrong for
  thousands.

  `webhooks`, and the `to_decision()` / `to_outcome()` / `to_collected()`
  conversions, are not awaited: no request, so no `await`.

  The module is generated from the synchronous classes by
  `scripts/gen_async.py`, and the committed file is held to that script's
  output, so a method cannot exist on one client and not the other.

That closes the last named difference between this package and
`@deliverd/sdk`.

## 0.2.1

### Fixed

- **Development mode no longer pretends to publish.** `publish()` with
  `mode="development"` returned `status: "published"` and a `deliverd.dev`
  URL that resolves to nothing — the one shape in the offline transport that
  could be mistaken for the real thing and pasted to somebody. It raises now,
  naming the call and the remedy, which is what every other unsupported call
  there already did.

  Asking a person can be simulated because there is an imaginary approver and
  the answer is a value. Publishing puts bytes somewhere, and there is nowhere
  local to put them.

- **Flows work offline.** `flows.resume()`, `flow.approve()`, `evidence()`,
  `close()` and `cancel()` all ran against the live API and raised
  `development_only` offline, so the example in this README's own Flows
  section failed on its first line without a key. The same routes the
  TypeScript SDK has served for a while.

Both were found by a new check that reads the two SDKs' development
transports and refuses a route one serves and the other does not — the two
had drifted in opposite directions, each in silence.

## 0.2.0

Everything the TypeScript SDK offers, except one thing that is named below.

### Added

- **`deliverd.flows`** — the thread that ties one job's asks together.
  `flows.resume(title=…, external_id=…)` is the flow for a reference, started
  if it does not exist, so a restarted agent extends the job rather than
  beginning a second one. The handle is the point: `flow.approve(…)` is the
  ordinary call with the flow already named, because a `flow_id` passed by hand
  at four call sites is one that gets left off the fifth.
  `flow.evidence()` returns the whole record — every step, who was asked, what
  they said — for when somebody asks you to show your working.
- **`deliverd.comments`** — `list()` for one report's threads, `open()` for
  every open thread in the organisation without naming a report first,
  `create()`, `resolve()` and `retract()`.
- **`deliverd.schedules`** — `list()`, `create()`, `update()` and `delete()`
  for a recurring publish. Nothing here publishes: the sweep marks a schedule
  due and your agent does the work.

That closes the gap 0.1.0 named. Twelve new response types, each held to its
TypeScript counterpart field for field by a guard in the Deliverd repository.

### Still different from the TypeScript SDK

- **No async client.** Everything blocks. Inside `asyncio`, use
  `await asyncio.to_thread(deliverd.approve, title=…)`.

That is now the only difference, and it is checked, so it cannot quietly
become two.

### Unchanged and worth repeating

A bare duration is **seconds** here and milliseconds in TypeScript, because
that is what each language's own timers take. `"30m"`, `"4h"` and `"2d"` mean
the same in both.

---

## 0.1.0

First release. `approve()`, `confirm()`, `review()`, `collect()`, publishing,
webhook verification, and a development mode that runs the whole loop offline
with no key and no network. No dependencies; Python 3.9 and up.
