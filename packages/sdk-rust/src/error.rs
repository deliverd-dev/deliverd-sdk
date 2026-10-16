use std::fmt;
use std::time::Duration;

use serde_json::Value;

/// Where somebody without an account makes one, counted against this crate.
pub(crate) const SIGN_UP_URL: &str =
    "https://deliverd.dev/sign-up?utm_source=crates&utm_medium=package&utm_campaign=rust-sdk&utm_content=no-api-key";

/// Every failure the SDK returns, with the API's own code on it.
///
/// One type rather than an enum of kinds: callers branch on [`code`](Self::code),
/// which is the string the API documents, and the helpers below name the
/// handful of cases worth branching on so nobody has to memorise the codes.
#[derive(Clone)]
pub struct DeliverdError {
    // Boxed so a `Result` stays one pointer wide on the happy path.
    inner: Box<Inner>,
}

#[derive(Debug, Clone)]
struct Inner {
    status: u16,
    code: String,
    message: String,
    hint: Option<String>,
    details: Option<Value>,
    retry_after: Option<Duration>,
}

impl DeliverdError {
    pub(crate) fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        let (message, hint) = explain(&code, message.into());
        Self { inner: Box::new(Inner { status, code, message, hint, details: None, retry_after: None }) }
    }

    pub(crate) fn with_details(mut self, details: Option<Value>) -> Self {
        self.inner.details = details;
        self
    }

    pub(crate) fn with_retry_after(mut self, retry_after: Option<Duration>) -> Self {
        self.inner.retry_after = retry_after;
        self
    }

    pub(crate) fn timeout(message: impl Into<String>) -> Self {
        Self::new(0, "timeout", message)
    }

    /// HTTP status, or 0 when the request never got a response.
    pub fn status(&self) -> u16 {
        self.inner.status
    }

    /// The API's error code: `not_found`, `rate_limited`, `self_approval`…
    pub fn code(&self) -> &str {
        &self.inner.code
    }

    /// What happened, in a sentence written for a person.
    pub fn message(&self) -> &str {
        &self.inner.message
    }

    /// The one thing to do next, when we know it.
    pub fn hint(&self) -> Option<&str> {
        self.inner.hint.as_deref()
    }

    /// Whatever the API attached: validation issues, the unknown approvers.
    pub fn details(&self) -> Option<&Value> {
        self.inner.details.as_ref()
    }

    /// What the server's `Retry-After` asked for, when it sent one.
    pub fn retry_after(&self) -> Option<Duration> {
        self.inner.retry_after
    }

    /// The key is missing, wrong, or lacks the scope the call needs.
    pub fn is_auth(&self) -> bool {
        self.inner.status == 401 || self.inner.status == 403
    }

    /// Slow down; the client already retried and gave up.
    pub fn is_rate_limit(&self) -> bool {
        self.inner.status == 429
    }

    /// Nothing there, or nothing this key may see.
    pub fn is_not_found(&self) -> bool {
        self.inner.status == 404
    }

    /// The request was fine and the state was not: re-read and try again.
    pub fn is_conflict(&self) -> bool {
        self.inner.status == 409
    }

    /// A wait was abandoned rather than answered. The request is still open.
    pub fn is_timeout(&self) -> bool {
        self.inner.code == "timeout"
    }
}

impl fmt::Debug for DeliverdError {
    // Flat, because `fn main() -> deliverd::Result<()>` prints this one.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let inner = &self.inner;
        let mut out = f.debug_struct("DeliverdError");
        out.field("status", &inner.status).field("code", &inner.code).field("message", &inner.message);
        if let Some(hint) = &inner.hint {
            out.field("hint", hint);
        }
        if let Some(details) = &inner.details {
            out.field("details", details);
        }
        out.finish()
    }
}

impl fmt::Display for DeliverdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.inner.message)?;
        if let Some(hint) = &self.inner.hint {
            write!(f, " {hint}")?;
        }
        Ok(())
    }
}

impl std::error::Error for DeliverdError {}

/// A shorthand for the SDK's results.
pub type Result<T, E = DeliverdError> = std::result::Result<T, E>;

/// What a failure says, for the codes where we can say it better than the
/// code. Anything unlisted keeps the API's own message, which is written for a
/// person too.
fn explain(code: &str, message: String) -> (String, Option<String>) {
    let (replacement, hint): (Option<&str>, Option<String>) = match code {
        "no_api_key" => (
            Some("No API key."),
            Some(format!(
                "Set DELIVERD_API_KEY in your environment, or pass one to Deliverd::builder().api_key(…) — or use Deliverd::development() to run without one. No account yet? Setting up a free one hands you a key: {SIGN_UP_URL}"
            )),
        ),
        "auth_error" => (
            Some("That credential was not accepted."),
            Some("Check DELIVERD_API_KEY. An API key starts with dlv_ and is created in Settings → API tokens; an OAuth access token starts with dlvo_ and needs no setup.".into()),
        ),
        "insufficient_scope" => (
            Some("That credential is valid and does not carry the scope this call needs."),
            Some("Reissue the key with the scope named above, or re-consent the connector for it.".into()),
        ),
        "unknown_approver" => (
            Some("No approver could be found for this request."),
            Some("Everyone in `approvers` must be an active member of your organisation, named by email or user id. Invite them first, or leave `approvers` out and your owners and admins decide.".into()),
        ),
        "self_approval" => (
            Some("You cannot approve your own request."),
            Some("Name somebody else in `approvers`, or leave it out so your organisation's owners and admins decide.".into()),
        ),
        _ => (None, None),
    };
    (replacement.map(str::to_owned).unwrap_or(message), hint)
}
