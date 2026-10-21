//! The API's objects, by hand, field for field with the TypeScript SDK's
//! `types.ts`.
//!
//! Every response type reads leniently: a field the server adds tomorrow is
//! ignored rather than fatal, a field it leaves out takes its default, and a
//! status this version does not know reads as `Unknown` instead of failing the
//! whole call. Each handle keeps the raw JSON beside the typed copy, so a
//! field these structs do not name is still one `raw()` away.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::duration::DurationArg;

/// A JSON object: an action's `input`, a request's `metadata`.
pub type Object = Map<String, Value>;

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant,)+
            /// A value this version of the crate does not know.
            #[default]
            #[serde(other)]
            Unknown,
        }

        impl $name {
            /// The wire spelling.
            pub fn as_str(&self) -> &'static str {
                match self {
                    $($name::$variant => $text,)+
                    $name::Unknown => "unknown",
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

string_enum!(
    /// Where an approval stands.
    ApprovalStatus {
        Pending = "pending",
        Approved = "approved",
        Rejected = "rejected",
        ChangesRequested = "changes_requested",
        Expired = "expired",
        Cancelled = "cancelled",
    }
);

string_enum!(
    /// How the approver should weigh it.
    Risk {
        Low = "low",
        Medium = "medium",
        High = "high",
        Critical = "critical",
    }
);

string_enum!(
    /// What a gate decision can be. `Allowed` and `Denied` are what a *rule*
    /// said; the rest are what a *person* did about a request no rule settled.
    GateStatus {
        Allowed = "allowed",
        Denied = "denied",
        Pending = "pending",
        Approved = "approved",
        Rejected = "rejected",
        ChangesRequested = "changes_requested",
        Expired = "expired",
        Cancelled = "cancelled",
        /// A person took the permission back before it was used.
        Revoked = "revoked",
        /// The permission has been used. A further act needs a new gate.
        Used = "used",
    }
);

string_enum!(
    /// What policy said, fixed when the gate was made.
    GatePolicyDecision {
        Allow = "ALLOW",
        ApprovalRequired = "APPROVAL_REQUIRED",
        ReviewRequired = "REVIEW_REQUIRED",
        Deny = "DENY",
    }
);

string_enum!(
    /// Where a review stands.
    ReviewStatus {
        Pending = "pending",
        Approved = "approved",
        ChangesRequested = "changes_requested",
        Expired = "expired",
        Cancelled = "cancelled",
    }
);

string_enum!(
    /// Where a request for information stands.
    CollectionStatus {
        Pending = "pending",
        Complete = "complete",
        Expired = "expired",
        Cancelled = "cancelled",
    }
);

string_enum!(
    /// What shape of answer a question takes.
    QuestionKind {
        Text = "text",
        LongText = "long_text",
        Number = "number",
        Date = "date",
        Choice = "choice",
        MultiChoice = "multi_choice",
        Boolean = "boolean",
    }
);

/* ── Approvals ─────────────────────────────────────────────────────────── */

/// One line of evidence, as the approval page shows it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Factor {
    pub label: String,
    /// `ok`, `warning` or `info`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Factor {
    pub fn ok(label: impl Into<String>) -> Self {
        Self { label: label.into(), status: Some("ok".into()), detail: None }
    }

    pub fn warning(label: impl Into<String>) -> Self {
        Self { label: label.into(), status: Some("warning".into()), detail: None }
    }

    pub fn info(label: impl Into<String>) -> Self {
        Self { label: label.into(), status: Some("info".into()), detail: None }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Where to read more.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Link {
    pub label: String,
    pub url: String,
}

/// A question the approver asked the requester.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalQuestion {
    pub id: String,
    pub question: String,
    pub answer: Option<String>,
    pub asked_at: String,
    pub answered_at: Option<String>,
}

/// One field an approver corrected before approving.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FieldChange {
    pub field: String,
    pub from: Value,
    pub to: Value,
}

/// What the organisation's ethics rules asked whoever decides to weigh.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Concern {
    pub principle: String,
    pub rule: String,
    pub concern: String,
}

/// An approval request, as the API returns it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalData {
    pub id: String,
    pub status: ApprovalStatus,
    /// The page the approver decides on.
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub risk: Risk,
    pub factors: Vec<Factor>,
    pub links: Vec<Link>,
    pub report_id: Option<String>,
    pub external_id: Option<String>,
    pub metadata: Object,
    /// What you proposed to run with, unchanged.
    pub input: Option<Object>,
    /// Which fields of it the approver may correct.
    pub editable_fields: Vec<String>,
    /// What to run with once approved: `input` with any corrections.
    pub approved_input: Option<Object>,
    pub changes: Vec<FieldChange>,
    pub concerns: Vec<Concern>,
    pub requested_by: String,
    pub approvers: Vec<String>,
    pub required_approvals: u32,
    pub approvals_so_far: u32,
    /// Who decided, as a name rather than an id.
    pub decided_by: Option<String>,
    pub decided_by_id: Option<String>,
    pub decided_at: Option<String>,
    /// The approver's reason, when they gave one.
    pub note: Option<String>,
    pub expires_at: Option<String>,
    pub questions: Vec<ApprovalQuestion>,
    pub created_at: String,
    /// Which agent asked, as the request declared it. Not verified.
    pub agent: Option<DeclaredAgent>,
    /// The model the request said the agent was running on. Not verified.
    pub model: Option<String>,
}

/// Which agent made a request, as it described itself (`agent` on a request).
///
/// Every field is optional. The API stores and returns it as declared; nothing
/// checks it and nothing is decided on it.
///
/// ```
/// use deliverd::{ApprovalRequest, DeclaredAgent};
///
/// let request = ApprovalRequest::new("Refund order 4471")
///     .agent(DeclaredAgent::named("Claims triage").provider("anthropic"))
///     .model("claude-opus-5");
/// ```
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeclaredAgent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
}

impl DeclaredAgent {
    pub fn named(value: impl Into<String>) -> Self {
        Self { name: Some(value.into()), ..Default::default() }
    }
    pub fn provider(mut self, value: impl Into<String>) -> Self {
        self.provider = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
}

/// What to ask a person.
///
/// ```
/// use deliverd::{ApprovalRequest, Factor, Risk};
///
/// let request = ApprovalRequest::new("Deploy release 4.2 to production")
///     .description("142 commits since 4.1. All checks green.")
///     .risk(Risk::High)
///     .factor(Factor::ok("All checks green"))
///     .approver("dave@example.com")
///     .expires_in("4h")
///     .external_id("deploy_4842");
/// ```
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// What is being asked, as a headline.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub factors: Vec<Factor>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<Link>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    /// People, teams or groups who may decide. Your owners and admins when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub approvers: Vec<String>,
    /// An exact moment it expires, ISO 8601. Takes precedence over `expires_in`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// How long until it expires, worked out when the call is made.
    #[serde(skip)]
    pub expires_in: Option<DurationArg>,
    /// Your own reference. With one, a restarted agent reuses its request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    /// Where to POST the outcome instead of polling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Object>,
    /// What you will run with if it is approved, shown to the approver.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Object>,
    /// Fields of `input` the approver may correct.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub editable_fields: Vec<String>,
    /// Which agent is asking, in your words. Recorded and shown as declared;
    /// nothing is decided on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<DeclaredAgent>,
    /// The model the agent is running on, such as `claude-opus-5`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl ApprovalRequest {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), ..Default::default() }
    }
    pub fn description(mut self, value: impl Into<String>) -> Self {
        self.description = Some(value.into());
        self
    }
    pub fn risk(mut self, value: Risk) -> Self {
        self.risk = Some(value);
        self
    }
    pub fn factor(mut self, value: Factor) -> Self {
        self.factors.push(value);
        self
    }
    pub fn link(mut self, label: impl Into<String>, url: impl Into<String>) -> Self {
        self.links.push(Link { label: label.into(), url: url.into() });
        self
    }
    pub fn report_id(mut self, value: impl Into<String>) -> Self {
        self.report_id = Some(value.into());
        self
    }
    pub fn approver(mut self, value: impl Into<String>) -> Self {
        self.approvers.push(value.into());
        self
    }
    pub fn expires_at(mut self, value: impl Into<String>) -> Self {
        self.expires_at = Some(value.into());
        self
    }
    /// `"4h"`, `"30m"`, `"2d"`, or a `std::time::Duration`.
    pub fn expires_in(mut self, value: impl Into<DurationArg>) -> Self {
        self.expires_in = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    /// Which agent is asking. Recorded as declared.
    pub fn agent(mut self, value: DeclaredAgent) -> Self {
        self.agent = Some(value);
        self
    }
    /// The model the agent is running on. Recorded as declared.
    pub fn model(mut self, value: impl Into<String>) -> Self {
        self.model = Some(value.into());
        self
    }
    pub fn callback_url(mut self, value: impl Into<String>) -> Self {
        self.callback_url = Some(value.into());
        self
    }
    pub fn metadata(mut self, value: Object) -> Self {
        self.metadata = Some(value);
        self
    }
    pub fn input(mut self, value: Object) -> Self {
        self.input = Some(value);
        self
    }
    pub fn editable_field(mut self, value: impl Into<String>) -> Self {
        self.editable_fields.push(value.into());
        self
    }
}

/// The answer to [`approve`](crate::Deliverd::approve), flattened.
///
/// The line after the call is `if decision.approved`; the whole request is on
/// `approval` when a field here does not cover it.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    /// True only for an approval. False for rejected, changes requested,
    /// expired and cancelled.
    pub approved: bool,
    /// Never `Pending`: a request that settled nothing reads as `Expired`.
    pub status: ApprovalStatus,
    pub note: Option<String>,
    pub decided_by: Option<String>,
    pub decided_by_id: Option<String>,
    pub decided_at: Option<String>,
    pub id: String,
    pub url: String,
    /// What to run with, when you sent an `input` and it was approved: yours,
    /// with the approver's corrections. `None` otherwise — never run the
    /// proposal when this is `None`.
    pub input: Option<Object>,
    pub changes: Vec<FieldChange>,
    pub approval: ApprovalData,
}

/* ── Gates ─────────────────────────────────────────────────────────────── */

/// Where an act lands.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Destination {
    /// `workspace`, `report`, `user`, `email`, `url`, `channel`, `repository`, …
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What an act is about: a Deliverd report version, or a file you hold.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArtifactRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

/// Who is asking, when you ask through a person's connection.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Ask whether an action may happen.
///
/// `external_id` is required, which nothing else here is: a random
/// per-attempt key guards a retried *request*; this guards a retried
/// *decision*. A crashed agent re-running its refund step must re-read the
/// answer it already got rather than ask a second person about the same money.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateRequest {
    /// The registered action: `finance.refund`.
    pub action_id: String,
    /// The arguments you will actually execute with.
    pub input: Object,
    pub external_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<Destination>,
    /// `public`, `internal`, `confidential` or `restricted`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_gate_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Object>,
}

impl GateRequest {
    /// `input` is anything that serialises to a JSON object; `json!({…})` is
    /// the usual way to write one.
    pub fn new(action: impl Into<String>, external_id: impl Into<String>, input: Value) -> Self {
        let input = match input {
            Value::Object(map) => map,
            Value::Null => Object::new(),
            other => {
                let mut map = Object::new();
                map.insert("value".into(), other);
                map
            }
        };
        Self { action_id: action.into(), external_id: external_id.into(), input, ..Default::default() }
    }
    pub fn environment(mut self, value: impl Into<String>) -> Self {
        self.environment = Some(value.into());
        self
    }
    pub fn reason(mut self, value: impl Into<String>) -> Self {
        self.reason = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    pub fn description(mut self, value: impl Into<String>) -> Self {
        self.description = Some(value.into());
        self
    }
    pub fn destination(mut self, value: Destination) -> Self {
        self.destination = Some(value);
        self
    }
    pub fn classification(mut self, value: impl Into<String>) -> Self {
        self.classification = Some(value.into());
        self
    }
    pub fn risk(mut self, value: Risk) -> Self {
        self.risk = Some(value);
        self
    }
    pub fn artifact(mut self, value: ArtifactRef) -> Self {
        self.artifact = Some(value);
        self
    }
    pub fn agent(mut self, value: AgentRef) -> Self {
        self.agent = Some(value);
        self
    }
    pub fn supersedes(mut self, gate_id: impl Into<String>) -> Self {
        self.supersedes_gate_id = Some(gate_id.into());
        self
    }
    pub fn callback_url(mut self, value: impl Into<String>) -> Self {
        self.callback_url = Some(value.into());
        self
    }
    pub fn metadata(mut self, value: Object) -> Self {
        self.metadata = Some(value);
        self
    }
}

/// What a gate's permission covers, fixed when the gate is made.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateScope {
    pub destination: Option<Destination>,
    /// `internal` or `external`, worked out by Deliverd.
    pub recipient_scope: Option<String>,
    pub classification: Option<String>,
    pub risk: Option<Risk>,
    pub artifact: Option<Value>,
    pub digest: Option<String>,
}

/// How long a permission lasts and how many uses are left.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Authorisation {
    pub valid_until: Option<String>,
    pub max_uses: u32,
    pub uses_remaining: u32,
}

/// A gate decision, as the API returns it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateData {
    pub id: String,
    pub status: GateStatus,
    /// A rule permitted it, or a person agreed to it.
    pub allowed: bool,
    /// What to execute with: the validated input, or the approver's correction.
    pub input: Object,
    pub changes: Vec<FieldChange>,
    pub concerns: Vec<Concern>,
    /// `policy` or `human`.
    pub basis: String,
    pub reason: Option<String>,
    pub rule: Option<String>,
    pub policy_version_id: Option<String>,
    pub approval_id: Option<String>,
    pub approval_url: Option<String>,
    pub outcome: Option<String>,
    pub settled_at: Option<String>,
    /// True when this call read back a decision already made under your id.
    pub reused: bool,
    pub decision: GatePolicyDecision,
    /// Whether you may act on it now: authorised, in its window, with a use left.
    pub can_execute: bool,
    pub blocked_because: Option<String>,
    pub scope: GateScope,
    pub authorisation: Authorisation,
    pub action_id: String,
    pub agent_id: Option<String>,
    pub flow_id: Option<String>,
    pub supersedes_gate_id: Option<String>,
    pub description: Option<String>,
    pub requested_by: String,
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_secret: Option<String>,
}

/// The answer to [`gate`](crate::Deliverd::gate), flattened.
#[derive(Debug, Clone, PartialEq)]
pub struct GateDecision {
    pub allowed: bool,
    pub status: GateStatus,
    pub reason: Option<String>,
    pub rule: Option<String>,
    /// What to execute with, corrections included. Use this, not your own copy.
    pub input: Object,
    pub changes: Vec<FieldChange>,
    pub id: String,
    pub approval_url: Option<String>,
    pub gate: GateData,
}

/// What you tell Deliverd you did with a permission. Recorded as your report.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordExecution {
    /// `started`, `completed` (the default) or `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<Destination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Object>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
}

/// A receipt: what the agent reported doing, and how much Deliverd checked.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecutionReceipt {
    pub id: String,
    pub gate_id: String,
    pub phase: String,
    pub claim_id: Option<String>,
    pub executed_at: Option<String>,
    pub artifact_sha256: Option<String>,
    pub destination: Option<Destination>,
    pub result: Object,
    /// `verified`, `hash_matched` or `reported`.
    pub verification: String,
    pub detail: Option<String>,
    pub reported_by: String,
    pub created_at: String,
}

/* ── Reviews ───────────────────────────────────────────────────────────── */

/// Ask people to read what you made and say whether it is right.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub title: String,
    /// What to check. Without this a reviewer decides what "review" means.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    pub reviewers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_approvals: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip)]
    pub expires_in: Option<DurationArg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Object>,
    /// Which agent is asking, in your words. Recorded and shown as declared;
    /// nothing is decided on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<DeclaredAgent>,
    /// The model the agent is running on, such as `claude-opus-5`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl ReviewRequest {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), ..Default::default() }
    }
    pub fn instructions(mut self, value: impl Into<String>) -> Self {
        self.instructions = Some(value.into());
        self
    }
    pub fn report_id(mut self, value: impl Into<String>) -> Self {
        self.report_id = Some(value.into());
        self
    }
    pub fn version_id(mut self, value: impl Into<String>) -> Self {
        self.version_id = Some(value.into());
        self
    }
    pub fn reviewer(mut self, value: impl Into<String>) -> Self {
        self.reviewers.push(value.into());
        self
    }
    pub fn required_approvals(mut self, value: u32) -> Self {
        self.required_approvals = Some(value);
        self
    }
    pub fn expires_at(mut self, value: impl Into<String>) -> Self {
        self.expires_at = Some(value.into());
        self
    }
    pub fn expires_in(mut self, value: impl Into<DurationArg>) -> Self {
        self.expires_in = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    /// Which agent is asking. Recorded as declared.
    pub fn agent(mut self, value: DeclaredAgent) -> Self {
        self.agent = Some(value);
        self
    }
    /// The model the agent is running on. Recorded as declared.
    pub fn model(mut self, value: impl Into<String>) -> Self {
        self.model = Some(value.into());
        self
    }
    pub fn callback_url(mut self, value: impl Into<String>) -> Self {
        self.callback_url = Some(value.into());
        self
    }
    pub fn metadata(mut self, value: Object) -> Self {
        self.metadata = Some(value);
        self
    }
}

/// A person on a review.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewerRef {
    /// `user` or `guest`.
    pub kind: String,
    pub id: String,
    pub label: String,
}

/// One reviewer's answer.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewVerdict {
    /// `approved` or `changes_requested`.
    pub verdict: String,
    /// Who gave it, as a name rather than an id.
    pub by: String,
    pub note: Option<String>,
    pub at: String,
}

/// A review, as the API returns it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewData {
    pub id: String,
    pub status: ReviewStatus,
    pub url: String,
    pub title: String,
    pub instructions: Option<String>,
    pub report_id: Option<String>,
    pub version_id: Option<String>,
    pub external_id: Option<String>,
    pub metadata: Object,
    pub requested_by: String,
    pub required_approvals: u32,
    pub reviewers: Vec<ReviewerRef>,
    pub verdicts: Vec<ReviewVerdict>,
    /// How many comment threads the reviewers opened while reading.
    pub thread_count: u32,
    pub settled_at: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    /// Which agent asked, as the request declared it. Not verified.
    pub agent: Option<DeclaredAgent>,
    /// The model the request said the agent was running on. Not verified.
    pub model: Option<String>,
}

/// The answer to [`review`](crate::Deliverd::review), flattened.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewOutcome {
    /// False for changes requested, expired and cancelled.
    pub approved: bool,
    /// Never `Pending`.
    pub status: ReviewStatus,
    pub verdicts: Vec<ReviewVerdict>,
    pub thread_count: u32,
    pub id: String,
    pub url: String,
    pub review: ReviewData,
}

/* ── Collections ───────────────────────────────────────────────────────── */

/// One question to ask.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The question, as you would ask it out loud.
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    pub kind: QuestionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
}

impl Question {
    pub fn new(prompt: impl Into<String>, kind: QuestionKind) -> Self {
        Self { prompt: prompt.into(), kind, ..Default::default() }
    }
    pub fn text(prompt: impl Into<String>) -> Self {
        Self::new(prompt, QuestionKind::Text)
    }
    pub fn number(prompt: impl Into<String>) -> Self {
        Self::new(prompt, QuestionKind::Number)
    }
    pub fn boolean(prompt: impl Into<String>) -> Self {
        Self::new(prompt, QuestionKind::Boolean)
    }
    pub fn date(prompt: impl Into<String>) -> Self {
        Self::new(prompt, QuestionKind::Date)
    }
    pub fn choice(prompt: impl Into<String>, options: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self { options: options.into_iter().map(Into::into).collect(), ..Self::new(prompt, QuestionKind::Choice) }
    }
    pub fn help(mut self, value: impl Into<String>) -> Self {
        self.help = Some(value.into());
        self
    }
    pub fn optional(mut self) -> Self {
        self.required = Some(false);
        self
    }
}

/// Ask people for what you do not have.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRequest {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub questions: Vec<Question>,
    pub respondents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_responses: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip)]
    pub expires_in: Option<DurationArg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Object>,
    /// Which agent is asking, in your words. Recorded and shown as declared;
    /// nothing is decided on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<DeclaredAgent>,
    /// The model the agent is running on, such as `claude-opus-5`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl CollectionRequest {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), ..Default::default() }
    }
    pub fn instructions(mut self, value: impl Into<String>) -> Self {
        self.instructions = Some(value.into());
        self
    }
    pub fn question(mut self, value: Question) -> Self {
        self.questions.push(value);
        self
    }
    pub fn respondent(mut self, value: impl Into<String>) -> Self {
        self.respondents.push(value.into());
        self
    }
    pub fn required_responses(mut self, value: u32) -> Self {
        self.required_responses = Some(value);
        self
    }
    pub fn report_id(mut self, value: impl Into<String>) -> Self {
        self.report_id = Some(value.into());
        self
    }
    pub fn due_at(mut self, value: impl Into<String>) -> Self {
        self.due_at = Some(value.into());
        self
    }
    pub fn expires_at(mut self, value: impl Into<String>) -> Self {
        self.expires_at = Some(value.into());
        self
    }
    pub fn expires_in(mut self, value: impl Into<DurationArg>) -> Self {
        self.expires_in = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    /// Which agent is asking. Recorded as declared.
    pub fn agent(mut self, value: DeclaredAgent) -> Self {
        self.agent = Some(value);
        self
    }
    /// The model the agent is running on. Recorded as declared.
    pub fn model(mut self, value: impl Into<String>) -> Self {
        self.model = Some(value.into());
        self
    }
    pub fn callback_url(mut self, value: impl Into<String>) -> Self {
        self.callback_url = Some(value.into());
        self
    }
    pub fn metadata(mut self, value: Object) -> Self {
        self.metadata = Some(value);
        self
    }
}

/// What an answer can hold, shaped by its question's kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnswerValue {
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<String>),
}

impl AnswerValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            AnswerValue::Text(text) => Some(text),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            AnswerValue::Number(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            AnswerValue::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// A question as the API stored it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CollectionQuestion {
    pub id: String,
    pub prompt: String,
    pub help: Option<String>,
    pub kind: QuestionKind,
    pub required: bool,
    pub options: Vec<String>,
}

/// One submitted answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Answer {
    /// The question's prompt.
    pub question: String,
    #[serde(default)]
    pub kind: QuestionKind,
    pub value: AnswerValue,
}

/// One person's reply.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionReply {
    /// Who answered, as a name rather than an id.
    pub respondent: String,
    /// `pending` or `submitted`.
    pub status: String,
    pub submitted_at: Option<String>,
    /// Empty until they submit.
    pub answers: Vec<Answer>,
}

/// A request for information, as the API returns it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionData {
    pub id: String,
    pub status: CollectionStatus,
    pub url: String,
    pub title: String,
    pub instructions: Option<String>,
    pub report_id: Option<String>,
    pub external_id: Option<String>,
    pub metadata: Object,
    pub requested_by: String,
    pub required_responses: u32,
    pub questions: Vec<CollectionQuestion>,
    pub responses: Vec<CollectionReply>,
    pub submitted_count: u32,
    pub asked_count: u32,
    pub settled_at: Option<String>,
    pub due_at: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    /// Which agent asked, as the request declared it. Not verified.
    pub agent: Option<DeclaredAgent>,
    /// The model the request said the agent was running on. Not verified.
    pub model: Option<String>,
}

/// The answer to [`collect`](crate::Deliverd::collect), flattened.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectedAnswers {
    /// True when enough people replied; false if it expired or was withdrawn.
    pub complete: bool,
    /// Never `Pending`.
    pub status: CollectionStatus,
    /// Every submitted reply, in the order they arrived.
    pub responses: Vec<CollectionReply>,
    /// The first submitted answer to each question, by its prompt.
    pub answers: BTreeMap<String, AnswerValue>,
    pub id: String,
    pub url: String,
    pub collection: CollectionData,
}

/* ── Reports ───────────────────────────────────────────────────────────── */

/// A file published beside the page.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InlineFile {
    pub path: String,
    pub content: String,
    /// `base64` for an image or a font; text otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

/// Publish HTML to a secure URL.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Names, teams, groups or emails, resolved server-side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub living: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_summary: Option<String>,
    /// Publish only if this is still the current version; 0 claims a new slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    /// The HTML.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<InlineFile>,
}

impl PublishRequest {
    pub fn new(title: impl Into<String>, content: impl Into<String>) -> Self {
        Self { title: Some(title.into()), content: Some(content.into()), ..Default::default() }
    }
    pub fn slug(mut self, value: impl Into<String>) -> Self {
        self.slug = Some(value.into());
        self
    }
    pub fn description(mut self, value: impl Into<String>) -> Self {
        self.description = Some(value.into());
        self
    }
    pub fn workspace_id(mut self, value: impl Into<String>) -> Self {
        self.workspace_id = Some(value.into());
        self
    }
    pub fn audience(mut self, value: Value) -> Self {
        self.audience = Some(value);
        self
    }
    pub fn change_summary(mut self, value: impl Into<String>) -> Self {
        self.change_summary = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    pub fn task_id(mut self, value: impl Into<String>) -> Self {
        self.task_id = Some(value.into());
        self
    }
    pub fn file(mut self, value: InlineFile) -> Self {
        self.files.push(value);
        self
    }
}

/// A published report.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportData {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub url: String,
    pub status: String,
    pub current_version: Option<u32>,
    pub task_id: Option<String>,
}

/// What a publish answered. Check `status`: a publishing policy can hold the
/// version for a person's approval, in which case nothing is live yet.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PublishResult {
    /// `published`, `updated` or `pending_approval`.
    pub status: Option<String>,
    pub report: ReportData,
    pub version: Option<Value>,
    pub approval: Option<Value>,
    pub warnings: Vec<String>,
}

/* ── Flows ─────────────────────────────────────────────────────────────── */

string_enum!(
    /// Where a flow stands. The app calls a flow a project.
    FlowStatus {
        Open = "open",
        Complete = "complete",
        Cancelled = "cancelled",
    }
);

/// One approval, review, request for information or report in a flow.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowMember {
    /// `approval`, `review`, `collection` or `report`.
    pub kind: String,
    pub id: String,
    pub title: String,
    /// The member's own status word, which differs by kind.
    pub status: String,
    /// Still waiting on somebody. Always false for a report.
    pub open: bool,
    pub created_at: String,
}

/// One step of a flow's timeline.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowEvent {
    pub event: String,
    pub actor: String,
    pub actor_type: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub at: String,
}

/// A flow, as the API returns it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowData {
    pub id: String,
    pub status: FlowStatus,
    /// The timeline page a person can open.
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub external_id: Option<String>,
    pub metadata: Object,
    pub started_by: String,
    pub members: Vec<FlowMember>,
    pub member_count: u32,
    pub open_count: u32,
    /// Nothing outstanding right now — not a claim that the job is finished.
    pub all_settled: bool,
    /// On a single read; empty from a list.
    pub timeline: Vec<FlowEvent>,
    pub parent_flow_id: Option<String>,
    pub settled_at: Option<String>,
    pub created_at: String,
}

/// A flow to start.
///
/// ```
/// use deliverd::FlowRequest;
///
/// let request = FlowRequest::new("Release 4.2").external_id("release-4.2");
/// ```
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRequest {
    /// What this piece of work is, as the timeline will be titled.
    pub title: String,
    /// What it is for, for whoever reads the history a year from now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Your own reference. Pass it and use [`resume`](crate::Flows::resume) so a
    /// restart does not start a second flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Object>,
    /// The flow this work was delegated from: an orchestrator's run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_flow_id: Option<String>,
}

impl FlowRequest {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), ..Self::default() }
    }
    pub fn description(mut self, value: impl Into<String>) -> Self {
        self.description = Some(value.into());
        self
    }
    pub fn workspace_id(mut self, value: impl Into<String>) -> Self {
        self.workspace_id = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
    pub fn metadata(mut self, value: Object) -> Self {
        self.metadata = Some(value);
        self
    }
    pub fn parent_flow_id(mut self, value: impl Into<String>) -> Self {
        self.parent_flow_id = Some(value.into());
        self
    }
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

string_enum!(
    /// What a task is: the objective, or a side task branched from it.
    TaskKind {
        Objective = "objective",
        SideTask = "side_task",
        Investigation = "investigation",
        Research = "research",
        Debug = "debug",
        Decision = "decision",
    }
);

string_enum!(
    /// Where a task stands. `update` may set the first four; completing and
    /// cancelling have their own calls.
    TaskStatus {
        Open = "open",
        InProgress = "in_progress",
        Blocked = "blocked",
        AwaitingApproval = "awaiting_approval",
        Completed = "completed",
        Cancelled = "cancelled",
    }
);

/// The short working state of a task: where it stands, what is open, what is
/// in the way, what comes next.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskState {
    pub current_state: Option<String>,
    pub open_questions: Vec<String>,
    pub constraints: Vec<String>,
    pub blocked_by: Vec<String>,
    pub next_action: Option<String>,
}

/// A change to a task's working state. Only what you set is sent; `Some(None)`
/// clears a field that can be cleared.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_state: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_questions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub add_open_questions: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resolve_open_questions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<Option<String>>,
}

impl TaskStatePatch {
    pub fn current_state(mut self, value: impl Into<String>) -> Self {
        self.current_state = Some(Some(value.into()));
        self
    }
    pub fn next_action(mut self, value: impl Into<String>) -> Self {
        self.next_action = Some(Some(value.into()));
        self
    }
    pub fn add_open_question(mut self, value: impl Into<String>) -> Self {
        self.add_open_questions.push(value.into());
        self
    }
    pub fn resolve_open_question(mut self, value: impl Into<String>) -> Self {
        self.resolve_open_questions.push(value.into());
        self
    }
}

/// Something a finished task found.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskResultFinding {
    pub title: String,
    pub description: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
}

/// A decision a finished task proposes. It reaches the parent as a suggestion.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskResultDecision {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

/// What a task came back with.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskResult {
    pub summary: String,
    pub findings: Vec<TaskResultFinding>,
    pub decisions: Vec<TaskResultDecision>,
    pub recommendations: Vec<String>,
    pub unresolved_questions: Vec<String>,
    pub parent_impact: Option<String>,
    pub suggested_next_action: Option<String>,
}

/// A task, as the API returns it. What these fields do not name — a side
/// task's snapshot, a single read's path, children and findings — is on the
/// handle's `raw()`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskData {
    pub id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    /// The page a person can open.
    pub url: String,
    pub title: String,
    /// What the work is for: the objective's purpose, or a side task's goal.
    pub objective: String,
    pub root_task_id: String,
    /// `None` on the objective itself.
    pub parent_task_id: Option<String>,
    pub depth: u32,
    pub workspace_id: Option<String>,
    pub flow_id: Option<String>,
    pub state: TaskState,
    /// Once completed: what it came back with.
    pub result: Option<TaskResult>,
    /// Earlier results, kept when a completed task is reopened.
    pub previous_results: Vec<TaskResult>,
    /// `applied`, `kept` or `discarded`, once a side task's result is used.
    pub outcome: Option<String>,
    pub external_id: Option<String>,
    pub session_url: Option<String>,
    /// Pass it back as `expected_version` to refuse an update somebody else got in before.
    pub version: u64,
    pub started_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// True when `create` returned an open objective you had already started
    /// under the same `external_id`.
    pub resumed: bool,
}

/// An objective to start.
///
/// ```
/// use deliverd::{TaskRequest, TaskStatePatch};
///
/// let request = TaskRequest::new("SSO rollout", "Every customer on SAML by March")
///     .external_id("objective:sso")
///     .state(TaskStatePatch::default().next_action("List the customers still on passwords"));
/// ```
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    /// A short name for the objective.
    pub title: String,
    /// What the work is ultimately for. Returned at the top of every context.
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The flow its approvals and reviews belong to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    /// Your own reference. An open objective you started under it is returned
    /// instead of a new one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    /// A link to the conversation where the work happens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_url: Option<String>,
    /// The starting state, if anything is already known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskStatePatch>,
}

impl TaskRequest {
    pub fn new(title: impl Into<String>, objective: impl Into<String>) -> Self {
        Self { title: title.into(), objective: objective.into(), ..Self::default() }
    }
    pub fn workspace_id(mut self, value: impl Into<String>) -> Self {
        self.workspace_id = Some(value.into());
        self
    }
    pub fn flow_id(mut self, value: impl Into<String>) -> Self {
        self.flow_id = Some(value.into());
        self
    }
    pub fn external_id(mut self, value: impl Into<String>) -> Self {
        self.external_id = Some(value.into());
        self
    }
    pub fn session_url(mut self, value: impl Into<String>) -> Self {
        self.session_url = Some(value.into());
        self
    }
    pub fn state(mut self, value: TaskStatePatch) -> Self {
        self.state = Some(value);
        self
    }
}

/// A change to a task. Only what you set is sent.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Refused to an agent: only a person changes what the work is for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// Open, in progress, blocked or awaiting approval. Use `complete` and
    /// `cancel` for the other two.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TaskStatePatch>,
    /// The version you read; the update is refused if somebody wrote in between.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u64>,
}

impl TaskUpdate {
    pub fn title(mut self, value: impl Into<String>) -> Self {
        self.title = Some(value.into());
        self
    }
    pub fn status(mut self, value: TaskStatus) -> Self {
        self.status = Some(value);
        self
    }
    pub fn state(mut self, value: TaskStatePatch) -> Self {
        self.state = Some(value);
        self
    }
    pub fn expected_version(mut self, value: u64) -> Self {
        self.expected_version = Some(value);
        self
    }
}

/// How a task finished.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletion {
    /// What was found, in a few sentences.
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<TaskResultFinding>,
    /// Decisions you propose. They reach the parent as suggestions.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<TaskResultDecision>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recommendations: Vec<String>,
    /// Added to the parent's open questions when applied.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unresolved_questions: Vec<String>,
    /// What this means for the main task.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_impact: Option<String>,
    /// Becomes the parent's next action when applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_next_action: Option<String>,
}

impl TaskCompletion {
    pub fn new(summary: impl Into<String>) -> Self {
        Self { summary: summary.into(), ..Self::default() }
    }
    pub fn finding(mut self, title: impl Into<String>, description: impl Into<String>) -> Self {
        self.findings.push(TaskResultFinding {
            title: title.into(),
            description: description.into(),
            evidence: vec![],
        });
        self
    }
    pub fn decision(mut self, title: impl Into<String>) -> Self {
        self.decisions.push(TaskResultDecision { title: title.into(), rationale: None });
        self
    }
    pub fn recommendation(mut self, value: impl Into<String>) -> Self {
        self.recommendations.push(value.into());
        self
    }
    pub fn suggested_next_action(mut self, value: impl Into<String>) -> Self {
        self.suggested_next_action = Some(value.into());
        self
    }
}

/* ── Webhooks ──────────────────────────────────────────────────────────── */

/// What an organisation webhook endpoint receives.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookEvent {
    /// `approval.approved`, `report.published`, `gate.denied`, …
    pub event: String,
    pub sent_at: String,
    /// True when sent by the Send test button, not by real activity.
    pub test: bool,
    pub data: Object,
}

/// What arrives at a request's `callback_url` when a person answers.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CallbackEnvelope {
    pub event: String,
    pub sent_at: String,
    /// `approval`, `review`, `collection` or `gate`.
    pub request_type: String,
    pub request_id: String,
    pub data: Object,
}
