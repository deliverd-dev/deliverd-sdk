//! Ask before you act, and let the organisation's policy answer.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{AgentRef, ExecutionReceipt, GateData, GateDecision, GateRequest, GateStatus, RecordExecution};
use crate::wait::{Poller, WaitOptions};

/// A decision, and what you can do with it.
#[derive(Debug, Clone)]
pub struct Gate {
    http: HttpClient,
    data: GateData,
    raw: Value,
}

impl Gate {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        Ok(Self { http, data: parse(&raw)?, raw })
    }

    /// A handle over data you already hold, with no client behind it: for
    /// reading a decision that arrived by webhook. Calls that reach the API
    /// fail on it.
    pub fn from_data(data: GateData) -> Self {
        let raw = serde_json::to_value(&data).unwrap_or(Value::Null);
        Self { http: HttpClient::detached(), data, raw }
    }

    pub fn data(&self) -> &GateData {
        &self.data
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn status(&self) -> GateStatus {
        self.data.status
    }
    /// The one to branch on: a rule permitted it **or** a person agreed to it.
    /// False for denied, rejected, expired, cancelled and while pending.
    pub fn allowed(&self) -> bool {
        self.data.allowed
    }
    /// Still waiting on a person.
    pub fn pending(&self) -> bool {
        self.data.status == GateStatus::Pending
    }
    /// Refused by a rule, as against rejected by a person.
    pub fn denied(&self) -> bool {
        self.data.status == GateStatus::Denied
    }
    /// Whether you may act on it **now**: authorised, inside its window, with a
    /// use left, not revoked.
    pub fn can_execute(&self) -> bool {
        self.data.can_execute
    }

    /// The answer, flattened: what [`gate`](crate::Deliverd::gate) hands back.
    pub fn to_decision(&self) -> GateDecision {
        let data = &self.data;
        GateDecision {
            allowed: data.allowed,
            status: data.status,
            reason: data.reason.clone(),
            rule: data.rule.clone(),
            input: data.input.clone(),
            changes: data.changes.clone(),
            id: data.id.clone(),
            approval_url: data.approval_url.clone(),
            gate: data.clone(),
        }
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw = self.http.request_value(RequestOptions::get(format!("/gates/{}", encode(&self.data.id)))).await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Report what you did with the permission. Spends a use.
    pub async fn record_execution(&mut self, input: RecordExecution) -> Result<ExecutionReceipt> {
        let (receipt, gate) = record_execution(&self.http, &self.data.id, input).await?;
        self.raw = serde_json::to_value(&gate).unwrap_or(Value::Null);
        self.data = gate;
        Ok(receipt)
    }

    /// Withdraw it: the request if nobody has answered, the permission if unused.
    pub async fn cancel(&mut self, note: Option<&str>) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(
                format!("/gates/{}/cancel", encode(&self.data.id)),
                Some(cancel_body(note, None)),
            ))
            .await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Wait until a person decides. Returns at once when a rule already
    /// settled it, which is the common case.
    pub async fn wait(&mut self, options: WaitOptions<GateData>) -> Result<&mut Self> {
        if !self.pending() {
            return Ok(self);
        }
        let mut poller = Poller::new(&options);
        loop {
            if poller.expired() {
                let rule = self.data.rule.as_ref().map(|r| format!("\"{r}\" ")).unwrap_or_default();
                let action = if self.data.action_id.is_empty() { &self.data.id } else { &self.data.action_id };
                let open = match &self.data.approval_url {
                    Some(url) => format!("It is still open at {url}."),
                    None => "It is still open.".to_owned(),
                };
                return Err(DeliverdError::timeout(format!(
                    "Nobody decided the {rule}gate on \"{action}\" within the timeout. {open}"
                )));
            }
            poller.tick().await;
            self.refresh().await?;
            if let Some(on_poll) = &options.on_poll {
                on_poll(&self.data);
            }
            if !self.pending() {
                return Ok(self);
            }
        }
    }
}

fn parse(raw: &Value) -> Result<GateData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("A gate was not the shape expected: {e}")))
}

/// Only what was given, as the TypeScript SDK sends it: a field left out and
/// a field sent as `null` are not the same thing to a schema.
fn cancel_body(note: Option<&str>, agent: Option<&AgentRef>) -> Value {
    let mut body = serde_json::Map::new();
    if let Some(note) = note {
        body.insert("note".into(), json!(note));
    }
    if let Some(agent) = agent {
        body.insert("agent".into(), json!(agent));
    }
    Value::Object(body)
}

#[derive(Deserialize)]
struct Executed {
    receipt: ExecutionReceipt,
    gate: GateData,
}

async fn record_execution(http: &HttpClient, id: &str, input: RecordExecution) -> Result<(ExecutionReceipt, GateData)> {
    let mut body = to_value(&input)?;
    if let Value::Object(map) = &mut body {
        map.entry("phase").or_insert_with(|| Value::String("completed".into()));
    }
    let executed: Executed =
        http.request(RequestOptions::post(format!("/gates/{}/execution", encode(id)), Some(body))).await?;
    Ok((executed.receipt, executed.gate))
}

/// The gates API.
#[derive(Debug, Clone)]
pub struct Gates {
    pub(crate) http: HttpClient,
}

impl Gates {
    /// Raise a decision and return straight away, even if it went to a person.
    ///
    /// The caller's `external_id` goes out as the HTTP idempotency key too, so
    /// a retry inside the transport and a retry by your own code are the same
    /// key rather than one guarding the request and the other the decision.
    pub async fn create(&self, request: GateRequest) -> Result<Gate> {
        // Refused before anything leaves: an empty id would be one the server
        // could not tell from every other empty id.
        if request.external_id.trim().is_empty() {
            return Err(DeliverdError::new(
                0,
                "external_id_required",
                "A gate needs your own external_id for this unit of work (\"refund:ord_8812\"), so a retry re-reads the decision instead of asking twice.",
            ));
        }
        let mut options = RequestOptions::post("/gates", Some(to_value(&request)?));
        options.idempotency_key = Some(request.external_id.clone());
        let raw = self.http.request_value(options).await?;
        Gate::from_raw(self.http.clone(), raw)
    }

    /// The same as [`create`](Self::create), named for what it does.
    pub async fn check(&self, request: GateRequest) -> Result<Gate> {
        self.create(request).await
    }

    pub async fn get(&self, id: &str) -> Result<Gate> {
        let raw = self.http.request_value(RequestOptions::get(format!("/gates/{}", encode(id)))).await?;
        Gate::from_raw(self.http.clone(), raw)
    }

    /// Report what you did with a gate's permission.
    pub async fn record_execution(&self, id: &str, input: RecordExecution) -> Result<(ExecutionReceipt, Gate)> {
        let (receipt, gate) = record_execution(&self.http, id, input).await?;
        let raw = serde_json::to_value(&gate).unwrap_or(Value::Null);
        Ok((receipt, Gate { http: self.http.clone(), data: gate, raw }))
    }

    /// Withdraw a request, or an unused permission.
    pub async fn cancel(&self, id: &str, note: Option<&str>, agent: Option<AgentRef>) -> Result<Gate> {
        let raw = self
            .http
            .request_value(RequestOptions::post(
                format!("/gates/{}/cancel", encode(id)),
                Some(cancel_body(note, agent.as_ref())),
            ))
            .await?;
        Gate::from_raw(self.http.clone(), raw)
    }

    /// The gate's evidence pack, as JSON.
    pub async fn evidence(&self, id: &str) -> Result<Value> {
        self.http.request_value(RequestOptions::get(format!("/gates/{}/evidence", encode(id)))).await
    }
}
