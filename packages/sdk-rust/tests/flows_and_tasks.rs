//! Flows and tasks: what goes on the wire, and the loop in development mode.

use std::sync::{Arc, Mutex};

use deliverd::http::{BoxFuture, Transport, TransportError, TransportRequest, TransportResponse};
use deliverd::{
    ApprovalRequest, Deliverd, DevelopmentOptions, FlowRequest, FlowStatus, ListFlows, ListTasks, TaskCompletion,
    TaskRequest, TaskStatePatch, TaskStatus, TaskUpdate,
};
use serde_json::{json, Value};

/// Answers every request with `body`, and remembers what it was sent.
struct Spy {
    body: Value,
    seen: Mutex<Vec<TransportRequest>>,
}

impl Spy {
    fn new(body: Value) -> Arc<Self> {
        Arc::new(Self { body, seen: Mutex::new(Vec::new()) })
    }
    fn last(&self) -> (String, String, Option<Value>) {
        let seen = self.seen.lock().unwrap();
        let request = seen.last().expect("nothing was sent");
        let path = request.url.split("/api/v1").nth(1).unwrap_or_default().to_owned();
        (request.method.clone(), path, request.body.as_deref().map(|b| serde_json::from_str(b).unwrap()))
    }
}

impl Transport for Spy {
    fn send(&self, request: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, TransportError>> {
        self.seen.lock().unwrap().push(request);
        let body = self.body.clone();
        Box::pin(async move { Ok(TransportResponse::json(200, &body)) })
    }
}

fn spying(body: Value) -> (Deliverd, Arc<Spy>) {
    let spy = Spy::new(body);
    let deliverd = Deliverd::builder().api_key("dlv_test").transport(spy.clone()).build().unwrap();
    (deliverd, spy)
}

fn quiet() -> Deliverd {
    Deliverd::builder().development(DevelopmentOptions::default().quiet()).build().unwrap()
}

#[tokio::test]
async fn a_flow_is_started_found_and_closed_on_the_routes_the_api_serves() {
    let (deliverd, spy) = spying(json!({ "id": "flw_1", "status": "open", "url": "u", "title": "Release 4.2" }));

    let mut flow = deliverd.flows().create(FlowRequest::new("Release 4.2").external_id("release-4.2")).await.unwrap();
    assert_eq!(
        spy.last(),
        ("POST".into(), "/flows".into(), Some(json!({ "title": "Release 4.2", "externalId": "release-4.2" })))
    );

    flow.close().await.unwrap();
    assert_eq!(spy.last().0, "POST");
    assert_eq!(spy.last().1, "/flows/flw_1/complete");
    flow.cancel().await.unwrap();
    assert_eq!(spy.last().1, "/flows/flw_1/cancel");
    deliverd.flows().complete("flw_1").await.unwrap();
    assert_eq!(spy.last().1, "/flows/flw_1/complete");

    let (deliverd, spy) = spying(json!({ "flows": [], "nextCursor": null }));
    let filter =
        ListFlows { status: Some(FlowStatus::Open), external_id: Some("release 4.2".into()), ..Default::default() };
    deliverd.flows().list(filter).await.unwrap();
    assert_eq!(spy.last().1, "/flows?status=open&externalId=release%204.2");
    assert!(deliverd.flows().find_by_external_id("x").await.unwrap().is_none());
}

#[tokio::test]
async fn resume_without_a_reference_is_refused_before_anything_is_sent() {
    let (deliverd, spy) = spying(json!({}));
    let error = deliverd.flows().resume(FlowRequest::new("Release")).await.unwrap_err();
    assert_eq!(error.code(), "invalid_request");
    assert!(spy.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_task_is_updated_with_patch_and_finished_with_its_own_calls() {
    let (deliverd, spy) = spying(json!({ "id": "tsk_1", "kind": "objective", "status": "open", "version": 3 }));

    let mut task = deliverd
        .tasks()
        .create(TaskRequest::new("SSO rollout", "Every customer on SAML").external_id("objective:sso").flow_id("flw_1"))
        .await
        .unwrap();
    assert_eq!(
        spy.last(),
        (
            "POST".into(),
            "/tasks".into(),
            Some(
                json!({ "title": "SSO rollout", "objective": "Every customer on SAML", "flowId": "flw_1", "externalId": "objective:sso" })
            )
        )
    );

    task.update(
        TaskUpdate::default()
            .status(TaskStatus::InProgress)
            .state(TaskStatePatch::default().next_action("Ask Acme"))
            .expected_version(3),
    )
    .await
    .unwrap();
    let (method, path, body) = spy.last();
    assert_eq!((method.as_str(), path.as_str()), ("PATCH", "/tasks/tsk_1"));
    assert_eq!(
        body,
        Some(json!({ "status": "in_progress", "state": { "nextAction": "Ask Acme" }, "expectedVersion": 3 }))
    );
    // A PATCH carries no idempotency key: only a create needs one.
    assert!(spy.seen.lock().unwrap().last().unwrap().header("idempotency-key").is_none());

    task.complete(TaskCompletion::new("Twelve customers left.").recommendation("Start with Acme")).await.unwrap();
    assert_eq!(
        spy.last(),
        (
            "POST".into(),
            "/tasks/tsk_1/complete".into(),
            Some(json!({ "summary": "Twelve customers left.", "recommendations": ["Start with Acme"] }))
        )
    );
    task.cancel(Some("Superseded")).await.unwrap();
    assert_eq!(spy.last(), ("POST".into(), "/tasks/tsk_1/cancel".into(), Some(json!({ "reason": "Superseded" }))));

    let (deliverd, spy) = spying(json!({ "tasks": [], "nextCursor": null }));
    deliverd
        .tasks()
        .list(ListTasks {
            status: Some("active".into()),
            external_id: Some("objective:sso".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(spy.last().1, "/tasks?status=active&externalId=objective%3Asso");
}

#[tokio::test]
async fn the_whole_loop_runs_offline() {
    let deliverd = quiet();
    let mut flow = deliverd.flows().resume(FlowRequest::new("Release 4.2").external_id("release-4.2")).await.unwrap();
    let decision = deliverd.approve(ApprovalRequest::new("Deploy 4.2").flow_id(flow.id())).await.unwrap();
    assert!(decision.approved);

    let mut task = deliverd
        .tasks()
        .create(TaskRequest::new("Ship 4.2", "Release 4.2 in production").flow_id(flow.id()))
        .await
        .unwrap();
    assert_eq!(task.data().flow_id.as_deref(), Some(flow.id()));
    let version = task.version();
    task.update(TaskUpdate::default().state(TaskStatePatch::default().add_open_question("Is the migration applied?")))
        .await
        .unwrap();
    assert_eq!(task.version(), version + 1);
    assert_eq!(task.data().state.open_questions, vec!["Is the migration applied?".to_owned()]);

    // An update against a version somebody else moved on from is refused.
    let error = deliverd
        .tasks()
        .update(task.id(), TaskUpdate::default().title("x").expected_version(version))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "version_conflict");

    let context = task.context().await.unwrap();
    assert_eq!(context["rootObjective"], json!("Release 4.2 in production"));

    task.complete(TaskCompletion::new("Shipped.")).await.unwrap();
    assert!(task.completed());
    assert_eq!(task.data().result.as_ref().unwrap().summary, "Shipped.");
    assert_eq!(deliverd.tasks().get(task.id()).await.unwrap().status(), TaskStatus::Completed);

    flow.close().await.unwrap();
    assert!(flow.complete());
    // Closing twice is refused, as the API refuses it.
    assert_eq!(flow.close().await.unwrap_err().code(), "not_open");
    assert_eq!(deliverd.flows().get(flow.id()).await.unwrap().status(), FlowStatus::Complete);
}
