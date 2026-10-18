# @deliverd/sdk

You build the action. Deliverd handles the human.

```bash
npm install @deliverd/sdk
```

```ts
import { deliverd } from "@deliverd/sdk";

const decision = await deliverd.approve({ title: "Deploy to production" });

if (decision.approved) await deploy();
```

That is the integration. What it stands in for: an approval page, the emails
and the reminders, identity and single sign-on, who is allowed to decide, a
table to keep it in, an audit trail, and the dashboard somebody uses to do it.
None of that is yours to build.

Your approver gets an email and a notification, opens a page that works on a
phone, and approves, rejects with a reason, or asks your agent a question.
Every step is on the record.

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=readme).
   The Free plan needs no card.
2. Name your organisation. The next page hands you a key: set it as
   `DELIVERD_API_KEY`.
3. Run the five lines above. Leave `approvers` out and the request goes to
   your organisation's owners and admins; name anyone else in it to ask them.

Want to see it work before you sign up? Development mode, next, needs no key
and no network.

## Before you have an account

```ts
import { Deliverd } from "@deliverd/sdk";

const deliverd = new Deliverd({ mode: "development" });
const decision = await deliverd.approve({ title: "Deploy to production" });
```

No key, no network, nobody interrupted. It prints what the approver would have
seen and answers instantly:

```
  ┌─ Deliverd · development mode ─────────────────────────
  │ Refund £1,240 to Acme
  │ Duplicate charge on invoice 4821.
  │ Risk: high
  │ ✓ Within the refund limit
  │ To: finance@example.com
  │
  │ Simulating: approved
  └───────────────────────────────────────────────────────
```

All four things that can happen are one word away, including the one people
forget to write:

```ts
new Deliverd({ mode: "development", development: { outcome: "rejected" } });
new Deliverd({ mode: "development", development: { outcome: "timeout" } });
new Deliverd({ mode: "development", development: { outcome: "question" } });
```

Or flip a whole test suite from the command line with
`DELIVERD_DEV_OUTCOME=rejected`. Development mode swaps out the network and
nothing else, so the code it exercises is the code that will run in
production — the same retries, the same errors, the same waiting.

It simulates `review()` too, and there a rejection becomes "changes requested"
with a note attached, because that is what saying no to a piece of work means
and a refusal with no reason is useless.

## Configuration

There is none. `new Deliverd()` reads `DELIVERD_API_KEY`, and
`import { deliverd }` does not even need that line. Everything below has a
default that works:

| | Default |
|---|---|
| Who decides | Your organisation's owners and admins, unless you name `approvers` |
| Expiry | 24 hours, so a wait always ends |
| Notifications | Email and in-app, to whoever has to decide |
| Retries | Transient failures and rate limits, honouring `Retry-After` |
| Audit | On. Every request, question and decision, with the actor |
| Correlation id | Generated per request and sent with it |
| Webhook signing | Already signed; verify with `constructEvent` |
| Lists | `list()` returns every row; it follows the cursor so you do not have to |

## Progressive depth

Level one is the five lines above. Level two adds context, which is what the
approver reads before deciding:

```ts
await deliverd.approve({
  title: "Deploy release 4.2 to production",
  description: "142 commits since 4.1. All checks green.",
  risk: "high",
  factors: [
    { label: "All checks green", status: "ok" },
    { label: "Touches the payments path", status: "warning", detail: "3 files under /billing" },
  ],
  links: [{ label: "The diff", url: "https://github.com/…/compare/4.1...4.2" }],
  approvers: ["dave@example.com"],
  expiresIn: "4h",
  externalId: "deploy_4842",
});
```

`externalId` is your own reference. Pass one and a restarted agent reuses the
request it already made rather than asking a second time.

## Answering the approver

The thing that makes this more than a pause button: a person can ask your
agent a question from the approval page, and your agent can answer it without
anyone leaving what they are doing.

```ts
await approval.wait({
  onQuestion: async (question) => {
    // Return a string and it is posted as the answer; return null to leave
    // it for a person.
    return await agent.ask(question.question);
  },
});
```

Without a handler the question simply sits there — which is correct, because
the approver is waiting on an answer and nothing should move until they get
one or decide anyway.

## Waiting

`wait()` polls, backing off from two seconds to a minute with jitter, so a
hundred agents started by the same cron do not arrive together. It resolves
when the request settles, **including on a rejection** — a refusal is an
answer, and `if (approval.approved)` is the line that should follow.

It throws only when the wait itself failed:

```ts
try {
  await approval.wait({ timeout: 30 * 60_000 });
} catch (err) {
  if (err instanceof DeliverdTimeoutError) {
    // Nobody decided in time. The request is still open at approval.url.
  }
}
```

Give every request an `expiresAt` or every wait a `timeout`. A request with
neither can be waited on for ever, which is what `await` means.

`wait()` also takes an `AbortSignal`, and `onPoll` for a progress line.

## The primitives

```ts
await deliverd.gate({ action, input, externalId });  // may I? — your organisation answers
await deliverd.approve({ title });   // ask permission, and wait for the answer
await deliverd.review({ title, reportId, reviewers });  // ask whether it is right
await deliverd.collect({ title, questions, respondents }); // ask for what you lack
await deliverd.confirm({ title });   // a yes or no on something small → boolean
await deliverd.publish({ title, content });  // get the work to the people who need it
```

Six primitives, one API. Each one is a person your agent needs and cannot be —
and the first is the one that asks *before* the work rather than about it.

## Gating

`gate()` is the only primitive whose answer is not yours to decide. The other
five ask a named person something; this one asks your **organisation's policy**
whether the action may happen at all, and the answer comes from rules an
administrator wrote and your code does not see.

```ts
const decision = await deliverd.gate({
  action: "finance.refund",
  externalId: `refund:${order.id}`,
  input: { customer_id: order.customerId, amount: 1240, currency: "GBP" },
});

if (!decision.allowed) return;            // denied by a rule, or refused by a person
await stripe.refunds.create(decision.input);
```

Three answers, one field to branch on:

| `status` | `allowed` | What happened |
|---|---|---|
| `allowed` | `true` | A rule permitted it. Go. |
| `denied` | `false` | A rule refused it. `reason` and `rule` say which and why — do not retry it under another name. |
| `approved` / `rejected` / `expired` / `cancelled` | varies | No rule settled it, so a person was asked. `gate()` waited for them. |

**Use `decision.input`, not the object you passed.** It is what the action's
schema validated and what an approver actually saw. Passing your original works
right up until somebody edits a value before approving, and then it spends an
approval for £1200 on a refund of £1240.

**`externalId` is required**, which no other call here is. A random
per-attempt key guards a retried *request*; this guards a retried *decision*. A
crashed agent re-running its refund step must re-read the answer it already got
rather than ask a second person about the same money — and no id this library
could invent would know which two calls are the same attempt. Retrying with the
same id returns the same decision, with `reused: true`.

`wait: false` returns as soon as the decision is raised, pending or not.
`deliverd.gates.create()` and `deliverd.gates.get(id)` are the same thing with
the handle exposed, for work that resumes on a webhook rather than in this call.

Try it before you have an account: `DELIVERD_DEV_OUTCOME=denied` rehearses a
policy refusal, which is the branch agents most often forget to write.

## Flows

A job that takes more than one of them is one job, and a firm asking about it
afterwards asks about the job — not about approvals in October. A flow is the
thread that ties them together.

```ts
const flow = await deliverd.flows.resume({
  title: "Q3 close",
  externalId: "close_2026_q3",   // so a restart extends this one
});

const { answers } = await flow.collect({ title: "Before I start", questions, respondents });
const outcome = await flow.review({ title: "Draft pack", reportId, reviewers });
if (outcome.approved) await deliverd.publish({ title, content, flowId: flow.id });

await flow.close();
```

`flow.approve()`, `flow.review()` and `flow.collect()` are the same calls as
the ones above with the flow already named. That is the whole point of the
handle: a `flowId` passed by hand at four call sites is one that gets left off
the fifth, and the step is then missing from the history with nothing to say
so. Publishing takes `flowId` directly, because a report joins a flow when it
is first created rather than through a handle.

It groups and does nothing else. Nothing waits on a flow, nothing is blocked
by one, and there are no steps to declare in advance — do the work in the
order you want it done and name the flow as you go.

```ts
flow.allSettled     // nothing in it is waiting on anybody right now
flow.openCount      // how many still are
flow.timeline       // every audited step across all of them, in order
await flow.refresh()
await flow.close()  // say the work is done; it stops taking new members
await flow.cancel() // call it off; nothing inside it is cancelled
await deliverd.flows.list({ status: "open" });
await deliverd.flows.get(id);
```

`allSettled` is a fact about this moment, not a verdict. You may be about to
add the next step, so nothing closes a flow but you.

## Tasks

An agent deep in a debugging session forgets what it set out to do, because
the objective is a paragraph thousands of tokens back. A task keeps it
somewhere the agent can ask for, and a side task keeps a detour from taking
over the thread.

```ts
const task = await deliverd.tasks.create({
  title: "Ship SSO",
  objective: "Customers can sign in with their own identity provider.",
  externalId: "sso_rollout",          // a restart resumes this one
});

const side = await task.createSideTask({
  title: "Token audience",
  goal: "Find why the API refuses the access token.",
  kind: "debug",
});
await side.addFinding({ kind: "evidence", title: "aud is the SPA client id" });
await side.complete({
  summary: "The token is issued for the wrong audience.",
  suggestedNextAction: "Request the token for the API audience.",
});

const { context } = await side.apply();   // the result, carried into the parent
context.rootObjective                     // said first, always
context.reanchor                          // one paragraph to say back to yourself
```

`task.context()` is what to read instead of the history: the objective, where
this task stands, what is settled, what is still open, and the reports already
published for it. `task.graph()` is the whole tree.
`deliverd.tasks.list({ status: "active" })` lists objectives; side tasks are
reached through the one they belong to.

A status report is written from that context and kept with the task:

```ts
const context = await task.context();
const html = renderStatus(context);       // your own: objective, state, decisions, what is open

const [existing] = context.reports;       // newest first
if (existing) {
  await deliverd.reports.update(existing.id, { content: html, changeSummary: "This week" });
} else {
  await deliverd.reports.publish({ title: "SSO rollout: status", content: html, taskId: task.id });
}
```

The report is then listed on the task's page and in its context, so the next
status report is a new version of it rather than a second one. A later
publish naming another `taskId` moves it there; leaving `taskId` out keeps it
where it is. It needs `tasks:read` on the key.

A finding of kind `decision` is a suggestion until a person confirms it.
`task.requestDecisionApproval(findingId)` puts it to somebody. Only a person
changes what a task is for; an agent proposes that as a finding too.

## Evidence

Show your working. One call assembles the whole record of a piece of work —
every approval, review and request with who was asked, what they were told and
what they said, plus the timeline across all of it.

```ts
const pack = await flow.evidence();
// or, for the deliverable itself:
const pack = await deliverd.reports.evidence(report.id);

pack.steps;        // each one with asked[], outcomes[] and its own detail
pack.timeline;     // what happened, in order
pack.integrity;    // what the digest stands for, in the pack's own words
```

A person downloads it as a PDF from the flow or report page; this is the same
pack as JSON. It needs every read scope, because it contains everything.

**Read `integrity` before you quote it.** The digest is over the pack as
exported, so it detects a file altered after it left. It makes no claim about
the database — what stands behind the records is that the audit table rejects
updates and deletes at the database level. That is tamper-evident history, not
cryptographic immutability, and the pack says so in both directions rather than
leaving a hash to imply the stronger one.

## Collecting

`approve()` asks permission, `review()` asks judgement, and this asks for a
fact — a figure, a date, a choice between options, the sentence only they can
write.

```ts
const { complete, answers } = await deliverd.collect({
  title: "Before I file the Q3 return",
  respondents: ["finance@firm.example"],
  questions: [
    { prompt: "Headcount at 30 September", kind: "number" },
    { prompt: "Any disposals in the quarter?", kind: "boolean" },
    { prompt: "Which basis?", kind: "choice", options: ["Accrual", "Cash"] },
  ],
});

if (!complete) return escalate();
file(answers["Headcount at 30 September"]);
```

`answers` is keyed by the question you asked, and carries the first submitted
reply to each. Check `complete` before using it: a request that expired has
whatever arrived and no more, and what you do without the figure is usually
not what you do with it. Use `responses` when several people were asked and
you need all of them rather than the first.

Seven kinds of question: `text`, `long_text`, `number`, `date`, `choice`,
`multi_choice` and `boolean`. Every answer is checked against the kind that
asked for it before it is stored, and a required question blocks submission —
so a number field gives you a number, not the string a person typed.

There are no file questions. Answers are typed values, and a `file` kind with
no storage behind it would be a promise the page could not keep.

A respondent must be **an active member of your organisation, or a guest the
organisation already knows**. Anyone else is refused rather than emailed,
which is what stops an agent reaching an address of its choosing.

```ts
await deliverd.collections.create(input);    // ask without waiting
await deliverd.collections.get(id);
await deliverd.collections.list({ status: "pending" });
await deliverd.collections.findByExternalId("q3_close");
await collection.wait({ onPoll });
await collection.cancel();
```

There is no method that submits an answer, and no endpoint behind one. People
answer on the page. They get one reminder before the due date and no more,
because a nudge that arrives twice teaches people to ignore the first.

## Reviewing

`approve()` asks permission before you act. `review()` asks whether what you
already produced is right.

```ts
const outcome = await deliverd.review({
  title: "Q3 board pack",
  reportId: report.id,
  instructions: "Check the figures against the ledger.",
  reviewers: ["partner@firm.example"],
});

if (!outcome.approved) await revise(outcome.verdicts);
```

It resolves on `changes_requested` as well as `approved`, because that is an
answer — usually the more useful one. `outcome.verdicts` is what each reviewer
said, and `outcome.threadCount` is how many comments they left anchored to the
passages they meant. Read those with `deliverd.comments.list(reportId)` and
turn them into the next version with `deliverd.reports.revisionBrief(reportId)`.

A reviewer must be **an active member of your organisation, or a guest who can
already open the report** — anyone else is refused rather than emailed, which
is also what stops an agent reaching an address of its choosing. Share the
report with someone before naming them.

You cannot review your own request. One reviewer gives one verdict, and a
second is refused, because the first one is evidence. `requiredApprovals`
decides how many approvals settle it; a single `changes_requested` settles it
regardless, since collecting the rest after somebody has found a problem spends
their afternoon on a question already answered.

```ts
await deliverd.reviews.create(input);        // ask without waiting
await deliverd.reviews.get(id);
await deliverd.reviews.list({ status: "pending" });
await deliverd.reviews.findByExternalId("pack_2026q3");
await review.wait({ onPoll });
await review.cancel();
```

There is no method that returns a verdict, and there is no endpoint behind one.
A verdict is a person's judgement; your key is not a person. They record theirs
on the page, where they have just read the work.

Under `approve()` is the full surface, when you want it:

```ts
await deliverd.approvals.create(input);      // ask without waiting
await deliverd.approvals.get(id);
await deliverd.approvals.list({ status: "pending" });
await deliverd.approvals.findByExternalId("deploy_4842");
await approval.wait({ onQuestion });
await approval.answer(questionId, "…");
await approval.cancel();                     // withdraw; the row stays
```

Two rules the API enforces and the SDK cannot talk you out of: **an agent
never decides** — the decision takes a person's session, and there is no
endpoint for it — and **nobody approves their own request**. Approvers must be
members of your organisation, named by email or user id; an address that is
not a member is refused when you create the request, rather than notified into
nothing.

## Publishing

The sixth primitive: get what your agent wrote to the people who need it, at
an address that does not change.

```ts
const { report } = await deliverd.reports.publish({
  title: "Q3 board pack",
  content: html,
  audience: "the Finance team",
});
console.log(report.url);

await deliverd.reports.update(report.id, { content: revised, changeSummary: "…" });
await deliverd.reports.share(report.id, "sarah@client.example");
await deliverd.reports.share(report.id, "Finance team", { capability: "comment" });

// Sharing grants access to people the organisation knows. Sending reaches
// addresses it has never seen, and says something alongside the link.
await deliverd.reports.send(report.id, {
  to: ["sarah@client.com", "ops@client.com"],
  message: "Final numbers — let me know by Friday if anything looks wrong.",
});
```

A publishing policy can hold a version for a person's approval, so check
`result.status`: `published`, `updated` or `pending_approval`. When it is
held, `result.approval` names the request and nothing is live until somebody
says so.

Also on `reports`: `get`, `list`, `rename`, `archive`, `unarchive`,
`rollback`, `versions`, `copy`, `analytics`, `putData`, `listData`,
`deleteData`, `evidence`, `revisionBrief`.

And reader feedback:

```ts
// Everything open, across every report — "is anything waiting on me?"
const waiting = await deliverd.comments.open();

const threads = await deliverd.comments.list(reportId);
await deliverd.comments.resolve(threadId, { note: "Fixed in v4." });
```

## Schedules

A schedule says when an agent is asked for a new version. It says nothing
about who hears about one — publishing emails the report's audience either
way, and nothing publishes by itself: the agent polls and does the work.

```ts
await deliverd.schedules.create({
  reportId: report.id,
  agentId,
  recurrence: "0 9 * * 5", // Fridays at nine, UTC
});

const due = await deliverd.schedules.list({ dueOnly: true });
await deliverd.schedules.update(id, { recurrence: "0 9 * * 1" });
await deliverd.schedules.delete(id);
```

`recurrence` has to have a next occurrence: `0 0 30 2 *` is five well-formed
fields and a date that never arrives, and is refused rather than stored.

An **agent key cannot write here**. A schedule is an instruction *to* an
agent, so setting one is a person's decision — use a user key. Reading is
open to both, and an agent sees only the schedules addressed to it.

## Webhooks

Rather than polling, take the decision as it happens. Verify first — a
receiver that skips this accepts anything anyone posts at the URL.

```ts
import { constructEvent } from "@deliverd/sdk";

app.post("/webhooks/deliverd", express.raw({ type: "application/json" }), (req, res) => {
  const event = constructEvent(
    process.env.DELIVERD_WEBHOOK_SECRET!,
    req.body.toString("utf8"),   // the raw body, not a re-encoded object
    req.header("deliverd-signature")
  );

  if (event.event === "approval.approved") {
    // event.data.approvalId, .externalId, .decidedBy, .note
  }
  res.sendStatus(200);
});
```

`constructEvent` throws if the signature does not verify; `verifySignature`
returns a boolean if you would rather branch. The scheme is Stripe's — a
timestamp and an HMAC in one header, the timestamp inside the signed material,
five minutes of tolerance — so anything you have written before will work too.

## Webhook endpoints

Add, change and remove the endpoints themselves from code, rather than under
Admin → Webhooks. The secret comes back from `create()` **once** — no other
call returns it — so store it where your receiver reads it.

```ts
const endpoint = await deliverd.webhookEndpoints.create({
  url: "https://hooks.example.com/deliverd",
  events: ["approval.approved", "approval.rejected"], // leave out for everything
});
await saveSecret(endpoint.secret);

const { delivered, responseStatus } = await deliverd.webhookEndpoints.test(endpoint.id);
await deliverd.webhookEndpoints.update(endpoint.id, { enabled: false });
const all = await deliverd.webhookEndpoints.list();
await deliverd.webhookEndpoints.delete(endpoint.id);
```

These need a key with `webhooks:manage` held by an owner or an administrator
— the people who can do it in the console. An **agent key is refused**, reads
included: an endpoint receives every event in the organisation.

## Approving with changes

Send what you will act on as `input`, and say which fields a person may
correct. The approver sees the values and can fix a field instead of
rejecting the whole thing; you run with what they approved.

```ts
const decision = await deliverd.approve({
  title: "Refund £420 to Acme",
  input: { orderId: "1042", amount: 420 },
  editableFields: ["amount"],
});
if (decision.approved) await refund(decision.input!); // corrections included
// decision.changes: [{ field: "amount", from: 420, to: 300 }]
```

`decision.input` is null unless it was approved, so it is never the proposal
by accident. With the Claude Agent SDK adapter, pass
`editable: (tool) => (tool === "refund" ? ["amount"] : [])` and the tool runs
with the approved input.

## Callbacks

A webhook tells one endpoint about everything in the organisation. A callback
is per request: pass `callbackUrl` and Deliverd POSTs that request's outcome
there, signed with a secret only it uses, retrying if your endpoint is down.

```ts
const approval = await deliverd.approvals.create({
  title: "Refund £420 to Acme",
  approvers: ["finance"],
  callbackUrl: "https://agent.example.com/hooks/deliverd",
});
await store.put(approval.id, approval.callbackSecret); // handed over once

// …and where it lands:
const envelope = constructCallback(secret, rawBody, req.header("deliverd-signature"));
// envelope.event: "approval.approved" | "approval.rejected" | "approval.expired" | "approval.question" | …
```

For code that should not hold a process open while a person decides: a
serverless function, a durable workflow, a paused graph.

## Inside your own product

The approver can decide without leaving your app. A decision session is a page
for one approver on one request: hosted, like a checkout page, or mounted in
your own UI. It shows the request; it never decides it — the approver signs
in, or confirms a code sent to their own address, before they can.

```ts
// Server: a page to send them to, and back again afterwards.
const session = await deliverd.approvals.createSession(approval.id, {
  approver: "sarah@acme.com",
  mode: "hosted",
  returnUrl: "https://app.acme.com/refunds/1240",
});
redirect(session.url!); // returned once

// Or a frame in your own page. The origin must be on the organisation's
// embedding allow-list (Admin → Security → Embedding), or http://localhost.
const embedded = await deliverd.approvals.createSession(approval.id, {
  approver: "sarah@acme.com",
  mode: "embedded",
  origin: "https://app.acme.com",
});
// Hand embedded.clientSecret to the browser, then:
//   <script src="https://deliverd.dev/elements/v1.js"></script>
//   Deliverd.mountDecision("#decision", { clientSecret, onDecided(e) { … } });

// Afterwards, from your server — never trust the browser's word for it:
const done = await deliverd.decisionSessions.get(embedded.id);
done.status;   // "complete"
done.decision; // "approved"
```

`deliverd.approvals.list({ approver: "sarah@acme.com", status: "pending" })` is
her inbox, to show in your own UI. `deliverd.decisionSessions.expire(id)` ends a
session early.

## Inside your agent framework

`@deliverd/sdk/adapters` plugs Deliverd into the approval hook each framework
already has. A person approves the tool call from the email, Slack or Teams;
a decline reaches the model as their reason; a retried call never asks twice.

**Claude Agent SDK**

```ts
import { deliverdCanUseTool } from "@deliverd/sdk/adapters";

query({ prompt, options: { canUseTool: deliverdCanUseTool({ deliverd, when: (tool) => tool === "Bash" }) } });
```

**Vercel AI SDK**

```ts
import { deliverdToolApproval } from "@deliverd/sdk/adapters";

generateText({ model, tools, prompt, toolApproval: deliverdToolApproval({ deliverd, approvers: ["finance"] }) });
```

**OpenAI Agents SDK** — mark tools `needsApproval: true`, then:

```ts
import { runWithDeliverdApprovals } from "@deliverd/sdk/adapters";

const result = await runWithDeliverdApprovals((input) => run(agent, input), "Refund order 1042", { deliverd });
```

**Mastra** — mark tools `requireApproval: true` (or pass `requireToolApproval`), then:

```ts
import { generateWithDeliverdApprovals } from "@deliverd/sdk/adapters";

const output = await generateWithDeliverdApprovals(agent, agent.generate("Refund order 1042", { requireToolApproval: true }), { deliverd });
```

Each suspended call is approved with `agent.approveToolCallGenerate` or declined
with `agent.declineToolCallGenerate`, and the person's reason reaches the model.

**Muse Spark** (Meta Model API) — the loop runs the calls, so hand them over with the function that runs them:

```ts
import { runMuseFunctionCalls } from "@deliverd/sdk/adapters";

const results = await runMuseFunctionCalls(resp.output, runTool, { deliverd, when: (tool) => tool === "refund" });
resp = await muse.responses.create({ model: "muse-spark-1.1", input: results, tools, previous_response_id: resp.id });
```

Only approved calls run; a declined one's result tells the model a person said
no, and why. `runMuseToolCalls(message, runTool, { deliverd })` does the same
for Chat Completions' `tool_calls`.

**LangGraph** — pause the graph rather than a process, and resume it from the callback:

```ts
import { approveInGraph, resumeFromCallback } from "@deliverd/sdk/adapters";

// in a node
const decision = await approveInGraph(deliverd, {
  interrupt, threadId: config.configurable.thread_id, step: "refund",
  title: "Refund £420 to Acme", callbackUrl: "https://agent.example.com/hooks/deliverd",
});

// in the callback handler
const resume = resumeFromCallback(constructCallback(secret, rawBody, signature));
if (resume) await graph.invoke(new Command({ resume: resume.value }), { configurable: { thread_id: resume.threadId } });
```

The decision is always read back from Deliverd, never taken from the resume
value, so a stray resume cannot approve anything.


## Lists

`list()` gives you all of them. It follows the API's cursor until there is no
next page, so `.length` is the real count rather than a page size that happens
to look like one:

```ts
const waiting = await deliverd.approvals.list({ status: "pending" });
```

Ask for a `limit` and you get exactly that page instead — one request, one
page. When you want to drive the paging yourself, `listPage()` hands back the
cursor:

```ts
let cursor: string | undefined;
do {
  const page = await deliverd.approvals.listPage({ limit: 100, cursor });
  for (const approval of page.items) { /* … */ }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

The reason `list()` defaults to everything rather than to one page: a full page
and a complete list look identical, so a method called `list` that quietly
returns the first fifty is a wrong answer shaped like a right one.

## Errors

An error is part of the interface, so it says what happened and the one thing
to do next:

```
No approver could be found for this request.
Everyone in `approvers` must be an active member of your organisation, named
by email or user id. Invite them first, or leave `approvers` out and your
owners and admins decide.
```

Every failure is a `DeliverdError` with the API's `code`, the HTTP `status`,
the `hint` as its own property, and `isAuth`, `isNotFound`, `isRateLimit` and
`isConflict` for the cases worth branching on. Rate limits and 5xx are retried
for you; a 4xx is not, because it will be just as wrong a second later.

## Options

```ts
new Deliverd({
  apiKey: process.env.DELIVERD_API_KEY,   // default: DELIVERD_API_KEY
  baseUrl: "https://deliverd.dev",        // default: DELIVERD_BASE_URL
  mode: "live",                           // default: DELIVERD_MODE
  maxRetries: 3,
  timeout: 30_000,                        // per request, not per wait
});
```

Zero dependencies. Node 20 or later.

## Also

- [Create a free account](https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=readme), if
  you have not yet.
- The same walkthrough as a page, if you would rather read it there:
  [deliverd.dev/quickstart](https://deliverd.dev/quickstart?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=readme)
- The API reference: [deliverd.dev/docs/api](https://deliverd.dev/docs/api?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=readme)
- MCP, if your agent speaks it rather than TypeScript:
  [deliverd.dev/docs/developers/mcp](https://deliverd.dev/docs/developers/mcp?utm_source=npm&utm_medium=package&utm_campaign=sdk&utm_content=readme)
- The CLI, for a terminal or a CI job: `npm install -g deliverd`

MIT.
