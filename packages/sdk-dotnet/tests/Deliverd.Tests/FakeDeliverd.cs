using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Deliverd.Tests;

/// <summary>A request the fake API was sent, with what it carried.</summary>
public sealed record Seen(string Method, string Path, string? Query, IReadOnlyDictionary<string, string> Headers, JsonObject? Body)
{
    public string? Header(string name) =>
        Headers.FirstOrDefault(h => string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
}

/// <summary>Answers every request from a script, and remembers what it was sent.</summary>
public sealed class Scripted : HttpMessageHandler
{
    private readonly Queue<(int Status, JsonNode Body, string? RetryAfter)> _answers = new();
    private (int Status, JsonNode Body, string? RetryAfter) _last;
    public List<Seen> Seen { get; } = new();

    public Scripted(params (int Status, JsonNode Body, string? RetryAfter)[] answers)
    {
        foreach (var a in answers) _answers.Enqueue(a);
        _last = answers[^1];
    }

    public static Scripted Always(int status) =>
        new((status, new JsonObject { ["error"] = new JsonObject { ["code"] = "x", ["message"] = "x" } }, null));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Seen.Add(await Record(request).ConfigureAwait(false));
        var (status, body, retryAfter) = _answers.Count > 0 ? _answers.Dequeue() : _last;
        var response = new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (retryAfter is not null) response.Headers.TryAddWithoutValidation("Retry-After", retryAfter);
        return response;
    }

    internal static async Task<Seen> Record(HttpRequestMessage request)
    {
        var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        var text = request.Content is null ? null : await request.Content.ReadAsStringAsync().ConfigureAwait(false);
        return new Seen(
            request.Method.Method,
            request.RequestUri!.AbsolutePath,
            request.RequestUri.Query,
            headers,
            string.IsNullOrEmpty(text) ? null : JsonNode.Parse(text) as JsonObject);
    }
}

/// <summary>
/// An in-memory Deliverd: approvals a person decides by the script, gates a
/// rule decides by the script. Enough of the API for the adapter, with nothing
/// mocked above the HTTP line.
/// </summary>
public sealed class FakeDeliverd : HttpMessageHandler
{
    private readonly Dictionary<string, JsonObject> _approvals = new();
    private readonly Dictionary<string, JsonObject> _gates = new();
    private int _next;

    public List<Seen> Seen { get; } = new();

    /// <summary>How a person answers an approval about a tool: status, note, changes. Pending forever when null.</summary>
    public Func<string, (string Status, string? Note, JsonArray? Changes)?> Person { get; set; } =
        _ => (ApprovalStatus.Approved, null, null);

    /// <summary>What a rule says about an action. A gate that waits on a person when the status is pending.</summary>
    public Func<string, (string Status, bool Allowed, string? Reason, JsonArray? Changes)> Rule { get; set; } =
        _ => (GateStatus.Allowed, true, null, null);

    public IEnumerable<JsonObject> Approvals => _approvals.Values;

    public DeliverdClient Client() => Client(this);

    public static DeliverdClient Client(HttpMessageHandler handler)
    {
        var client = new DeliverdClient(new DeliverdClientOptions
        {
            ApiKey = "dlv_test",
            BaseUrl = "https://deliverd.test",
            HttpClient = new HttpClient(handler),
        });
        client.Http.Delay = (_, _) => Task.CompletedTask;
        return client;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var seen = await Scripted.Record(request).ConfigureAwait(false);
        lock (Seen) Seen.Add(seen);
        lock (_approvals) return Answer(seen);
    }

    private HttpResponseMessage Answer(Seen seen)
    {
        var path = seen.Path.Substring("/api/v1".Length);
        if (seen.Method == "POST" && path == "/approvals")
        {
            var body = seen.Body!;
            var id = "apr_" + ++_next;
            var row = new JsonObject
            {
                ["id"] = id,
                ["status"] = ApprovalStatus.Pending,
                ["url"] = "https://deliverd.test/a/" + id,
                ["title"] = body["title"]?.DeepClone(),
                ["externalId"] = body["externalId"]?.DeepClone(),
                ["metadata"] = body["metadata"]?.DeepClone(),
                ["input"] = body["input"]?.DeepClone(),
                ["request"] = body.DeepClone(),
            };
            _approvals[id] = row;
            return Json(201, row);
        }
        if (seen.Method == "GET" && path == "/approvals")
        {
            var externalId = Uri.UnescapeDataString(seen.Query!.Split('&').First(p => p.TrimStart('?').StartsWith("externalId=", StringComparison.Ordinal)).Split('=')[1]);
            var found = _approvals.Values.Where(a => a["externalId"]?.GetValue<string>() == externalId).Select(a => (JsonNode)Settle(a).DeepClone()).ToArray();
            return Json(200, new JsonObject { ["approvals"] = new JsonArray(found) });
        }
        if (seen.Method == "GET" && path.StartsWith("/approvals/", StringComparison.Ordinal))
        {
            var row = Settle(_approvals[path.Substring("/approvals/".Length)]);
            return Json(200, row);
        }
        if (seen.Method == "POST" && path == "/gates")
        {
            var body = seen.Body!;
            var externalId = body["externalId"]!.GetValue<string>();
            if (_gates.TryGetValue(externalId, out var existing))
            {
                existing["reused"] = true;
                return Json(200, existing);
            }
            var action = body["actionId"]!.GetValue<string>();
            var (status, allowed, reason, changes) = Rule(action);
            var gate = new JsonObject
            {
                ["id"] = "gat_" + ++_next,
                ["status"] = status,
                ["allowed"] = allowed,
                ["reason"] = reason,
                ["actionId"] = action,
                ["input"] = body["input"]?.DeepClone(),
                ["reused"] = false,
            };
            if (changes is not null) gate["changes"] = changes.DeepClone();
            _gates[externalId] = gate;
            return Json(201, gate);
        }
        if (seen.Method == "GET" && path.StartsWith("/gates/", StringComparison.Ordinal))
        {
            return Json(200, _gates.Values.First(g => g["id"]!.GetValue<string>() == path.Substring("/gates/".Length)));
        }
        return Json(404, new JsonObject { ["error"] = new JsonObject { ["code"] = "not_found", ["message"] = path } });
    }

    /// <summary>A person looks at it whenever anyone reads it, as a real one might have in the meantime.</summary>
    private JsonObject Settle(JsonObject row)
    {
        if (row["status"]!.GetValue<string>() != ApprovalStatus.Pending) return row;
        var tool = row["metadata"]?["tool"]?.GetValue<string>() ?? string.Empty;
        if (Person(tool) is { } answer)
        {
            row["status"] = answer.Status;
            row["note"] = answer.Note;
            row["decidedBy"] = "Dana";
            if (answer.Changes is not null) row["changes"] = answer.Changes.DeepClone();
        }
        return row;
    }

    private static HttpResponseMessage Json(int status, JsonNode body) => new((HttpStatusCode)status)
    {
        Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
    };
}
