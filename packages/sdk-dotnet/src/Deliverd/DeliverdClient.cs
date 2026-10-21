using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Deliverd;

/// <summary>How a <see cref="DeliverdClient"/> is made. Every field is optional.</summary>
public sealed class DeliverdClientOptions
{
    /// <summary>Defaults to <c>DELIVERD_API_KEY</c>.</summary>
    public string? ApiKey { get; set; }
    /// <summary>For self-hosted or preview deployments. Defaults to <c>DELIVERD_BASE_URL</c>, then <c>https://deliverd.dev</c>.</summary>
    public string? BaseUrl { get; set; }
    /// <summary>Attempts per request, retries included. Three.</summary>
    public int MaxAttempts { get; set; } = 3;
    /// <summary>How long one attempt may take. Thirty seconds.</summary>
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>
    /// Your own <see cref="System.Net.Http.HttpClient"/>, from <c>IHttpClientFactory</c>
    /// or with a handler of yours. Its timeout is left as you set it.
    /// </summary>
    public HttpClient? HttpClient { get; set; }
}

/// <summary>How a wait behaves. Every field is optional.</summary>
public sealed class WaitOptions
{
    /// <summary>
    /// Give up after this long with a <see cref="DeliverdTimeoutException"/>. The
    /// request stays open. Without one the wait ends when the request does,
    /// which is when it expires.
    /// </summary>
    public TimeSpan? Timeout { get; set; }
    /// <summary>How long between polls, as the wait lengthens. Rarely worth changing.</summary>
    public IReadOnlyList<TimeSpan>? PollIntervals { get; set; }
}

/// <summary>
/// The Deliverd client: ask a person, or the organisation's policy, before your
/// agent acts.
/// </summary>
/// <example>
/// <code>
/// var deliverd = new DeliverdClient();
/// var decision = await deliverd.ApproveAsync(new ApprovalRequest
/// {
///     Title = "Refund order 1042",
///     Approvers = { "finance" },
///     ExternalId = "refund:1042",
/// });
/// if (decision.Approved) await RefundAsync(1042);
/// </code>
/// </example>
public sealed class DeliverdClient
{
    /// <summary>How long a request stays open unless you say: a day.</summary>
    public static readonly TimeSpan DefaultExpiry = TimeSpan.FromDays(1);

    /// <summary>
    /// How often to ask, as the wait gets longer. The first is quick: the
    /// approvals that take two seconds are the ones somebody is watching.
    /// </summary>
    public static readonly IReadOnlyList<TimeSpan> PollSchedule = new[]
    {
        TimeSpan.FromMilliseconds(250),
        TimeSpan.FromMilliseconds(750),
        TimeSpan.FromSeconds(2),
        TimeSpan.FromSeconds(4),
        TimeSpan.FromSeconds(8),
        TimeSpan.FromSeconds(15),
        TimeSpan.FromSeconds(30),
    };

    /// <summary>A client from the environment: <c>DELIVERD_API_KEY</c>, and <c>DELIVERD_BASE_URL</c> when set.</summary>
    public DeliverdClient() : this(new DeliverdClientOptions()) { }

    /// <summary>A client with this key, and everything else from the environment or the defaults.</summary>
    public DeliverdClient(string apiKey) : this(new DeliverdClientOptions { ApiKey = apiKey }) { }

    /// <summary>A client as described.</summary>
    /// <exception cref="DeliverdException">With code <c>no_api_key</c> when there is no key anywhere.</exception>
    public DeliverdClient(DeliverdClientOptions options)
    {
        var apiKey = Blank(options.ApiKey) ?? Blank(Environment.GetEnvironmentVariable("DELIVERD_API_KEY"));
        if (apiKey is null)
        {
            throw new DeliverdException(
                0,
                "no_api_key",
                $"An API key is required. Pass one, or set DELIVERD_API_KEY. No account yet? The Free plan needs no card: {DeliverdException.SignUpUrl}");
        }
        var baseUrl = Blank(options.BaseUrl) ?? Blank(Environment.GetEnvironmentVariable("DELIVERD_BASE_URL")) ?? "https://deliverd.dev";
        var client = options.HttpClient ?? new HttpClient { Timeout = options.RequestTimeout };
        Http = new DeliverdHttp(client, apiKey, baseUrl, options.MaxAttempts);
        Approvals = new Approvals(Http);
        Gates = new Gates(Http);
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    /// <summary>
    /// The authenticated transport, for the parts of the API this client has no
    /// named method for yet. The same retries and errors apply.
    /// </summary>
    public DeliverdHttp Http { get; }

    /// <summary>Ask a person, step by step.</summary>
    public Approvals Approvals { get; }

    /// <summary>Ask the organisation's policy, step by step.</summary>
    public Gates Gates { get; }

    /// <summary>
    /// Ask a person and wait for their answer.
    /// </summary>
    /// <remarks>
    /// Returns on approved, rejected, expired and cancelled alike: a refusal is an
    /// answer, not an error. With an <see cref="ApprovalRequest.ExternalId"/> the
    /// request already filed under it is found and waited on rather than asked
    /// again, so a restarted agent does not ask twice.
    /// </remarks>
    /// <exception cref="DeliverdTimeoutException">The wait ran out; the request is still open.</exception>
    public async Task<Decision> ApproveAsync(ApprovalRequest request, WaitOptions? wait = null, CancellationToken cancellationToken = default)
    {
        if (request.ExternalId is { Length: > 0 } externalId)
        {
            var existing = await Approvals.FindByExternalIdAsync(externalId, cancellationToken).ConfigureAwait(false);
            if (existing is not null)
            {
                return (await Approvals.WaitAsync(existing, wait, cancellationToken).ConfigureAwait(false)).ToDecision();
            }
        }
        var created = await Approvals.CreateAsync(request, DefaultExpiry, cancellationToken).ConfigureAwait(false);
        return (await Approvals.WaitAsync(created, wait, cancellationToken).ConfigureAwait(false)).ToDecision();
    }

    /// <summary>
    /// Ask whether to act, and wait if a person has to decide.
    /// </summary>
    /// <remarks>
    /// The answer comes from policy the developer does not own: a rule may allow
    /// it at once, deny it, or send it to a person. Pass <paramref name="wait"/>
    /// false to return straight away even when it went to a person.
    /// </remarks>
    /// <exception cref="DeliverdTimeoutException">The wait ran out; the gate is still open.</exception>
    public async Task<GateDecision> GateAsync(GateRequest request, bool wait = true, WaitOptions? waitOptions = null, CancellationToken cancellationToken = default)
    {
        var gate = await Gates.CreateAsync(request, cancellationToken).ConfigureAwait(false);
        // No wait when the caller said not to, and none when a rule already
        // answered: the common case, which must not cost a poll.
        if (!wait || !gate.IsPending) return gate.ToDecision();
        return (await Gates.WaitAsync(gate, waitOptions, cancellationToken).ConfigureAwait(false)).ToDecision();
    }

    internal static async Task<T> PollAsync<T>(
        T current,
        Func<T, bool> pending,
        Func<CancellationToken, Task<T>> refresh,
        Func<T, string> timedOut,
        WaitOptions? options,
        Func<TimeSpan, CancellationToken, Task> delay,
        CancellationToken cancellationToken)
    {
        if (!pending(current)) return current;
        var schedule = options?.PollIntervals is { Count: > 0 } custom ? custom : PollSchedule;
        var deadline = options?.Timeout is { } timeout ? DateTimeOffset.UtcNow + timeout : (DateTimeOffset?)null;
        for (var poll = 0; ; poll++)
        {
            if (deadline is { } d && DateTimeOffset.UtcNow >= d) throw new DeliverdTimeoutException(timedOut(current));
            var step = schedule[Math.Min(poll, schedule.Count - 1)];
            // Plus or minus a quarter, so a hundred agents started by the same
            // cron do not arrive together.
            var wait = TimeSpan.FromTicks((long)(step.Ticks * (0.75 + Random.Shared.NextDouble() * 0.5)));
            if (deadline is { } end && end - DateTimeOffset.UtcNow < wait) wait = end - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero) await delay(wait, cancellationToken).ConfigureAwait(false);
            current = await refresh(cancellationToken).ConfigureAwait(false);
            if (!pending(current)) return current;
        }
    }
}

/// <summary>The approvals API.</summary>
public sealed class Approvals
{
    private readonly DeliverdHttp _http;

    internal Approvals(DeliverdHttp http) => _http = http;

    /// <summary>Ask. Returns as soon as the request is filed; wait on it next, or keep the id and look later.</summary>
    public Task<ApprovalData> CreateAsync(ApprovalRequest request, CancellationToken cancellationToken = default) =>
        CreateAsync(request, null, cancellationToken);

    internal async Task<ApprovalData> CreateAsync(ApprovalRequest request, TimeSpan? fallbackExpiry, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
        {
            throw new DeliverdException(0, "invalid_request", "An approval needs a title: what is being asked, as a headline.");
        }
        return ApprovalData.From(await _http.PostAsync("/approvals", request.ToJson(fallbackExpiry), null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>One request, as it stands now.</summary>
    public async Task<ApprovalData> GetAsync(string id, CancellationToken cancellationToken = default) =>
        ApprovalData.From(await _http.GetAsync("/approvals/" + Uri.EscapeDataString(id), null, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// The request already filed under this external id, if there is one, so a
    /// restarted agent does not ask twice. Best effort: two concurrent calls can
    /// still both find nothing and both create.
    /// </summary>
    public async Task<ApprovalData?> FindByExternalIdAsync(string externalId, CancellationToken cancellationToken = default)
    {
        var page = await _http.GetAsync(
            "/approvals",
            new Dictionary<string, string?> { ["externalId"] = externalId, ["limit"] = "1" },
            cancellationToken).ConfigureAwait(false);
        var first = (page?["approvals"] as JsonArray)?.FirstOrDefault();
        return first is null ? null : ApprovalData.From(first);
    }

    /// <summary>Withdraw it. The row stays as evidence of what was asked and dropped.</summary>
    public async Task<ApprovalData> CancelAsync(string id, CancellationToken cancellationToken = default) =>
        ApprovalData.From(await _http.PostAsync("/approvals/" + Uri.EscapeDataString(id) + "/cancel", null, null, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// Wait until a person decides. Returns on every settled status; fails only
    /// when the wait itself did.
    /// </summary>
    /// <exception cref="DeliverdTimeoutException">The wait ran out; the request is still open.</exception>
    public Task<ApprovalData> WaitAsync(ApprovalData approval, WaitOptions? options = null, CancellationToken cancellationToken = default) =>
        DeliverdClient.PollAsync(
            approval,
            a => a.IsPending,
            ct => GetAsync(approval.Id, ct),
            a => a.OpenQuestions.Count > 0
                // Say which of the two happened. An approver who asked a question
                // and got no answer has not ignored the request.
                ? $"An approver asked a question about \"{a.Title}\" and nothing answered it: \"{a.OpenQuestions[0]}\". Answer it at {a.Url}."
                : $"Nobody decided \"{a.Title}\" within the timeout. It is still open at {a.Url}.",
            options,
            _http.Delay,
            cancellationToken);
}

/// <summary>The gates API.</summary>
public sealed class Gates
{
    private readonly DeliverdHttp _http;

    internal Gates(DeliverdHttp http) => _http = http;

    /// <summary>
    /// Raise a decision and return straight away, even if it went to a person.
    /// </summary>
    /// <remarks>
    /// The caller's external id goes out as the HTTP idempotency key too, so a
    /// retry inside the transport and a retry by your own code are the same key.
    /// </remarks>
    /// <exception cref="DeliverdException">With code <c>external_id_required</c>, before anything is sent.</exception>
    public async Task<GateData> CreateAsync(GateRequest request, CancellationToken cancellationToken = default)
    {
        // Refused before anything leaves: an empty id would be one the server
        // could not tell from every other empty id.
        if (string.IsNullOrWhiteSpace(request.ExternalId))
        {
            throw new DeliverdException(
                0,
                "external_id_required",
                "A gate needs your own ExternalId for this unit of work (\"refund:ord_8812\"), so a retry re-reads the decision instead of asking twice.");
        }
        return GateData.From(await _http.PostAsync("/gates", request.ToJson(), request.ExternalId, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>One gate, as it stands now.</summary>
    public async Task<GateData> GetAsync(string id, CancellationToken cancellationToken = default) =>
        GateData.From(await _http.GetAsync("/gates/" + Uri.EscapeDataString(id), null, cancellationToken).ConfigureAwait(false));

    /// <summary>Wait until a person decides. Returns at once when a rule already settled it.</summary>
    /// <exception cref="DeliverdTimeoutException">The wait ran out; the gate is still open.</exception>
    public Task<GateData> WaitAsync(GateData gate, WaitOptions? options = null, CancellationToken cancellationToken = default) =>
        DeliverdClient.PollAsync(
            gate,
            g => g.IsPending,
            ct => GetAsync(gate.Id, ct),
            g => $"Nobody decided the gate on \"{(g.ActionId.Length > 0 ? g.ActionId : g.Id)}\" within the timeout. "
                + (g.ApprovalUrl is null ? "It is still open." : $"It is still open at {g.ApprovalUrl}."),
            options,
            _http.Delay,
            cancellationToken);
}
