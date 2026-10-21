using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Xunit;

namespace Deliverd.Tests;

/// <summary>
/// The behaviour every SDK shares, read from one table.
/// </summary>
/// <remarks>
/// <c>packages/conformance/cases.json</c> is read by the TypeScript, Python and
/// Rust suites and this one, so a case added there fails in whichever language
/// has not implemented it.
///
/// Not read here: <c>resume</c>, because this package has no flows or tasks
/// yet, and the gate's <c>developmentOutcomes</c>, because it has no
/// development mode. Both are named in the guard that holds every suite to the
/// table (<c>apps/web/src/lib/api/python-sdk-parity.test.ts</c>), with why.
/// </remarks>
public class ConformanceTests
{
    private static readonly JsonObject CASES = Load();

    private static JsonObject Load([CallerFilePath] string here = "") =>
        (JsonObject)JsonNode.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "..", "conformance", "cases.json")))!;

    [Fact]
    public void ReadsDurationsAsTheOtherSdksDo()
    {
        var durations = CASES["durations"]!;
        foreach (var c in durations["shared"]!.AsArray())
        {
            Assert.Equal(TimeSpan.FromSeconds(c!["seconds"]!.GetValue<double>()), DeliverdDuration.Parse(c["input"]!.GetValue<string>()));
        }
        foreach (var input in durations["rejected"]!.AsArray())
        {
            var error = Assert.Throws<DeliverdException>(() => DeliverdDuration.Parse(input!.GetValue<string>()));
            Assert.Equal("invalid_duration", error.Code);
        }
        // A bare number means a different unit in TypeScript and Python. .NET
        // takes neither: its timers take a TimeSpan, which says its own unit,
        // so the number is refused rather than read as a third guess.
        foreach (var c in durations["divergent"]!.AsArray())
        {
            Assert.Throws<DeliverdException>(() => DeliverdDuration.Parse(c!["input"]!.ToJsonString()));
        }
    }

    [Fact]
    public async Task RetriesExactlyWhatTheTableSays()
    {
        var retries = CASES["retries"]!;
        Assert.Equal(3, retries["_maxAttempts"]!.GetValue<int>());
        foreach (var c in retries["cases"]!.AsArray())
        {
            var status = c!["status"]!.GetValue<int>();
            var handler = Scripted.Always(status);
            var error = await Assert.ThrowsAsync<DeliverdException>(() => FakeDeliverd.Client(handler).Http.GetAsync("/approvals"));
            Assert.Equal(status, error.Status);
            Assert.True(c["attempts"]!.GetValue<int>() == handler.Seen.Count, $"{status}: {c["why"]}");
            Assert.Equal(c["attempts"]!.GetValue<int>() > 1, DeliverdHttp.IsRetryable(status));
        }
    }

    [Fact]
    public async Task HonoursRetryAfterInSeconds()
    {
        var retryAfter = CASES["retryAfter"]!;
        Assert.True(retryAfter["honoured"]!.GetValue<bool>());
        var header = retryAfter["header"]!.GetValue<string>();
        var seconds = retryAfter["py_seconds"]!.GetValue<double>();
        Assert.Equal(TimeSpan.FromSeconds(seconds), DeliverdHttp.ParseRetryAfter(header));

        var handler = new Scripted(
            (429, new JsonObject { ["error"] = new JsonObject { ["code"] = "rate_limited" } }, header),
            (200, new JsonObject { ["ok"] = true }, null));
        var client = FakeDeliverd.Client(handler);
        var waits = new List<TimeSpan>();
        client.Http.Delay = (span, _) => { waits.Add(span); return Task.CompletedTask; };
        await client.Http.GetAsync("/approvals");
        Assert.Equal(2, handler.Seen.Count);
        Assert.Equal(new[] { TimeSpan.FromSeconds(seconds) }, waits);
    }

    [Fact]
    public async Task ARetriedPostCarriesOneIdempotencyKey()
    {
        var idempotency = CASES["idempotency"]!;
        var handler = Scripted.Always(idempotency["retryStatus"]!.GetValue<int>());
        await Assert.ThrowsAsync<DeliverdException>(() => FakeDeliverd.Client(handler).Http.PostAsync("/approvals", new JsonObject { ["title"] = "x" }));

        Assert.Equal(idempotency["expectedAttempts"]!.GetValue<int>(), handler.Seen.Count);
        var keys = handler.Seen.Select(s => s.Header(idempotency["header"]!.GetValue<string>())).ToList();
        Assert.All(keys, k => Assert.False(string.IsNullOrEmpty(k), "A POST went out with no idempotency key."));
        Assert.True(idempotency["sameKeyOnEveryAttempt"]!.GetValue<bool>());
        Assert.Single(keys.Distinct());
    }

    [Fact]
    public void WebhookSignaturesAgreeWithTheFixedVectors()
    {
        var signatures = CASES["signatures"]!;
        var tolerance = signatures["toleranceSeconds"]!.GetValue<long>();
        Assert.Equal(Webhooks.ToleranceSeconds, tolerance);
        var secret = signatures["secret"]!.GetValue<string>();
        var body = signatures["body"]!.GetValue<string>();
        Assert.Equal(signatures["validSignature"]!.GetValue<string>(), Webhooks.Sign(secret, signatures["timestamp"]!.GetValue<long>(), body));
        var cases = signatures["cases"]!.AsArray();
        Assert.True(cases.Count > 8);
        foreach (var c in cases)
        {
            var verifies = Webhooks.VerifySignature(secret, body, c!["header"]?.GetValue<string>(), c["now"]!.GetValue<long>(), tolerance);
            Assert.True(c["verifies"]!.GetValue<bool>() == verifies, c["name"]!.GetValue<string>());
        }
    }

    [Fact]
    public void TheGateAgreesOnWhatCountsAsPermission()
    {
        foreach (var c in CASES["gate"]!["allowed"]!.AsArray())
        {
            var status = c!["status"]!.GetValue<string>();
            var allowed = c["allowed"]!.GetValue<bool>();
            var gate = GateData.From(new JsonObject { ["id"] = "gat_1", ["status"] = status, ["allowed"] = allowed });
            Assert.True(allowed == gate.Allowed, $"{status}: {c["why"]}");
            Assert.Equal(status == GateStatus.Pending, gate.IsPending);
            Assert.Equal(status == GateStatus.Denied, gate.IsDenied);
            // The flattened answer must agree with the data, or GateAsync and
            // Gates.CreateAsync disagree about the same decision.
            Assert.Equal(allowed, gate.ToDecision().Allowed);
            Assert.Equal(status, gate.ToDecision().Status);
        }
    }

    [Fact]
    public async Task TheGateRequiresTheCallersIdAndSendsItAsTheIdempotencyKey()
    {
        var externalId = CASES["gate"]!["externalId"]!;
        Assert.True(externalId["required"]!.GetValue<bool>());
        Assert.True(externalId["sentAsIdempotencyKey"]!.GetValue<bool>());

        var handler = new Scripted((201, new JsonObject { ["id"] = "gat_1", ["status"] = "allowed", ["allowed"] = true }, null));
        var deliverd = FakeDeliverd.Client(handler);

        var refused = await Assert.ThrowsAsync<DeliverdException>(() =>
            deliverd.Gates.CreateAsync(new GateRequest { Action = "finance.refund", ExternalId = " " }));
        Assert.Equal("external_id_required", refused.Code);
        Assert.Empty(handler.Seen);

        await deliverd.Gates.CreateAsync(new GateRequest { Action = "finance.refund", ExternalId = "refund:1" });
        Assert.Equal("refund:1", handler.Seen[0].Header(CASES["idempotency"]!["header"]!.GetValue<string>()));
    }

    [Fact]
    public async Task TheGateReadsBackADecisionAlreadyMade()
    {
        var reuse = CASES["gate"]!["reuse"]!;
        var api = new FakeDeliverd();
        var deliverd = api.Client();
        var first = await deliverd.Gates.CreateAsync(new GateRequest { Action = "finance.refund", ExternalId = "refund:2" });
        Assert.False(first.Reused);
        var again = await deliverd.Gates.CreateAsync(new GateRequest { Action = "finance.refund", ExternalId = "refund:2" });
        Assert.Equal(first.Id, again.Id);
        Assert.True(reuse["reused"]!.GetValue<bool>() == again.Reused, reuse["why"]!.GetValue<string>());
    }
}
