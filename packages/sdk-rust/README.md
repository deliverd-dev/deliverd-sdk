# deliverd

**You build the action. Deliverd handles the human.** Ask a person, wait for
the answer, act on it.

[Create a free account](https://deliverd.dev/sign-up?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=readme) ·
[Website](https://deliverd.dev/?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=readme) ·
[Quickstart](https://deliverd.dev/quickstart?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=readme) ·
[SDK docs](https://deliverd.dev/docs/developers/sdk?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=readme)

```bash
cargo add deliverd
cargo add tokio --features macros,rt-multi-thread
```

```rust
use deliverd::{ApprovalRequest, Deliverd};

#[tokio::main]
async fn main() -> deliverd::Result<()> {
    let deliverd = Deliverd::from_env()?;
    let decision = deliverd
        .approve(ApprovalRequest::new("Refund £1,240 to Acme").approver("Finance"))
        .await?;
    if decision.approved {
        refund().await;
    }
    Ok(())
}
```

That is the whole integration. The call waits until somebody decides, and
returns whether they said yes.

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=readme).
   The Free plan needs no card.
2. Name your organisation. The next page hands you a key: set it as
   `DELIVERD_API_KEY`.
3. Run the example above with `approver` naming someone in your organisation,
   or leave it out and the request goes to your owners and admins.

Want to see it work before you sign up? `Deliverd::development()` needs no key
and no network — see *Before you have an account* below.

What it stands in for: an approval page, the emails and the reminders, identity
and single sign-on, who is allowed to decide, a table to keep it in, an audit
trail, and the dashboard somebody uses to do it. None of that is yours to
build.

- **Async, on tokio.** HTTP is [reqwest](https://crates.io/crates/reqwest) with
  rustls, so nothing links against the system's OpenSSL.
- **The same behaviour as the TypeScript and Python SDKs.** Retries,
  idempotency keys, webhook signatures, durations and gating are held to theirs
  by one shared conformance table, which this crate's test suite reads.
- **Rust 1.89 and up.**

## Before you have an account

```rust
let deliverd = deliverd::Deliverd::development();
let decision = deliverd.approve(ApprovalRequest::new("Deploy to production")).await?;
```

No key, no network, nobody interrupted. It prints what the approver would have
seen, to stderr, and answers at once:

```
  ┌─ Deliverd · development mode ─────────────────────────
  │ Deploy release 4.2 to production
  │ 142 commits since 4.1. All checks green.
  │ Risk: high
  │ ✓ All checks green
  │
  │ Simulating: approved
  └───────────────────────────────────────────────────────
```

Every way a real request can end is one word away, including the one people
forget to write:

```rust
use deliverd::{Deliverd, DevelopmentOptions, DevelopmentOutcome};

let deliverd = Deliverd::builder()
    .development(DevelopmentOptions::default().outcome(DevelopmentOutcome::Rejected))
    .build()?;
```

Or flip a whole test suite from the command line: `DELIVERD_MODE=development`
turns it on, and `DELIVERD_DEV_OUTCOME` picks `approved`, `rejected`, `denied`
(a policy refusal, for gates), `timeout` or `question`. Development mode swaps
the transport and nothing else, so the code it exercises is the code that will
run in production: the same retries, the same errors, the same waiting.

## The primitives

```rust
deliverd.gate(GateRequest::new(action, external_id, input)).await?;   // may I? — your organisation answers
deliverd.approve(ApprovalRequest::new(title)).await?;                  // ask permission, and wait
deliverd.review(ReviewRequest::new(title).reviewer(who)).await?;       // ask whether it is right
deliverd.collect(CollectionRequest::new(title).question(q)).await?;    // ask for what you lack
deliverd.confirm(ApprovalRequest::new(title)).await?;                  // a yes or no → bool
deliverd.publish(PublishRequest::new(title, html)).await?;             // get the work to people
```

Six primitives, one API. Each one is a person your agent needs and cannot be.

## Asking with context

What the approver reads before deciding:

```rust
use deliverd::{ApprovalRequest, Factor, Risk};

deliverd
    .approve(
        ApprovalRequest::new("Deploy release 4.2 to production")
            .description("142 commits since 4.1. All checks green.")
            .risk(Risk::High)
            .factor(Factor::ok("All checks green"))
            .factor(Factor::warning("Touches the payments path").detail("3 files under /billing"))
            .link("The diff", "https://github.com/acme/app/compare/4.1...4.2")
            .approver("dave@example.com")
            .expires_in("4h")
            .external_id("deploy_4842"),
    )
    .await?;
```

`external_id` is your own reference. Pass one and a restarted agent reuses the
request it already made rather than asking a second time.

`expires_in` takes `"30m"`, `"4h"`, `"2d"` or a `std::time::Duration`. Requests
expire after a day unless you say otherwise, so a wait always ends.

## Answering the approver

A person can ask your agent a question from the approval page, and your agent
can answer it without anyone leaving what they are doing:

```rust
use deliverd::{on_question, AskOptions};

let options = AskOptions::default().on_question(on_question(|question, _approval| async move {
    // Some(answer) is posted; None leaves it for a person.
    Some(agent_answer(&question.question).await)
}));
let decision = deliverd.approve_with(request, options).await?;
```

## Waiting

The wait polls, backing off from a quarter of a second to thirty seconds with
jitter, so a hundred agents started by the same cron do not arrive together.
It returns when the request settles, **including on a rejection**: a refusal
is an answer, and `if decision.approved` is the line that should follow.

It fails only when the wait itself did:

```rust
let options = AskOptions::default().timeout(Duration::from_secs(30 * 60));
match deliverd.approve_with(request, options).await {
    Ok(decision) => { /* decided */ }
    Err(error) if error.is_timeout() => { /* nobody decided in time; it is still open */ }
    Err(error) => return Err(error),
}
```

Dropping the future abandons the wait, which is how you cancel one; the
request stays open until it expires.

## Gating

`gate()` asks your **organisation's policy** whether an action may happen at
all, and the answer comes from rules an administrator wrote and your code does
not see. Most calls never reach a person, because a rule settles them.

```rust
use deliverd::GateRequest;
use serde_json::json;

let decision = deliverd
    .gate(GateRequest::new(
        "finance.refund",
        format!("refund:{}", order.id),
        json!({ "customer_id": order.customer_id, "amount": 1240, "currency": "GBP" }),
    ))
    .await?;

if !decision.allowed {
    return Ok(()); // denied by a rule, or refused by a person
}
refund(&decision.input).await?;
```

**Use `decision.input`, not the value you passed.** It is what the action's
schema validated and what an approver actually saw, corrections included.

**The external id is required**, which nothing else here is. A random
per-attempt key guards a retried *request*; this guards a retried *decision*.
A crashed agent re-running its refund step must re-read the answer it already
got rather than ask a second person about the same money. Retrying with the
same id returns the same decision, with `reused` set.

`gate_with(request, GateOptions::default().no_wait())` returns as soon as the
decision is raised, pending or not; `deliverd.gates()` has `create`, `get`,
`record_execution` and `cancel` for work that resumes on a webhook.

## Before a model's tool call runs

A model that calls tools over an OpenAI-compatible API, such as Meta's Muse
Spark at `https://api.meta.ai/v1`, hands your loop the calls to make. Ask
before the ones that matter, keyed by the call's id so a retried loop does not
ask twice, and run what was approved:

```rust
use deliverd::ApprovalRequest;

// call: a `function_call` item from the response, its arguments parsed into `args`.
let decision = deliverd
    .approve(
        ApprovalRequest::new(format!("Allow the agent to run {}", call.name))
            .input(args.clone())
            .approver("finance")
            .expires_in("1h")
            .external_id(format!("muse-spark:{}", call.call_id)),
    )
    .await?;
let output = match decision.input {
    Some(approved) if decision.approved => run_tool(&call.name, approved).await,
    _ => format!("A person declined running {}. Do not retry it.", call.name),
};
// Send back {"type": "function_call_output", "call_id": call.call_id, "output": output}.
```

The TypeScript and Python SDKs do this loop for you: `runMuseFunctionCalls`
and `run_function_calls`.

## Webhooks and callbacks

```rust
use deliverd::webhooks::{construct_event, SIGNATURE_HEADER};

let event = construct_event(&secret, &raw_body, headers.get(SIGNATURE_HEADER))?;
```

Pass the raw body, exactly as it arrived: a re-encoded object is a different
string and will never verify. `construct_callback` does the same for a
request's own `callback_url`, with the `callback_secret` its handle carried.

## Errors

Every failure is a `DeliverdError` with the API's own `code()`, and
`is_auth()`, `is_rate_limit()`, `is_not_found()`, `is_conflict()` and
`is_timeout()` for the cases worth branching on. Rate limits and server errors
are retried for you, honouring `Retry-After`; a 4xx is not, because it will be
just as wrong in a second.

## Flows and tasks

A flow ties one job's approvals, reviews, requests and publishes together on
one timeline; the app calls it a project. A task keeps the job's objective
somewhere an agent can ask for it, apart from the conversation.

```rust
use deliverd::{ApprovalRequest, FlowRequest, TaskCompletion, TaskRequest};

// The open flow for this reference, started if there is none, so a restarted
// agent extends its job rather than starting a second.
let mut flow = deliverd.flows().resume(FlowRequest::new("Release 4.2").external_id("release-4.2")).await?;
deliverd.approve(ApprovalRequest::new("Deploy 4.2 to production").flow_id(flow.id())).await?;

// With an external_id, the objective you already started comes back
// (`task.resumed()`) instead of a second one.
let mut task = deliverd
    .tasks()
    .create(TaskRequest::new("Ship 4.2", "Release 4.2 in production").external_id("ship-4.2").flow_id(flow.id()))
    .await?;
let context = task.context().await?; // the objective first, then where it stands
task.complete(TaskCompletion::new("Shipped.")).await?;
flow.close().await?;
```

`flows()` has `create`, `get`, `list`, `find_by_external_id`, `resume`,
`complete` and `cancel`; `tasks()` has `create`, `get`, `list`,
`find_by_external_id`, `update`, `complete`, `cancel` and `context`. Both work
in development mode.

## The rest of the API

`deliverd.http()` is the authenticated client, with the same retries and
errors, for the parts of the API this crate has no named method for yet:
side tasks, findings, governance, comments and schedules.

```rust
let schedules: serde_json::Value = deliverd.http().get("/schedules").await?;
```

## Configuration

`Deliverd::from_env()` reads `DELIVERD_API_KEY`, and `DELIVERD_BASE_URL` and
`DELIVERD_MODE` when set. `Deliverd::builder()` sets any of them in code, with
the number of attempts, the per-request timeout and the transport.

## Licence

MIT. The Deliverd service it talks to is a separate, proprietary product.
