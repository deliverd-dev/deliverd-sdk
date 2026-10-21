//! # deliverd-screen
//!
//! **A pre-send check for every prompt.** Find and redact personal data,
//! secrets and your own confidential terms before text goes to an AI model.
//!
//! ```
//! let checked = deliverd_screen::screen("Reply to mary@example.ie about the renewal");
//! assert_eq!(checked.text.as_deref(), Some("Reply to [EMAIL_1] about the renewal"));
//!
//! // Send `checked.text` to the model, then put the values back in its answer.
//! let answer = "Sent to [EMAIL_1].";
//! assert_eq!(checked.restore(answer), "Sent to mary@example.ie.");
//! ```
//!
//! Everything runs here. Nothing is sent anywhere: there is no account, no key
//! and no network call. The detectors are the ones Deliverd's servers and SDKs
//! run, held to the same shared test cases as the TypeScript and Python
//! packages.
//!
//! Patterns find structured identifiers well (email addresses, phone numbers,
//! IBANs, card numbers, national ids, IP addresses, dates of birth, keys and
//! tokens) and people's names hardly at all. Plug in a model for names with
//! [`Screen::detector`]; [`adapters`] turns a token classifier's or a Presidio
//! analyzer's output into spans.
//!
//! **A net, not a certificate.** Never tell anyone a text is clean because
//! this allowed it, and remember that pseudonymised text is still personal
//! data in law.
//!
//! When a person has to decide (the [`Verdict::Ask`] verdict), this cannot ask
//! one: there is nobody here to ask. Deliverd's Data Gate can: the same check,
//! with the policy taken from your organisation's AI register, the question
//! routed to the right person, and a record of what was decided.

pub mod adapters;
mod data_screen;

use std::collections::BTreeMap;

pub use data_screen::{
    assess_counts, describe_counts, redact, redact_for, restore, screen_text, summarise, term_classification_of,
    Action, Assessment, Category, Classification, Counts, DataKind, DetectedSpan, Detector, Escalation, Finding,
    Policy, Redaction, Target, Term, Verdict, MAX_TERMS,
};

/// This crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const ASK_REASON: &str = "A person has to decide whether this may be sent, and nobody can be asked from here. Deliverd's Data Gate routes the question to one: https://deliverd.dev/docs/developers/screen";

/// What may be sent, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Screened {
    pub verdict: Verdict,
    /// Whether to send [`text`](Self::text). False for a deny, and for an ask:
    /// nobody here can say yes.
    pub allowed: bool,
    /// What may be sent: the original, the redacted text, or `None` when
    /// nothing may be.
    pub text: Option<String>,
    /// The redacted text, also for an ask, to show whoever decides. `None` for
    /// a deny.
    pub redacted: Option<String>,
    /// Where each finding is. Byte offsets into the original text; the values
    /// are not copied.
    pub findings: Vec<Finding>,
    /// How many of each kind, which is all Deliverd's Data Gate is ever sent.
    pub counts: Counts,
    /// One sentence each: why. Empty for a plain allow.
    pub reasons: Vec<String>,
    /// Placeholder to original value, for a redact. Yours alone: never sent
    /// anywhere.
    pub replacements: BTreeMap<String, String>,
}

impl Screened {
    /// Put the original values back into text a model wrote using the
    /// placeholders.
    pub fn restore(&self, answer: &str) -> String {
        restore(answer, &self.replacements)
    }
}

/// The check, set up once and run on every prompt.
///
/// ```
/// use deliverd_screen::{Classification, Screen, Term, Verdict};
///
/// let screen = Screen::new()
///     .model("the summariser")
///     .allow(Classification::Confidential, false)
///     .term(Term::new("Project Kestrel").labelled("Code name"));
///
/// let checked = screen.check("Kestrel? No: Project Kestrel ships Friday.");
/// assert_eq!(checked.verdict, Verdict::Allow); // confidential is allowed here
/// ```
pub struct Screen<'a> {
    model: String,
    classification: Classification,
    personal_data: bool,
    policy: Policy,
    terms: Vec<Term>,
    detectors: Vec<Box<dyn Detector + 'a>>,
}

impl Default for Screen<'_> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> Screen<'a> {
    /// By default the model may receive internal data and no personal data;
    /// secrets are denied, the rest redacted, and what redaction cannot fix
    /// goes to a person.
    pub fn new() -> Self {
        Self {
            model: "the model".to_string(),
            classification: Classification::Internal,
            personal_data: false,
            policy: Policy::default(),
            terms: vec![],
            detectors: vec![],
        }
    }

    /// The model's name, for the reasons.
    pub fn model(mut self, name: impl Into<String>) -> Self {
        self.model = name.into();
        self
    }

    /// What that model may receive: the highest classification, and whether
    /// personal data.
    pub fn allow(mut self, classification: Classification, personal_data: bool) -> Self {
        self.classification = classification;
        self.personal_data = personal_data;
        self
    }

    /// What to do with what it may not receive.
    pub fn policy(mut self, policy: Policy) -> Self {
        self.policy = policy;
        self
    }

    /// A word your organisation does not want sent: a client, a code name, a
    /// deal.
    pub fn term(mut self, term: impl Into<Term>) -> Self {
        self.terms.push(term.into());
        self
    }

    pub fn terms<T: Into<Term>>(mut self, terms: impl IntoIterator<Item = T>) -> Self {
        self.terms.extend(terms.into_iter().map(Into::into));
        self
    }

    /// A detector to run beside the patterns, such as a model for names. Any
    /// `Fn(&str) -> Vec<DetectedSpan>` is one.
    pub fn detector(mut self, detector: impl Detector + 'a) -> Self {
        self.detectors.push(Box::new(detector));
        self
    }

    /// Find what is in a text, whatever it is going to: the findings and their
    /// counts, no verdict. `spans` are what another detector already found.
    pub fn detect(&self, text: &str, spans: &[DetectedSpan]) -> (Vec<Finding>, Counts) {
        let mut all = spans.to_vec();
        for d in &self.detectors {
            all.extend(d.detect(text));
        }
        let findings = screen_text(text, &self.terms, &all);
        let counts = summarise(&findings);
        (findings, counts)
    }

    /// Check text before it goes to the model, and decide what may be sent.
    pub fn check(&self, text: &str) -> Screened {
        self.check_with_spans(text, &[])
    }

    /// [`check`](Self::check), with spans another detector already found:
    /// one you ran asynchronously, say.
    pub fn check_with_spans(&self, text: &str, spans: &[DetectedSpan]) -> Screened {
        let (findings, counts) = self.detect(text, spans);
        let target = Target {
            name: self.model.clone(),
            approved_classification: Some(self.classification),
            personal_data: self.personal_data,
            active: true,
        };
        let mut a = assess_counts(&counts, Some(&target), &self.policy, term_classification_of(&findings));
        let redaction = redact_for(text, &findings, &a);
        let (sent, replacements) = match (a.verdict, &redaction) {
            (Verdict::Allow, _) => (Some(text.to_string()), BTreeMap::new()),
            (Verdict::Redact, Some(r)) => (Some(r.text.clone()), r.replacements.clone()),
            _ => (None, BTreeMap::new()),
        };
        if a.verdict == Verdict::Ask {
            a.reasons.push(ASK_REASON.to_string());
        }
        Screened {
            verdict: a.verdict,
            allowed: sent.is_some(),
            redacted: if a.verdict == Verdict::Allow { Some(text.to_string()) } else { redaction.map(|r| r.text) },
            text: sent,
            findings,
            counts,
            reasons: a.reasons,
            replacements,
        }
    }
}

/// Check text with the defaults: the model may receive internal data and no
/// personal data.
///
/// - [`Verdict::Allow`]: send `text` as it is.
/// - [`Verdict::Redact`]: `text` has what the model may not receive replaced
///   by placeholders such as `[EMAIL_1]`. Send that; [`Screened::restore`] puts
///   the values back in the answer.
/// - [`Verdict::Ask`]: a person has to decide. `allowed` is false; `redacted`
///   is what to show them.
/// - [`Verdict::Deny`]: nothing may be sent.
pub fn screen(text: &str) -> Screened {
    Screen::new().check(text)
}
