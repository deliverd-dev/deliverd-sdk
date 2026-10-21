//! Task Graph: what the work is for, kept apart from the conversation doing it.
//!
//! An agent deep in a debugging session forgets the objective it started
//! from, because the objective is a paragraph thousands of tokens back. A task
//! keeps it somewhere the agent can ask for: [`Task::context`] returns the
//! objective first, then where the task stands and what comes next.
//!
//! Nothing here asks a person anything. Side tasks, findings, governance and
//! the rest of the Task Graph API are reached through
//! [`Deliverd::http`](crate::Deliverd::http) until this crate names them.

use serde_json::{json, Value};

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{TaskCompletion, TaskData, TaskKind, TaskRequest, TaskStatus, TaskUpdate};
use crate::Page;

fn path(id: &str, rest: &str) -> String {
    format!("/tasks/{}{rest}", encode(id))
}

/// A task, and what you can do with it.
#[derive(Debug, Clone)]
pub struct Task {
    http: HttpClient,
    data: TaskData,
    raw: Value,
}

impl Task {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        Ok(Self { http, data: parse(&raw)?, raw })
    }

    pub fn data(&self) -> &TaskData {
        &self.data
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn kind(&self) -> TaskKind {
        self.data.kind
    }
    pub fn status(&self) -> TaskStatus {
        self.data.status
    }
    /// The page a person can open.
    pub fn url(&self) -> &str {
        &self.data.url
    }
    pub fn title(&self) -> &str {
        &self.data.title
    }
    /// What the work is for: the objective's purpose, or a side task's goal.
    pub fn objective(&self) -> &str {
        &self.data.objective
    }
    pub fn version(&self) -> u64 {
        self.data.version
    }
    /// True when `create` returned an open objective you had already started
    /// under the same `external_id`.
    pub fn resumed(&self) -> bool {
        self.data.resumed
    }
    pub fn is_side_task(&self) -> bool {
        self.data.kind != TaskKind::Objective
    }
    /// Neither completed nor cancelled.
    pub fn active(&self) -> bool {
        !self.completed() && !self.cancelled()
    }
    pub fn completed(&self) -> bool {
        self.data.status == TaskStatus::Completed
    }
    pub fn cancelled(&self) -> bool {
        self.data.status == TaskStatus::Cancelled
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw = self.http.request_value(RequestOptions::get(path(&self.data.id, ""))).await?;
        self.set(raw)
    }

    /// What to read instead of the history, as JSON: the objective first,
    /// then where this task stands, what is settled and a paragraph to say
    /// back to yourself (`reanchor`). Call it whenever you have lost the thread.
    pub async fn context(&self) -> Result<Value> {
        self.http.request_value(RequestOptions::get(path(&self.data.id, "/context"))).await
    }

    /// Change the title, status or working state.
    pub async fn update(&mut self, update: TaskUpdate) -> Result<&mut Self> {
        let raw =
            self.http.request_value(RequestOptions::patch(path(&self.data.id, ""), Some(to_value(&update)?))).await?;
        self.set(raw)
    }

    /// Finish it with a structured result. A side task's result then waits to
    /// be applied to its parent.
    pub async fn complete(&mut self, completion: TaskCompletion) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(path(&self.data.id, "/complete"), Some(to_value(&completion)?)))
            .await?;
        self.set(raw)
    }

    /// Open a completed task again. Its result is kept in `previous_results`.
    pub async fn reopen(&mut self) -> Result<&mut Self> {
        let raw =
            self.http.request_value(RequestOptions::post(path(&self.data.id, "/reopen"), Some(json!({})))).await?;
        self.set(raw)
    }

    /// Call it off. It stays in the tree as a record of what was tried.
    pub async fn cancel(&mut self, reason: Option<&str>) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(path(&self.data.id, "/cancel"), Some(cancel_body(reason))))
            .await?;
        self.set(raw)
    }

    fn set(&mut self, raw: Value) -> Result<&mut Self> {
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }
}

fn cancel_body(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({ "reason": reason }),
        None => json!({}),
    }
}

fn parse(raw: &Value) -> Result<TaskData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("A task was not the shape expected: {e}")))
}

/// Filters for [`Tasks::list`]. Leave `limit` unset to get every row.
#[derive(Debug, Clone, Default)]
pub struct ListTasks {
    /// A [`TaskStatus`]'s wire spelling, or `active` for anything not
    /// completed or cancelled.
    pub status: Option<String>,
    pub external_id: Option<String>,
    /// Search the titles and objectives.
    pub q: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The tasks API.
#[derive(Debug, Clone)]
pub struct Tasks {
    pub(crate) http: HttpClient,
}

impl Tasks {
    /// Start an objective. With an `external_id`, an open objective you
    /// already started under it comes back instead ([`Task::resumed`]), so a
    /// restarted agent picks its goal up rather than starting a second.
    pub async fn create(&self, request: TaskRequest) -> Result<Task> {
        let raw = self.http.request_value(RequestOptions::post("/tasks", Some(to_value(&request)?))).await?;
        Task::from_raw(self.http.clone(), raw)
    }

    /// A task with its path, children, findings and links (on `raw()`).
    pub async fn get(&self, id: &str) -> Result<Task> {
        let raw = self.http.request_value(RequestOptions::get(path(id, ""))).await?;
        Task::from_raw(self.http.clone(), raw)
    }

    /// The task's context, as JSON. The same as [`Task::context`], by id.
    pub async fn context(&self, id: &str) -> Result<Value> {
        self.http.request_value(RequestOptions::get(path(id, "/context"))).await
    }

    pub async fn update(&self, id: &str, update: TaskUpdate) -> Result<Task> {
        let raw = self.http.request_value(RequestOptions::patch(path(id, ""), Some(to_value(&update)?))).await?;
        Task::from_raw(self.http.clone(), raw)
    }

    pub async fn complete(&self, id: &str, completion: TaskCompletion) -> Result<Task> {
        let raw =
            self.http.request_value(RequestOptions::post(path(id, "/complete"), Some(to_value(&completion)?))).await?;
        Task::from_raw(self.http.clone(), raw)
    }

    pub async fn cancel(&self, id: &str, reason: Option<&str>) -> Result<Task> {
        let raw = self.http.request_value(RequestOptions::post(path(id, "/cancel"), Some(cancel_body(reason)))).await?;
        Task::from_raw(self.http.clone(), raw)
    }

    /// Objectives, most recently active first. Side tasks are reached through
    /// the objective they belong to. With no `limit`, every one of them.
    pub async fn list(&self, filter: ListTasks) -> Result<Vec<Task>> {
        if filter.limit.is_some() {
            return Ok(self.list_page(&filter).await?.items);
        }
        let mut all = Vec::new();
        let mut filter = filter;
        loop {
            let page = self.list_page(&filter).await?;
            let empty = page.items.is_empty();
            all.extend(page.items);
            match page.next_cursor {
                Some(cursor) if !empty => filter.cursor = Some(cursor),
                _ => return Ok(all),
            }
        }
    }

    pub async fn list_page(&self, filter: &ListTasks) -> Result<Page<Task>> {
        let options = RequestOptions::get("/tasks")
            .query("status", filter.status.as_deref())
            .query("externalId", filter.external_id.as_deref())
            .query("q", filter.q.as_deref())
            .query("limit", filter.limit)
            .query("cursor", filter.cursor.as_deref());
        let raw = self.http.request_value(options).await?;
        Page::read(&raw, "tasks", |item| Task::from_raw(self.http.clone(), item))
    }

    /// The objective started under this reference, if there is one.
    pub async fn find_by_external_id(&self, external_id: &str) -> Result<Option<Task>> {
        let filter = ListTasks { external_id: Some(external_id.to_owned()), limit: Some(1), ..Default::default() };
        Ok(self.list(filter).await?.into_iter().next())
    }
}
