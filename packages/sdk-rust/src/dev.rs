//! Development mode: the whole loop, on your machine, with nobody in it.
//!
//! No key, no network, no colleague to interrupt — and the things that can
//! happen to a real request all reachable before you have an account:
//! approved, rejected, refused by policy, nobody answered, and somebody asked
//! you a question.
//!
//! Implemented as a [`Transport`] rather than a branch inside the client, so
//! development mode runs the *same* code as production — the same retries,
//! the same error mapping, the same polling. It serves the routes the
//! primitives use and answers everything else with a 501 saying so, rather
//! than pretending to be the whole API and returning something plausible.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Map, Value};

use crate::duration::iso_utc;
use crate::http::{BoxFuture, Transport, TransportError, TransportRequest, TransportResponse};

/// What the imaginary approver does.
///
/// Four for the primitives that ask a person, and a fifth for the gate:
/// `Denied` is a **policy** refusal, which nothing else can have — an approval
/// cannot be refused without somebody refusing it. On anything but a gate it
/// reads as `Rejected`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DevelopmentOutcome {
    #[default]
    Approved,
    Rejected,
    Denied,
    /// Nobody answers, so a wait times out.
    Timeout,
    /// The approver asks a question and approves once it is answered.
    Question,
}

impl DevelopmentOutcome {
    /// `"approved"`, `"rejected"`, `"denied"`, `"timeout"` or `"question"`,
    /// as `DELIVERD_DEV_OUTCOME` takes them.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "approved" => Some(Self::Approved),
            "rejected" => Some(Self::Rejected),
            "denied" => Some(Self::Denied),
            "timeout" => Some(Self::Timeout),
            "question" => Some(Self::Question),
            _ => None,
        }
    }
}

/// How development mode behaves. Every field has a default.
#[derive(Debug, Clone)]
pub struct DevelopmentOptions {
    /// What the imaginary approver does. Defaults to `DELIVERD_DEV_OUTCOME`,
    /// then to approved, so a whole test suite can be flipped from the
    /// command line.
    pub outcome: Option<DevelopmentOutcome>,
    /// How long they take to do it.
    pub delay: Duration,
    /// What they say.
    pub note: Option<String>,
    /// Corrections they make when approving a request that sent an `input`.
    /// Only fields named in `editable_fields` are applied, as in production.
    pub edits: Map<String, Value>,
    /// What they ask, when the outcome is `Question`.
    pub question: Option<String>,
    /// Print what the approver would have seen, to stderr. Default true.
    pub log: bool,
}

impl Default for DevelopmentOptions {
    fn default() -> Self {
        Self { outcome: None, delay: Duration::ZERO, note: None, edits: Map::new(), question: None, log: true }
    }
}

impl DevelopmentOptions {
    pub fn outcome(mut self, value: DevelopmentOutcome) -> Self {
        self.outcome = Some(value);
        self
    }
    pub fn delay(mut self, value: Duration) -> Self {
        self.delay = value;
        self
    }
    pub fn note(mut self, value: impl Into<String>) -> Self {
        self.note = Some(value.into());
        self
    }
    pub fn edit(mut self, field: impl Into<String>, value: Value) -> Self {
        self.edits.insert(field.into(), value);
        self
    }
    pub fn question(mut self, value: impl Into<String>) -> Self {
        self.question = Some(value.into());
        self
    }
    pub fn quiet(mut self) -> Self {
        self.log = false;
        self
    }
}

const DEFAULT_QUESTION: &str = "Has this been through staging?";
const DEV_APPROVER_ID: &str = "00000000-0000-0000-0000-00000000dev0";

struct Stored {
    data: Value,
    outcome: DevelopmentOutcome,
    decide_at: Instant,
}

#[derive(Default)]
struct State {
    approvals: Vec<(String, Stored)>,
    gates: Vec<(String, Stored)>,
    reviews: Vec<(String, Stored)>,
    collections: Vec<(String, Stored)>,
    flows: Vec<(String, Value)>,
    tasks: Vec<(String, Value)>,
}

fn find<'a>(list: &'a mut [(String, Stored)], id: &str) -> Option<&'a mut Stored> {
    list.iter_mut().find(|(key, _)| key == id).map(|(_, stored)| stored)
}

/// The development transport. [`Deliverd::development`](crate::Deliverd::development)
/// installs one; you rarely need it by name.
pub struct DevelopmentTransport {
    options: DevelopmentOptions,
    state: Mutex<State>,
    counter: AtomicU64,
}

impl DevelopmentTransport {
    pub fn new(options: DevelopmentOptions) -> Arc<Self> {
        Arc::new(Self { options, state: Mutex::new(State::default()), counter: AtomicU64::new(0) })
    }

    fn next(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn outcome(&self) -> DevelopmentOutcome {
        self.options
            .outcome
            .or_else(|| std::env::var("DELIVERD_DEV_OUTCOME").ok().and_then(|v| DevelopmentOutcome::parse(&v)))
            .unwrap_or_default()
    }

    fn handle(&self, method: &str, path: &str, query: &HashMap<String, String>, body: Value) -> (u16, Value) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let str_of = |key: &str| body.get(key).cloned().unwrap_or(Value::Null);

        match (method, segments.as_slice()) {
            ("POST", ["approvals"]) => {
                let n = self.next();
                let id = format!("apr_dev_{n}");
                let outcome = self.outcome();
                let questions = if outcome == DevelopmentOutcome::Question {
                    json!([{
                        "id": format!("q_dev_{n}"),
                        "question": self.options.question.clone().unwrap_or_else(|| DEFAULT_QUESTION.into()),
                        "answer": null,
                        "askedAt": now(),
                        "answeredAt": null,
                    }])
                } else {
                    json!([])
                };
                let data = json!({
                    "id": id,
                    "status": "pending",
                    "url": format!("https://deliverd.dev/approve/{id}"),
                    "title": body.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
                    "description": str_of("description"),
                    "risk": body.get("risk").cloned().unwrap_or(json!("medium")),
                    "factors": body.get("factors").cloned().unwrap_or(json!([])),
                    "links": body.get("links").cloned().unwrap_or(json!([])),
                    "reportId": str_of("reportId"),
                    "externalId": str_of("externalId"),
                    "metadata": body.get("metadata").cloned().unwrap_or(json!({})),
                    "input": str_of("input"),
                    "editableFields": body.get("editableFields").cloned().unwrap_or(json!([])),
                    "approvedInput": null,
                    "changes": [],
                    "concerns": [],
                    "requestedBy": "You (development mode)",
                    "approvers": body.get("approvers").cloned().unwrap_or(json!([])),
                    // One, always: development mode has no rules that could
                    // escalate it, and an imaginary approver is one person.
                    "requiredApprovals": 1,
                    "approvalsSoFar": 0,
                    "decidedBy": null,
                    "decidedById": null,
                    "decidedAt": null,
                    "note": null,
                    "expiresAt": str_of("expiresAt"),
                    "questions": questions,
                    "createdAt": now(),
                });
                if self.options.log {
                    announce(&data, outcome);
                }
                state.approvals.push((id, Stored { data: data.clone(), outcome, decide_at: self.decide_at() }));
                (201, data)
            }
            ("GET", ["approvals"]) => {
                for (_, stored) in state.approvals.iter_mut() {
                    self.settle_approval(stored);
                }
                let approver = query.get("approver").map(|a| a.to_lowercase());
                let all: Vec<Value> = state
                    .approvals
                    .iter()
                    .map(|(_, s)| s.data.clone())
                    .filter(|a| query.get("externalId").is_none_or(|x| a["externalId"] == json!(x)))
                    .filter(|a| query.get("status").is_none_or(|x| a["status"] == json!(x)))
                    .filter(|a| {
                        approver.as_ref().is_none_or(|who| {
                            a["approvers"].as_array().is_some_and(|list| {
                                list.iter().any(|v| v.as_str().is_some_and(|v| v.to_lowercase() == *who))
                            })
                        })
                    })
                    .collect();
                (200, json!({ "approvals": all, "nextCursor": null }))
            }
            (_, ["approvals", id, rest @ ..]) => {
                let Some(stored) = find(&mut state.approvals, id) else {
                    return not_found("approval");
                };
                match (method, rest) {
                    ("GET", []) => {
                        self.settle_approval(stored);
                        (200, stored.data.clone())
                    }
                    ("POST", ["answers"]) => {
                        let question_id = body.get("questionId").cloned().unwrap_or(Value::Null);
                        let answer = body.get("answer").and_then(Value::as_str).unwrap_or_default().to_owned();
                        let Some(question) = stored.data["questions"]
                            .as_array_mut()
                            .and_then(|qs| qs.iter_mut().find(|q| q["id"] == question_id))
                        else {
                            return (404, error("question_not_found", "No such question."));
                        };
                        question["answer"] = json!(answer);
                        question["answeredAt"] = json!(now());
                        // Answered: the imaginary approver is satisfied.
                        stored.outcome = DevelopmentOutcome::Approved;
                        stored.decide_at = self.decide_at();
                        if self.options.log {
                            eprintln!("  ↳ answered: {answer}\n");
                        }
                        (200, stored.data.clone())
                    }
                    ("POST", ["cancel"]) => {
                        stored.data["status"] = json!("cancelled");
                        (200, stored.data.clone())
                    }
                    _ => not_simulated(method, path),
                }
            }

            ("POST", ["gates"]) => {
                let external_id = body.get("externalId").and_then(Value::as_str).unwrap_or_default().to_owned();
                // Server-side reuse, which the real endpoint enforces in its
                // database: the one thing `gate()` promises over `approve()`
                // is that a retry re-reads its decision.
                if let Some((_, stored)) =
                    state.gates.iter_mut().find(|(_, s)| s.data["__externalId"] == json!(external_id))
                {
                    settle_gate(stored);
                    let mut data = public(&stored.data);
                    data["reused"] = json!(true);
                    return (200, data);
                }
                let id = format!("gat_dev_{}", self.next());
                let outcome = self.outcome();
                // `Denied` is settled by a rule and reaches nobody; everything
                // else goes through a person, which is where `wait()` earns
                // its place.
                let by_rule = outcome == DevelopmentOutcome::Denied;
                let data = json!({
                    "id": id,
                    "status": if by_rule { "denied" } else { "pending" },
                    "allowed": false,
                    "input": body.get("input").cloned().unwrap_or(json!({})),
                    "changes": [],
                    "concerns": [],
                    "basis": if by_rule { "policy" } else { "human" },
                    "reason": if by_rule {
                        "Development mode refused it. A real rule would say which one and why."
                    } else {
                        "No rule covers this action yet, so it needs a person."
                    },
                    "rule": if by_rule { json!("Development mode") } else { Value::Null },
                    "policyVersionId": null,
                    "approvalId": if by_rule { Value::Null } else { json!(format!("apr_dev_{id}")) },
                    "approvalUrl": if by_rule { Value::Null } else { json!(format!("https://deliverd.dev/approve/apr_dev_{id}")) },
                    "outcome": null,
                    "settledAt": null,
                    "reused": false,
                    "decision": if by_rule { "DENY" } else { "APPROVAL_REQUIRED" },
                    "canExecute": false,
                    "blockedBecause": if by_rule { "Policy does not allow this action." } else { "Waiting for a person to decide." },
                    "scope": {
                        "destination": str_of("destination"),
                        "recipientScope": if body.get("destination").is_some() { json!("external") } else { Value::Null },
                        "classification": str_of("classification"),
                        "risk": str_of("risk"),
                        "artifact": str_of("artifact"),
                        "digest": null,
                    },
                    "authorisation": { "validUntil": null, "maxUses": 1, "usesRemaining": 1 },
                    "actionId": body.get("actionId").and_then(Value::as_str).unwrap_or_default(),
                    "agentId": null,
                    "flowId": str_of("flowId"),
                    "supersedesGateId": str_of("supersedesGateId"),
                    "description": body.get("description").or_else(|| body.get("reason")).cloned().unwrap_or(Value::Null),
                    "requestedBy": "Development agent",
                    "createdAt": now(),
                    "__externalId": external_id,
                });
                let public_data = public(&data);
                state.gates.push((id, Stored { data, outcome, decide_at: self.decide_at() }));
                (201, public_data)
            }
            (_, ["gates", id, rest @ ..]) => {
                let Some(stored) = find(&mut state.gates, id) else {
                    return not_found("gate");
                };
                settle_gate(stored);
                let gate = &mut stored.data;
                match (method, rest) {
                    ("GET", []) => (200, public(gate)),
                    ("POST", ["cancel"]) => {
                        gate["status"] = json!("cancelled");
                        gate["canExecute"] = json!(false);
                        gate["blockedBecause"] = json!("This request was withdrawn.");
                        (200, public(gate))
                    }
                    ("POST", ["execution"]) => {
                        if gate["canExecute"] != json!(true) {
                            let used = gate["status"] == json!("used");
                            let message = gate["blockedBecause"].as_str().unwrap_or("Not authorised.").to_owned();
                            return if used {
                                (409, error("gate_used", &message))
                            } else {
                                (403, error("not_authorised", &message))
                            };
                        }
                        gate["status"] = json!("used");
                        gate["canExecute"] = json!(false);
                        gate["blockedBecause"] =
                            json!("This permission has been used. A further action needs a new request.");
                        gate["authorisation"]["usesRemaining"] = json!(0);
                        let receipt = json!({
                            "id": format!("exe_dev_{}", self.next()),
                            "gateId": gate["id"],
                            "phase": body.get("phase").cloned().unwrap_or(json!("completed")),
                            "claimId": null,
                            "executedAt": now(),
                            "artifactSha256": str_of("artifactSha256"),
                            "destination": str_of("destination"),
                            "result": body.get("result").cloned().unwrap_or(json!({})),
                            "verification": "reported",
                            "detail": str_of("detail"),
                            "reportedBy": "Development agent",
                            "createdAt": now(),
                        });
                        (201, json!({ "receipt": receipt, "gate": public(gate) }))
                    }
                    _ => not_simulated(method, path),
                }
            }

            ("POST", ["reviews"]) => {
                let id = format!("rev_dev_{}", self.next());
                let outcome = self.outcome();
                // A rejection of a piece of work is "changes requested"; there
                // is nothing to ask about on a review, so a question approves.
                let changes = matches!(outcome, DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied);
                let reviewers: Vec<Value> = body
                    .get("reviewers")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .enumerate()
                            .map(|(i, who)| json!({ "kind": "user", "id": format!("usr_dev_{}", i + 1), "label": who }))
                            .collect()
                    })
                    .unwrap_or_default();
                let data = json!({
                    "id": id,
                    "status": "pending",
                    "url": format!("https://deliverd.dev/reviews/{id}"),
                    "title": body.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
                    "instructions": str_of("instructions"),
                    "reportId": str_of("reportId"),
                    "versionId": str_of("versionId"),
                    "externalId": str_of("externalId"),
                    "metadata": body.get("metadata").cloned().unwrap_or(json!({})),
                    "requestedBy": "You (development mode)",
                    "requiredApprovals": body.get("requiredApprovals").cloned().unwrap_or(json!(1)),
                    "reviewers": reviewers,
                    "verdicts": [],
                    // A review that asks for changes has something to read.
                    "threadCount": if changes { 2 } else { 0 },
                    "settledAt": null,
                    "expiresAt": str_of("expiresAt"),
                    "createdAt": now(),
                });
                if self.options.log {
                    announce_review(&data, outcome);
                }
                state.reviews.push((id, Stored { data: data.clone(), outcome, decide_at: self.decide_at() }));
                (201, data)
            }
            ("GET", ["reviews"]) => {
                let all: Vec<Value> = state
                    .reviews
                    .iter()
                    .map(|(_, s)| s.data.clone())
                    .filter(|r| query.get("externalId").is_none_or(|x| r["externalId"] == json!(x)))
                    .collect();
                (200, json!({ "reviews": all, "nextCursor": null }))
            }
            (_, ["reviews", id, rest @ ..]) => {
                let Some(stored) = find(&mut state.reviews, id) else {
                    return not_found("review");
                };
                match (method, rest) {
                    ("GET", []) => {
                        settle_review(stored);
                        (200, stored.data.clone())
                    }
                    ("POST", ["cancel"]) => {
                        stored.data["status"] = json!("cancelled");
                        (200, stored.data.clone())
                    }
                    _ => not_simulated(method, path),
                }
            }

            ("POST", ["collections"]) => {
                let id = format!("col_dev_{}", self.next());
                let outcome = self.outcome();
                let asked: Vec<Value> = body.get("respondents").and_then(Value::as_array).cloned().unwrap_or_default();
                let questions: Vec<Value> = body
                    .get("questions")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .enumerate()
                            .map(|(i, q)| {
                                json!({
                                    "id": format!("q_dev_{}", i + 1),
                                    "prompt": q.get("prompt").and_then(Value::as_str).unwrap_or("Question"),
                                    "help": q.get("help").cloned().unwrap_or(Value::Null),
                                    "kind": q.get("kind").cloned().unwrap_or(json!("text")),
                                    "required": q.get("required") != Some(&json!(false)),
                                    "options": q.get("options").cloned().unwrap_or(json!([])),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let data = json!({
                    "id": id,
                    "status": "pending",
                    "url": format!("https://deliverd.dev/collect/{id}"),
                    "title": body.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
                    "instructions": str_of("instructions"),
                    "reportId": str_of("reportId"),
                    "externalId": str_of("externalId"),
                    "metadata": body.get("metadata").cloned().unwrap_or(json!({})),
                    "requestedBy": "You (development mode)",
                    "requiredResponses": body.get("requiredResponses").cloned().unwrap_or(json!(asked.len().max(1))),
                    "questions": questions,
                    "responses": asked.iter().map(|who| json!({
                        "respondent": who, "status": "pending", "submittedAt": null, "answers": [],
                    })).collect::<Vec<_>>(),
                    "submittedCount": 0,
                    "askedCount": asked.len(),
                    "settledAt": null,
                    "dueAt": str_of("dueAt"),
                    "expiresAt": str_of("expiresAt"),
                    "createdAt": now(),
                });
                if self.options.log {
                    announce_collection(&data, outcome);
                }
                state.collections.push((id, Stored { data: data.clone(), outcome, decide_at: self.decide_at() }));
                (201, data)
            }
            ("GET", ["collections"]) => {
                let all: Vec<Value> = state
                    .collections
                    .iter()
                    .map(|(_, s)| s.data.clone())
                    .filter(|c| query.get("externalId").is_none_or(|x| c["externalId"] == json!(x)))
                    .collect();
                (200, json!({ "collections": all, "nextCursor": null }))
            }
            (_, ["collections", id, rest @ ..]) => {
                let Some(stored) = find(&mut state.collections, id) else {
                    return not_found("request");
                };
                match (method, rest) {
                    ("GET", []) => {
                        settle_collection(stored);
                        (200, stored.data.clone())
                    }
                    ("POST", ["cancel"]) => {
                        stored.data["status"] = json!("cancelled");
                        (200, stored.data.clone())
                    }
                    _ => not_simulated(method, path),
                }
            }

            /*
             * Flows and tasks in development: real objects with no simulation
             * attached. Nobody decides anything about either, so there is
             * nothing to fake, and a restartable agent's find-or-start works
             * here exactly as it will against the API.
             */
            ("POST", ["flows"]) => {
                let id = format!("flw_dev_{}", self.next());
                let data = json!({
                    "id": id,
                    "status": "open",
                    "url": format!("https://deliverd.dev/flows/{id}"),
                    "title": body.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
                    "description": str_of("description"),
                    "externalId": str_of("externalId"),
                    "metadata": body.get("metadata").cloned().unwrap_or(json!({})),
                    "startedBy": "You (development mode)",
                    // The store holds no members: a development flow reports
                    // what it knows rather than invent a membership.
                    "members": [],
                    "memberCount": 0,
                    "openCount": 0,
                    "allSettled": false,
                    "timeline": [],
                    "parentFlowId": str_of("parentFlowId"),
                    "settledAt": null,
                    "createdAt": now(),
                });
                if self.options.log {
                    eprintln!(
                        "\n  ▸ Flow started: {}\n    {}\n",
                        data["title"].as_str().unwrap_or_default(),
                        data["url"].as_str().unwrap_or_default()
                    );
                }
                state.flows.push((id, data.clone()));
                (201, data)
            }
            ("GET", ["flows"]) => {
                // Newest first, as the API lists them.
                let all: Vec<Value> = state
                    .flows
                    .iter()
                    .rev()
                    .map(|(_, f)| f.clone())
                    .filter(|f| query.get("externalId").is_none_or(|x| f["externalId"] == json!(x)))
                    .filter(|f| query.get("status").is_none_or(|x| f["status"] == json!(x)))
                    .take(query.get("limit").and_then(|l| l.parse().ok()).unwrap_or(usize::MAX))
                    .collect();
                (200, json!({ "flows": all, "nextCursor": null }))
            }
            (_, ["flows", id, rest @ ..]) => {
                let Some((_, flow)) = state.flows.iter_mut().find(|(key, _)| key == id) else {
                    return not_found("flow");
                };
                match (method, rest) {
                    ("GET", []) => (200, flow.clone()),
                    ("POST", [end @ ("complete" | "cancel")]) => {
                        if flow["status"] != json!("open") {
                            let message =
                                format!("This flow is already {}.", flow["status"].as_str().unwrap_or("closed"));
                            return (409, error("not_open", &message));
                        }
                        flow["status"] = json!(if *end == "complete" { "complete" } else { "cancelled" });
                        flow["settledAt"] = json!(now());
                        (200, flow.clone())
                    }
                    _ => not_simulated(method, path),
                }
            }

            ("POST", ["tasks"]) => {
                // An open objective already started under this reference
                // comes back instead of a second one, as the API does.
                if let Some(external_id) = body.get("externalId").and_then(Value::as_str) {
                    if let Some((_, existing)) =
                        state.tasks.iter().find(|(_, t)| t["externalId"] == json!(external_id) && task_active(t))
                    {
                        let mut data = existing.clone();
                        data["resumed"] = json!(true);
                        return (200, data);
                    }
                }
                let id = format!("tsk_dev_{}", self.next());
                let mut task_state = json!({ "currentState": null, "openQuestions": [], "constraints": [], "blockedBy": [], "nextAction": null });
                merge_task_state(&mut task_state, body.get("state"));
                let data = json!({
                    "id": id,
                    "kind": "objective",
                    "status": "open",
                    "url": format!("https://deliverd.dev/tasks/{id}"),
                    "title": body.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
                    "objective": body.get("objective").and_then(Value::as_str).unwrap_or_default(),
                    "rootTaskId": id,
                    "parentTaskId": null,
                    "depth": 0,
                    "workspaceId": str_of("workspaceId"),
                    "flowId": str_of("flowId"),
                    "state": task_state,
                    "snapshot": null,
                    "result": null,
                    "previousResults": [],
                    "outcome": null,
                    "origin": "manual",
                    "externalId": str_of("externalId"),
                    "sessionUrl": str_of("sessionUrl"),
                    "version": 1,
                    "startedBy": "You (development mode)",
                    "createdAt": now(),
                    "updatedAt": now(),
                    "completedAt": null,
                    "resumed": false,
                });
                if self.options.log {
                    eprintln!(
                        "\n  ▸ Objective: {}\n    {}\n",
                        data["title"].as_str().unwrap_or_default(),
                        data["url"].as_str().unwrap_or_default()
                    );
                }
                state.tasks.push((id, data.clone()));
                (201, data)
            }
            ("GET", ["tasks"]) => {
                let q = query.get("q").map(|q| q.to_lowercase());
                let all: Vec<Value> = state
                    .tasks
                    .iter()
                    .rev()
                    .map(|(_, t)| t.clone())
                    .filter(|t| query.get("externalId").is_none_or(|x| t["externalId"] == json!(x)))
                    .filter(|t| {
                        query.get("status").is_none_or(|x| {
                            if x == "active" {
                                task_active(t)
                            } else {
                                t["status"] == json!(x)
                            }
                        })
                    })
                    .filter(|t| {
                        q.as_ref().is_none_or(|q| {
                            let text = format!(
                                "{} {}",
                                t["title"].as_str().unwrap_or_default(),
                                t["objective"].as_str().unwrap_or_default()
                            );
                            text.to_lowercase().contains(q)
                        })
                    })
                    .take(query.get("limit").and_then(|l| l.parse().ok()).unwrap_or(usize::MAX))
                    .collect();
                (200, json!({ "tasks": all, "nextCursor": null }))
            }
            (_, ["tasks", id, rest @ ..]) => {
                let Some((_, task)) = state.tasks.iter_mut().find(|(key, _)| key == id) else {
                    return not_found("task");
                };
                match (method, rest) {
                    ("GET", []) => (200, task.clone()),
                    ("GET", ["context"]) => (200, task_context(task)),
                    ("PATCH", []) => {
                        if let Some(expected) = body.get("expectedVersion").and_then(Value::as_u64) {
                            if Some(expected) != task["version"].as_u64() {
                                return (
                                    409,
                                    error(
                                        "version_conflict",
                                        "The task changed since you read it. Read it again and retry.",
                                    ),
                                );
                            }
                        }
                        for key in ["title", "objective", "status"] {
                            if let Some(value) = body.get(key).filter(|v| v.is_string()) {
                                task[key] = value.clone();
                            }
                        }
                        if let Some(value) = body.get("sessionUrl") {
                            task["sessionUrl"] = value.clone();
                        }
                        merge_task_state(&mut task["state"], body.get("state"));
                        bump_task(task);
                        (200, task.clone())
                    }
                    ("POST", ["complete"]) => {
                        if !task_active(task) {
                            return (409, error("not_active", "This task is already finished."));
                        }
                        let strings = |key: &str| body.get(key).cloned().unwrap_or(json!([]));
                        task["result"] = json!({
                            "summary": body.get("summary").and_then(Value::as_str).unwrap_or_default(),
                            "findings": strings("findings"),
                            "decisions": strings("decisions"),
                            "recommendations": strings("recommendations"),
                            "unresolvedQuestions": strings("unresolvedQuestions"),
                            "parentImpact": str_of("parentImpact"),
                            "suggestedNextAction": str_of("suggestedNextAction"),
                        });
                        task["status"] = json!("completed");
                        task["completedAt"] = json!(now());
                        bump_task(task);
                        (200, task.clone())
                    }
                    ("POST", ["reopen"]) => {
                        if task["status"] != json!("completed") {
                            return (409, error("not_completed", "Only a completed task can be reopened."));
                        }
                        let previous = task["result"].take();
                        if let Some(list) = task["previousResults"].as_array_mut() {
                            list.push(previous);
                        }
                        task["status"] = json!("open");
                        task["completedAt"] = Value::Null;
                        bump_task(task);
                        (200, task.clone())
                    }
                    ("POST", ["cancel"]) => {
                        if !task_active(task) {
                            return (409, error("not_active", "This task is already finished."));
                        }
                        task["status"] = json!("cancelled");
                        bump_task(task);
                        (200, task.clone())
                    }
                    _ => not_simulated(method, path),
                }
            }

            _ => not_simulated(method, path),
        }
    }

    fn decide_at(&self) -> Instant {
        Instant::now() + self.options.delay
    }

    /// Move a pending approval to its outcome once the approver has had time.
    fn settle_approval(&self, stored: &mut Stored) {
        let data = &mut stored.data;
        if data["status"] != json!("pending") || Instant::now() < stored.decide_at {
            return;
        }
        let unanswered = data["questions"].as_array().is_some_and(|qs| qs.iter().any(|q| q["answer"].is_null()));
        match stored.outcome {
            DevelopmentOutcome::Timeout => return,
            DevelopmentOutcome::Question if unanswered => return,
            _ => {}
        }
        let rejected = matches!(stored.outcome, DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied);
        data["status"] = json!(if rejected { "rejected" } else { "approved" });
        data["decidedBy"] = json!("Development approver");
        data["decidedById"] = json!(DEV_APPROVER_ID);
        data["decidedAt"] = json!(now());
        data["note"] = match (&self.options.note, rejected) {
            (Some(note), _) => json!(note),
            (None, true) => json!("Not yet — development mode says no."),
            (None, false) => Value::Null,
        };
        if !rejected {
            if let Some(proposed) = data["input"].as_object().cloned() {
                let editable: Vec<String> = data["editableFields"]
                    .as_array()
                    .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default();
                let mut approved = proposed.clone();
                let mut changes = Vec::new();
                for (field, to) in &self.options.edits {
                    if editable.contains(field) && proposed.get(field) != Some(to) {
                        changes.push(json!({ "field": field, "from": proposed.get(field).cloned().unwrap_or(Value::Null), "to": to }));
                        approved.insert(field.clone(), to.clone());
                    }
                }
                data["approvedInput"] = Value::Object(approved);
                data["changes"] = Value::Array(changes);
            }
        }
    }
}

/// A gate that went to a person, once that person has answered.
fn settle_gate(stored: &mut Stored) {
    let gate = &mut stored.data;
    if gate["status"] != json!("pending") || Instant::now() < stored.decide_at {
        return;
    }
    let approved = match stored.outcome {
        DevelopmentOutcome::Approved => true,
        DevelopmentOutcome::Rejected => false,
        _ => return,
    };
    gate["status"] = json!(if approved { "approved" } else { "rejected" });
    gate["allowed"] = json!(approved);
    gate["canExecute"] = json!(approved);
    gate["blockedBecause"] = if approved { Value::Null } else { json!("A person rejected this action.") };
    gate["outcome"] = gate["status"].clone();
    gate["settledAt"] = json!(now());
    gate["basis"] = json!("human");
    gate["reason"] =
        json!(if approved { "A development approver agreed to it." } else { "A development approver refused it." });
}

fn settle_review(stored: &mut Stored) {
    let data = &mut stored.data;
    if stored.outcome == DevelopmentOutcome::Timeout
        || data["status"] != json!("pending")
        || Instant::now() < stored.decide_at
    {
        return;
    }
    let changes = matches!(stored.outcome, DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied);
    let verdict = if changes { "changes_requested" } else { "approved" };
    let by = data["reviewers"][0]["label"].as_str().unwrap_or("A reviewer (development mode)").to_owned();
    data["verdicts"] = json!([{
        "verdict": verdict,
        "by": by,
        "note": if changes { json!("Simulated: the figures on page two do not tie back.") } else { Value::Null },
        "at": now(),
    }]);
    data["status"] = json!(verdict);
    data["settledAt"] = json!(now());
}

/// Everyone answers at once, with a plausible value for the kind of question:
/// plausible rather than empty, so a caller learns here that a number question
/// answers with a number.
fn settle_collection(stored: &mut Stored) {
    let data = &mut stored.data;
    if stored.outcome == DevelopmentOutcome::Timeout
        || data["status"] != json!("pending")
        || Instant::now() < stored.decide_at
    {
        return;
    }
    let at = now();
    // There is no way to say no to a question, only to leave it unanswered.
    if matches!(stored.outcome, DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied) {
        data["status"] = json!("expired");
        data["settledAt"] = json!(at);
        return;
    }
    let answers: Vec<Value> = data["questions"]
        .as_array()
        .map(|qs| {
            qs.iter()
                .map(|q| json!({ "question": q["prompt"], "kind": q["kind"], "value": sample_answer(q) }))
                .collect()
        })
        .unwrap_or_default();
    if let Some(responses) = data["responses"].as_array_mut() {
        for reply in responses.iter_mut() {
            reply["status"] = json!("submitted");
            reply["submittedAt"] = json!(at);
            reply["answers"] = json!(answers);
        }
    }
    data["submittedCount"] = json!(data["responses"].as_array().map_or(0, Vec::len));
    data["status"] = json!("complete");
    data["settledAt"] = json!(at);
}

fn sample_answer(question: &Value) -> Value {
    let options = question["options"].as_array().cloned().unwrap_or_default();
    match question["kind"].as_str().unwrap_or("text") {
        "number" => json!(42),
        "boolean" => json!(true),
        "date" => json!(now()[..10].to_owned()),
        "choice" => options.first().cloned().unwrap_or(json!("")),
        "multi_choice" => json!(options.into_iter().take(1).collect::<Vec<_>>()),
        "long_text" => json!("Simulated: a longer answer than a line."),
        _ => json!("Simulated answer"),
    }
}

/// The stored gate without the bookkeeping kept beside it.
fn public(gate: &Value) -> Value {
    let mut out = gate.clone();
    if let Value::Object(map) = &mut out {
        map.remove("__externalId");
    }
    out
}

/// Neither completed nor cancelled.
fn task_active(task: &Value) -> bool {
    task["status"] != json!("completed") && task["status"] != json!("cancelled")
}

fn bump_task(task: &mut Value) {
    task["version"] = json!(task["version"].as_u64().unwrap_or(0) + 1);
    task["updatedAt"] = json!(now());
}

/// A task's working state with a patch applied, as the API merges one:
/// whole lists replace, `addOpenQuestions` and `resolveOpenQuestions` edit.
fn merge_task_state(current: &mut Value, patch: Option<&Value>) {
    let Some(patch) = patch.and_then(Value::as_object) else {
        return;
    };
    for key in ["currentState", "nextAction", "openQuestions", "constraints", "blockedBy"] {
        if let Some(value) = patch.get(key) {
            current[key] = value.clone();
        }
    }
    let mut questions: Vec<Value> = current["openQuestions"].as_array().cloned().unwrap_or_default();
    for added in patch.get("addOpenQuestions").and_then(Value::as_array).into_iter().flatten() {
        if !questions.contains(added) {
            questions.push(added.clone());
        }
    }
    if let Some(resolved) = patch.get("resolveOpenQuestions").and_then(Value::as_array) {
        questions.retain(|q| !resolved.contains(q));
    }
    current["openQuestions"] = json!(questions);
}

/// The context of a development task: the objective first, as the API puts
/// it, and no more than this store knows.
fn task_context(task: &Value) -> Value {
    let state = &task["state"];
    json!({
        "rootObjective": task["objective"],
        "task": {
            "id": task["id"],
            "kind": task["kind"],
            "status": task["status"],
            "title": task["title"],
            "objective": task["objective"],
            "url": task["url"],
        },
        "path": [],
        "currentState": state["currentState"],
        "nextAction": state["nextAction"],
        "openQuestions": state["openQuestions"],
        "constraints": state["constraints"],
        "blockedBy": state["blockedBy"],
        "decisions": { "confirmed": [], "suggested": [] },
        "snapshot": null,
        "relevantFindings": [],
        "sideTasks": { "open": [], "awaitingApply": [], "applied": [] },
        "reports": [],
        "reanchor": format!(
            "The objective: {}. {}",
            task["objective"].as_str().unwrap_or_default(),
            state["nextAction"].as_str().map(|next| format!("Next: {next}")).unwrap_or_else(|| "No next action set.".into())
        ),
    })
}

fn now() -> String {
    iso_utc(SystemTime::now())
}

fn error(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

fn not_found(what: &str) -> (u16, Value) {
    (404, error("not_found", &format!("No such {what} in this development session.")))
}

fn not_simulated(method: &str, path: &str) -> (u16, Value) {
    (
        501,
        error(
            "not_in_development_mode",
            &format!(
                "Development mode simulates approvals, gates, reviews, requests for information, flows and tasks only, and something called {method} {path}. Use a real API key for the rest of the API."
            ),
        ),
    )
}

/// What the approver would have seen, in the terminal: the title and the
/// factors are copy somebody has to read on a phone at nine at night, and the
/// only way to know whether it reads well is to see it written out.
fn announce(data: &Value, outcome: DevelopmentOutcome) {
    let mut lines = vec![
        String::new(),
        "  ┌─ Deliverd · development mode ─────────────────────────".to_owned(),
        format!("  │ {}", data["title"].as_str().unwrap_or_default()),
    ];
    if let Some(description) = data["description"].as_str() {
        lines.push(format!("  │ {description}"));
    }
    lines.push(format!("  │ Risk: {}", data["risk"].as_str().unwrap_or("medium")));
    for factor in data["factors"].as_array().into_iter().flatten() {
        let mark = match factor["status"].as_str() {
            Some("ok") => "✓",
            Some("warning") => "⚠",
            _ => "·",
        };
        lines.push(format!("  │ {mark} {}", factor["label"].as_str().unwrap_or_default()));
    }
    let approvers: Vec<&str> = data["approvers"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !approvers.is_empty() {
        lines.push(format!("  │ To: {}", approvers.join(", ")));
    }
    let simulating = match outcome {
        DevelopmentOutcome::Approved => "approved",
        DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied => "rejected",
        DevelopmentOutcome::Timeout => "timeout",
        DevelopmentOutcome::Question => "question (needs an on_question handler)",
    };
    lines.push("  │".to_owned());
    lines.push(format!("  │ Simulating: {simulating}"));
    lines.push("  └───────────────────────────────────────────────────────".to_owned());
    eprintln!("{}\n", lines.join("\n"));
}

fn announce_review(data: &Value, outcome: DevelopmentOutcome) {
    let reviewers: Vec<&str> =
        data["reviewers"].as_array().into_iter().flatten().filter_map(|r| r["label"].as_str()).collect();
    let simulating = match outcome {
        DevelopmentOutcome::Timeout => "nobody reviews it",
        DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied => "changes requested",
        _ => "approved",
    };
    let mut lines = vec![
        "  ┌─ Deliverd · development mode ─────────────────────────".to_owned(),
        format!("  │ {}", data["title"].as_str().unwrap_or_default()),
    ];
    if let Some(instructions) = data["instructions"].as_str() {
        lines.push(format!("  │ Check: {instructions}"));
    }
    lines.push(format!(
        "  │ Reviewers: {}",
        if reviewers.is_empty() { "nobody named".to_owned() } else { reviewers.join(", ") }
    ));
    lines.push("  │".to_owned());
    lines.push(format!("  │ Simulating: {simulating}"));
    lines.push("  └───────────────────────────────────────────────────────".to_owned());
    eprintln!("{}\n", lines.join("\n"));
}

fn announce_collection(data: &Value, outcome: DevelopmentOutcome) {
    let prompts: Vec<&str> =
        data["questions"].as_array().into_iter().flatten().filter_map(|q| q["prompt"].as_str()).collect();
    let respondents: Vec<&str> =
        data["responses"].as_array().into_iter().flatten().filter_map(|r| r["respondent"].as_str()).collect();
    let simulating = match outcome {
        DevelopmentOutcome::Timeout => "nobody answers",
        DevelopmentOutcome::Rejected | DevelopmentOutcome::Denied => "it expires unanswered",
        _ => "everyone answers",
    };
    let lines = [
        "  ┌─ Deliverd · development mode ─────────────────────────".to_owned(),
        format!("  │ {}", data["title"].as_str().unwrap_or_default()),
        format!("  │ Asking: {}", if prompts.is_empty() { "nothing".to_owned() } else { prompts.join(" · ") }),
        format!("  │ Of: {}", if respondents.is_empty() { "nobody named".to_owned() } else { respondents.join(", ") }),
        "  │".to_owned(),
        format!("  │ Simulating: {simulating}"),
        "  └───────────────────────────────────────────────────────".to_owned(),
    ];
    eprintln!("{}\n", lines.join("\n"));
}

impl Transport for DevelopmentTransport {
    fn send(&self, request: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, TransportError>> {
        Box::pin(async move {
            let after_host = request.url.splitn(4, '/').nth(3).unwrap_or_default();
            let (path, query) = after_host.split_once('?').unwrap_or((after_host, ""));
            let path = format!("/{}", path.trim_start_matches("api/v1/").trim_start_matches('/'));
            let query: HashMap<String, String> =
                query.split('&').filter_map(|pair| pair.split_once('=')).map(|(k, v)| (decode(k), decode(v))).collect();
            let body = request.body.as_deref().and_then(|b| serde_json::from_str(b).ok()).unwrap_or(json!({}));
            let (status, payload) = self.handle(&request.method, &path, &query, body);
            Ok(TransportResponse::json(status, &payload))
        })
    }
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
