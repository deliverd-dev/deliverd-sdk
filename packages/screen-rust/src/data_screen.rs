//! The detectors, redaction and the decision: a port of
//! `packages/core/src/data-screen.ts`, the file the TypeScript and Python
//! packages copy byte for byte.
//!
//! A port cannot be a copy, so it is held to the same behaviour another way:
//! `packages/conformance/screening.json`, which the TypeScript and Python
//! suites read too, is read by `tests/conformance.rs`. A case added there
//! fails in whichever language does not reproduce it.
//!
//! Two things differ from the TypeScript, both on purpose:
//!
//! - **Offsets are byte offsets**, so `&text[f.start..f.end]` is the value, as
//!   everything else in Rust expects. TypeScript counts UTF-16 units and
//!   Python counts code points; for ASCII text all three agree.
//! - **No look-around.** The `regex` crate has none, and it is why matching is
//!   linear in the length of the text. The few patterns that used it in
//!   TypeScript check the same conditions in code around the match, so they
//!   find the same things.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::LazyLock;

use regex::bytes::{Regex as BytesRegex, RegexBuilder};
use regex::Regex;

// ── Kinds ─────────────────────────────────────────────────────────────────

/// How sensitive something is. Ordered: the stricter of two is the greater.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Classification {
    Public,
    Internal,
    Confidential,
    Restricted,
}

impl Classification {
    pub const ALL: [Classification; 4] = [Self::Public, Self::Internal, Self::Confidential, Self::Restricted];

    /// The word the other SDKs and Deliverd's API use: `confidential`.
    pub fn key(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
            Self::Confidential => "confidential",
            Self::Restricted => "restricted",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.key() == key)
    }
}

impl fmt::Display for Classification {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.key())
    }
}

/// What kind of concern a finding is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    Personal,
    Financial,
    Special,
    Secret,
    Confidential,
}

impl Category {
    pub const ALL: [Category; 5] = [Self::Personal, Self::Financial, Self::Special, Self::Secret, Self::Confidential];

    pub fn key(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Financial => "financial",
            Self::Special => "special",
            Self::Secret => "secret",
            Self::Confidential => "confidential",
        }
    }

    /// What a finding of this category is, absent anything more specific.
    pub fn classification(self) -> Classification {
        match self {
            Self::Personal | Self::Financial | Self::Confidential => Classification::Confidential,
            Self::Special | Self::Secret => Classification::Restricted,
        }
    }

    /// Whether it is personal data, for a model approved for none.
    pub fn is_personal(self) -> bool {
        matches!(self, Self::Personal | Self::Financial | Self::Special)
    }
}

/// What was found. Ordered as the other SDKs list them, which is the order
/// counts are described in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DataKind {
    Email,
    Phone,
    Iban,
    PaymentCard,
    UkNationalInsurance,
    IePps,
    UsSsn,
    IpAddress,
    DateOfBirth,
    /// Never found by a pattern here: only by a detector you plug in.
    PersonName,
    SpecialCategory,
    Secret,
    Term,
}

impl DataKind {
    pub const ALL: [DataKind; 13] = [
        Self::Email,
        Self::Phone,
        Self::Iban,
        Self::PaymentCard,
        Self::UkNationalInsurance,
        Self::IePps,
        Self::UsSsn,
        Self::IpAddress,
        Self::DateOfBirth,
        Self::PersonName,
        Self::SpecialCategory,
        Self::Secret,
        Self::Term,
    ];

    /// The key the other SDKs and Deliverd's API use: `payment_card`.
    pub fn key(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Phone => "phone",
            Self::Iban => "iban",
            Self::PaymentCard => "payment_card",
            Self::UkNationalInsurance => "uk_national_insurance",
            Self::IePps => "ie_pps",
            Self::UsSsn => "us_ssn",
            Self::IpAddress => "ip_address",
            Self::DateOfBirth => "date_of_birth",
            Self::PersonName => "person_name",
            Self::SpecialCategory => "special_category",
            Self::Secret => "secret",
            Self::Term => "term",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.key() == key)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Email => "Email address",
            Self::Phone => "Phone number",
            Self::Iban => "IBAN",
            Self::PaymentCard => "Payment card number",
            Self::UkNationalInsurance => "UK National Insurance number",
            Self::IePps => "Irish PPS number",
            Self::UsSsn => "US Social Security number",
            Self::IpAddress => "IP address",
            Self::DateOfBirth => "Date of birth",
            Self::PersonName => "Person's name",
            Self::SpecialCategory => "Special-category data",
            Self::Secret => "Secret or credential",
            Self::Term => "Confidential term",
        }
    }

    pub fn category(self) -> Category {
        match self {
            Self::Iban | Self::PaymentCard => Category::Financial,
            Self::SpecialCategory => Category::Special,
            Self::Secret => Category::Secret,
            Self::Term => Category::Confidential,
            _ => Category::Personal,
        }
    }

    /// The word in a placeholder: `[EMAIL_1]`.
    pub fn placeholder(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Phone => "PHONE",
            Self::Iban => "IBAN",
            Self::PaymentCard => "CARD",
            Self::UkNationalInsurance => "NINO",
            Self::IePps => "PPS",
            Self::UsSsn => "SSN",
            Self::IpAddress => "IP",
            Self::DateOfBirth => "DOB",
            Self::PersonName => "NAME",
            Self::SpecialCategory => "SPECIAL",
            Self::Secret => "SECRET",
            Self::Term => "TERM",
        }
    }

    /// Whether replacing the match removes the concern. An IBAN replaced by
    /// `[IBAN_1]` is gone; a sentence about someone's diagnosis is still about
    /// their diagnosis with the word "diagnosis" taken out.
    pub fn redactable(self) -> bool {
        self != Self::SpecialCategory
    }

    /// Earlier wins an overlap: a card number is not also a phone number.
    fn priority(self) -> u8 {
        match self {
            Self::Secret => 0,
            Self::Iban => 1,
            Self::PaymentCard => 2,
            Self::UsSsn => 3,
            Self::UkNationalInsurance => 4,
            Self::IePps => 5,
            Self::Email => 6,
            Self::DateOfBirth => 7,
            Self::Phone => 8,
            Self::IpAddress => 9,
            Self::Term => 10,
            Self::PersonName => 11,
            Self::SpecialCategory => 12,
        }
    }
}

impl fmt::Display for DataKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.key())
    }
}

/// A word or phrase your organisation does not want sent: a client's name, a
/// project's code name, a deal. Matched whole-word and case-insensitively.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Term {
    pub term: String,
    /// Shown to people and used in the placeholder: `[CLIENT_1]`.
    pub label: Option<String>,
    /// Confidential unless you say restricted.
    pub classification: Option<Classification>,
}

impl Term {
    pub fn new(term: impl Into<String>) -> Self {
        Self { term: term.into(), label: None, classification: None }
    }

    pub fn labelled(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn restricted(mut self) -> Self {
        self.classification = Some(Classification::Restricted);
        self
    }
}

impl<S: Into<String>> From<S> for Term {
    fn from(term: S) -> Self {
        Self::new(term)
    }
}

/// One thing found. Offsets into the screened text; the value is never copied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub kind: DataKind,
    pub category: Category,
    pub classification: Classification,
    /// Byte offsets: `&text[start..end]` is the value.
    pub start: usize,
    pub end: usize,
    /// For a term, its label; otherwise the kind's.
    pub label: String,
    pub redactable: bool,
}

/// How many of each kind: all that leaves your machine when Deliverd's Data
/// Gate decides.
pub type Counts = BTreeMap<DataKind, usize>;

/// What another detector found, such as a model for names, as byte offsets
/// into the same text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DetectedSpan {
    pub kind: DataKind,
    pub start: usize,
    pub end: usize,
}

impl DetectedSpan {
    pub fn new(kind: DataKind, start: usize, end: usize) -> Self {
        Self { kind, start, end }
    }
}

/// A detector to run beside the patterns: anything from the text to spans.
/// A closure is one.
pub trait Detector {
    fn detect(&self, text: &str) -> Vec<DetectedSpan>;
}

impl<F: Fn(&str) -> Vec<DetectedSpan>> Detector for F {
    fn detect(&self, text: &str) -> Vec<DetectedSpan> {
        self(text)
    }
}

// ── Detectors ─────────────────────────────────────────────────────────────

/// One pattern, and the checks around it that the TypeScript wrote as
/// look-around or as a second look at the match.
struct Pattern {
    kind: DataKind,
    re: BytesRegex,
    /// A second look a pattern alone cannot judge: a checksum, a digit count.
    /// A match that fails it is skipped whole.
    valid: Option<fn(&str) -> bool>,
    /// What TypeScript checked with look-around at the start of the match: the
    /// character before it, and the match itself. A match that fails is not a
    /// match at that position, so the search goes on from the next one.
    starts_ok: Option<fn(&[u8], usize) -> bool>,
}

/// The patterns run on bytes with Unicode off, which is what JavaScript does
/// without the `u` flag: `\b`, `\w` and `\d` are ASCII, and so is ignoring
/// case. `\s` is Unicode in JavaScript either way, so it is spelled out as
/// [`ws!`] rather than left to the flag.
fn bytes(pattern: &str, ignore_case: bool) -> BytesRegex {
    RegexBuilder::new(pattern).unicode(false).case_insensitive(ignore_case).build().expect("a valid pattern")
}

fn digits_of(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.bytes().rev().enumerate() {
        let mut d = u32::from(c - b'0');
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

fn iban_valid(raw: &str) -> bool {
    let iban: String = raw.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    if iban.len() < 15 || iban.len() > 34 {
        return false;
    }
    let moved = format!("{}{}", &iban[4..], &iban[..4]);
    let mut remainder: u32 = 0;
    for c in moved.bytes() {
        let value = if c.is_ascii_uppercase() { (c - 55).to_string() } else { (c as char).to_string() };
        for d in value.bytes() {
            remainder = (remainder * 10 + u32::from(d.wrapping_sub(b'0'))) % 97;
        }
    }
    remainder == 1
}

/// The PPS check character: weights 8 to 2 on the digits, 9 on a second
/// letter, mod 23, 0 is W.
fn pps_valid(raw: &str) -> bool {
    let s = raw.to_ascii_uppercase();
    let b = s.as_bytes();
    if !(8..=9).contains(&b.len()) || !b[..7].iter().all(u8::is_ascii_digit) || !(b'A'..=b'W').contains(&b[7]) {
        return false;
    }
    let mut sum: u32 = b[..7].iter().enumerate().map(|(i, d)| u32::from(d - b'0') * (8 - i as u32)).sum();
    if let Some(&second) = b.get(8) {
        if !(b'A'..=b'I').contains(&second) && second != b'W' {
            return false;
        }
        sum += if second == b'W' { 0 } else { u32::from(second - 64) } * 9;
    }
    let r = (sum % 23) as u8;
    b[7] == if r == 0 { b'W' } else { 64 + r }
}

fn ipv4_valid(raw: &str) -> bool {
    let parts: Vec<u32> = raw.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 4 || parts.iter().any(|&p| p > 255) {
        return false;
    }
    // Loopback and the unspecified address identify nobody.
    parts[0] != 127 && parts[0] != 0
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}`.
fn ssn_ok(text: &[u8], at: usize) -> bool {
    let s = &text[at..];
    s.len() >= 11 && &s[..3] != b"000" && &s[..3] != b"666" && s[0] != b'9' && &s[4..6] != b"00" && &s[7..11] != b"0000"
}

/// `(?!BG|GB|NK|KN|TN|NT|ZZ)`: prefixes never issued.
fn nino_ok(text: &[u8], at: usize) -> bool {
    let p = text.get(at..at + 2).map(|p| p.to_ascii_uppercase());
    !matches!(p.as_deref(), Some(b"BG" | b"GB" | b"NK" | b"KN" | b"TN" | b"NT" | b"ZZ"))
}

/// `(?<![\w+])`: not the middle of a word or of a longer number.
fn phone_ok(text: &[u8], at: usize) -> bool {
    at == 0 || !(is_word(text[at - 1]) || text[at - 1] == b'+')
}

/// JavaScript's `\s`: Unicode whitespace as ECMAScript defines it, which is
/// not quite Unicode's `White_Space` (no U+0085, and U+FEFF). A no-break space
/// between "born on" and the date counts.
macro_rules! ws {
    () => {
        r"(?u:[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}])"
    };
}

/// Credential patterns. The same set the publish scanner blocks a report for,
/// because a key that must not be published must not be sent to a model
/// either.
const SECRET_PATTERNS: [(&str, bool); 11] = [
    (r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", false),
    (r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----", false),
    (r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", false),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", false),
    (r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b", false),
    (r"\bsk-ant-[A-Za-z0-9_-]{24,}\b", false),
    (r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b", false),
    (r"\bAIza[0-9A-Za-z_-]{35}\b", false),
    (r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", false),
    (
        concat!(
            r"\b(?:password|passwd|secret_key|api_key|apikey|auth_token)",
            ws!(),
            "*[:=]",
            ws!(),
            r#"*["'][^"']{8,}["']"#
        ),
        true,
    ),
    (r"\b(?:dlv|dlvk)_[A-Za-z0-9]{24,}\b", false),
];

/// Words that say a passage is about special-category data (GDPR Article 9,
/// and criminal-offence data under Article 10). A keyword is a weak signal, so
/// it is never redacted away: it sends the passage to a person when the model
/// is not approved for restricted personal data.
const SPECIAL_PATTERN: &str = r"\b(?:diagnos(?:is|ed|es)|medical (?:record|history|condition)s?|mental health|prescri(?:bed|ption)s?|HIV|pregnan(?:t|cy)|disabilit(?:y|ies)|sexual orientation|religious belief|ethnic origin|racial origin|trade union member(?:ship)?|biometric|genetic data|criminal (?:record|conviction|offence)s?)\b";

static PATTERNS: LazyLock<Vec<Pattern>> = LazyLock::new(|| {
    let p = |kind, re: &str, ignore_case| Pattern { kind, re: bytes(re, ignore_case), valid: None, starts_ok: None };
    let mut all: Vec<Pattern> = SECRET_PATTERNS.iter().map(|&(re, i)| p(DataKind::Secret, re, i)).collect();
    all.extend([
        Pattern { valid: Some(iban_valid), ..p(DataKind::Iban, r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b", false) },
        Pattern {
            valid: Some(|m| {
                let d = digits_of(m);
                (13..=19).contains(&d.len()) && luhn(&d)
            }),
            ..p(DataKind::PaymentCard, r"\b[2-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b", false)
        },
        Pattern { starts_ok: Some(ssn_ok), ..p(DataKind::UsSsn, r"\b\d{3}-\d{2}-\d{4}\b", false) },
        Pattern {
            starts_ok: Some(nino_ok),
            ..p(DataKind::UkNationalInsurance, r"\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b", false)
        },
        Pattern { valid: Some(pps_valid), ..p(DataKind::IePps, r"\b\d{7}[A-W][A-IW]?\b", false) },
        p(DataKind::Email, r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b", false),
        // The value is group 1; the words before it are only context.
        p(
            DataKind::DateOfBirth,
            concat!(r"\b(?:date of birth|d\.?o\.?b\.?|born(?: on)?)", ws!(), r"*[:\-]?", ws!(), r"*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4})"),
            true,
        ),
        // An international number, or a national one starting with 0: a bare
        // run of digits is far more often an amount, an id or a date. The
        // number is group 1. What follows it stands in for `(?![\w])`: one
        // character that is not a word character, or the end, matched but not
        // part of the number, so the engine prefers the same shorter number
        // JavaScript backtracks to.
        Pattern {
            valid: Some(|m| (9..=15).contains(&digits_of(m).len())),
            starts_ok: Some(phone_ok),
            ..p(
                DataKind::Phone,
                r"((?:\+\d{1,3}[ .-]?(?:\(0\)[ .-]?)?|\(?0)\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4})(?:[^0-9A-Za-z_]|\z)",
                false,
            )
        },
        Pattern { valid: Some(ipv4_valid), ..p(DataKind::IpAddress, r"\b(?:\d{1,3}\.){3}\d{1,3}\b", false) },
        p(DataKind::SpecialCategory, SPECIAL_PATTERN, true),
    ]);
    all
});

/// Terms past this are ignored, so a pasted list cannot make every screen slow.
pub const MAX_TERMS: usize = 500;

static LETTER_OR_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}]").expect("a valid pattern"));

fn is_letter_or_number(c: Option<char>) -> bool {
    c.is_some_and(|c| LETTER_OR_NUMBER.is_match(c.encode_utf8(&mut [0; 4])))
}

/// Lengths compare in UTF-16 units, as TypeScript's do, so an overlap is
/// settled the same way in every language.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Find what is in a text. Overlapping matches keep the stronger kind, so each
/// character belongs to at most one finding. `spans` are another detector's
/// findings, held to the same rules; one outside the text, not on a character
/// boundary, or of kind `Term` is dropped.
pub fn screen_text(text: &str, terms: &[Term], spans: &[DetectedSpan]) -> Vec<Finding> {
    let mut raw: Vec<Finding> = Vec::new();
    let mut add =
        |kind: DataKind, start: usize, end: usize, label: Option<&str>, classification: Option<Classification>| {
            raw.push(Finding {
                kind,
                category: kind.category(),
                classification: classification.unwrap_or(kind.category().classification()),
                start,
                end,
                label: label.unwrap_or(kind.label()).to_string(),
                redactable: kind.redactable(),
            });
        };

    let b = text.as_bytes();
    for p in PATTERNS.iter() {
        let mut at = 0;
        while at <= b.len() {
            let Some(caps) = p.re.captures_at(b, at) else { break };
            let whole = caps.get(0).expect("group 0");
            if p.starts_ok.is_some_and(|ok| !ok(b, whole.start())) {
                at = whole.start() + 1;
                continue;
            }
            let value = caps.get(1).unwrap_or(whole);
            at = if p.kind == DataKind::Phone { value.end() } else { whole.end() }.max(whole.start() + 1);
            // Every pattern starts and ends on ASCII, so these are character boundaries.
            let found = &text[value.start()..value.end()];
            if found.is_empty() || p.valid.is_some_and(|valid| !valid(found)) {
                continue;
            }
            add(p.kind, value.start(), value.end(), None, None);
        }
    }

    for t in terms.iter().take(MAX_TERMS) {
        let term = t.term.trim();
        if utf16_len(term) < 2 {
            continue;
        }
        let Ok(re) = Regex::new(&format!("(?i){}", regex::escape(term))) else { continue };
        let label = t.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
        let mut at = 0;
        while let Some(m) = re.find_at(text, at) {
            // `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])`: whole words only.
            if is_letter_or_number(text[..m.start()].chars().next_back())
                || is_letter_or_number(text[m.end()..].chars().next())
            {
                at = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            add(
                DataKind::Term,
                m.start(),
                m.end(),
                Some(label.unwrap_or(DataKind::Term.label())),
                Some(t.classification.unwrap_or(Classification::Confidential)),
            );
            at = m.end().max(m.start() + 1);
            if at > text.len() {
                break;
            }
        }
    }

    for s in spans {
        if s.kind == DataKind::Term || s.end > text.len() || s.end <= s.start {
            continue;
        }
        if !text.is_char_boundary(s.start) || !text.is_char_boundary(s.end) {
            continue;
        }
        add(s.kind, s.start, s.end, None, None);
    }

    let len = |f: &Finding| utf16_len(&text[f.start..f.end]);
    raw.sort_by(|a, b| a.kind.priority().cmp(&b.kind.priority()).then(len(b).cmp(&len(a))).then(a.start.cmp(&b.start)));
    let mut kept: Vec<Finding> = Vec::new();
    for f in raw {
        if !kept.iter().any(|k| f.start < k.end && k.start < f.end) {
            kept.push(f);
        }
    }
    kept.sort_by_key(|f| f.start);
    kept
}

/// Counts only: what goes over the wire when the text stays where it is.
pub fn summarise(findings: &[Finding]) -> Counts {
    let mut counts = Counts::new();
    for f in findings {
        *counts.entry(f.kind).or_default() += 1;
    }
    counts
}

// ── Redaction ─────────────────────────────────────────────────────────────

/// Text with placeholders, and what each placeholder stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Redaction {
    pub text: String,
    /// Placeholder to original value. Stays with you; never sent anywhere.
    pub replacements: BTreeMap<String, String>,
}

fn placeholder_word(f: &Finding) -> String {
    if f.kind != DataKind::Term || f.label == DataKind::Term.label() {
        return f.kind.placeholder().to_string();
    }
    let mut word = String::new();
    for c in f.label.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            word.push(c);
        } else if !word.ends_with('_') {
            word.push('_');
        }
    }
    let word = word.strip_prefix('_').unwrap_or(&word);
    let word = word.strip_suffix('_').unwrap_or(word);
    let word: String = word.chars().take(24).collect();
    if word.is_empty() {
        "TERM".to_string()
    } else {
        word
    }
}

/// Replace each redactable finding with a placeholder. The same value gets the
/// same placeholder throughout, so a model can still tell that two mentions
/// are one person, and [`restore`] can put the values back in its answer.
pub fn redact(text: &str, findings: &[Finding]) -> Redaction {
    let mut replacements = BTreeMap::new();
    let mut by_value: HashMap<(DataKind, String), String> = HashMap::new();
    let mut counters: HashMap<String, usize> = HashMap::new();
    let mut sorted: Vec<&Finding> = findings.iter().collect();
    sorted.sort_by_key(|f| f.start);
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for f in sorted {
        if !f.redactable || f.start < at {
            continue;
        }
        let value = &text[f.start..f.end];
        let placeholder = by_value
            .entry((f.kind, value.to_lowercase()))
            .or_insert_with(|| {
                let word = placeholder_word(f);
                let n = counters.entry(word.clone()).or_default();
                *n += 1;
                let placeholder = format!("[{word}_{n}]");
                replacements.insert(placeholder.clone(), value.to_string());
                placeholder
            })
            .clone();
        out.push_str(&text[at..f.start]);
        out.push_str(&placeholder);
        at = f.end;
    }
    out.push_str(&text[at..]);
    Redaction { text: out, replacements }
}

/// Put the original values back into text a model wrote using the
/// placeholders.
pub fn restore(text: &str, replacements: &BTreeMap<String, String>) -> String {
    if replacements.is_empty() {
        return text.to_string();
    }
    let mut keys: Vec<&String> = replacements.keys().collect();
    keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
    let pattern = keys.iter().map(|k| regex::escape(k)).collect::<Vec<_>>().join("|");
    let re = Regex::new(&pattern).expect("escaped placeholders");
    re.replace_all(text, |c: &regex::Captures<'_>| replacements[&c[0]].clone()).into_owned()
}

// ── Deciding ──────────────────────────────────────────────────────────────

/// What may be sent, from the least to the most cautious.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Verdict {
    /// Send it as it is.
    Allow,
    /// Send it with placeholders in place of what the model may not receive.
    Redact,
    /// A person has to decide.
    Ask,
    /// Send nothing.
    Deny,
}

impl Verdict {
    pub fn key(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Redact => "redact",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        [Self::Allow, Self::Redact, Self::Ask, Self::Deny].into_iter().find(|v| v.key() == key)
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.key())
    }
}

/// What a policy may do with data the model is not approved for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Redact,
    Ask,
    Deny,
}

impl From<Action> for Verdict {
    fn from(a: Action) -> Self {
        match a {
            Action::Redact => Verdict::Redact,
            Action::Ask => Verdict::Ask,
            Action::Deny => Verdict::Deny,
        }
    }
}

/// What to do with data that redaction cannot fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Escalation {
    Ask,
    Deny,
}

impl From<Escalation> for Verdict {
    fn from(e: Escalation) -> Self {
        match e {
            Escalation::Ask => Verdict::Ask,
            Escalation::Deny => Verdict::Deny,
        }
    }
}

/// What the model the text goes to is approved to receive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub name: String,
    /// The highest classification approved; `None` when nobody said.
    pub approved_classification: Option<Classification>,
    pub personal_data: bool,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Secrets and credentials. Default deny: a key sent to a model is a key disclosed.
    pub secrets: Action,
    /// Redactable data the model is not approved for. Default redact.
    pub beyond_approval: Action,
    /// Data that redaction cannot fix (special category) the model is not approved for. Default ask.
    pub not_redactable: Escalation,
    /// What a model nobody described is taken to be approved for. Default
    /// internal, no personal data.
    pub unregistered_classification: Classification,
    pub unregistered_personal_data: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            secrets: Action::Deny,
            beyond_approval: Action::Redact,
            not_redactable: Escalation::Ask,
            unregistered_classification: Classification::Internal,
            unregistered_personal_data: false,
        }
    }
}

/// The decision, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assessment {
    pub verdict: Verdict,
    /// The classification of what was found; public when nothing was.
    pub classification: Classification,
    pub personal_data: bool,
    pub categories: Vec<Category>,
    /// The kinds behind the verdict: what redaction replaces, and what a
    /// person is asked about.
    pub offending: Vec<DataKind>,
    /// One sentence each.
    pub reasons: Vec<String>,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// "2 email addresses and 1 IBAN", for a reason or an approval's title.
pub fn describe_counts(counts: &Counts) -> String {
    let parts: Vec<String> = DataKind::ALL
        .into_iter()
        .filter_map(|k| counts.get(&k).copied().filter(|&n| n > 0).map(|n| (k, n)))
        .map(|(k, n)| match k {
            DataKind::Email => plural(n, "email address", "email addresses"),
            DataKind::Phone => plural(n, "phone number", "phone numbers"),
            DataKind::Iban => plural(n, "IBAN", "IBANs"),
            DataKind::PaymentCard => plural(n, "payment card number", "payment card numbers"),
            DataKind::UkNationalInsurance => plural(n, "UK National Insurance number", "UK National Insurance numbers"),
            DataKind::IePps => plural(n, "Irish PPS number", "Irish PPS numbers"),
            DataKind::UsSsn => plural(n, "US Social Security number", "US Social Security numbers"),
            DataKind::IpAddress => plural(n, "IP address", "IP addresses"),
            DataKind::DateOfBirth => plural(n, "date of birth", "dates of birth"),
            DataKind::PersonName => plural(n, "person's name", "people's names"),
            DataKind::SpecialCategory => {
                plural(n, "mention of special-category data", "mentions of special-category data")
            }
            DataKind::Secret => plural(n, "secret or credential", "secrets or credentials"),
            DataKind::Term => plural(n, "confidential term", "confidential terms"),
        })
        .collect();
    match parts.as_slice() {
        [] => "nothing".to_string(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Decide from counts alone, so the same answer comes back whether the text
/// was screened here or anywhere else.
///
/// `term_classification` is the strictest classification among the terms
/// found, which counts cannot carry: see [`term_classification_of`].
pub fn assess_counts(
    counts: &Counts,
    target: Option<&Target>,
    policy: &Policy,
    term_classification: Classification,
) -> Assessment {
    let present: Vec<DataKind> =
        DataKind::ALL.into_iter().filter(|k| counts.get(k).copied().unwrap_or(0) > 0).collect();
    let categories: Vec<Category> =
        Category::ALL.into_iter().filter(|c| present.iter().any(|k| k.category() == *c)).collect();
    let class_of = |k: DataKind| if k == DataKind::Term { term_classification } else { k.category().classification() };
    let classification =
        present.iter().map(|&k| class_of(k)).max().unwrap_or(Classification::Public).max(Classification::Public);
    let personal_data = categories.iter().any(|c| c.is_personal());

    if let Some(t) = target.filter(|t| !t.active) {
        return Assessment {
            verdict: Verdict::Deny,
            classification,
            personal_data,
            categories,
            offending: present,
            reasons: vec![format!(
                "{} is not an active system in the AI register, so nothing should be sent to it.",
                t.name
            )],
        };
    }
    let mut a = Assessment {
        verdict: Verdict::Allow,
        classification,
        personal_data,
        categories,
        offending: vec![],
        reasons: vec![],
    };
    if present.is_empty() {
        return a;
    }

    let name = target.map_or("an AI system that is not in the register", |t| t.name.as_str());
    let approved = target.and_then(|t| t.approved_classification).unwrap_or(policy.unregistered_classification);
    let personal_approved = target.map_or(policy.unregistered_personal_data, |t| t.personal_data);

    let secrets = counts.get(&DataKind::Secret).copied().unwrap_or(0);
    if secrets > 0 {
        a.verdict = a.verdict.max(policy.secrets.into());
        a.offending.push(DataKind::Secret);
        a.reasons.push(format!(
            "It contains {}, which should never be sent to a model.",
            describe_counts(&Counts::from([(DataKind::Secret, secrets)]))
        ));
    }

    for &k in &present {
        if k == DataKind::Secret {
            continue;
        }
        let too_sensitive = class_of(k) > approved;
        let personal_not_approved = k.category() != Category::Confidential && !personal_approved;
        if !too_sensitive && !personal_not_approved {
            continue;
        }
        let action: Verdict = if k.redactable() { policy.beyond_approval.into() } else { policy.not_redactable.into() };
        a.verdict = a.verdict.max(action);
        a.offending.push(k);
        let why = if personal_not_approved {
            "which is not approved to receive personal data".to_string()
        } else {
            format!("which is approved for {approved} data at most")
        };
        a.reasons.push(format!(
            "It contains {}, and goes to {name}, {why}.",
            describe_counts(&Counts::from([(k, counts[&k])]))
        ));
    }
    a
}

/// The text with the findings behind a verdict replaced: only those, so data
/// the model is approved for still reaches it. `None` for a deny, which sends
/// nothing.
pub fn redact_for(text: &str, findings: &[Finding], assessment: &Assessment) -> Option<Redaction> {
    if assessment.verdict == Verdict::Deny {
        return None;
    }
    let offending: Vec<Finding> = findings.iter().filter(|f| assessment.offending.contains(&f.kind)).cloned().collect();
    Some(redact(text, &offending))
}

/// The strictest classification among the terms found, for [`assess_counts`].
pub fn term_classification_of(findings: &[Finding]) -> Classification {
    if findings.iter().any(|f| f.kind == DataKind::Term && f.classification == Classification::Restricted) {
        Classification::Restricted
    } else {
        Classification::Confidential
    }
}
