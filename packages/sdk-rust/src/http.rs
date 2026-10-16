//! The one place a request is made.
//!
//! Retries are deliberately narrow. A 429 or a 5xx or a dropped connection is
//! worth repeating; a 4xx is the API saying the request itself is wrong, and it
//! will be just as wrong in a second. `Retry-After` is honoured when the server
//! sends one, because guessing against a server that has told you the answer
//! is how a client turns a rate limit into an outage.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::error::{DeliverdError, Result};

/// Where requests go unless you say otherwise.
pub const DEFAULT_BASE_URL: &str = "https://deliverd.dev";

/// What the SDK calls itself in `User-Agent`.
pub const USER_AGENT: &str = concat!("deliverd-rust/", env!("CARGO_PKG_VERSION"));

/// A boxed future, so a [`Transport`] can be a trait object.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One HTTP request, as the client hands it to a [`Transport`].
#[derive(Debug, Clone)]
pub struct TransportRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// How long this attempt may take before it counts as a dropped connection.
    pub timeout: Duration,
}

impl TransportRequest {
    /// A header's value, by name, ignoring case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// What came back.
#[derive(Debug, Clone)]
pub struct TransportResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl TransportResponse {
    /// A JSON response, which is what every route answers with.
    pub fn json(status: u16, body: &Value) -> Self {
        Self { status, headers: vec![("content-type".into(), "application/json".into())], body: body.to_string() }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// The request never got an answer: a refused connection, a reset, a timeout.
#[derive(Debug, Clone)]
pub struct TransportError {
    pub message: String,
    pub timed_out: bool,
}

/// What actually sends a request.
///
/// [`ReqwestTransport`] in production. Swapped for development mode, which
/// answers from memory, and in tests — and swapped *beneath* the client rather
/// than beside it, so development mode runs the same retries, the same error
/// mapping and the same polling as production. A simulator that bypassed all
/// that would prove an integration works against the simulator.
pub trait Transport: Send + Sync + 'static {
    fn send(&self, request: TransportRequest) -> BoxFuture<'_, std::result::Result<TransportResponse, TransportError>>;
}

/// The production transport, on [`reqwest`].
#[derive(Debug, Clone, Default)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, request: TransportRequest) -> BoxFuture<'_, std::result::Result<TransportResponse, TransportError>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|e| TransportError { message: e.to_string(), timed_out: false })?;
            let mut builder = self.client.request(method, &request.url).timeout(request.timeout);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            let failed = |e: reqwest::Error| TransportError { timed_out: e.is_timeout(), message: describe(&e) };
            let response = builder.send().await.map_err(failed)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_owned(), v.to_owned())))
                .collect();
            let body = response.text().await.map_err(failed)?;
            Ok(TransportResponse { status, headers, body })
        })
    }
}

/// reqwest's own message is "error sending request"; the reason is further
/// down the chain, and the reason is what anyone reading it wants.
fn describe(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// One logical request: the client may make it more than once.
#[derive(Debug, Clone)]
pub struct RequestOptions {
    pub method: &'static str,
    /// Under `/api/v1`: `/approvals`, `/gates/gat_1`.
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    /// Overrides the key generated for a POST. Pass one when the *caller's*
    /// own retry should be recognised too: a job that reruns from the start
    /// after a crash wants the key its first run used, which only the caller
    /// knows how to derive.
    pub idempotency_key: Option<String>,
}

impl RequestOptions {
    pub fn get(path: impl Into<String>) -> Self {
        Self { method: "GET", path: path.into(), query: Vec::new(), body: None, idempotency_key: None }
    }

    pub fn post(path: impl Into<String>, body: Option<Value>) -> Self {
        Self { method: "POST", path: path.into(), query: Vec::new(), body, idempotency_key: None }
    }

    pub fn query(mut self, name: &str, value: Option<impl ToString>) -> Self {
        if let Some(value) = value {
            self.query.push((name.to_owned(), value.to_string()));
        }
        self
    }
}

pub(crate) struct ClientConfig {
    pub api_key: String,
    pub base_url: String,
    pub max_retries: u32,
    pub timeout: Duration,
    pub transport: Arc<dyn Transport>,
}

/// The authenticated client every resource shares. Cheap to clone.
///
/// [`Deliverd::http`](crate::Deliverd::http) hands it out for the parts of the
/// API this crate has no named method for yet: flows, tasks, comments,
/// schedules. The same retries and errors apply.
#[derive(Clone)]
pub struct HttpClient {
    config: Arc<ClientConfig>,
}

impl std::fmt::Debug for HttpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the key.
        f.debug_struct("HttpClient").field("base_url", &self.config.base_url).finish_non_exhaustive()
    }
}

impl HttpClient {
    pub(crate) fn new(config: ClientConfig) -> Result<Self> {
        if config.api_key.is_empty() {
            return Err(DeliverdError::new(0, "no_api_key", "An API key is required."));
        }
        Ok(Self { config: Arc::new(ClientConfig { max_retries: config.max_retries.max(1), ..config }) })
    }

    /// A client that reaches nothing, behind a handle built from data you
    /// already hold.
    pub(crate) fn detached() -> Self {
        struct Nowhere;
        impl Transport for Nowhere {
            fn send(
                &self,
                _: TransportRequest,
            ) -> BoxFuture<'_, std::result::Result<TransportResponse, TransportError>> {
                Box::pin(async {
                    Err(TransportError {
                        message: "this handle was built from data and has no client behind it".into(),
                        timed_out: false,
                    })
                })
            }
        }
        Self {
            config: Arc::new(ClientConfig {
                api_key: String::new(),
                base_url: DEFAULT_BASE_URL.into(),
                max_retries: 1,
                timeout: Duration::from_secs(1),
                transport: Arc::new(Nowhere),
            }),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    /// Make a request and read its JSON answer as `T`.
    pub async fn request<T: DeserializeOwned>(&self, options: RequestOptions) -> Result<T> {
        let path = options.path.clone();
        let value = self.request_value(options).await?;
        serde_json::from_value(value).map_err(|e| {
            DeliverdError::new(0, "invalid_response", format!("The answer from {path} was not the shape expected: {e}"))
        })
    }

    /// `GET`, read as `T`.
    pub async fn get<T: DeserializeOwned>(&self, path: impl Into<String>) -> Result<T> {
        self.request(RequestOptions::get(path)).await
    }

    /// `POST` with a JSON body, read as `T`.
    pub async fn post<T: DeserializeOwned>(&self, path: impl Into<String>, body: &impl Serialize) -> Result<T> {
        self.request(RequestOptions::post(path, Some(to_value(body)?))).await
    }

    /// Make a request and return its JSON as it came: `Null` for a 204.
    pub async fn request_value(&self, options: RequestOptions) -> Result<Value> {
        let config = &self.config;
        let mut url = format!("{}/api/v1{}", config.base_url, options.path);
        if !options.query.is_empty() {
            let query: Vec<String> =
                options.query.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect();
            url.push('?');
            url.push_str(&query.join("&"));
        }

        // One id per logical request, kept across retries: it is the thing to
        // quote when something went wrong.
        let correlation_id = uuid::Uuid::new_v4().to_string();
        // One idempotency key per logical request, held across every attempt
        // below — which is the whole point. A POST that arrived and lost its
        // response on the way back would otherwise be retried as a second
        // create, and for an approval that means two people asked to authorise
        // one act. Only on POST: nothing else here creates anything.
        let idempotency_key = (options.method == "POST")
            .then(|| options.idempotency_key.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));

        let mut headers = vec![
            ("Authorization".to_owned(), format!("Bearer {}", config.api_key)),
            ("Accept".to_owned(), "application/json".to_owned()),
            ("User-Agent".to_owned(), USER_AGENT.to_owned()),
            ("deliverd-correlation-id".to_owned(), correlation_id),
        ];
        if let Some(key) = idempotency_key {
            headers.push(("Idempotency-Key".to_owned(), key));
        }
        if options.body.is_some() {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        let body = options.body.as_ref().map(Value::to_string);

        let mut last_error: Option<DeliverdError> = None;
        for attempt in 1..=config.max_retries {
            if attempt > 1 {
                let delay =
                    last_error.as_ref().and_then(DeliverdError::retry_after).unwrap_or_else(|| backoff(attempt));
                tokio::time::sleep(delay).await;
            }

            let request = TransportRequest {
                method: options.method.to_owned(),
                url: url.clone(),
                headers: headers.clone(),
                body: body.clone(),
                timeout: config.timeout,
            };
            let response = match config.transport.send(request).await {
                Ok(response) => response,
                Err(failure) => {
                    let message = if failure.timed_out {
                        format!("The request timed out: {}", failure.message)
                    } else {
                        format!("Could not reach Deliverd: {}", failure.message)
                    };
                    let error = DeliverdError::new(0, "network_error", message);
                    if attempt == config.max_retries {
                        return Err(error);
                    }
                    last_error = Some(error);
                    continue;
                }
            };

            if response.status == 204 {
                return Ok(Value::Null);
            }

            let json: Value = if response.body.trim().is_empty() {
                Value::Object(Default::default())
            } else {
                match serde_json::from_str(&response.body) {
                    Ok(json) => json,
                    Err(_) => {
                        let preview: String = response.body.chars().take(120).collect();
                        let error = DeliverdError::new(
                            response.status,
                            "invalid_response",
                            format!("Expected JSON from {} and got {preview}", options.path),
                        );
                        if is_retryable(response.status) && attempt < config.max_retries {
                            last_error = Some(error);
                            continue;
                        }
                        return Err(error);
                    }
                }
            };

            if (200..300).contains(&response.status) {
                return Ok(json);
            }

            let envelope = json.get("error");
            let field = |name: &str| envelope.and_then(|e| e.get(name)).and_then(Value::as_str).map(str::to_owned);
            let error = DeliverdError::new(
                response.status,
                field("code").unwrap_or_else(|| "error".into()),
                field("message").unwrap_or_else(|| format!("Request failed ({})", response.status)),
            )
            .with_details(envelope.and_then(|e| e.get("details")).cloned())
            .with_retry_after(response.header("retry-after").and_then(parse_retry_after));
            if is_retryable(response.status) && attempt < config.max_retries {
                last_error = Some(error);
                continue;
            }
            return Err(error);
        }
        Err(last_error.unwrap_or_else(|| DeliverdError::new(0, "error", "Request failed.")))
    }
}

pub(crate) fn to_value(body: &impl Serialize) -> Result<Value> {
    serde_json::to_value(body)
        .map_err(|e| DeliverdError::new(0, "invalid_request", format!("Could not encode the request: {e}")))
}

/// 429 and most 5xx: a 4xx will be just as wrong on the next attempt.
///
/// 501 is the exception among the 5xx. It means the call is not built, which
/// is a fact about the server rather than about this moment — the same
/// argument as a 4xx. `packages/conformance/cases.json` holds all three SDKs
/// to this list.
pub fn is_retryable(status: u16) -> bool {
    status == 429 || (status >= 500 && status != 501)
}

/// `Retry-After` is seconds on the wire, or an HTTP date.
pub fn parse_retry_after(header: &str) -> Option<Duration> {
    let header = header.trim();
    if let Ok(seconds) = header.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds));
    }
    let at = httpdate::parse_http_date(header).ok()?;
    Some(at.duration_since(SystemTime::now()).unwrap_or_default())
}

/// Exponential from 500ms with jitter, so a fleet of agents does not resonate.
fn backoff(attempt: u32) -> Duration {
    let base = 8_000f64.min(500.0 * 2f64.powi(attempt as i32 - 1));
    Duration::from_millis((base / 2.0 + fastrand::f64() * base / 2.0) as u64)
}

/// Percent-encode a path segment or a query value: everything but the
/// unreserved characters.
pub(crate) fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
