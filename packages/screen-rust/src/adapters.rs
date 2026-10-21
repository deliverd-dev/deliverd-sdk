//! Turn a model's answer into spans, for what patterns cannot find: people's
//! names above all.
//!
//! This crate runs no model and depends on none. You run one (a token
//! classifier through `candle` or `ort`, a GLiNER server, Presidio) and hand
//! its output to these, then the spans to [`Screen::check_with_spans`], or
//! wrap the whole thing in a closure for [`Screen::detector`].
//!
//! Whatever runs the model should run where the text already is. A detector
//! that sends the text to a hosted service has sent it somewhere, which is the
//! thing this check exists to prevent.
//!
//! [`Screen::check_with_spans`]: crate::Screen::check_with_spans
//! [`Screen::detector`]: crate::Screen::detector

use crate::{DataKind, DetectedSpan};

/// One entity, as a token classifier returns it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClassifiedToken {
    /// The model's label: `B-PER`, `PERSON`, `private_person`.
    pub label: String,
    /// Default 1 when the model gives none.
    pub score: Option<f32>,
    /// Byte offsets, when the model gives them.
    pub start: Option<usize>,
    pub end: Option<usize>,
    /// The token's text, found in the text when there are no offsets.
    pub word: Option<String>,
}

/// What the common label sets mean. Person labels (`PER`, `PERSON`,
/// `private_person`, `NAME`, `GIVENNAME`, `SURNAME`) become names; email and
/// phone labels map to those kinds, which the patterns find too and the
/// overlap rules keep once. Anything else is ignored. A position prefix
/// (`B-`, `I-`, `E-`, `S-`, `L-`) is removed first.
pub fn default_labels(label: &str) -> Option<DataKind> {
    let l = label.to_ascii_lowercase();
    const PERSON: [&str; 14] = [
        "per",
        "person",
        "private_person",
        "name",
        "fullname",
        "full_name",
        "firstname",
        "first_name",
        "lastname",
        "last_name",
        "givenname",
        "given_name",
        "surname",
        "username",
    ];
    if PERSON.contains(&l.as_str()) {
        return Some(DataKind::PersonName);
    }
    if l.contains("email") {
        return Some(DataKind::Email);
    }
    if l.contains("phone") || l.contains("telephone") {
        return Some(DataKind::Phone);
    }
    if l.contains("iban") {
        return Some(DataKind::Iban);
    }
    if ["creditcard", "credit_card", "cardnumber", "card_number"].iter().any(|w| l.contains(w)) {
        return Some(DataKind::PaymentCard);
    }
    if ["ip", "ipaddress", "ip_address"].contains(&l.as_str()) {
        return Some(DataKind::IpAddress);
    }
    None
}

fn strip_position(label: &str) -> &str {
    match label.as_bytes() {
        [b'B' | b'I' | b'E' | b'S' | b'L', b'-', ..] => &label[2..],
        _ => label,
    }
}

/// A token classifier's entities as spans. Entities scored below `min_score`
/// (0.5 is a good start) are ignored, and `labels` maps a label to a kind
/// ([`default_labels`] unless you know better).
///
/// Offsets are used when the model gives them. When it gives only words, each
/// word is found in the text from where the last one ended. Adjacent tokens of
/// one kind become one span, so "Mary" and "Byrne" are one name.
pub fn token_spans(
    text: &str,
    tokens: &[ClassifiedToken],
    min_score: f32,
    labels: impl Fn(&str) -> Option<DataKind>,
) -> Vec<DetectedSpan> {
    let mut spans: Vec<DetectedSpan> = Vec::new();
    let mut cursor = 0;
    for t in tokens {
        if t.label.is_empty() || t.score.unwrap_or(1.0) < min_score {
            continue;
        }
        let kind = labels(strip_position(&t.label));
        let (start, end) = match (t.start, t.end) {
            (Some(s), Some(e)) if e > s && e <= text.len() && text.is_char_boundary(s) && text.is_char_boundary(e) => {
                (s, e)
            }
            _ => {
                let raw = t.word.as_deref().unwrap_or("");
                let word = ["##", "▁", "Ġ"].iter().find_map(|p| raw.strip_prefix(p)).unwrap_or(raw).trim();
                if word.is_empty() || cursor > text.len() {
                    continue;
                }
                let Some(at) = text[cursor..].find(word) else { continue };
                (cursor + at, cursor + at + word.len())
            }
        };
        cursor = end;
        let Some(kind) = kind else { continue };
        match spans.last_mut() {
            // "Mary" "Byrne", or a word split into sub-word pieces: one span.
            Some(last) if last.kind == kind && start >= last.end && is_joiner(&text[last.end..start]) => last.end = end,
            _ => spans.push(DetectedSpan::new(kind, start, end)),
        }
    }
    spans
}

/// Nothing, or one space or hyphen.
fn is_joiner(between: &str) -> bool {
    let mut chars = between.chars();
    match (chars.next(), chars.next()) {
        (None, _) => true,
        (Some(c), None) => c.is_whitespace() || c == '-',
        _ => false,
    }
}

/// One result from a Presidio analyzer's `POST /analyze`.
#[derive(Clone, Debug, PartialEq)]
pub struct PresidioResult {
    pub entity_type: String,
    /// Presidio counts characters, not bytes: [`presidio_spans`] converts.
    pub start: usize,
    pub end: usize,
    pub score: f32,
}

/// Presidio's entity types to kinds.
pub fn presidio_kind(entity_type: &str) -> Option<DataKind> {
    Some(match entity_type {
        "PERSON" => DataKind::PersonName,
        "EMAIL_ADDRESS" => DataKind::Email,
        "PHONE_NUMBER" => DataKind::Phone,
        "IBAN_CODE" => DataKind::Iban,
        "CREDIT_CARD" => DataKind::PaymentCard,
        "IP_ADDRESS" => DataKind::IpAddress,
        "US_SSN" => DataKind::UsSsn,
        "UK_NINO" => DataKind::UkNationalInsurance,
        _ => return None,
    })
}

/// A Presidio analyzer's results as spans. Run the analyzer yourself, next to
/// the agent (`docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer`),
/// post `{"text": ..., "language": "en"}` to `/analyze` with the HTTP client
/// you already use, and pass what comes back.
pub fn presidio_spans(text: &str, results: &[PresidioResult], min_score: f32) -> Vec<DetectedSpan> {
    results
        .iter()
        .filter(|r| r.score >= min_score)
        .filter_map(|r| {
            let kind = presidio_kind(&r.entity_type)?;
            Some(DetectedSpan::new(kind, char_to_byte(text, r.start)?, char_to_byte(text, r.end)?))
        })
        .collect()
}

/// A character (code point) offset as a byte offset, for a model that counts
/// characters, as Python ones do. `None` past the end.
pub fn char_to_byte(text: &str, chars: usize) -> Option<usize> {
    text.char_indices().map(|(i, _)| i).chain(std::iter::once(text.len())).nth(chars)
}
