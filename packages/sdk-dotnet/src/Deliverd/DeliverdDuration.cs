using System;
using System.Globalization;

namespace Deliverd;

/// <summary>
/// The lengths of time the API's conveniences take: <c>"30m"</c>, <c>"4h"</c>,
/// <c>"2d"</c>, <c>"1.5h"</c>.
/// </summary>
/// <remarks>
/// There is no bare number. The TypeScript SDK reads one as milliseconds and the
/// Python SDK as seconds, each because that is what its own timers take; in .NET
/// the timer takes a <see cref="TimeSpan"/>, which says its own unit, so a number
/// would only be a third guess. Everywhere a duration is taken, a
/// <see cref="TimeSpan"/> is taken too.
/// </remarks>
public static class DeliverdDuration
{
    /// <summary>
    /// Reads a number, then one of <c>s</c>, <c>m</c>, <c>h</c> or <c>d</c>, with
    /// nothing between them. Surrounding space is forgiven; any other shape is
    /// refused rather than guessed at.
    /// </summary>
    /// <exception cref="DeliverdException">With code <c>invalid_duration</c>.</exception>
    public static TimeSpan Parse(string value)
    {
        DeliverdException Refuse() => new(
            0,
            "invalid_duration",
            $"Could not read \"{value}\" as a duration. Use a string like \"30m\", \"4h\" or \"2d\", or a TimeSpan.");

        var text = (value ?? string.Empty).Trim();
        if (text.Length < 2) throw Refuse();
        double secondsPerUnit = text[text.Length - 1] switch
        {
            's' => 1,
            'm' => 60,
            'h' => 3_600,
            'd' => 86_400,
            _ => throw Refuse(),
        };
        var number = text.Substring(0, text.Length - 1);
        var dot = number.IndexOf('.');
        var whole = dot < 0 ? number : number.Substring(0, dot);
        var fraction = dot < 0 ? null : number.Substring(dot + 1);
        if (!Digits(whole) || (fraction is not null && !Digits(fraction))) throw Refuse();
        var amount = double.Parse(number, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
        return TimeSpan.FromSeconds(amount * secondsPerUnit);
    }

    private static bool Digits(string part)
    {
        if (part.Length == 0) return false;
        foreach (var c in part)
        {
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    /// <summary>An ISO 8601 timestamp in UTC, as the API takes <c>expiresAt</c>.</summary>
    internal static string Iso(DateTimeOffset at) =>
        at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
