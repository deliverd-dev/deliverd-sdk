using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Deliverd.AgentFramework;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Xunit;

namespace Deliverd.Tests;

/// <summary>
/// The adapter against Agent Framework itself: a real <see cref="ChatClientAgent"/>
/// with a real <see cref="ApprovalRequiredAIFunction"/>, over a model that is a
/// script. Nothing of the framework is mocked, so what is proved is that the
/// answers this builds are ones the framework binds to its own requests and acts
/// on: an approved call runs, a declined one does not, and the model reads why.
/// </summary>
public class AgentFrameworkTests
{
    /// <summary>
    /// A model that calls the tools it is told to, once, then reports what the
    /// tool results said: enough to see what the framework handed it.
    /// </summary>
    private sealed class ScriptedModel : IChatClient
    {
        private readonly (string CallId, string Tool, Dictionary<string, object?> Args)[] _calls;
        public List<List<ChatMessage>> Seen { get; } = new();

        public ScriptedModel(params (string, string, Dictionary<string, object?>)[] calls) => _calls = calls;

        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            var history = messages.ToList();
            Seen.Add(history);
            var results = history.SelectMany(m => m.Contents).OfType<FunctionResultContent>().ToList();
            if (results.Count == 0)
            {
                var calls = _calls.Select(c => (AIContent)new FunctionCallContent(c.CallId, c.Tool, c.Args)).ToList();
                return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, calls)));
            }
            var said = string.Join(" | ", results.Select(r => $"{r.CallId}={r.Result}"));
            return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, said)));
        }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            foreach (var update in (await GetResponseAsync(messages, options, cancellationToken)).ToChatResponseUpdates()) yield return update;
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose() { }
    }

    private static (AIAgent Agent, ScriptedModel Model, List<string> Ran) Build(params (string, string, Dictionary<string, object?>)[] calls)
    {
        var ran = new List<string>();
        var refund = AIFunctionFactory.Create((int amount) => { ran.Add($"refund {amount}"); return $"refunded {amount}"; }, "refund");
        var email = AIFunctionFactory.Create((string to) => { ran.Add($"email {to}"); return $"emailed {to}"; }, "email");
        var model = new ScriptedModel(calls);
        // Built the way the README builds one.
        var agent = model.AsAIAgent(
            instructions: "You process refunds.",
            tools: [new ApprovalRequiredAIFunction(refund), new ApprovalRequiredAIFunction(email)]);
        return (agent, model, ran);
    }

    private static Dictionary<string, object?> Args(string name, object value) => new() { [name] = value };

    [Fact]
    public async Task AnApprovedCallRunsOnTheSessionThatAsked()
    {
        var (agent, _, ran) = Build(("call_1", "refund", Args("amount", 40)));
        var api = new FakeDeliverd();
        var session = await agent.CreateSessionAsync();

        var response = await agent.RunWithDeliverdApprovalsAsync("Refund order 1042", session, api.Client(), new DeliverdToolApprovalOptions { Approvers = { "finance" } });

        Assert.Equal(new[] { "refund 40" }, ran);
        Assert.Contains("call_1=refunded 40", response.Text);
        var asked = Assert.Single(api.Approvals);
        var request = asked["request"]!;
        Assert.Equal("agent-framework:call_1", request["externalId"]!.GetValue<string>());
        Assert.Equal("Allow the agent to run refund", request["title"]!.GetValue<string>());
        Assert.Equal("finance", request["approvers"]![0]!.GetValue<string>());
        Assert.Equal("refund", request["metadata"]!["tool"]!.GetValue<string>());
        Assert.Equal(40, request["input"]!["amount"]!.GetValue<int>());
        // An hour, not the client's day: an agent is waiting on it.
        var expires = DateTimeOffset.Parse(request["expiresAt"]!.GetValue<string>());
        Assert.InRange(expires - DateTimeOffset.UtcNow, TimeSpan.FromMinutes(59), TimeSpan.FromMinutes(61));
        // Nothing a person could edit: the framework would run the original anyway.
        Assert.Null(request["editableFields"]);
    }

    [Fact]
    public async Task ADeclinedCallDoesNotRunAndTheModelIsToldWhy()
    {
        var (agent, model, ran) = Build(("call_1", "refund", Args("amount", 9000)));
        var api = new FakeDeliverd { Person = _ => (ApprovalStatus.Rejected, "Over the refund limit", null) };
        var session = await agent.CreateSessionAsync();

        var response = await agent.RunWithDeliverdApprovalsAsync("Refund order 1042", session, api.Client());

        Assert.Empty(ran);
        // What Agent Framework itself put in front of the model, not what this
        // adapter claims to have sent.
        var result = model.Seen.Last().SelectMany(m => m.Contents).OfType<FunctionResultContent>().Single();
        var text = result.Result?.ToString() ?? string.Empty;
        Assert.Contains("A person declined running refund by Dana. Their reason: Over the refund limit.", text);
        Assert.Contains("Do not retry it", text);
        Assert.Contains("call_1=", response.Text);
    }

    [Fact]
    public async Task ACallApprovedOnlyWithChangesIsDeclinedWithTheApprovedValues()
    {
        var (agent, model, ran) = Build(("call_1", "refund", Args("amount", 120)));
        var changes = new JsonArray(new JsonObject { ["field"] = "amount", ["from"] = 120, ["to"] = 100 });
        var api = new FakeDeliverd { Person = _ => (ApprovalStatus.Approved, null, changes) };
        var session = await agent.CreateSessionAsync();

        await agent.RunWithDeliverdApprovalsAsync("Refund order 1042", session, api.Client());

        Assert.Empty(ran);
        var text = model.Seen.Last().SelectMany(m => m.Contents).OfType<FunctionResultContent>().Single().Result?.ToString();
        Assert.Contains("A person approved refund only with changes: amount from 120 to 100.", text);
    }

    [Fact]
    public async Task SeveralCallsAreAskedTogetherAndAnsweredInOneMessage()
    {
        var (agent, _, ran) = Build(("call_1", "refund", Args("amount", 5)), ("call_2", "email", Args("to", "ann@example.com")));
        var api = new FakeDeliverd { Person = tool => tool == "email" ? (ApprovalStatus.Rejected, null, null) : (ApprovalStatus.Approved, null, null) };
        var session = await agent.CreateSessionAsync();

        var response = await agent.RunWithDeliverdApprovalsAsync("Refund and tell her", session, api.Client());

        Assert.Equal(new[] { "refund 5" }, ran);
        Assert.Equal(2, api.Approvals.Count());
        Assert.Contains("call_1=refunded 5", response.Text);
        Assert.Contains("call_2=", response.Text);
        Assert.DoesNotContain("emailed", response.Text);
    }

    [Fact]
    public async Task WhenLetsTheCallsItDoesNotSelectThroughWithoutAsking()
    {
        var (agent, _, ran) = Build(("call_1", "refund", Args("amount", 5)), ("call_2", "email", Args("to", "ann@example.com")));
        var api = new FakeDeliverd();
        var session = await agent.CreateSessionAsync();

        await agent.RunWithDeliverdApprovalsAsync("Refund and tell her", session, api.Client(), new DeliverdToolApprovalOptions
        {
            When = call => new ValueTask<bool>(call.Tool == "refund"),
        });

        Assert.Equal(new[] { "email ann@example.com", "refund 5" }, ran.OrderBy(r => r).ToArray());
        Assert.Equal("refund", Assert.Single(api.Approvals)["metadata"]!["tool"]!.GetValue<string>());
    }

    [Fact]
    public async Task AToolMappedToAnActionIsDecidedByTheGate()
    {
        var (agent, model, ran) = Build(("call_1", "refund", Args("amount", 9000)));
        var api = new FakeDeliverd { Rule = _ => (GateStatus.Denied, false, "Refunds over 5,000 need a director", null) };
        var session = await agent.CreateSessionAsync();

        await agent.RunWithDeliverdApprovalsAsync("Refund", session, api.Client(), new DeliverdToolApprovalOptions
        {
            Actions = { ["refund"] = "finance.refund" },
        });

        Assert.Empty(ran);
        Assert.Empty(api.Approvals);
        var gate = api.Seen.Single(s => s.Path == "/api/v1/gates");
        Assert.Equal("finance.refund", gate.Body!["actionId"]!.GetValue<string>());
        Assert.Equal("agent-framework:call_1", gate.Header("Idempotency-Key"));
        Assert.Equal(9000, gate.Body["input"]!["amount"]!.GetValue<int>());
        var text = model.Seen.Last().SelectMany(m => m.Contents).OfType<FunctionResultContent>().Single().Result?.ToString();
        Assert.Contains("The organisation's policy does not allow running refund. Why: Refunds over 5,000 need a director.", text);
    }

    [Fact]
    public async Task ACallNobodyDecidedInTimeIsLeftPendingAndFoundAgain()
    {
        var (agent, _, ran) = Build(("call_1", "refund", Args("amount", 5)));
        var api = new FakeDeliverd { Person = _ => null };
        var deliverd = api.Client();
        var session = await agent.CreateSessionAsync();
        var options = new DeliverdToolApprovalOptions { Timeout = TimeSpan.Zero };

        var response = await agent.RunWithDeliverdApprovalsAsync("Refund", session, deliverd, options);

        // Returned with the request still in the response, nothing run, nothing refused.
        Assert.Empty(ran);
        Assert.Single(DeliverdToolApprovals.ApprovalRequests(response));
        var pending = await deliverd.ResolveToolApprovalsAsync(response, options);
        Assert.False(pending.Complete);
        Assert.Equal(new[] { "call_1" }, pending.Pending);
        Assert.Empty(pending.Responses);
        // The second look found the request the first one made.
        Assert.Single(api.Approvals);

        // A person decides; the same response resolves, and the run carries on.
        api.Person = _ => (ApprovalStatus.Approved, null, null);
        var resolution = await deliverd.ResolveToolApprovalsAsync(response, options);
        Assert.True(resolution.Complete);
        Assert.Single(api.Approvals);
        var finished = await agent.RunAsync(resolution.ToMessage(), session);
        Assert.Equal(new[] { "refund 5" }, ran);
        Assert.Contains("call_1=refunded 5", finished.Text);
    }

    [Fact]
    public async Task TheAutoApprovalRuleLetsThroughOnlyWhatPolicyAlreadyAllows()
    {
        var api = new FakeDeliverd { Rule = action => action == "finance.refund" ? (GateStatus.Allowed, true, null, null) : (GateStatus.Pending, false, null, null) };
        var deliverd = api.Client();
        var rule = DeliverdToolApprovals.AutoApprovalRule(
            deliverd,
            new Dictionary<string, string> { ["refund"] = "finance.refund", ["wire"] = "finance.wire" },
            when: call => new ValueTask<bool>(call.Tool != "lookup"));
        var (agent, _, _) = Build();
        var session = await agent.CreateSessionAsync();
        ValueTask<bool> Ask(string tool) =>
            rule(new ToolAutoApprovalRuleContext(new FunctionCallContent("c_" + tool, tool, Args("amount", 1)), agent, session, Array.Empty<ChatMessage>(), null!));

        Assert.True(await Ask("refund"));   // a rule allowed it
        Assert.False(await Ask("wire"));    // went to a person: not this rule's to pass
        Assert.True(await Ask("lookup"));   // `when` does not select it
        Assert.False(await Ask("email"));   // `when` selects it: a person decides
        Assert.Empty(api.Approvals);

        // Fails closed when the gate cannot be asked.
        var broken = DeliverdToolApprovals.AutoApprovalRule(FakeDeliverd.Client(Scripted.Always(400)), new Dictionary<string, string> { ["refund"] = "finance.refund" });
        Assert.False(await broken(new ToolAutoApprovalRuleContext(new FunctionCallContent("c", "refund", Args("amount", 1)), agent, session, Array.Empty<ChatMessage>(), null!)));
    }

    [Fact]
    public async Task InsideToolApprovalAgentAPolicyAllowedCallNeverReachesAPerson()
    {
        // The README's harness example, end to end: the framework's own
        // ToolApprovalAgent consults the rule and approves the call itself.
        var (inner, _, ran) = Build(("call_1", "refund", Args("amount", 5)));
        var api = new FakeDeliverd();
        var deliverd = api.Client();
        var agent = inner.AsBuilder()
            .UseToolApproval(new ToolApprovalAgentOptions
            {
                AutoApprovalRules = new[]
                {
                    DeliverdToolApprovals.AutoApprovalRule(deliverd, new Dictionary<string, string> { ["refund"] = "finance.refund" }),
                },
            })
            .Build();
        var session = await agent.CreateSessionAsync();

        var response = await agent.RunWithDeliverdApprovalsAsync("Refund", session, deliverd);

        Assert.Equal(new[] { "refund 5" }, ran);
        Assert.Empty(api.Approvals);
        Assert.Contains("call_1=refunded 5", response.Text);
    }

    [Fact]
    public async Task ItStopsAfterTheCapOnRounds()
    {
        var (agent, _, _) = Build(("call_1", "refund", Args("amount", 5)));
        var api = new FakeDeliverd();
        var session = await agent.CreateSessionAsync();
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            agent.RunWithDeliverdApprovalsAsync("Refund", session, api.Client(), new DeliverdToolApprovalOptions { MaxRounds = 0 }));
        Assert.Contains("after 0 rounds", error.Message);
    }

    [Fact]
    public void AHostedMcpCallNamesItsServer()
    {
        var call = DeliverdToolCall.From(new McpServerToolCallContent("mcp_1", "create_issue", "github") { Arguments = Args("title", "x") });
        Assert.Equal("create_issue", call.Tool);
        Assert.Equal("github", call.Server);
        Assert.Equal("agent-framework:mcp_1", call.ExternalId);
    }
}
