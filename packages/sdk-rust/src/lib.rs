//! # deliverd
//!
//! **You build the action. Deliverd handles the human.** Ask a person, wait for
//! the answer, act on it.
//!
//! ```no_run
//! use deliverd::{ApprovalRequest, Deliverd};
//!
//! # async fn deploy() {}
//! # #[tokio::main] async fn main() -> deliverd::Result<()> {
//! let deliverd = Deliverd::from_env()?;
//! let decision = deliverd.approve(ApprovalRequest::new("Deploy to production")).await?;
//! if decision.approved {
//!     deploy().await;
//! }
//! # Ok(()) }
//! ```
//!
//! That is the whole integration. What it stands in for: an approval page, the
//! emails and the reminders, identity and single sign-on, who is allowed to
//! decide, a table to keep it in, an audit trail, and the dashboard somebody
//! uses to do it.
//!
//! Six primitives, the same as the TypeScript and Python SDKs, held to them by
//! a shared conformance table:
//!
//! | | |
//! |---|---|
//! | [`gate`](Deliverd::gate) | may I? — your organisation's policy answers |
//! | [`approve`](Deliverd::approve) | ask permission, and wait for the answer |
//! | [`confirm`](Deliverd::confirm) | a yes or no on something small |
//! | [`review`](Deliverd::review) | ask whether what you made is right |
//! | [`collect`](Deliverd::collect) | ask for what you do not have |
//! | [`publish`](Deliverd::publish) | get the work to the people who need it |
//!
//! Before you have an account, [`Deliverd::development`] runs the same code
//! with an imaginary approver: no key, no network.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

mod approvals;
mod collections;
pub mod dev;
mod duration;
mod error;
mod gates;
pub mod http;
mod reports;
mod reviews;
mod types;
mod wait;
pub mod webhooks;

pub use approvals::{Approval, Approvals, ListApprovals};
pub use collections::{Collection, Collections, ListCollections};
pub use dev::{DevelopmentOptions, DevelopmentOutcome};
pub use duration::{parse_duration, DurationArg};
pub use error::{DeliverdError, Result};
pub use gates::{Gate, Gates};
pub use http::{HttpClient, RequestOptions, DEFAULT_BASE_URL};
pub use reports::Reports;
pub use reviews::{ListReviews, Review, Reviews};
pub use types::*;
pub use wait::{on_question, OnPoll, QuestionHandler, WaitOptions, POLL_SCHEDULE};

use crate::http::{ClientConfig, ReqwestTransport, Transport};
use crate::wait::FAST_POLL_SCHEDULE;

/// How long a request waits for a person before it expires, unless you say.
pub const DEFAULT_EXPIRY: Duration = Duration::from_secs(24 * 60 * 60);

/// In development the approver is imaginary and instant, so a wait still
/// running after a moment is one that will never settle — a question with
/// nothing to answer it, usually. Ending it quickly turns that into a message
/// rather than a hung test.
const DEVELOPMENT_TIMEOUT: Duration = Duration::from_secs(2);

/// One page of a list, and the cursor to continue from: `None` at the end.
#[derive(Debug, Clone)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

impl<T> Page<T> {
    pub(crate) fn read(
        raw: &serde_json::Value,
        key: &str,
        item: impl Fn(serde_json::Value) -> Result<T>,
    ) -> Result<Self> {
        let items = raw
            .get(key)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(item)
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = raw.get("nextCursor").and_then(serde_json::Value::as_str).map(str::to_owned);
        Ok(Self { items, next_cursor })
    }
}

/// `expires_at` as given, or `expires_in` from now, or `fallback` from now.
pub(crate) fn resolve_expiry(
    expires_at: Option<String>,
    expires_in: &Option<DurationArg>,
    fallback: Option<Duration>,
) -> Result<Option<String>> {
    if expires_at.is_some() {
        return Ok(expires_at);
    }
    let length = match expires_in {
        Some(arg) => Some(arg.resolve()?),
        None => fallback,
    };
    Ok(length.map(|d| duration::iso_utc(SystemTime::now() + d)))
}

/// Options for [`Deliverd::approve_with`] and its siblings.
pub struct AskOptions<T> {
    /// With an `external_id`, reuse the request already filed under it rather
    /// than filing a second, so restarting a crashed agent does not ask twice.
    /// On by default.
    pub reuse: bool,
    pub wait: WaitOptions<T>,
}

impl<T> Default for AskOptions<T> {
    fn default() -> Self {
        Self { reuse: true, wait: WaitOptions::default() }
    }
}

impl<T> AskOptions<T> {
    pub fn reuse(mut self, value: bool) -> Self {
        self.reuse = value;
        self
    }
    pub fn timeout(mut self, value: Duration) -> Self {
        self.wait.timeout = Some(value);
        self
    }
    pub fn on_poll(mut self, value: impl Fn(&T) + Send + Sync + 'static) -> Self {
        self.wait.on_poll = Some(Arc::new(value));
        self
    }
    /// Approvals only: answer the approver's questions without leaving the wait.
    pub fn on_question(mut self, value: QuestionHandler) -> Self {
        self.wait.on_question = Some(value);
        self
    }
}

/// Options for [`Deliverd::gate_with`].
pub struct GateOptions {
    /// Whether to block when policy sends it to a person. Default true. False
    /// returns the pending decision at once, which is what you want inside a
    /// request handler that must not hold a connection open for an hour.
    pub wait: bool,
    pub wait_options: WaitOptions<GateData>,
}

impl Default for GateOptions {
    fn default() -> Self {
        Self { wait: true, wait_options: WaitOptions::default() }
    }
}

impl GateOptions {
    pub fn no_wait(mut self) -> Self {
        self.wait = false;
        self
    }
    pub fn timeout(mut self, value: Duration) -> Self {
        self.wait_options.timeout = Some(value);
        self
    }
    pub fn on_poll(mut self, value: impl Fn(&GateData) + Send + Sync + 'static) -> Self {
        self.wait_options.on_poll = Some(Arc::new(value));
        self
    }
}

/// Configures a [`Deliverd`] client. Every setting has a default.
#[derive(Default)]
pub struct DeliverdBuilder {
    api_key: Option<String>,
    base_url: Option<String>,
    max_retries: Option<u32>,
    timeout: Option<Duration>,
    transport: Option<Arc<dyn Transport>>,
    development: Option<DevelopmentOptions>,
}

impl DeliverdBuilder {
    /// A `dlv_` key from Settings → API tokens, or an OAuth access token.
    /// Defaults to `DELIVERD_API_KEY`.
    pub fn api_key(mut self, value: impl Into<String>) -> Self {
        self.api_key = Some(value.into());
        self
    }
    /// For self-hosted or preview deployments. Defaults to `DELIVERD_BASE_URL`,
    /// then to <https://deliverd.dev>.
    pub fn base_url(mut self, value: impl Into<String>) -> Self {
        self.base_url = Some(value.into());
        self
    }
    /// Attempts for a retryable failure, the first included. Default 3.
    pub fn max_retries(mut self, value: u32) -> Self {
        self.max_retries = Some(value);
        self
    }
    /// How long one attempt may take. Default 30 seconds.
    pub fn timeout(mut self, value: Duration) -> Self {
        self.timeout = Some(value);
        self
    }
    /// What sends the requests. A [`reqwest`]-based transport unless you say.
    pub fn transport(mut self, value: Arc<dyn Transport>) -> Self {
        self.transport = Some(value);
        self
    }
    /// Run against an imaginary approver: no key, no network.
    pub fn development(mut self, options: DevelopmentOptions) -> Self {
        self.development = Some(options);
        self
    }

    pub fn build(self) -> Result<Deliverd> {
        let development = self.development.or_else(|| {
            (std::env::var("DELIVERD_MODE").as_deref() == Ok("development")).then(DevelopmentOptions::default)
        });
        let is_development = development.is_some();
        let transport: Arc<dyn Transport> = match (development, self.transport) {
            (Some(options), _) => dev::DevelopmentTransport::new(options),
            (None, Some(transport)) => transport,
            (None, None) => Arc::new(ReqwestTransport::default()),
        };
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        // A key is not needed when nothing leaves the machine.
        let api_key = self
            .api_key
            .or_else(|| env("DELIVERD_API_KEY"))
            .or_else(|| is_development.then(|| "dlv_development".to_owned()))
            .unwrap_or_default();
        let base_url = self.base_url.or_else(|| env("DELIVERD_BASE_URL")).unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let http = HttpClient::new(ClientConfig {
            api_key,
            base_url: base_url.trim_end_matches('/').to_owned(),
            max_retries: self.max_retries.unwrap_or(3),
            timeout: self.timeout.unwrap_or(Duration::from_secs(30)),
            transport,
        })?;
        Ok(Deliverd { http, development: is_development })
    }
}

/// Deliverd: you build the action, Deliverd handles the human.
///
/// Cheap to clone; every clone shares one connection pool.
#[derive(Debug, Clone)]
pub struct Deliverd {
    http: HttpClient,
    development: bool,
}

impl Deliverd {
    pub fn builder() -> DeliverdBuilder {
        DeliverdBuilder::default()
    }

    /// A client from the environment: `DELIVERD_API_KEY`, and
    /// `DELIVERD_BASE_URL` and `DELIVERD_MODE` when set.
    pub fn from_env() -> Result<Self> {
        Self::builder().build()
    }

    /// A client with this key.
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        Self::builder().api_key(api_key).build()
    }

    /// Development mode with its defaults: no key, no network, and an approver
    /// who says yes — or whatever `DELIVERD_DEV_OUTCOME` says.
    pub fn development() -> Self {
        Self::builder().development(DevelopmentOptions::default()).build().expect("development mode needs no key")
    }

    /// Whether an imaginary approver is deciding these.
    pub fn is_development(&self) -> bool {
        self.development
    }

    /// The authenticated client, for the parts of the API this crate has no
    /// named method for yet.
    pub fn http(&self) -> &HttpClient {
        &self.http
    }

    pub fn approvals(&self) -> Approvals {
        Approvals { http: self.http.clone() }
    }
    pub fn gates(&self) -> Gates {
        Gates { http: self.http.clone() }
    }
    pub fn reviews(&self) -> Reviews {
        Reviews { http: self.http.clone() }
    }
    pub fn collections(&self) -> Collections {
        Collections { http: self.http.clone() }
    }
    pub fn reports(&self) -> Reports {
        Reports { http: self.http.clone() }
    }

    fn tune<T>(&self, mut wait: WaitOptions<T>, default_timeout: bool) -> WaitOptions<T> {
        if self.development {
            if wait.poll_intervals.is_none() {
                wait.poll_intervals = Some(FAST_POLL_SCHEDULE.to_vec());
            }
            if default_timeout && wait.timeout.is_none() {
                wait.timeout = Some(DEVELOPMENT_TIMEOUT);
            }
        }
        wait
    }

    /// Ask a person, and wait for the answer.
    ///
    /// Returns when they decide — including when they say no, because a
    /// refusal is an answer and `if decision.approved` is the line that
    /// follows. It fails only when the wait itself did: a timeout, or an API
    /// that could not be reached. Requests expire after a day unless you say
    /// otherwise, so a wait always ends.
    pub async fn approve(&self, request: ApprovalRequest) -> Result<Decision> {
        self.approve_with(request, AskOptions::default()).await
    }

    /// [`approve`](Self::approve), with a timeout, a question handler or a
    /// progress callback.
    pub async fn approve_with(&self, request: ApprovalRequest, options: AskOptions<ApprovalData>) -> Result<Decision> {
        if let (Some(external_id), true) = (&request.external_id, options.reuse) {
            if let Some(mut existing) = self.approvals().find_by_external_id(external_id).await? {
                existing.wait(self.tune(options.wait, false)).await?;
                return Ok(existing.to_decision());
            }
        }
        let request = ApprovalRequest {
            expires_at: resolve_expiry(request.expires_at, &request.expires_in, Some(DEFAULT_EXPIRY))?,
            expires_in: None,
            ..request
        };
        let mut approval = self.approvals().create(request).await?;
        approval.wait(self.tune(options.wait, true)).await?;
        Ok(approval.to_decision())
    }

    /// A yes or no on something small: low risk and an hour to answer,
    /// because that is what "are you sure?" means.
    pub async fn confirm(&self, request: ApprovalRequest) -> Result<bool> {
        let request = ApprovalRequest {
            risk: request.risk.or(Some(Risk::Low)),
            expires_in: request.expires_in.or_else(|| Some(Duration::from_secs(3_600).into())),
            ..request
        };
        Ok(self.approve(request).await?.approved)
    }

    /// Ask whether to act, and wait if a person has to decide.
    ///
    /// The answer comes from **policy the developer does not own**: what needs
    /// a human is an organisation's decision, not a line in your code. Most
    /// calls never reach a person, because a rule already settles them.
    ///
    /// **Execute with `decision.input`, not your own object.** It is what the
    /// action's schema validated and what an approver actually saw.
    ///
    /// ```no_run
    /// # use deliverd::{Deliverd, GateRequest};
    /// # use serde_json::json;
    /// # #[tokio::main] async fn main() -> deliverd::Result<()> {
    /// # let deliverd = Deliverd::from_env()?;
    /// let decision = deliverd
    ///     .gate(GateRequest::new(
    ///         "finance.refund",
    ///         "refund:ord_8812",
    ///         json!({ "customer_id": "cus_1", "amount": 1240, "currency": "GBP" }),
    ///     ))
    ///     .await?;
    /// if !decision.allowed {
    ///     return Ok(());
    /// }
    /// // refund(decision.input)
    /// # Ok(()) }
    /// ```
    pub async fn gate(&self, request: GateRequest) -> Result<GateDecision> {
        self.gate_with(request, GateOptions::default()).await
    }

    pub async fn gate_with(&self, request: GateRequest, options: GateOptions) -> Result<GateDecision> {
        let mut gate = self.gates().create(request).await?;
        // No wait when the caller said not to, and none when a rule already
        // answered — the common case, which must not cost a poll.
        if !options.wait || !gate.pending() {
            return Ok(gate.to_decision());
        }
        gate.wait(self.tune(options.wait_options, true)).await?;
        Ok(gate.to_decision())
    }

    /// Ask people to read what you made, and wait for their answer.
    ///
    /// Returns on changes requested as well as approval, because that is an
    /// answer — usually the more useful one.
    pub async fn review(&self, request: ReviewRequest) -> Result<ReviewOutcome> {
        self.review_with(request, AskOptions::default()).await
    }

    pub async fn review_with(&self, request: ReviewRequest, options: AskOptions<ReviewData>) -> Result<ReviewOutcome> {
        if let (Some(external_id), true) = (&request.external_id, options.reuse) {
            if let Some(mut existing) = self.reviews().find_by_external_id(external_id).await? {
                existing.wait(self.tune(options.wait, false)).await?;
                return Ok(existing.to_outcome());
            }
        }
        let request = ReviewRequest {
            expires_at: resolve_expiry(request.expires_at, &request.expires_in, Some(DEFAULT_EXPIRY))?,
            expires_in: None,
            ..request
        };
        let mut review = self.reviews().create(request).await?;
        review.wait(self.tune(options.wait, true)).await?;
        Ok(review.to_outcome())
    }

    /// Ask people for what you do not have, and wait for it.
    ///
    /// `answers` is keyed by the question you asked. Check `complete` before
    /// you use it: a request that expired has whatever arrived and no more.
    pub async fn collect(&self, request: CollectionRequest) -> Result<CollectedAnswers> {
        self.collect_with(request, AskOptions::default()).await
    }

    pub async fn collect_with(
        &self,
        request: CollectionRequest,
        options: AskOptions<CollectionData>,
    ) -> Result<CollectedAnswers> {
        if let (Some(external_id), true) = (&request.external_id, options.reuse) {
            if let Some(mut existing) = self.collections().find_by_external_id(external_id).await? {
                existing.wait(self.tune(options.wait, false)).await?;
                return Ok(existing.to_collected());
            }
        }
        let request = CollectionRequest {
            expires_at: resolve_expiry(request.expires_at, &request.expires_in, Some(DEFAULT_EXPIRY))?,
            expires_in: None,
            ..request
        };
        let mut collection = self.collections().create(request).await?;
        collection.wait(self.tune(options.wait, true)).await?;
        Ok(collection.to_collected())
    }

    /// Publish HTML to a secure URL. The sixth primitive, one call in.
    pub async fn publish(&self, request: PublishRequest) -> Result<PublishResult> {
        self.reports().publish(request).await
    }
}
