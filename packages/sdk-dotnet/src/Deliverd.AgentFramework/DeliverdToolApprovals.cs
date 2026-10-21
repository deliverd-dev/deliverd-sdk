using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace Deliverd.AgentFramework;

/// <summary>How tool calls are put to people. Every field is optional.</summary>
public sealed class DeliverdToolApprovalOptions
{
    /// <summary>How long a tool call's request stays open unless you say. An hour, not the client's day: an agent is waiting on it.</summary>
    public static readonly TimeSpan DefaultExpiry = TimeSpan.FromHours(1);

    /// <summary>People, teams or groups who may decide. Your owners and admins when empty.</summary>
    public IList<string> Approvers { get; set; } = new List<string>();

    /// <summary>
    /// Picks the calls that need a person; the rest are approved without asking.
    /// Every call when null.
    /// </summary>
    public Func<DeliverdToolCall, ValueTask<bool>>? When { get; set; }

    /// <summary>What a person is shown about a call. A plain account of the tool and its input when null.</summary>
    public Func<DeliverdToolCall, ToolCallDescription>? Describe { get; set; }

    /// <summary>
    /// Maps a tool to a Deliverd action, whose gate decides instead: by policy,
    /// or by a person when a rule says so.
    /// </summary>
    public IDictionary<string, string> Actions { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>How long each request stays open. <see cref="DefaultExpiry"/> when null.</summary>
    public TimeSpan? ExpiresIn { get; set; }

    /// <summary>
    /// Stop waiting after this long. A call nobody decided by then is left
    /// pending with no answer built; resolve the same response again later and
    /// the same request is found.
    /// </summary>
    public TimeSpan? Timeout { get; set; }

    /// <summary>The flow (a project, in the app) the requests belong to.</summary>
    public string? FlowId { get; set; }

    /// <summary>Anything you want back on every request's record. <c>tool</c> and <c>mcp_server</c> are added.</summary>
    public JsonObject? Metadata { get; set; }

    /// <summary>Which agent is asking, as you describe it. Recorded and shown; nothing is decided on it.</summary>
    public DeclaredAgent? Agent { get; set; }

    /// <summary>The model the agent is running on.</summary>
    public string? Model { get; set; }

    /// <summary>Polling, for the waits. Rarely worth changing.</summary>
    public IReadOnlyList<TimeSpan>? PollIntervals { get; set; }

    /// <summary>A cap on rounds, so an agent that keeps asking does not wait forever. Ten.</summary>
    public int MaxRounds { get; set; } = 10;
}

/// <summary>What one round of decisions came to.</summary>
/// <remarks>
/// Three fields rather than a list, because "nothing to send" and "nothing
/// decided yet" are different instructions and a list cannot tell them apart.
/// </remarks>
public sealed class ToolApprovalResolution
{
    /// <summary>
    /// The answers to hand back to the agent, one per decided call, in the order
    /// the calls were asked about. Send them in one user message on the same
    /// session.
    /// </summary>
    public IList<ToolApprovalResponseContent> Responses { get; } = new List<ToolApprovalResponseContent>();

    /// <summary>
    /// The calls nobody decided before the timeout, by call id. Still open in
    /// Deliverd and still waiting in the session.
    /// </summary>
    public IList<string> Pending { get; } = new List<string>();

    /// <summary>
    /// Why each declined call was declined, by call id. The same sentence rides
    /// on the response's <see cref="ToolApprovalResponseContent.Reason"/>, which
    /// Agent Framework hands to the model with the rejection.
    /// </summary>
    public IDictionary<string, string> Reasons { get; } = new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>Every call has an answer, so <see cref="Responses"/> is the whole reply.</summary>
    public bool Complete => Pending.Count == 0;

    /// <summary>The responses as one user message, ready for <c>RunAsync</c>.</summary>
    public ChatMessage ToMessage() => new(ChatRole.User, Responses.Cast<AIContent>().ToList());
}

/// <summary>
/// Microsoft Agent Framework: a person approves tool calls, through Deliverd.
/// </summary>
/// <remarks>
/// <para>
/// Mark the tools that need a person as Agent Framework already has you do, by
/// wrapping them in <see cref="ApprovalRequiredAIFunction"/>, and run the agent
/// through <see cref="RunWithDeliverdApprovalsAsync(AIAgent, string, AgentSession, DeliverdClient, DeliverdToolApprovalOptions?, AgentRunOptions?, CancellationToken)"/>.
/// Each <see cref="ToolApprovalRequestContent"/> in the response becomes a
/// request in Deliverd, keyed by its call id (<c>agent-framework:&lt;call id&gt;</c>)
/// so a retried round finds the request it already made. Approved calls run;
/// declined ones do not, and the model is told why.
/// </para>
/// <para>
/// The run continues on the same session, which is where Agent Framework binds
/// an answer to the request it issued: pass the session, or an answer cannot
/// resume anything.
/// </para>
/// <para>
/// A call approved only with changes is declined, and the model is told the
/// approved values. Agent Framework runs an approved call exactly as it
/// recorded it when it asked, so a corrected call cannot be run in its place.
/// </para>
/// </remarks>
public static class DeliverdToolApprovals
{
    /// <summary>The tool approvals among a response's contents.</summary>
    public static IReadOnlyList<ToolApprovalRequestContent> ApprovalRequests(AgentResponse response) =>
        response.Messages.SelectMany(m => m.Contents).OfType<ToolApprovalRequestContent>().ToList();

    /// <summary>
    /// Input the response asks for that this adapter cannot give, such as an
    /// OAuth consent: any request for input that is not a tool approval.
    /// </summary>
    private static int OtherInputRequests(AgentResponse response) =>
        response.Messages.SelectMany(m => m.Contents).Count(c => c is InputRequestContent && c is not ToolApprovalRequestContent);

    /// <summary>
    /// Ask about every tool approval in a response, and build the answers.
    /// </summary>
    /// <remarks>
    /// The requests are asked together, so their approvers hear about all of them
    /// at once. For a loop you own:
    /// <code>
    /// var resolution = await deliverd.ResolveToolApprovalsAsync(response, options);
    /// if (resolution.Complete)
    ///     response = await agent.RunAsync(resolution.ToMessage(), session);
    /// </code>
    /// </remarks>
    public static async Task<ToolApprovalResolution> ResolveToolApprovalsAsync(
        this DeliverdClient deliverd,
        AgentResponse response,
        DeliverdToolApprovalOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (deliverd is null) throw new ArgumentNullException(nameof(deliverd));
        if (response is null) throw new ArgumentNullException(nameof(response));
        options ??= new DeliverdToolApprovalOptions();

        var requests = ApprovalRequests(response);
        var calls = requests.Select(r => DeliverdToolCall.From(r.ToolCall, r.RequestId)).ToList();
        var outcomes = await Task.WhenAll(calls.Select(c => DecideAsync(c, deliverd, options, cancellationToken))).ConfigureAwait(false);

        var resolution = new ToolApprovalResolution();
        for (var i = 0; i < requests.Count; i++)
        {
            var (call, outcome) = (calls[i], outcomes[i]);
            if (outcome.Pending)
            {
                resolution.Pending.Add(call.CallId);
                continue;
            }
            resolution.Responses.Add(requests[i].CreateResponse(outcome.Allowed, outcome.Allowed ? null : outcome.Reason));
            if (!outcome.Allowed && outcome.Reason is not null) resolution.Reasons[call.CallId] = outcome.Reason;
        }
        return resolution;
    }

    /// <inheritdoc cref="RunWithDeliverdApprovalsAsync(AIAgent, IEnumerable{ChatMessage}, AgentSession, DeliverdClient, DeliverdToolApprovalOptions?, AgentRunOptions?, CancellationToken)"/>
    public static Task<AgentResponse> RunWithDeliverdApprovalsAsync(
        this AIAgent agent,
        string message,
        AgentSession session,
        DeliverdClient deliverd,
        DeliverdToolApprovalOptions? options = null,
        AgentRunOptions? runOptions = null,
        CancellationToken cancellationToken = default) =>
        RunWithDeliverdApprovalsAsync(agent, new[] { new ChatMessage(ChatRole.User, message) }, session, deliverd, options, runOptions, cancellationToken);

    /// <inheritdoc cref="RunWithDeliverdApprovalsAsync(AIAgent, IEnumerable{ChatMessage}, AgentSession, DeliverdClient, DeliverdToolApprovalOptions?, AgentRunOptions?, CancellationToken)"/>
    public static Task<AgentResponse> RunWithDeliverdApprovalsAsync(
        this AIAgent agent,
        ChatMessage message,
        AgentSession session,
        DeliverdClient deliverd,
        DeliverdToolApprovalOptions? options = null,
        AgentRunOptions? runOptions = null,
        CancellationToken cancellationToken = default) =>
        RunWithDeliverdApprovalsAsync(agent, new[] { message }, session, deliverd, options, runOptions, cancellationToken);

    /// <summary>
    /// Run until nothing is waiting on a person, and return the last response.
    /// </summary>
    /// <remarks>
    /// The agent runs on <paramref name="session"/> first, then, after each round
    /// of decisions, the answers go back in one user message on the same session.
    /// <paramref name="runOptions"/> goes to every run. Returns early, with the
    /// requests still in the response, when <see cref="DeliverdToolApprovalOptions.Timeout"/>
    /// ran out before somebody decided (keep the session and call
    /// <see cref="ResolveToolApprovalsAsync"/> on that response later), and when
    /// the response asks for input this adapter cannot give, such as an OAuth
    /// consent.
    /// </remarks>
    /// <exception cref="InvalidOperationException">The run was still asking after <see cref="DeliverdToolApprovalOptions.MaxRounds"/> rounds.</exception>
    public static async Task<AgentResponse> RunWithDeliverdApprovalsAsync(
        this AIAgent agent,
        IEnumerable<ChatMessage> messages,
        AgentSession session,
        DeliverdClient deliverd,
        DeliverdToolApprovalOptions? options = null,
        AgentRunOptions? runOptions = null,
        CancellationToken cancellationToken = default)
    {
        if (agent is null) throw new ArgumentNullException(nameof(agent));
        // Agent Framework binds an answer to the request it surfaced on this
        // session. Without one the answers this sends could resume nothing.
        if (session is null) throw new ArgumentNullException(nameof(session), "Pass the session the agent runs on: Agent Framework binds each answer to the request it issued there.");
        options ??= new DeliverdToolApprovalOptions();

        var response = await agent.RunAsync(messages, session, runOptions, cancellationToken).ConfigureAwait(false);
        for (var rounds = 0; ; rounds++)
        {
            var requests = ApprovalRequests(response);
            if (requests.Count == 0 || OtherInputRequests(response) > 0) return response;
            if (rounds >= options.MaxRounds) throw new InvalidOperationException(Texts.MaxRounds(options.MaxRounds));
            var resolution = await deliverd.ResolveToolApprovalsAsync(response, options, cancellationToken).ConfigureAwait(false);
            if (!resolution.Complete) return response;
            response = await agent.RunAsync(resolution.ToMessage(), session, runOptions, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// An auto-approval rule for <see cref="ToolApprovalAgentOptions.AutoApprovalRules"/>:
    /// true only for a call that needs no person.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A tool named in <paramref name="actions"/> is the organisation's to decide:
    /// it is put to that Deliverd action's gate without waiting, and passes only
    /// when a rule allowed it as proposed. Any other tool passes when
    /// <paramref name="when"/> does not select it. With neither, nothing passes:
    /// every call goes to a person, through <see cref="ResolveToolApprovalsAsync"/>,
    /// which finds the same gate by the same external id rather than asking twice.
    /// </para>
    /// <para>
    /// Fails closed: a gate that cannot be asked (an unknown action, input its
    /// schema refuses, an unreachable API) is not permission, so the call goes to
    /// a person, where resolving it raises the same error loudly.
    /// </para>
    /// </remarks>
    public static Func<ToolAutoApprovalRuleContext, ValueTask<bool>> AutoApprovalRule(
        DeliverdClient deliverd,
        IReadOnlyDictionary<string, string>? actions = null,
        Func<DeliverdToolCall, ValueTask<bool>>? when = null,
        string? flowId = null)
    {
        if (deliverd is null) throw new ArgumentNullException(nameof(deliverd));
        return async context =>
        {
            var call = DeliverdToolCall.From(context.FunctionCallContent);
            if (actions is not null && actions.TryGetValue(call.Tool, out var action))
            {
                try
                {
                    var decision = await deliverd.GateAsync(
                        new GateRequest { Action = action, ExternalId = call.ExternalId, Input = Texts.GateInput(call.Arguments), FlowId = flowId },
                        wait: false).ConfigureAwait(false);
                    return decision.Allowed && decision.Changes.Count == 0;
                }
                catch (DeliverdException)
                {
                    return false;
                }
            }
            if (when is null) return false;
            return !await when(call).ConfigureAwait(false);
        };
    }

    private readonly struct Outcome
    {
        public Outcome(bool allowed, bool pending = false, string? reason = null)
        {
            Allowed = allowed;
            Pending = pending;
            Reason = reason;
        }

        public bool Allowed { get; }
        public bool Pending { get; }
        public string? Reason { get; }
    }

    private static async Task<Outcome> DecideAsync(DeliverdToolCall call, DeliverdClient deliverd, DeliverdToolApprovalOptions options, CancellationToken cancellationToken)
    {
        var wait = new WaitOptions { Timeout = options.Timeout, PollIntervals = options.PollIntervals };
        try
        {
            if (options.Actions.TryGetValue(call.Tool, out var action))
            {
                var gate = await deliverd.GateAsync(
                    new GateRequest { Action = action, ExternalId = call.ExternalId, Input = Texts.GateInput(call.Arguments), FlowId = options.FlowId },
                    wait: true,
                    wait,
                    cancellationToken).ConfigureAwait(false);
                if (gate.Allowed)
                {
                    return gate.Changes.Count > 0 ? new Outcome(false, reason: Texts.Changed(call.Tool, gate.Changes)) : new Outcome(true);
                }
                if (gate.Status == GateStatus.Pending) return new Outcome(false, pending: true);
                return new Outcome(false, reason: Texts.Refusal(call.Tool, gate.Status, gate.Reason));
            }

            if (options.When is not null && !await options.When(call).ConfigureAwait(false)) return new Outcome(true);

            var decision = await deliverd.ApproveAsync(ApprovalFor(call, options), wait, cancellationToken).ConfigureAwait(false);
            if (decision.Approved)
            {
                return decision.Changes.Count > 0 ? new Outcome(false, reason: Texts.Changed(call.Tool, decision.Changes)) : new Outcome(true);
            }
            return new Outcome(false, reason: Texts.Refusal(call.Tool, decision.Status, decision.Note, decision.DecidedBy));
        }
        catch (DeliverdTimeoutException)
        {
            return new Outcome(false, pending: true);
        }
    }

    private static ApprovalRequest ApprovalFor(DeliverdToolCall call, DeliverdToolApprovalOptions options)
    {
        var described = options.Describe?.Invoke(call) ?? Texts.DefaultDescription(call);
        if (string.IsNullOrWhiteSpace(described.Title))
        {
            throw new InvalidOperationException("Describe must return a description with a title.");
        }
        var metadata = options.Metadata?.DeepClone() as JsonObject ?? new JsonObject();
        metadata["tool"] = call.Tool;
        if (call.Server is not null) metadata["mcp_server"] = call.Server;
        return new ApprovalRequest
        {
            Title = described.Title,
            Description = described.Description,
            Risk = described.Risk,
            Factors = described.Factors,
            Approvers = options.Approvers,
            // The idempotency: a retried round, or a restarted process, finds the
            // request this call already made instead of asking a second time.
            ExternalId = call.ExternalId,
            FlowId = options.FlowId,
            Metadata = metadata,
            ExpiresIn = options.ExpiresIn ?? DeliverdToolApprovalOptions.DefaultExpiry,
            // Shown field by field. No editable fields: Agent Framework cannot run
            // a corrected call, so a person is not offered the chance to make one.
            Input = Texts.Structured(call.Arguments),
            Agent = options.Agent,
            Model = options.Model,
        };
    }
}
