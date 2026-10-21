using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Deliverd;

/// <summary>
/// The one place a request is made.
/// </summary>
/// <remarks>
/// Retries are deliberately narrow. A 429, a 5xx or a dropped connection is
/// worth repeating; a 4xx is the API saying the request itself is wrong, and it
/// will be just as wrong in a second. <c>Retry-After</c> is honoured when the
/// server sends one. <c>packages/conformance/cases.json</c> holds this client
/// to the same answers as the TypeScript, Python and Rust SDKs.
/// </remarks>
public sealed class DeliverdHttp
{
    /// <summary>What the client calls itself in <c>User-Agent</c>.</summary>
    public static readonly string UserAgent =
        "deliverd-dotnet/" + (typeof(DeliverdHttp).Assembly.GetName().Version?.ToString(3) ?? "0.0.0");

    private readonly HttpClient _client;
    private readonly string _apiKey;
    private readonly int _maxAttempts;

    /// <summary>
    /// How the client waits between attempts. Replaced in tests so a retry
    /// after <c>Retry-After: 2</c> does not cost the suite two seconds.
    /// </summary>
    internal Func<TimeSpan, CancellationToken, Task> Delay { get; set; } = Task.Delay;

    internal DeliverdHttp(HttpClient client, string apiKey, string baseUrl, int maxAttempts)
    {
        _client = client;
        _apiKey = apiKey;
        BaseUrl = baseUrl.TrimEnd('/');
        _maxAttempts = Math.Max(1, maxAttempts);
    }

    /// <summary>Where requests go: <c>https://deliverd.dev</c> unless you said otherwise.</summary>
    public string BaseUrl { get; }

    /// <summary><c>GET</c> a path under <c>/api/v1</c>.</summary>
    public Task<JsonNode?> GetAsync(string path, IEnumerable<KeyValuePair<string, string?>>? query = null, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, path, query, null, null, cancellationToken);

    /// <summary><c>POST</c> a JSON body to a path under <c>/api/v1</c>.</summary>
    /// <param name="path">The path, such as <c>/approvals</c>.</param>
    /// <param name="body">The JSON body.</param>
    /// <param name="idempotencyKey">
    /// Overrides the key generated for the request. Pass one when the caller's
    /// own retry should be recognised too, which only the caller can derive.
    /// </param>
    /// <param name="cancellationToken">Stops the request and any retry.</param>
    public Task<JsonNode?> PostAsync(string path, JsonNode? body, string? idempotencyKey = null, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Post, path, null, body, idempotencyKey, cancellationToken);

    private async Task<JsonNode?> SendAsync(
        HttpMethod method,
        string path,
        IEnumerable<KeyValuePair<string, string?>>? query,
        JsonNode? body,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var url = BaseUrl + "/api/v1" + path;
        var pairs = query?.Where(p => p.Value is not null).ToList();
        if (pairs is { Count: > 0 })
        {
            url += "?" + string.Join("&", pairs.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value!)));
        }

        // One id per logical request, kept across retries: it is the thing to
        // quote when something went wrong.
        var correlationId = Guid.NewGuid().ToString();
        // One idempotency key per logical request, held across every attempt
        // below, which is the whole point. A POST that arrived and lost its
        // response on the way back would otherwise be retried as a second
        // create, and for an approval that means two people asked to authorise
        // one act.
        var key = method == HttpMethod.Post ? idempotencyKey ?? Guid.NewGuid().ToString() : null;
        var payload = body?.ToJsonString();

        DeliverdException? last = null;
        for (var attempt = 1; attempt <= _maxAttempts; attempt++)
        {
            if (attempt > 1)
            {
                await Delay(last?.RetryAfter ?? Backoff(attempt), cancellationToken).ConfigureAwait(false);
            }

            using var request = new HttpRequestMessage(method, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("deliverd-correlation-id", correlationId);
            if (key is not null) request.Headers.TryAddWithoutValidation("Idempotency-Key", key);
            if (payload is not null) request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

            HttpResponseMessage response;
            try
            {
                response = await _client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception e) when (e is HttpRequestException || (e is TaskCanceledException && !cancellationToken.IsCancellationRequested))
            {
                var message = e is TaskCanceledException ? $"The request timed out: {e.Message}" : $"Could not reach Deliverd: {e.Message}";
                last = new DeliverdException(0, "network_error", message);
                if (attempt == _maxAttempts) throw last;
                continue;
            }

            using (response)
            {
                var status = (int)response.StatusCode;
                if (status == 204) return null;
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

                JsonNode? json;
                try
                {
                    json = string.IsNullOrWhiteSpace(text) ? new JsonObject() : JsonNode.Parse(text);
                }
                catch (JsonException)
                {
                    var preview = text.Length > 120 ? text.Substring(0, 120) : text;
                    last = new DeliverdException(status, "invalid_response", $"Expected JSON from {path} and got {preview}");
                    if (IsRetryable(status) && attempt < _maxAttempts) continue;
                    throw last;
                }

                if (status >= 200 && status < 300) return json;

                var envelope = json?["error"] as JsonObject;
                last = new DeliverdException(
                    status,
                    envelope?["code"]?.GetValueKind() == JsonValueKind.String ? envelope["code"]!.GetValue<string>() : "error",
                    envelope?["message"]?.GetValueKind() == JsonValueKind.String ? envelope["message"]!.GetValue<string>() : $"Request failed ({status})",
                    envelope?["details"]?.DeepClone(),
                    ParseRetryAfter(response.Headers.TryGetValues("Retry-After", out var values) ? values.FirstOrDefault() : null));
                if (IsRetryable(status) && attempt < _maxAttempts) continue;
                throw last;
            }
        }
        throw last ?? new DeliverdException(0, "error", "Request failed.");
    }

    /// <summary>
    /// 429 and most 5xx: a 4xx will be just as wrong on the next attempt.
    /// 501 is the exception among the 5xx. It means the call is not built,
    /// which is a fact about the server rather than about this moment.
    /// </summary>
    public static bool IsRetryable(int status) => status == 429 || (status >= 500 && status != 501);

    /// <summary><c>Retry-After</c> is seconds on the wire, or an HTTP date.</summary>
    public static TimeSpan? ParseRetryAfter(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return null;
        var text = header!.Trim();
        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds))
        {
            return seconds >= 0 && !double.IsInfinity(seconds) ? TimeSpan.FromSeconds(seconds) : null;
        }
        if (DateTimeOffset.TryParseExact(text, "r", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at))
        {
            var wait = at - DateTimeOffset.UtcNow;
            return wait > TimeSpan.Zero ? wait : TimeSpan.Zero;
        }
        return null;
    }

    /// <summary>Exponential from 500ms with jitter, so a fleet of agents does not resonate.</summary>
    private static TimeSpan Backoff(int attempt)
    {
        var baseMs = Math.Min(8_000, 500 * Math.Pow(2, attempt - 2));
        var jitter = Random.Shared.NextDouble();
        return TimeSpan.FromMilliseconds(baseMs / 2 + jitter * baseMs / 2);
    }
}
