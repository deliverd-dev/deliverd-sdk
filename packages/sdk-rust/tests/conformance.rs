//! The behaviour the three SDKs share, read from one table.
//!
//! `packages/conformance/cases.json` is read by the TypeScript suite, the
//! Python suite and this one, so a case added there fails in whichever
//! language has not implemented it. Shapes were already compared; what drifted
//! between the SDKs was behaviour, which only a shared table catches.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use deliverd::http::{BoxFuture, Transport, TransportError, TransportRequest, TransportResponse};
use deliverd::webhooks::{verify_signature_at, TOLERANCE_SECONDS};
use deliverd::{
    parse_duration, Deliverd, DevelopmentOptions, DevelopmentOutcome, FlowRequest, Gate, GateData, GateRequest,
    GateStatus, TaskCompletion, TaskRequest,
};
use serde_json::{json, Value};

static CASES: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the conformance table is beside this package"))
        .expect("the conformance table is JSON")
});

/// A status, its headers and its JSON body.
type Answer = (u16, Vec<(String, String)>, Value);

/// Answers every request with one status, and remembers what it was sent.
struct Answering {
    statuses: Mutex<Vec<Answer>>,
    seen: Mutex<Vec<TransportRequest>>,
}

impl Answering {
    /// The same answer for ever.
    fn always(status: u16) -> Arc<Self> {
        Self::script(vec![(status, vec![], json!({ "error": { "code": "x", "message": "x" } }))])
    }

    /// These answers in order, the last one repeated.
    fn script(statuses: Vec<Answer>) -> Arc<Self> {
        Arc::new(Self { statuses: Mutex::new(statuses), seen: Mutex::new(Vec::new()) })
    }

    fn seen(&self) -> Vec<TransportRequest> {
        self.seen.lock().unwrap().clone()
    }
}

impl Transport for Answering {
    fn send(&self, request: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, TransportError>> {
        self.seen.lock().unwrap().push(request);
        let mut statuses = self.statuses.lock().unwrap();
        let (status, headers, body) =
            if statuses.len() > 1 { statuses.remove(0) } else { statuses.first().cloned().expect("an answer") };
        Box::pin(async move { Ok(TransportResponse { status, headers, body: body.to_string() }) })
    }
}

fn client(transport: Arc<Answering>) -> Deliverd {
    let attempts = CASES["retries"]["_maxAttempts"].as_u64().unwrap() as u32;
    Deliverd::builder().api_key("dlv_conformance").transport(transport).max_retries(attempts).build().unwrap()
}

#[test]
fn durations_read_the_same_strings() {
    let durations = &CASES["durations"];
    let shared = durations["shared"].as_array().unwrap();
    assert!(shared.len() > 5);
    for case in shared {
        let input = case["input"].as_str().unwrap();
        let seconds = case["seconds"].as_f64().unwrap();
        assert_eq!(parse_duration(input).unwrap(), Duration::from_secs_f64(seconds), "{input:?}");
    }
    for input in durations["rejected"].as_array().unwrap() {
        let input = input.as_str().unwrap();
        assert!(parse_duration(input).is_err(), "{input:?} should be refused");
    }
    // A bare number is the one per-language divergence: milliseconds in
    // TypeScript, seconds in Python. Rust takes neither, because its timers
    // take a `Duration`, which says its own unit; the number written as a
    // string is refused rather than read as a third guess.
    for case in durations["divergent"].as_array().unwrap() {
        let number = case["input"].as_f64().expect("the divergent cases are bare numbers");
        assert!(parse_duration(&number.to_string()).is_err(), "{number} has no unit and should be refused");
        assert!(case["why"].as_str().unwrap().len() > 40);
    }
}

#[tokio::test(start_paused = true)]
async fn retries_only_what_is_worth_asking_again() {
    let retries = &CASES["retries"];
    for case in retries["cases"].as_array().unwrap() {
        let status = case["status"].as_u64().unwrap() as u16;
        let expected = case["attempts"].as_u64().unwrap() as usize;
        let transport = Answering::always(status);
        let error = client(transport.clone()).http().get::<Value>("/approvals").await.unwrap_err();
        assert_eq!(error.status(), status);
        assert_eq!(transport.seen().len(), expected, "{status}: {}", case["why"]);
    }
}

#[tokio::test(start_paused = true)]
async fn honours_retry_after_in_seconds() {
    let retry_after = &CASES["retryAfter"];
    assert!(retry_after["honoured"].as_bool().unwrap());
    let header = retry_after["header"].as_str().unwrap();
    let seconds = retry_after["py_seconds"].as_f64().unwrap();
    assert_eq!(deliverd::http::parse_retry_after(header), Some(Duration::from_secs_f64(seconds)));

    let transport = Answering::script(vec![
        (429, vec![("retry-after".into(), header.into())], json!({ "error": { "code": "rate_limited" } })),
        (200, vec![], json!({ "ok": true })),
    ]);
    let started = tokio::time::Instant::now();
    client(transport.clone()).http().get::<Value>("/approvals").await.unwrap();
    let waited = started.elapsed();
    assert_eq!(transport.seen().len(), 2);
    assert!(
        waited >= Duration::from_secs_f64(seconds * 0.9),
        "The retry came after {waited:?} and Retry-After said {seconds}s."
    );
}

#[tokio::test(start_paused = true)]
async fn a_retried_post_carries_one_idempotency_key() {
    let idempotency = &CASES["idempotency"];
    let transport = Answering::always(idempotency["retryStatus"].as_u64().unwrap() as u16);
    let error = client(transport.clone()).http().post::<Value>("/approvals", &json!({ "title": "x" })).await;
    assert!(error.is_err());

    let seen = transport.seen();
    assert_eq!(seen.len() as u64, idempotency["expectedAttempts"].as_u64().unwrap());
    let header = idempotency["header"].as_str().unwrap();
    let keys: Vec<Option<&str>> = seen.iter().map(|r| r.header(header)).collect();
    assert!(keys.iter().all(Option::is_some), "A POST went out with no idempotency key.");
    assert!(idempotency["sameKeyOnEveryAttempt"].as_bool().unwrap());
    assert!(keys.windows(2).all(|w| w[0] == w[1]), "A retry minted a new key, which is a second create: {keys:?}");
}

#[test]
fn webhook_signatures_agree_with_the_fixed_vectors() {
    let signatures = &CASES["signatures"];
    let tolerance = signatures["toleranceSeconds"].as_i64().unwrap();
    assert_eq!(tolerance, TOLERANCE_SECONDS);
    let secret = signatures["secret"].as_str().unwrap();
    let body = signatures["body"].as_str().unwrap();
    assert_eq!(
        deliverd::webhooks::sign(secret, signatures["timestamp"].as_i64().unwrap(), body),
        signatures["validSignature"].as_str().unwrap()
    );
    let cases = signatures["cases"].as_array().unwrap();
    assert!(cases.len() > 8);
    for case in cases {
        let verifies =
            verify_signature_at(secret, body, case["header"].as_str(), case["now"].as_i64().unwrap(), tolerance);
        assert_eq!(verifies, case["verifies"].as_bool().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn the_gate_agrees_on_what_counts_as_permission() {
    for case in CASES["gate"]["allowed"].as_array().unwrap() {
        let status: GateStatus = serde_json::from_value(case["status"].clone()).unwrap();
        let allowed = case["allowed"].as_bool().unwrap();
        assert_ne!(status, GateStatus::Unknown, "{} is not a status this crate knows", case["status"]);
        let gate = Gate::from_data(GateData { id: "gat_1".into(), status, allowed, ..Default::default() });
        assert_eq!(gate.allowed(), allowed, "{}: {}", case["status"], case["why"]);
        assert_eq!(gate.pending(), status == GateStatus::Pending);
        assert_eq!(gate.denied(), status == GateStatus::Denied);
        // The flattened answer must agree with the handle, or `gate()` and
        // `gates().create()` disagree about the same decision.
        assert_eq!(gate.to_decision().allowed, allowed);
        assert_eq!(gate.to_decision().status, status);
    }
}

#[tokio::test]
async fn the_gate_requires_the_callers_id_and_sends_it_as_the_idempotency_key() {
    let external_id = &CASES["gate"]["externalId"];
    assert!(external_id["required"].as_bool().unwrap());
    assert!(external_id["sentAsIdempotencyKey"].as_bool().unwrap());

    let transport =
        Answering::script(vec![(201, vec![], json!({ "id": "gat_1", "status": "allowed", "allowed": true }))]);
    let deliverd = client(transport.clone());

    let refused = deliverd.gates().create(GateRequest::new("finance.refund", " ", json!({}))).await;
    assert_eq!(refused.unwrap_err().code(), "external_id_required");
    assert!(transport.seen().is_empty(), "A gate with no id of the caller's was sent anyway.");

    deliverd.gates().create(GateRequest::new("finance.refund", "refund:1", json!({}))).await.unwrap();
    assert_eq!(
        transport.seen()[0].header(CASES["idempotency"]["header"].as_str().unwrap()),
        Some("refund:1"),
        "The gate sent a random idempotency key instead of the caller's id."
    );
}

#[tokio::test]
async fn the_gate_reads_back_a_decision_already_made() {
    let reuse = &CASES["gate"]["reuse"];
    let deliverd = Deliverd::builder()
        .development(DevelopmentOptions::default().outcome(DevelopmentOutcome::Approved).quiet())
        .build()
        .unwrap();

    let first = deliverd.gates().create(GateRequest::new("finance.refund", "refund:2", json!({}))).await.unwrap();
    assert!(!first.data().reused);
    let again = deliverd.gates().create(GateRequest::new("finance.refund", "refund:2", json!({}))).await.unwrap();
    assert_eq!(again.id(), first.id(), "{}", reuse["sameExternalIdReturns"]);
    assert_eq!(again.data().reused, reuse["reused"].as_bool().unwrap(), "{}", reuse["why"]);
}

#[tokio::test]
async fn development_mode_offers_the_same_gate_outcomes() {
    let outcomes = &CASES["gate"]["developmentOutcomes"];
    for name in outcomes["outcomes"].as_array().unwrap() {
        let name = name.as_str().unwrap();
        let outcome = DevelopmentOutcome::parse(name).unwrap_or_else(|| panic!("dev mode does not know \"{name}\""));
        let deliverd =
            Deliverd::builder().development(DevelopmentOptions::default().outcome(outcome).quiet()).build().unwrap();
        let gate = deliverd.gates().create(GateRequest::new("finance.refund", "refund:3", json!({}))).await.unwrap();
        let by_rule = outcomes["settledByRule"].as_array().unwrap().iter().any(|v| v == name);
        assert_eq!(!gate.pending(), by_rule, "{name}: {}", outcomes["why"]);
    }
    let default = outcomes["default"].as_str().unwrap();
    assert_eq!(DevelopmentOutcome::parse(default), Some(DevelopmentOutcome::default()));
}

#[tokio::test]
async fn a_restarted_agent_picks_its_flow_up_and_never_a_closed_one() {
    let case = &CASES["resume"]["flow"];
    let deliverd = Deliverd::builder().development(DevelopmentOptions::default().quiet()).build().unwrap();
    let request =
        || FlowRequest::new(case["title"].as_str().unwrap()).external_id(case["externalId"].as_str().unwrap());

    let mut first = deliverd.flows().resume(request()).await.unwrap();
    assert!(first.open());
    let again = deliverd.flows().resume(request()).await.unwrap();
    assert_eq!(again.id() == first.id(), case["restartReturnsTheOpenFlow"].as_bool().unwrap(), "{}", case["why"]);

    first.close().await.unwrap();
    assert!(first.complete());
    let after = deliverd.flows().resume(request()).await.unwrap();
    assert_eq!(after.id() != first.id(), case["closedFlowStartsANewOne"].as_bool().unwrap(), "{}", case["why"]);
    assert!(after.open());
}

#[tokio::test]
async fn a_restarted_agent_picks_its_objective_up_and_says_so() {
    let case = &CASES["resume"]["task"];
    let deliverd = Deliverd::builder().development(DevelopmentOptions::default().quiet()).build().unwrap();
    let request = || {
        TaskRequest::new(case["title"].as_str().unwrap(), case["objective"].as_str().unwrap())
            .external_id(case["externalId"].as_str().unwrap())
    };

    let mut first = deliverd.tasks().create(request()).await.unwrap();
    assert!(!first.resumed());
    let again = deliverd.tasks().create(request()).await.unwrap();
    assert_eq!(again.id() == first.id(), case["restartReturnsTheOpenObjective"].as_bool().unwrap(), "{}", case["why"]);
    assert_eq!(again.resumed(), case["resumedIsTrue"].as_bool().unwrap(), "{}", case["why"]);

    first.complete(TaskCompletion::new("Done.")).await.unwrap();
    let after = deliverd.tasks().create(request()).await.unwrap();
    assert_eq!(after.id() != first.id(), case["completedObjectiveStartsANewOne"].as_bool().unwrap(), "{}", case["why"]);
    assert!(!after.resumed());
}
