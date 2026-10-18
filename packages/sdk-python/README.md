# deliverd

**You build the action. Deliverd handles the human.** Ask a person, wait for
the answer, act on it.

[Create a free account](https://deliverd.dev/sign-up?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme) ·
[Website](https://deliverd.dev/?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme) · [Quickstart](https://deliverd.dev/quickstart?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme) ·
[SDK docs](https://deliverd.dev/docs/developers/sdk?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme) ·
[TypeScript SDK](https://www.npmjs.com/package/@deliverd/sdk)

```bash
pip install deliverd
```

```python
from deliverd import deliverd

decision = deliverd.approve(title="Refund £1,240 to Acme", approvers=["Finance"])
if decision.approved:
    refund()
```

That is the whole integration. The call blocks until somebody decides, and
returns whether they said yes.

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme).
   The Free plan needs no card.
2. Name your organisation. The next page hands you a key: set it as
   `DELIVERD_API_KEY`.
3. Run the example above with `approvers` naming someone in your organisation,
   or leave it out and the request goes to your owners and admins.

Want to see it work before you sign up? `Deliverd(mode="development")` needs no
key and no network — see *Before you have an account* below.

What it stands in for: an approval page, the emails and the reminders, identity
and single sign-on, who is allowed to decide, a table to keep it in, an audit
trail, and the dashboard somebody uses to do it. None of that is yours to
build.

- **No dependencies.** The standard library has HTTP, HMAC and JSON. Nothing
  new lands in your agent's environment.
- **Python 3.9 and up.**
- **Calls block, or await.** `deliverd.approve(...)` is the shape an agent tool
  wants: the function that asks is the function that answers. Inside `asyncio`,
  `AsyncDeliverd` has the same names — see *Awaiting instead* below.
- **The same surface as the TypeScript SDK**, held to it field for field by a
  shared conformance suite — the six primitives (`gate()`, `approve()`,
  `confirm()`, `review()`, `collect()`, `publish()`), flows, tasks, reports,
  comments, schedules, Compliance Mode evidence and webhook verification.
- **Inside the agent frameworks you already use.** `deliverd.adapters` answers
  the tool approvals of Microsoft Agent Framework, Microsoft Foundry, Pydantic
  AI, CrewAI, Meta's Muse Spark, Amazon Bedrock Agents, Strands Agents (Bedrock
  AgentCore) and Google ADK (Vertex AI Agent Engine) with a person's decision,
  without any of them becoming a dependency. All eight are below.

---

## Before you have an account

```python
from deliverd import Deliverd

deliverd = Deliverd(mode="development")
decision = deliverd.approve(title="Deploy to production")
print(decision.approved)   # True
```

No key, no network, no colleague to interrupt. The imaginary approver decides
instantly, and the four things that can happen to a real request are all one
line away:

```python
from deliverd import DevelopmentOptions

Deliverd(mode="development", development=DevelopmentOptions(outcome="rejected"))
Deliverd(mode="development", development=DevelopmentOptions(outcome="timeout"))
Deliverd(mode="development", development=DevelopmentOptions(outcome="question"))
```

or `DELIVERD_DEV_OUTCOME=question` in the environment, so a whole test suite
flips without touching the code.

**`question` is the one people forget to write.** An approver can ask the agent
something before deciding, and until it is answered nothing moves:

```python
decision = deliverd.approve(
    title="Refund £1,240 to Acme",
    on_question=lambda q, approval: "Yes — staged on Tuesday",
)
```

Return `None` from the handler to leave it for a person.

Development mode is a stand-in transport, not a branch inside the client, so
the retries, the error handling and the polling are the same code that runs in
production. It answers the calls the primitives make — approve, gate, confirm,
review, collect, and flows — and returns 501 for everything else, rather than
pretending to be the whole API. **Publishing is the one it will not fake**: asking a
person has an imaginary approver and an answer, while publishing puts bytes
somewhere and there is nowhere local to put them, so a made-up "published"
with a URL that resolves to nothing would be worse than the refusal.

## Configuration

```python
from deliverd import Deliverd

deliverd = Deliverd()                      # DELIVERD_API_KEY from the environment
deliverd = Deliverd(api_key="dlv_…")       # or pass it
```

| Variable | What |
|---|---|
| `DELIVERD_API_KEY` | A `dlv_` key from Settings → API tokens, or a `dlvo_` OAuth access token |
| `DELIVERD_BASE_URL` | Override for a self-hosted deployment |
| `DELIVERD_MODE` | `development` to run the loop offline |
| `DELIVERD_DEV_OUTCOME` | `approved` · `rejected` · `timeout` · `question` |

The module-level `deliverd` builds itself from the environment the first time
you touch it, so the shortest form has no setup line at all. Build a `Deliverd`
yourself when you need two keys, a different base URL, or development mode.

## The six primitives

| | You want | Call |
|---|---|---|
| **Gate** | May this happen at all? — your organisation's policy answers | `gate()` |
| **Approval** | May I do this? | `approve()` |
| **Confirmation** | Are you sure? — lower ceremony | `confirm()` |
| **Review** | Is what I made right? | `review()` |
| **Information** | A figure, a date, a choice | `collect()` |
| **Publishing** | People need to read this | `publish()` |

### Approve

```python
decision = deliverd.approve(
    title="Refund £1,240 to Acme",
    description="Duplicate charge on invoice 4821.",
    risk="high",
    factors=[{"label": "Customer charged twice", "status": "warning"}],
    links=[{"label": "Invoice 4821", "url": "https://…"}],
    approvers=["Finance"],          # a person, a team, a group — or omit it
    expires_in="4h",
)

decision.approved        # True only for an approval
decision.status          # approved | rejected | expired | cancelled
decision.note            # their reason, when they gave one
decision.decided_by      # "Sarah Chen" — a name, not an id
decision.decided_by_id   # their user id, when the key is what you need
decision.url             # the page they decided on
```

**A refusal is an answer, not an error.** `approve()` returns on rejected,
expired and cancelled as well as approved; it raises only when the *wait*
failed — a timeout, a cancellation, or an API it could not reach.

`approvers` takes a person (email or user id), the name of a team or directory
group, or a word meaning the whole organisation. Naming a team is usually what
you want: a request addressed to one person waits for that person to come back
from holiday.

### Confirm

```python
if deliverd.confirm(title="Email 2,400 customers about the price change?"):
    send_campaign()
```

`confirm()` takes what `approve()` takes and returns a plain `bool`. It
defaults to low risk and an hour to answer, because that is what "are you
sure?" means; something that deserves a day and a paragraph of evidence
deserves `approve()`.

### Gate

`gate()` is the one primitive whose answer is not a named person's to give. It
asks your **organisation's policy** whether a registered action may happen,
with the arguments you will actually run with; a rule allows it, a rule
refuses it, or nobody has written a rule and a person is asked.

```python
decision = deliverd.gate(
    action="finance.refund",
    external_id=f"refund:{order.id}",
    input={"customer_id": order.customer_id, "amount": 1240, "currency": "GBP"},
)
if not decision.allowed:
    return                      # denied by a rule, or refused by a person
stripe.Refund.create(**decision.input)
```

Run with `decision.input`, not the object you passed: it is what the action's
schema validated and what an approver saw. `external_id` is required, because
it guards a retried *decision* rather than a retried request — a restarted
agent re-reads the answer it already has instead of asking a second person
about the same money. `DELIVERD_DEV_OUTCOME=denied` rehearses a refusal
before you have an account.

### Review

```python
outcome = deliverd.review(
    title="Q3 board pack",
    report_id=report.id,
    instructions="Check the figures against the ledger.",
    reviewers=["partner@firm.example"],
)
if not outcome.approved:
    revise(outcome.verdicts, outcome.thread_count)
```

### Collect

```python
answers = deliverd.collect(
    title="Before I file the Q3 return",
    respondents=["finance@firm.example"],
    questions=[
        {"prompt": "Headcount at 30 September", "kind": "number"},
        {"prompt": "Any disposals in the quarter?", "kind": "boolean"},
    ],
)
if answers.complete:
    file_return(answers["Headcount at 30 September"])
```

`answers` is keyed by the question as you asked it. Check `complete` before you
use it: a request that expired has whatever arrived and no more.

### Publish

```python
result = deliverd.publish(title="Weekly figures", content=html, audience=["Acme"])
if result.held:
    print("Waiting on a person before anyone can open it")
else:
    print(result.url)
```

## Restarting safely

Give a request your own `external_id` and a restarted agent finds the request it
already filed rather than asking two people about one act:

```python
deliverd.approve(title="Refund £1,240", external_id=f"refund-{invoice.id}")
```

That is best effort — two *concurrent* calls can still both find nothing. For
the guarantee, pass `idempotency_key`, which the server enforces.

## Waiting

```python
approval = deliverd.approvals.create(title="Deploy production")
print("Waiting at", approval.url)
approval.wait(on_poll=lambda a: print(".", end=""), timeout="30m")
```

Polling backs off — a quick first look so a fast decision reads as one, then
somebody's afternoon rather than a progress bar. Pass a `threading.Event` as
`cancel` to stop a wait from another thread.

Every request expires, so a wait always ends: 24 hours unless you pass
`expires_in`.

> **Durations are seconds here, not milliseconds.** `timeout=30` is half a
> minute, because `time.sleep` takes seconds and so does everything else in
> Python. The string forms — `"30m"`, `"4h"`, `"2d"` — and `timedelta` mean the
> same thing in every Deliverd SDK. (The TypeScript package reads a bare number
> as milliseconds, for the mirror-image reason.)

## Errors

```python
from deliverd import DeliverdError, DeliverdTimeoutError

try:
    deliverd.approve(title="…")
except DeliverdTimeoutError:
    ...                      # you stopped waiting; the request is still open
except DeliverdError as err:
    err.code                 # the API's own code: self_approval, rate_limited…
    err.is_auth              # 401 or 403
    err.is_rate_limit        # 429
    err.is_not_found         # 404
    err.is_conflict          # 409 — re-read and try again
    err.hint                 # the one thing to do next
```

Messages say what happened and what to do about it, rather than handing you a
code to search for.

## Webhooks

```python
from deliverd import construct_event, SIGNATURE_HEADER

@app.post("/webhooks/deliverd")
def receive():
    event = construct_event(
        secret=os.environ["DELIVERD_WEBHOOK_SECRET"],
        body=request.get_data(as_text=True),     # the RAW body
        header=request.headers.get(SIGNATURE_HEADER),
    )
    if event.event == "approval.approved":
        ...
```

`body` must be the raw request body. A re-encoded object is a different string
and will never verify — in FastAPI that is `(await request.body()).decode()`, in
Django `request.body.decode()`.

`construct_event` raises rather than returning `None`, because a route that
treats an unverifiable body as "no event" answers 200 and tells whoever is
posting that everything is fine.

## Webhook endpoints

Add, change and remove the endpoints themselves from code rather than under
Admin → Webhooks. The secret comes back from `create()` **once** — no other
call returns it — so store it where your receiver reads it.

```python
endpoint = deliverd.webhook_endpoints.create(
    url="https://hooks.example.com/deliverd",
    events=["approval.approved", "approval.rejected"],  # leave out for everything
)
save_secret(endpoint.secret)

result = deliverd.webhook_endpoints.test(endpoint.id)  # result.delivered, result.response_status
deliverd.webhook_endpoints.update(endpoint.id, enabled=False)
deliverd.webhook_endpoints.delete(endpoint.id)
```

These need a key with `webhooks:manage` held by an owner or an administrator.
An agent key is refused, reads included: an endpoint receives every event in
the organisation.

## Lists

```python
deliverd.approvals.list()                    # every one, following the cursor
deliverd.approvals.list(limit=20)            # one page of twenty
page = deliverd.approvals.list_page(limit=20)
page.items, page.next_cursor
```

**A `limit` means one page. No `limit` means all of them.** A full page and a
complete list are otherwise indistinguishable until somebody counts.

## Flows

A flow is the thread that ties one job's asks together. The handle is the
reason it is in this SDK rather than only in the API:

```python
flow = deliverd.flows.resume(title="Q3 close", external_id=f"close-{period}")

flow.approve(title="Sign off the trial balance", approvers=["Partners"])
flow.collect(title="Any disposals?", respondents=["finance@firm.example"],
             questions=[{"prompt": "Any disposals in the quarter?", "kind": "boolean"}])
flow.close()
```

Each of those is the ordinary call with the flow already named. A `flow_id`
passed by hand at four call sites is one that gets left off the fifth, and that
step is then missing from the history with nothing to say so.

`resume()` is what a restartable agent wants: the flow for this reference,
started if it does not exist. `flow.evidence()` is the whole record — every
step, who was asked, what they said — for when somebody asks you to show your
working.

## Tasks

An agent deep in a debugging session forgets what it set out to do, because
the objective is a paragraph thousands of tokens back. A task keeps it
somewhere the agent can ask for, and a side task keeps a detour from taking
over the thread:

```python
task = deliverd.tasks.create(
    title="Ship SSO",
    objective="Customers can sign in with their own identity provider.",
    external_id="sso-rollout",  # a restart resumes this one
)

side = task.create_side_task(
    title="Token audience", goal="Find why the API refuses the token.", kind="debug"
)
side.add_finding(kind="evidence", title="aud is the SPA client id")
side.complete(
    summary="The token is issued for the wrong audience.",
    suggested_next_action="Request the token for the API audience.",
)

context = side.apply().context  # the result, carried into the parent
context.root_objective          # said first, always
context.reanchor                # one paragraph to say back to yourself
```

`task.context()` is what to read instead of the history, and it lists the
reports already published for the task. `task.graph()` is the whole tree, and
`deliverd.tasks.list(status="active")` lists objectives. A finding of kind
`decision` is a suggestion until a person confirms it;
`task.request_decision_approval(finding_id)` puts it to somebody.

A status report is written from that context and kept with the task:

```python
context = task.context()
html = render_status(context)  # your own: objective, state, decisions, what is open

if context.reports:  # newest first
    deliverd.reports.update(context.reports[0].id, content=html, change_summary="This week")
else:
    deliverd.reports.publish(title="SSO rollout: status", content=html, task_id=task.id)
```

The report is then listed on the task's page and in its context, so the next
status report is a new version of it rather than a second one. A later publish
naming another `task_id` moves it there; leaving it out keeps it where it is.
It needs `tasks:read` on the key.

## Sharing

```python
deliverd.reports.share(report.id, "Finance team")                        # can read it
deliverd.reports.share(report.id, "partner@firm.example", capability="comment")
```

`capability` is `"view"` (the default) or `"comment"`. Letting someone share a
report on is a person's decision, made in the app, and a key is refused it.

## Compliance Mode

On a governed task (Business and Enterprise), an agent records what it ran as
evidence, and asks the task's gate before it ships:

```python
task.submit_evidence(
    type="model_evaluation",
    title="Nightly promptfoo run",
    controls=["model_evaluation"],
    report={"format": "promptfoo", "content": open("results.json").read()},
)

check = task.check_governance_gate()
if not check.allowed:
    print(check.reason, check.missing_controls)
    for score in check.scores:
        print(score.control, score.passed, score.reason)
```

`report` is the tool's own output — `promptfoo`, `inspect`, `garak`, `weave`,
`braintrust`, `junit` or `deliverd` — and the server reads it. Or send
`results=[{"metric": "pass_rate", "value": 0.97}]` yourself. A control with
thresholds is met only when its newest scored evidence meets them. A person
sets thresholds, on the task's page in the app, and no key can — whatever
submits the results must not also decide what passes. `task.governance()` is the whole
picture — controls, evidence, readiness and the frameworks it maps to.

## Comments

The other direction of publishing: what readers send back.

```python
for thread in deliverd.comments.open():       # across every report
    print(thread.report_title, "—", thread.quote)

for thread in deliverd.comments.list(report.id):
    for m in thread.messages:
        print(m.author, m.body)

deliverd.comments.create(report.id, body="Fixed in v4.", thread_id=thread.thread_id)
deliverd.comments.resolve(thread.thread_id, note="Fixed in v4")
```

`open()` answers "is anything waiting on me?" without naming a report first.
`resolve()` takes a thread id alone — resolving is keyed on the thread, not on
the report it sits under.

## Schedules

```python
deliverd.schedules.create(report_id=report.id, agent_id=agent, recurrence="0 9 * * 5")
for s in deliverd.schedules.list(due_only=True):
    ...   # publish, then the sweep re-times it
```

`recurrence` is a five-field cron expression in UTC that has to have a next
occurrence — `0 0 30 2 *` is well-formed and never arrives, and is refused
rather than stored. Nothing here publishes anything: the sweep marks a schedule
due and your agent does the work.

## Awaiting instead

```python
import asyncio
from deliverd.aio import AsyncDeliverd

deliverd = AsyncDeliverd()

async def main():
    decision = await deliverd.approve(title="Refund £1,240 to Acme", approvers=["Finance"])
    if decision.approved:
        await refund()

    # Six asks that wait together rather than in turn.
    outcomes = await asyncio.gather(*[
        deliverd.approve(title=f"Refund {inv}") for inv in invoices
    ])

asyncio.run(main())
```

Same names, same arguments, same return types. A handle that comes back is an
async handle, so `await (await deliverd.approvals.create(...)).wait()` does not
quietly block your event loop.

**How it works, because it matters.** Every call runs the synchronous one on a
worker thread. There is no native async transport and there is not going to be
one: this package has no dependencies — that is checked, and it is most of why
anyone trusts it — and the standard library has no async HTTP client. Writing
HTTP/1.1 and TLS over `asyncio` streams by hand would be several hundred lines
of protocol in a package whose whole pitch is that there is nothing to audit.

So what you get is ergonomics and concurrency; what it costs is one thread per
call in flight, parked on a poll. That is right for the tens of concurrent asks
an agent makes and wrong for thousands. If you are running thousands, call the
REST API directly with the async client you already have.

`deliverd.webhooks` is not awaited: verification is a pure function over bytes
you already hold, and `to_decision()`, `to_outcome()` and `to_collected()` are
the same — no request, so no `await`.

## Microsoft Agent Framework

Mark the tools that need a person as Agent Framework already has you do, and
let Deliverd find that person:

```python
from agent_framework import Agent, tool
from deliverd import Deliverd
from deliverd.adapters.agent_framework import run_with_deliverd_approvals

@tool(approval_mode="always_require")
def refund(order_id: str, amount: int) -> str:
    ...

agent = Agent(client=client, tools=[refund])
session = agent.create_session()

result = await run_with_deliverd_approvals(
    agent,
    "Refund order 1042",
    session,
    Deliverd(),
    approvers=["finance"],
    when=lambda tool, args: tool == "refund" and args["amount"] > 100,
)
print(result.text)
```

Each `function_approval_request` in the run becomes a request in Deliverd,
keyed by its call id (`agent-framework:<call_id>`), so a retried round finds
the request it already made rather than asking twice. The approver decides
from the page, the email, Slack or Teams; the answers go back on the same
session, which is where Agent Framework binds an answer to the request it
issued. MCP tools work the same way: `MCPStreamableHTTPTool(...,
approval_mode="always_require")`, or `{"always_require_approval": [...]}`.

- `when(tool, args)` picks the calls that need a person. The rest are approved
  without asking. Every call when omitted.
- `actions={"refund": "finance.refund"}` puts a tool to that action's gate
  instead, so the organisation's policy decides and a person only when a rule
  says so.
- `timeout="10m"` stops waiting. The run comes back still asking; keep the
  session, and resolving the same result later finds the same requests.
- **A declined call is not run, and the model is told only that it was
  rejected.** Agent Framework's approval response has no field for a reason.
  The person's words are in `resolution.reasons` when you resolve a round
  yourself, and in Deliverd either way.
- **A call approved only with changes is declined**, with the approved values
  in its reason. Agent Framework runs an approved call exactly as it asked
  about it, so running it would spend an approval on something nobody agreed to.

One round, for a loop you own:

```python
from agent_framework import Message
from deliverd.adapters.agent_framework import resolve_approval_requests

resolution = await resolve_approval_requests(result, deliverd, approvers=["finance"], timeout="10m")
if resolution.complete:
    result = await agent.run(Message("user", resolution.responses), session=session)
```

`resolve_approval_requests_sync` is the same without an event loop. In the
harness, `deliverd_approval_rule` is an `auto_approval_rules` entry that lets a
call through without a prompt when it needs nobody — `when` does not select
it, or a gate's rule already allows it:

```python
from agent_framework import ToolApprovalMiddleware
from deliverd.adapters.agent_framework import deliverd_approval_rule

rule = deliverd_approval_rule(deliverd, actions={"refund": "finance.refund"})
agent = Agent(client=client, tools=[refund], middleware=[ToolApprovalMiddleware(auto_approval_rules=[rule])])
```

## Microsoft Foundry

An agent in Foundry Agent Service with an MCP tool that asks first —
`require_approval="always"`, or `{"always": [...]}` for the tools that matter —
stops with `mcp_approval_request` items in its response. This answers them:

```python
from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from deliverd import Deliverd
from deliverd.adapters.foundry import run_with_deliverd_approvals

project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=DefaultAzureCredential())
openai = project.get_openai_client()

response = run_with_deliverd_approvals(
    openai,
    Deliverd(),
    create_kwargs={
        "input": "Close the issues nobody has touched since June",
        "extra_body": {"agent_reference": {"name": agent.name, "type": "agent_reference"}},
    },
    approvers=["platform-team"],
)
print(response.output_text)
```

Each request becomes a request in Deliverd keyed by its id (`foundry:<id>`).
The answers go back as `mcp_approval_response` input items on a new response
with `previous_response_id`, carrying the rest of `create_kwargs` but not
`input` or `conversation`, until the agent asks for nothing more. A declined
answer carries the person's reason in `reason`, the optional field on OpenAI's
`McpApprovalResponse`; Foundry's MCP guide does not show it, so
`send_reason=False` leaves it off if a service refuses it. `when`, `actions`
and `timeout` work as they do for Agent Framework.

`approval_responses_for(response, deliverd, ...)` does one round and returns
the items to send. `run_with_deliverd_approvals_async` and
`approval_responses_for_async` take the async client from
`azure.ai.projects.aio`.

## Pydantic AI

Mark the tools that need a person as Pydantic AI already has you do —
`requires_approval=True`, a tool that raises `ApprovalRequired`, or an
`ApprovalRequiredToolset` — and give the agent this capability:

```python
from pydantic_ai import Agent
from deliverd import Deliverd
from deliverd.adapters.pydantic_ai import deliverd_approvals

agent = Agent(
    "openai:gpt-5",
    capabilities=[deliverd_approvals(Deliverd(), approvers=["finance"])],
)

@agent.tool_plain(requires_approval=True)
def refund(order_id: str, amount: int) -> str:
    ...

result = await agent.run("Refund order 1042")
```

It is a `HandleDeferredToolCalls` capability, so the calls are answered inside
the run: each becomes a request in Deliverd keyed by its tool call id
(`pydantic-ai:<tool_call_id>`), an approved call runs as the model proposed it,
and a declined one comes back to the model as `ToolDenied` with the person's
reason, so the model reads why. `when`, `actions` and `describe` work as they
do for Agent Framework, and a call approved only with changes is declined with
the approved values in its message.

With `timeout`, a call nobody decided in time is left unanswered, and Pydantic
AI ends the run with it in a `DeferredToolRequests` output — so give the agent
`output_type=[str, DeferredToolRequests]`. Resolve it later and carry on; the
same request in Deliverd is found again:

```python
from deliverd.adapters.pydantic_ai import resolve_deferred_tool_requests

results = await resolve_deferred_tool_requests(result.output, deliverd, approvers=["finance"])
result = await agent.run(message_history=result.all_messages(), deferred_tool_results=results)
```

`resolve_deferred_tool_requests_sync` is the same for `run_sync`, and
`deliverd_deferred_tool_handler` is the bare handler, for a
`HandleDeferredToolCalls` of your own.

## CrewAI

CrewAI runs its tool hooks around every tool call an agent makes. Register
Deliverd's, and the calls that matter wait for a person:

```python
from deliverd import Deliverd
from deliverd.adapters.crewai import register_deliverd_approvals

approvals = register_deliverd_approvals(
    Deliverd(),
    approvers=["finance"],
    when=lambda tool, args: tool == "issue_refund" and args["amount"] > 100,
)
result = crew.kickoff()
approvals.unregister()
```

The before hook asks and waits — CrewAI's hooks are synchronous, so the agent's
thread waits with it — and an approved call runs unchanged. Anything else is
blocked, and the after hook replaces CrewAI's fixed "Tool execution blocked by
hook" with the reason, so the agent reads the person's words, or the policy's.

- **A call is keyed by its task and its input** (`crewai:<task id>:<digest>`),
  because CrewAI gives a call no id. The same call again in the same task finds
  the request it already made; a decision does not carry over to another task.
- **A wait that runs out blocks the call**, and the agent is told it is still
  waiting: CrewAI cannot park a tool call and resume it. The request stays open,
  and the same call in the same task picks up the answer once somebody decides.
- **It fails closed.** CrewAI runs the tool when a hook raises, so the hook
  never does: if Deliverd cannot be asked, the call is blocked with that reason.

`deliverd_tool_hooks` returns the same pair unregistered, for `@before_tool_call`
and `@after_tool_call` methods on a `@CrewBase` class when they should apply to
one crew only.

## Muse Spark

Meta's Muse Spark, on the Meta Model API, has no approval hook: a response
lists the calls the model wants and your loop makes them. Hand them to
Deliverd with the function that runs them, and only the approved ones run:

```python
from deliverd import Deliverd
from deliverd.adapters.muse_spark import run_function_calls

resp = muse.responses.create(model="muse-spark-1.1", input=prompt, tools=tools)
results = run_function_calls(
    Deliverd(), resp.output, run_tool,
    when=lambda tool, args: tool == "refund", approvers=["finance"],
)
resp = muse.responses.create(model="muse-spark-1.1", input=results, tools=tools, previous_response_id=resp.id)
```

`muse` is the OpenAI client pointed at `https://api.meta.ai/v1` with your
`MODEL_API_KEY`. Every call gets a `function_call_output`: the tool's result
when it was approved, and otherwise a sentence saying a person declined it and
why, or that nobody decided in time. The request stays open, keyed
`muse-spark:<call id>`, so asking about the same call again finds it.
`run_tool_calls` does the same for a Chat Completions message's `tool_calls`,
and `run_function_calls_async` and `run_tool_calls_async` take an
`AsyncDeliverd`.

## Amazon Bedrock Agents

Turn on user confirmation for the action group functions that matter
(`requireConfirmation: "ENABLED"`, or `x-requireConfirmation: ENABLED` on an
API operation) and Bedrock hands control back before each call. This answers
it on the same session:

```python
import boto3
from deliverd import Deliverd
from deliverd.adapters.bedrock import invoke_with_deliverd_approvals

run = invoke_with_deliverd_approvals(
    boto3.client("bedrock-agent-runtime"),
    Deliverd(),
    invoke_kwargs={
        "agentId": AGENT_ID,
        "agentAliasId": AGENT_ALIAS_ID,
        "sessionId": "ticket-1042",
        "inputText": "Refund order 1042",
    },
    approvers=["finance"],
)
print(run.text)
```

Each call is a request keyed by its return of control and its place in it
(`bedrock:<invocationId>:<n>`). The answers go back as
`sessionState.returnControlInvocationResults`: `CONFIRM`, or `DENY` with the
person's reason in `responseBody` so the agent reads why (`send_reason=False`
sends the bare `DENY`). An action group whose executor is return of control
hands calls back for your code to run; give `run_action=lambda call: ...` and
those are asked about first and run only when approved. Without it the loop
stops with the call in `run.return_control`. `confirmation_results_for(event["returnControl"], deliverd, ...)`
does one round, and `resolution.session_state` is what to send.

## Strands Agents and Bedrock AgentCore

Strands, AWS's agent SDK and the usual way to build an agent for AgentCore
Runtime, runs hooks before every tool call. Add Deliverd's to the agent:

```python
from strands import Agent
from deliverd import Deliverd
from deliverd.adapters.strands import DeliverdApprovals

agent = Agent(
    tools=[issue_refund, lookup_order],
    hooks=[DeliverdApprovals(Deliverd(), approvers=["finance"], when=lambda tool, args: tool == "issue_refund")],
)
agent("Refund order 1042")
```

The hook asks and waits, and an approved call runs unchanged. Anything else is
cancelled with `cancel_tool` set to the reason, which the model reads as the
tool's result. Each call is keyed by its tool use id (`strands:<toolUseId>`).
A wait that runs out cancels the call and says it is still waiting, and a
failure to ask cancels it too.

## Google ADK and Vertex AI Agent Engine

In the agent, a `before_tool_callback` asks before each call. It works
wherever the agent runs, Agent Engine included:

```python
from google.adk.agents import LlmAgent
from deliverd import Deliverd
from deliverd.adapters.adk import deliverd_before_tool_callback

agent = LlmAgent(
    model="gemini-2.5-flash",
    name="billing",
    tools=[issue_refund, lookup_order],
    before_tool_callback=deliverd_before_tool_callback(
        Deliverd(), approvers=["finance"], when=lambda tool, args: tool == "issue_refund"
    ),
)
```

A declined call does not run, and the model reads `{"error": ...}` with the
reason. `deliverd_before_tool_callback_async` waits without holding the event
loop. Each call is keyed by its function call id (`adk:<id>`).

From outside the agent, a tool built with `FunctionTool(fn,
require_confirmation=True)` pauses the run with an `adk_request_confirmation`
call. For an agent deployed to Agent Engine, this answers them:

```python
from vertexai import agent_engines
from deliverd import Deliverd
from deliverd.adapters.adk import run_with_deliverd_confirmations

app = agent_engines.get(RESOURCE_NAME)
events = run_with_deliverd_confirmations(
    app, Deliverd(), user_id="u-1", session_id=SESSION_ID, message="Refund order 1042", approvers=["finance"]
)
```

The tool's confirmation hint heads what the approver reads. ADK's answer is a
yes or a no, so a declined call is told only that it was rejected; the
person's reason is in `Resolution.reasons`. `confirmation_responses_for(events,
deliverd, ...)` does one round and returns the `function_response` parts to
send as one user message.

## Also

- **Docs** — [deliverd.dev/docs/developers](https://deliverd.dev/docs/developers?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme)
- **REST** — the [API reference](https://deliverd.dev/docs/api?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme), built from
  the [OpenAPI document](https://deliverd.dev/api/v1/openapi.json)
- **MCP** — a remote server any agent can connect to, at
  `https://deliverd.dev/api/mcp` ([setup](https://deliverd.dev/docs/developers/mcp?utm_source=pypi&utm_medium=package&utm_campaign=python-sdk&utm_content=readme))
- **TypeScript** — [`@deliverd/sdk`](https://www.npmjs.com/package/@deliverd/sdk),
  the same shapes with `await`
- **CLI** — [`deliverd`](https://www.npmjs.com/package/deliverd) on npm
  (`npx deliverd setup`), for a build step

MIT licensed.
