using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Deliverd;

/// <summary>
/// Verifying what Deliverd sends you.
/// </summary>
/// <remarks>
/// The scheme is Stripe's: a timestamp and a signature in one header, the
/// timestamp inside the signed material. Pass the request body exactly as it
/// arrived; a re-encoded object is a different string and never verifies.
/// </remarks>
public static class Webhooks
{
    /// <summary>The header the signature arrives in.</summary>
    public const string SignatureHeader = "deliverd-signature";

    /// <summary>The header naming the event.</summary>
    public const string EventHeader = "deliverd-event";

    /// <summary>The header carrying the delivery's id.</summary>
    public const string DeliveryHeader = "deliverd-delivery";

    /// <summary>How old a signature may be, in seconds. Five minutes, as the server sends.</summary>
    public const long ToleranceSeconds = 300;

    /// <summary>
    /// Whether <paramref name="header"/> is this secret's signature over this
    /// body, signed within the last five minutes.
    /// </summary>
    public static bool VerifySignature(string secret, string body, string? header) =>
        VerifySignature(secret, body, header, DateTimeOffset.UtcNow.ToUnixTimeSeconds(), ToleranceSeconds);

    /// <summary>
    /// <see cref="VerifySignature(string, string, string?)"/> with the clock and
    /// the window given: for tests, and for replaying a delivery you stored.
    /// </summary>
    public static bool VerifySignature(string secret, string body, string? header, long now, long toleranceSeconds)
    {
        if (string.IsNullOrEmpty(header)) return false;
        var parts = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in header!.Split(','))
        {
            var eq = part.IndexOf('=');
            var key = (eq < 0 ? part : part.Substring(0, eq)).Trim();
            var value = eq < 0 ? string.Empty : part.Substring(eq + 1).Trim();
            parts[key] = value;
        }
        if (!parts.TryGetValue("t", out var t)
            || !long.TryParse(t, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var timestamp))
        {
            return false;
        }
        if (!parts.TryGetValue("v1", out var v1) || v1.Length == 0) return false;
        if (Math.Abs(now - timestamp) > toleranceSeconds) return false;

        var expected = Encoding.ASCII.GetBytes(Sign(secret, timestamp, body));
        var given = Encoding.ASCII.GetBytes(v1);
        // Every byte compared whatever the first mismatch, so the time taken
        // says nothing about how close a guess was.
        return CryptographicOperations.FixedTimeEquals(expected, given);
    }

    /// <summary>The hex HMAC-SHA256 of <c>"{timestamp}.{body}"</c>: what the <c>v1</c> part carries.</summary>
    public static string Sign(string secret, long timestamp, string body)
    {
        using var mac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var hash = mac.ComputeHash(Encoding.UTF8.GetBytes(timestamp.ToString(CultureInfo.InvariantCulture) + "." + body));
        var hex = new StringBuilder(hash.Length * 2);
        foreach (var b in hash) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        return hex.ToString();
    }
}
