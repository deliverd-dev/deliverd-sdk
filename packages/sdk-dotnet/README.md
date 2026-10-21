# Deliverd for .NET

**You build the action. Deliverd handles the human.**

> **Published from a public repository. `Deliverd` and `Deliverd.AgentFramework` are built and released from [deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk), Deliverd's public SDK repository, since their first release, by GitHub Actions with NuGet trusted publishing, so each release comes from a workflow run anyone can inspect. Deliverd is growing and supports open source: the source is public, under the MIT licence.**

Your AI agent asks a person before it acts, and carries on when they answer.
Two packages:

| Package | What it is |
|---|---|
| `Deliverd` | The client: approvals, gates and webhook verification. No dependency beyond .NET. |
| `Deliverd.AgentFramework` | Microsoft Agent Framework's tool approvals, decided by a person through Deliverd. |

Both target .NET 8 and up, and both are MIT.

```bash
dotnet add package Deliverd.AgentFramework   # brings Deliverd with it
```

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=nuget&utm_medium=package&utm_campaign=dotnet-sdk&utm_content=readme).
   The Free plan needs no card.
2. Name your organisation. The next page hands you a key: set it as
   `DELIVERD_API_KEY`.
3. Ask a person. Leave `Approvers` empty and the request goes to your
   organisation's owners and admins.

## Microsoft Agent Framework

Mark the tools that need a person as Agent Framework already has you do, by
wrapping them in `ApprovalRequiredAIFunction`, and run the agent through
`RunWithDeliverdApprovalsAsync` instead of answering the approvals yourself:

```csharp
using Deliverd;
using Deliverd.AgentFramework;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction refund = AIFunctionFactory.Create(RefundOrder);
AIAgent agent = chatClient.AsAIAgent(
    instructions: "You handle refunds.",
    tools: [new ApprovalRequiredAIFunction(refund)]);

var deliverd = new DeliverdClient();            // DELIVERD_API_KEY
AgentSession session = await agent.CreateSessionAsync();

AgentResponse response = await agent.RunWithDeliverdApprovalsAsync(
    "Refund order 1042",
    session,
    deliverd,
    new DeliverdToolApprovalOptions { Approvers = { "finance" } });

Console.WriteLine(response.Text);
```

Each `ToolApprovalRequestContent` in the response becomes a request in
Deliverd, keyed by its call id (`agent-framework:<call id>`), so a retried
round finds the request it already made rather than asking twice. The person
decides from their inbox, Slack or Teams. Approved calls run; declined ones do
not. The run continues on the same session, which is where Agent Framework
binds an answer to the request it issued: pass the session, or an answer cannot
resume anything.

**The model is told why a call was declined.** The person's reason rides on
the approval response's `Reason`, and Agent Framework hands it to the model
after its own line saying the call was rejected:

> A person declined running refund by Dana. Their reason: Over the refund
> limit. Do not retry it; change course or ask how to proceed.

The same sentences as the Python adapter, word for word, so an agent behaves
the same whichever SDK asked.

**A call approved only with changes is declined, and the model is told the
approved values.** Agent Framework runs an approved call exactly as it recorded
it when it asked, so a corrected call cannot run in its place. The adapter
never offers editable fields for that reason; if a decision still arrives with
changes (a gate's action can allow them), the proposal is not run.

### Options

| Option | What it does |
|---|---|
| `Approvers` | Who may decide. Your owners and admins when empty. |
| `When` | Picks the calls that need a person; the rest are approved without asking. |
| `Describe` | What the person is shown: a title, a description, a risk and factors. |
| `Actions` | Maps a tool to a Deliverd action, whose gate decides instead: by policy, or by a person when a rule says so. |
| `ExpiresIn` | How long each request stays open. An hour. |
| `Timeout` | Stop waiting. An undecided call is left pending, not refused. |
| `FlowId`, `Metadata` | Put the requests on a flow's timeline, and on the record. |
| `Agent`, `Model` | Which agent is asking and on what model, as you declare it. |
| `MaxRounds` | A cap on rounds, so an agent that keeps asking does not wait forever. Ten. |

### A loop you own

`ResolveToolApprovalsAsync` does one round: it asks about every approval in a
response, together, and builds the answers.

```csharp
var resolution = await deliverd.ResolveToolApprovalsAsync(response, options);
if (resolution.Complete)
    response = await agent.RunAsync(resolution.ToMessage(), session);
```

`resolution.Pending` holds the calls nobody decided before `Timeout`. Keep the
session, resolve the same response again later, and the same requests are
found. `resolution.Reasons` holds why each declined call was declined, by call
id, for your logs.

### Let policy answer first

`ToolApprovalAgent`, Agent Framework's approval middleware, takes
auto-approval rules. `DeliverdToolApprovals.AutoApprovalRule` is one: it lets a
call through without a prompt when the organisation's policy (a Deliverd gate)
already allows it, or when `when` does not select it.

```csharp
AIAgent governed = agent.AsBuilder()
    .UseToolApproval(new ToolApprovalAgentOptions
    {
        AutoApprovalRules =
        [
            DeliverdToolApprovals.AutoApprovalRule(
                deliverd,
                new Dictionary<string, string> { ["refund"] = "finance.refund" }),
        ],
    })
    .Build();
```

It fails closed: a gate that cannot be asked is not permission, so the call
goes to a person, where `RunWithDeliverdApprovalsAsync` asks the same gate by
the same id rather than asking twice.

Hosted MCP tools (Foundry's, or OpenAI's through a chat client) arrive as
`McpServerToolCallContent`; the request names the server they would run on.

## The client

```csharp
var deliverd = new DeliverdClient();

Decision decision = await deliverd.ApproveAsync(new ApprovalRequest
{
    Title = "Refund order 1042",
    Risk = "high",
    Approvers = { "finance" },
    ExternalId = "refund:1042",
    Input = new JsonObject { ["amount"] = 1240, ["currency"] = "GBP" },
});
if (decision.Approved) await RefundAsync(decision.Input);
```

`ApproveAsync` returns on approved, rejected, expired and cancelled alike: a
refusal is an answer, not an exception. With an `ExternalId`, the request
already filed under it is found and waited on, so a restarted agent does not
ask twice. A `WaitOptions { Timeout = ... }` that runs out throws
`DeliverdTimeoutException`; the request stays open.

`GateAsync` asks the organisation's policy instead. The answer may be a rule's
at once, or a person's when a rule sends it to one. `ExternalId` is required,
and goes out as the HTTP idempotency key, so a crashed agent re-running its
step re-reads the decision rather than asking again.

```csharp
GateDecision gate = await deliverd.GateAsync(new GateRequest
{
    Action = "finance.refund",
    ExternalId = "refund:1042",
    Input = new JsonObject { ["amount"] = 1240 },
});
if (gate.Allowed) await RefundAsync(gate.Input);
```

`Webhooks.VerifySignature(secret, rawBody, header)` checks a delivery.
`deliverd.Http` reaches every other route under `/api/v1` with the same
retries and errors.

## Requests and retries

A 429, a 5xx other than 501, or a dropped connection is retried, three attempts
in all, honouring `Retry-After`; a 4xx is not. Every POST carries one
idempotency key across its retries. These are held to the same table as the
TypeScript, Python and Rust SDKs, `packages/conformance/cases.json`.

## Not here yet

Reviews, collections, publishing, flows, tasks and development mode. The
TypeScript, Python and Rust SDKs have them; over .NET, reach them with
`deliverd.Http`, or over MCP at `https://deliverd.dev/api/mcp`.
