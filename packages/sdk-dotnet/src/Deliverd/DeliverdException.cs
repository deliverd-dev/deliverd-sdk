using System;
using System.Text.Json.Nodes;

namespace Deliverd;

/// <summary>
/// Every failure the client raises, with the API's own code on it.
/// </summary>
/// <remarks>
/// One type rather than one per kind: callers branch on <see cref="Code"/>,
/// which is the string the API documents. A refusal by a person is not an
/// exception; it is an answer, and comes back as a <see cref="Decision"/>.
/// </remarks>
public class DeliverdException : Exception
{
    internal const string SignUpUrl =
        "https://deliverd.dev/sign-up?utm_source=nuget&utm_medium=package&utm_campaign=dotnet-sdk&utm_content=no-api-key";

    /// <summary>Creates an exception with the API's status, code and message.</summary>
    public DeliverdException(int status, string code, string message, JsonNode? details = null, TimeSpan? retryAfter = null)
        : base(message)
    {
        Status = status;
        Code = code;
        Details = details;
        RetryAfter = retryAfter;
    }

    /// <summary>HTTP status, or 0 when the request never got a response.</summary>
    public int Status { get; }

    /// <summary>The API's error code: <c>not_found</c>, <c>rate_limited</c>, <c>self_approval</c>…</summary>
    public string Code { get; }

    /// <summary>What the API added about the failure, as it sent it.</summary>
    public JsonNode? Details { get; }

    /// <summary>How long the server asked to be left alone, from <c>Retry-After</c>.</summary>
    public TimeSpan? RetryAfter { get; }
}

/// <summary>
/// The wait ran out before anybody decided. The request is still open: ask
/// again with the same external id later and the same request is found.
/// </summary>
public sealed class DeliverdTimeoutException : DeliverdException
{
    /// <summary>Creates a timeout with a message saying where the request is still open.</summary>
    public DeliverdTimeoutException(string message) : base(0, "timeout", message) { }
}
