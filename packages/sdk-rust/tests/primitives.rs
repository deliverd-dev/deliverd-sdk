//! The six primitives, end to end, against development mode: the same client,
//! the same retries and the same polling as production, with an imaginary
//! person answering.

use std::time::Duration;

use deliverd::{
    on_question, ApprovalRequest, ApprovalStatus, AskOptions, CollectionRequest, Deliverd, DevelopmentOptions,
    DevelopmentOutcome, GateOptions, GateRequest, GateStatus, PublishRequest, Question, ReviewRequest, ReviewStatus,
};
use serde_json::json;

fn development(outcome: DevelopmentOutcome) -> Deliverd {
    Deliverd::builder().development(DevelopmentOptions::default().outcome(outcome).quiet()).build().unwrap()
}

#[tokio::test]
async fn approve_returns_the_decision_including_a_no() {
    let yes = development(DevelopmentOutcome::Approved).approve(ApprovalRequest::new("Deploy")).await.unwrap();
    assert!(yes.approved);
    assert_eq!(yes.status, ApprovalStatus::Approved);
    assert_eq!(yes.decided_by.as_deref(), Some("Development approver"));
    assert!(yes.approval.expires_at.is_some(), "A request with no expiry can be waited on for ever.");

    let no = development(DevelopmentOutcome::Rejected).approve(ApprovalRequest::new("Deploy")).await.unwrap();
    assert!(!no.approved);
    assert_eq!(no.status, ApprovalStatus::Rejected);
    assert!(no.note.is_some());
}

#[tokio::test]
async fn approve_runs_with_the_approvers_corrections() {
    let deliverd = Deliverd::builder()
        .development(DevelopmentOptions::default().edit("amount", json!(1200)).edit("currency", json!("EUR")).quiet())
        .build()
        .unwrap();
    let mut input = serde_json::Map::new();
    input.insert("amount".into(), json!(1240));
    input.insert("currency".into(), json!("GBP"));
    let decision =
        deliverd.approve(ApprovalRequest::new("Refund").input(input).editable_field("amount")).await.unwrap();
    let input = decision.input.unwrap();
    assert_eq!(input["amount"], json!(1200));
    // Not editable, so not changed.
    assert_eq!(input["currency"], json!("GBP"));
    assert_eq!(decision.changes.len(), 1);
}

#[tokio::test]
async fn a_question_is_answered_inside_the_wait() {
    let deliverd = development(DevelopmentOutcome::Question);
    let options = AskOptions::default()
        .on_question(on_question(|question, _| async move { Some(format!("Yes. ({})", question.question)) }));
    let decision = deliverd.approve_with(ApprovalRequest::new("Deploy"), options).await.unwrap();
    assert!(decision.approved);
    assert!(decision.approval.questions[0].answer.as_deref().unwrap().starts_with("Yes."));
}

#[tokio::test]
async fn an_unanswered_question_says_so_when_the_wait_ends() {
    let deliverd = development(DevelopmentOutcome::Question);
    let error = deliverd.approve(ApprovalRequest::new("Deploy")).await.unwrap_err();
    assert!(error.is_timeout());
    assert!(error.message().contains("asked a question"), "{error}");
}

#[tokio::test]
async fn nobody_answering_is_a_timeout_not_a_refusal() {
    let deliverd = development(DevelopmentOutcome::Timeout);
    let options = AskOptions::default().timeout(Duration::from_millis(200));
    let error = deliverd.approve_with(ApprovalRequest::new("Deploy"), options).await.unwrap_err();
    assert!(error.is_timeout());
    assert!(error.message().contains("Nobody decided"), "{error}");
}

#[tokio::test]
async fn a_restarted_agent_does_not_ask_twice() {
    let deliverd = development(DevelopmentOutcome::Approved);
    let first = deliverd.approve(ApprovalRequest::new("Deploy").external_id("deploy_1")).await.unwrap();
    let second = deliverd.approve(ApprovalRequest::new("Deploy").external_id("deploy_1")).await.unwrap();
    assert_eq!(first.id, second.id);
}

#[tokio::test]
async fn confirm_is_a_boolean() {
    assert!(development(DevelopmentOutcome::Approved).confirm(ApprovalRequest::new("Sure?")).await.unwrap());
    assert!(!development(DevelopmentOutcome::Rejected).confirm(ApprovalRequest::new("Sure?")).await.unwrap());
}

#[tokio::test]
async fn gate_waits_for_a_person_and_hands_back_the_input_to_run() {
    let deliverd = development(DevelopmentOutcome::Approved);
    let decision =
        deliverd.gate(GateRequest::new("finance.refund", "refund:1", json!({ "amount": 1240 }))).await.unwrap();
    assert!(decision.allowed);
    assert_eq!(decision.status, GateStatus::Approved);
    assert_eq!(decision.input["amount"], json!(1240));
}

#[tokio::test]
async fn gate_denied_by_policy_has_no_wait_in_it() {
    let deliverd = development(DevelopmentOutcome::Denied);
    let decision = deliverd.gate(GateRequest::new("finance.refund", "refund:2", json!({}))).await.unwrap();
    assert!(!decision.allowed);
    assert_eq!(decision.status, GateStatus::Denied);
    assert_eq!(decision.rule.as_deref(), Some("Development mode"));
}

#[tokio::test]
async fn gate_without_waiting_returns_it_pending() {
    let deliverd = development(DevelopmentOutcome::Approved);
    let decision = deliverd
        .gate_with(GateRequest::new("finance.refund", "refund:3", json!({})), GateOptions::default().no_wait())
        .await
        .unwrap();
    assert_eq!(decision.status, GateStatus::Pending);
    assert!(!decision.allowed, "Nobody has decided yet, so nobody has said yes.");
}

#[tokio::test]
async fn a_used_permission_cannot_be_spent_twice() {
    let deliverd = development(DevelopmentOutcome::Approved);
    let mut gate = deliverd.gates().create(GateRequest::new("report.publish", "publish:1", json!({}))).await.unwrap();
    gate.wait(Default::default()).await.unwrap();
    assert!(gate.can_execute());
    let receipt = gate.record_execution(Default::default()).await.unwrap();
    assert_eq!(receipt.phase, "completed");
    assert_eq!(gate.status(), GateStatus::Used);
    let again = deliverd.gates().record_execution(gate.id(), Default::default()).await.unwrap_err();
    assert_eq!(again.code(), "gate_used");
}

#[tokio::test]
async fn review_comes_back_with_changes_requested() {
    let deliverd = development(DevelopmentOutcome::Rejected);
    let outcome = deliverd.review(ReviewRequest::new("Q3 board pack").reviewer("partner@firm.example")).await.unwrap();
    assert!(!outcome.approved);
    assert_eq!(outcome.status, ReviewStatus::ChangesRequested);
    assert_eq!(outcome.verdicts[0].by, "partner@firm.example");
    assert!(outcome.thread_count > 0);
}

#[tokio::test]
async fn collect_answers_by_the_question_asked() {
    let deliverd = development(DevelopmentOutcome::Approved);
    let collected = deliverd
        .collect(
            CollectionRequest::new("Before I file the Q3 return")
                .respondent("finance@firm.example")
                .question(Question::number("Headcount at 30 September"))
                .question(Question::boolean("Any disposals in the quarter?")),
        )
        .await
        .unwrap();
    assert!(collected.complete);
    assert_eq!(collected.answers["Headcount at 30 September"].as_f64(), Some(42.0));
    assert_eq!(collected.answers["Any disposals in the quarter?"].as_bool(), Some(true));
}

#[tokio::test]
async fn publishing_is_refused_in_development_mode_rather_than_faked() {
    let error =
        development(DevelopmentOutcome::Approved).publish(PublishRequest::new("Q3", "<h1>Q3</h1>")).await.unwrap_err();
    assert_eq!(error.status(), 501);
    assert_eq!(error.code(), "not_in_development_mode");
}

#[test]
fn a_live_client_needs_a_key_and_says_where_to_get_one() {
    // Only when the environment has none, so this never reads a real key.
    if std::env::var("DELIVERD_API_KEY").is_ok() || std::env::var("DELIVERD_MODE").is_ok() {
        return;
    }
    let error = Deliverd::from_env().unwrap_err();
    assert_eq!(error.code(), "no_api_key");
    assert!(error.hint().unwrap().contains("utm_source=crates"));
}

#[test]
fn an_expiry_that_does_not_parse_is_refused_before_anything_is_sent() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    let error = runtime
        .block_on(
            development(DevelopmentOutcome::Approved).approve(ApprovalRequest::new("Deploy").expires_in("4 hours")),
        )
        .unwrap_err();
    assert_eq!(error.code(), "invalid_duration");
}
