//! Flows: the thread that ties one job's approvals, reviews, requests for
//! information and publishes together. The app calls a flow a project.
//!
//! It groups and nothing else. Nothing waits on a flow; nothing is blocked by
//! one; there are no steps to declare up front. Start one, pass its id as
//! `flow_id` on everything that belongs to the work, and close it when the
//! work is over.

use serde_json::Value;

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{FlowData, FlowRequest, FlowStatus};
use crate::Page;

/// A flow, and what you can do with it.
#[derive(Debug, Clone)]
pub struct Flow {
    http: HttpClient,
    data: FlowData,
    raw: Value,
}

impl Flow {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        Ok(Self { http, data: parse(&raw)?, raw })
    }

    pub fn data(&self) -> &FlowData {
        &self.data
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn status(&self) -> FlowStatus {
        self.data.status
    }
    /// The timeline page a person can open.
    pub fn url(&self) -> &str {
        &self.data.url
    }
    pub fn title(&self) -> &str {
        &self.data.title
    }
    /// Still taking new members.
    pub fn open(&self) -> bool {
        self.data.status == FlowStatus::Open
    }
    pub fn complete(&self) -> bool {
        self.data.status == FlowStatus::Complete
    }
    pub fn cancelled(&self) -> bool {
        self.data.status == FlowStatus::Cancelled
    }
    /// Nothing in it is waiting on anybody at this moment. Not a claim that
    /// the job is finished: you may be about to add the next step, and an
    /// empty flow is never settled. Say the work is over with [`close`](Self::close).
    pub fn all_settled(&self) -> bool {
        self.data.all_settled
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw = self.http.request_value(RequestOptions::get(format!("/flows/{}", encode(&self.data.id)))).await?;
        self.set(raw)
    }

    /// The whole record of this flow, as JSON: every step with who was asked
    /// and what they said, and the timeline across all of it. Needs every
    /// read scope, because it contains everything.
    pub async fn evidence(&self) -> Result<Value> {
        self.http.request_value(RequestOptions::get(format!("/flows/{}/evidence", encode(&self.data.id)))).await
    }

    /// Say the work is done. It takes no new members from here.
    ///
    /// Named `close` rather than `complete`, as in the TypeScript and Python
    /// SDKs: [`complete`](Self::complete) asks, `close` decides. Allowed with
    /// steps still outstanding, and how many is recorded. Only whoever started
    /// the flow can close it.
    pub async fn close(&mut self) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/flows/{}/complete", encode(&self.data.id)), None))
            .await?;
        self.set(raw)
    }

    /// Call it off. The flow and its members stay as evidence; nothing inside
    /// is cancelled.
    pub async fn cancel(&mut self) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/flows/{}/cancel", encode(&self.data.id)), None))
            .await?;
        self.set(raw)
    }

    fn set(&mut self, raw: Value) -> Result<&mut Self> {
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }
}

fn parse(raw: &Value) -> Result<FlowData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("A flow was not the shape expected: {e}")))
}

/// Filters for [`Flows::list`]. Leave `limit` unset to get every row.
#[derive(Debug, Clone, Default)]
pub struct ListFlows {
    pub status: Option<FlowStatus>,
    pub external_id: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The flows API.
#[derive(Debug, Clone)]
pub struct Flows {
    pub(crate) http: HttpClient,
}

impl Flows {
    pub async fn create(&self, request: FlowRequest) -> Result<Flow> {
        let raw = self.http.request_value(RequestOptions::post("/flows", Some(to_value(&request)?))).await?;
        Flow::from_raw(self.http.clone(), raw)
    }

    /// A flow with its members and timeline.
    pub async fn get(&self, id: &str) -> Result<Flow> {
        let raw = self.http.request_value(RequestOptions::get(format!("/flows/{}", encode(id)))).await?;
        Flow::from_raw(self.http.clone(), raw)
    }

    /// Say the work a flow covers is done. The same as [`Flow::close`], by id.
    pub async fn complete(&self, id: &str) -> Result<Flow> {
        let raw =
            self.http.request_value(RequestOptions::post(format!("/flows/{}/complete", encode(id)), None)).await?;
        Flow::from_raw(self.http.clone(), raw)
    }

    /// Close a flow as abandoned rather than done. The same as [`Flow::cancel`], by id.
    pub async fn cancel(&self, id: &str) -> Result<Flow> {
        let raw = self.http.request_value(RequestOptions::post(format!("/flows/{}/cancel", encode(id)), None)).await?;
        Flow::from_raw(self.http.clone(), raw)
    }

    /// The organisation's flows, newest first. With no `limit`, every one of
    /// them: this follows the cursor to the end.
    pub async fn list(&self, filter: ListFlows) -> Result<Vec<Flow>> {
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

    pub async fn list_page(&self, filter: &ListFlows) -> Result<Page<Flow>> {
        let options = RequestOptions::get("/flows")
            .query("status", filter.status.map(|s| s.as_str()))
            .query("externalId", filter.external_id.as_deref())
            .query("limit", filter.limit)
            .query("cursor", filter.cursor.as_deref());
        let raw = self.http.request_value(options).await?;
        Page::read(&raw, "flows", |item| Flow::from_raw(self.http.clone(), item))
    }

    /// The same job as before, when there was one — so a restart extends it
    /// rather than starting a second.
    pub async fn find_by_external_id(&self, external_id: &str) -> Result<Option<Flow>> {
        let filter = ListFlows { external_id: Some(external_id.to_owned()), limit: Some(1), ..Default::default() };
        Ok(self.list(filter).await?.into_iter().next())
    }

    /// The open flow for this reference, started if there is none.
    ///
    /// What a restartable agent wants: one call that is right on the first run
    /// and on the fourth. A flow found closed is not reused, because it takes
    /// no new members; a new one is started under the same reference.
    pub async fn resume(&self, request: FlowRequest) -> Result<Flow> {
        let Some(external_id) = request.external_id.clone() else {
            return Err(DeliverdError::new(
                0,
                "invalid_request",
                "resume() needs an external_id: it is how the flow is found again.",
            ));
        };
        if let Some(existing) = self.find_by_external_id(&external_id).await? {
            if existing.open() {
                return Ok(existing);
            }
        }
        self.create(request).await
    }
}
