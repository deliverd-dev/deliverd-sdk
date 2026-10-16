use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{DeliverdError, Result};

/// A length of time, as the API's conveniences take it: `"30m"`, `"4h"`,
/// `"2d"`, or a [`std::time::Duration`].
///
/// There is no bare number. The TypeScript SDK reads one as milliseconds and
/// the Python SDK as seconds, each because that is what its own timers take;
/// in Rust the timer takes a `Duration`, which says its unit, so a number would
/// only be a third guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurationArg {
    /// `"30m"`, `"4h"`, `"2d"`, `"1.5h"`: read when the call is made.
    Text(String),
    Exact(Duration),
}

impl DurationArg {
    pub fn resolve(&self) -> Result<Duration> {
        match self {
            DurationArg::Text(text) => parse_duration(text),
            DurationArg::Exact(duration) => Ok(*duration),
        }
    }
}

impl From<&str> for DurationArg {
    fn from(value: &str) -> Self {
        DurationArg::Text(value.to_owned())
    }
}

impl From<String> for DurationArg {
    fn from(value: String) -> Self {
        DurationArg::Text(value)
    }
}

impl From<Duration> for DurationArg {
    fn from(value: Duration) -> Self {
        DurationArg::Exact(value)
    }
}

/// Read `"30m"`, `"4h"`, `"2d"` or `"1.5h"`: a number, then one of `s`, `m`,
/// `h` or `d`, with nothing between them. Surrounding space is forgiven; any
/// other shape is refused rather than guessed at.
pub fn parse_duration(value: &str) -> Result<Duration> {
    let refuse = || {
        DeliverdError::new(
            0,
            "invalid_duration",
            format!(
                "Could not read \"{value}\" as a duration. Use a string like \"30m\", \"4h\" or \"2d\", or a std::time::Duration."
            ),
        )
    };
    let text = value.trim();
    let unit = text.chars().last().ok_or_else(refuse)?;
    let seconds_per_unit = match unit {
        's' => 1.0,
        'm' => 60.0,
        'h' => 3_600.0,
        'd' => 86_400.0,
        _ => return Err(refuse()),
    };
    let number = &text[..text.len() - 1];
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (number, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
        return Err(refuse());
    }
    let amount: f64 = number.parse().map_err(|_| refuse())?;
    Ok(Duration::from_secs_f64(amount * seconds_per_unit))
}

/// An ISO 8601 timestamp in UTC, `2026-10-16T21:28:13.000Z`, as the API takes
/// `expiresAt`. Written out here rather than pulled in from a date library for
/// the sake of one format.
pub(crate) fn iso_utc(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let millis = since.subsec_millis();
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (hour, minute, second) = (rest / 3_600, (rest % 3_600) / 60, rest % 60);

    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_utc_timestamps() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(UNIX_EPOCH + Duration::from_millis(1_750_000_000_123)), "2025-06-15T15:06:40.123Z");
        // A leap day, which is where a hand-written calendar usually breaks.
        assert_eq!(iso_utc(UNIX_EPOCH + Duration::from_secs(1_709_208_000)), "2024-02-29T12:00:00.000Z");
    }
}
