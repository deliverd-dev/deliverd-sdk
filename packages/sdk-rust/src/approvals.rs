//! Ask a person before you act.

use serde_json::{json, Value};

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{ApprovalData, ApprovalQuestion, ApprovalRequest, ApprovalStatus, Decision};
use crate::wait::{Poller, WaitOptions};
use crate::{resolve_expiry, Page};

/// A request, and what you can do with it.
///
/// The data is a snapshot; [`wait`](Self::wait) and [`refresh`](Self::refresh)
/// replace it in place, so a handle held across a wait reads the settled
/// request rather than the one you created.
#[derive(Debug, Clone)]
pub struct Approval {
    http: HttpClient,
    data: ApprovalData,
    raw: Value,
    /// The secret this request's callbacks are signed with, when you gave a
    /// `callback_url`. Only on the handle `create()` returned: the API hands
    /// it over once and never again.
    pub callback_secret: Option<String>,
}

impl Approval {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        let data = parse(&raw)?;
        Ok(Self { http, data, raw, callback_secret: None })
    }

    pub fn data(&self) -> &ApprovalData {
        &self.data
    }
    /// Everything the API returned, for a field the typed copy does not name.
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn status(&self) -> ApprovalStatus {
        self.data.status
    }
    /// The page the approver decides on.
    pub fn url(&self) -> &str {
        &self.data.url
    }
    /// The one to branch on. False for rejected, expired and cancelled alike.
    pub fn approved(&self) -> bool {
        self.data.status == ApprovalStatus::Approved
    }
    pub fn pending(&self) -> bool {
        self.data.status == ApprovalStatus::Pending
    }
    /// Questions the approver is still waiting on you to answer.
    pub fn open_questions(&self) -> Vec<ApprovalQuestion> {
        self.data.questions.iter().filter(|q| q.answer.is_none()).cloned().collect()
    }

    /// The answer, flattened: what [`approve`](crate::Deliverd::approve) hands back.
    pub fn to_decision(&self) -> Decision {
        let data = &self.data;
        let approved = data.status == ApprovalStatus::Approved;
        Decision {
            approved,
            status: if data.status == ApprovalStatus::Pending { ApprovalStatus::Expired } else { data.status },
            note: data.note.clone(),
            decided_by: data.decided_by.clone(),
            decided_by_id: data.decided_by_id.clone(),
            decided_at: data.decided_at.clone(),
            id: data.id.clone(),
            url: data.url.clone(),
            input: if approved { data.approved_input.clone().or_else(|| data.input.clone()) } else { None },
            changes: data.changes.clone(),
            approval: data.clone(),
        }
    }

    fn replace(&mut self, raw: Value) -> Result<()> {
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(())
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw = self.http.request_value(RequestOptions::get(format!("/approvals/{}", encode(&self.data.id)))).await?;
        self.replace(raw)?;
        Ok(self)
    }

    /// Answer a question the approver asked. Only the requester may.
    pub async fn answer(&mut self, question_id: &str, answer: &str) -> Result<&mut Self> {
        let body = json!({ "questionId": question_id, "answer": answer });
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/approvals/{}/answers", encode(&self.data.id)), Some(body)))
            .await?;
        self.replace(raw)?;
        Ok(self)
    }

    /// Withdraw it. The row stays as evidence of what was asked and dropped.
    pub async fn cancel(&mut self) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/approvals/{}/cancel", encode(&self.data.id)), None))
            .await?;
        self.replace(raw)?;
        Ok(self)
    }

    /// Wait until a person decides.
    ///
    /// Returns on approved, rejected, expired and cancelled alike — a refusal
    /// is an answer, not an error. It fails only when the wait itself did: a
    /// timeout, or an API that could not be reached. Dropping the future
    /// abandons the wait; the request stays open.
    pub async fn wait(&mut self, options: WaitOptions<ApprovalData>) -> Result<&mut Self> {
        if !self.pending() {
            return Ok(self);
        }
        let mut poller = Poller::new(&options);
        loop {
            if poller.expired() {
                // Say which of the two happened. An approver who asked a
                // question and got no answer has not ignored the request —
                // they are waiting on you.
                let message = match self.data.questions.iter().find(|q| q.answer.is_none()) {
                    Some(q) => format!(
                        "An approver asked a question about \"{}\" and nothing answered it: \"{}\". Pass an on_question handler, or answer it at {}.",
                        self.data.title, q.question, self.data.url
                    ),
                    None => format!(
                        "Nobody decided \"{}\" within the timeout. It is still open at {}.",
                        self.data.title, self.data.url
                    ),
                };
                return Err(DeliverdError::timeout(message));
            }
            poller.tick().await;
            self.refresh().await?;
            if let Some(on_poll) = &options.on_poll {
                on_poll(&self.data);
            }
            if let Some(handler) = &options.on_question {
                for question in self.open_questions() {
                    if let Some(answer) = handler(question.clone(), self.data.clone()).await {
                        if !answer.trim().is_empty() {
                            self.answer(&question.id, &answer).await?;
                        }
                    }
                }
            }
            if !self.pending() {
                return Ok(self);
            }
        }
    }
}

fn parse(raw: &Value) -> Result<ApprovalData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("An approval was not the shape expected: {e}")))
}

/// Filters for [`Approvals::list`]. Leave `limit` unset to get every row.
#[derive(Debug, Clone, Default)]
pub struct ListApprovals {
    pub status: Option<ApprovalStatus>,
    pub external_id: Option<String>,
    /// The requests naming one person, by id or email.
    pub approver: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The approvals API.
#[derive(Debug, Clone)]
pub struct Approvals {
    pub(crate) http: HttpClient,
}

impl Approvals {
    /// Ask. Returns as soon as the request is filed, so call
    /// [`Approval::wait`] next, or keep the id and look later.
    pub async fn create(&self, request: ApprovalRequest) -> Result<Approval> {
        let request =
            ApprovalRequest { expires_at: resolve_expiry(request.expires_at, &request.expires_in, None)?, ..request };
        let raw = self.http.request_value(RequestOptions::post("/approvals", Some(to_value(&request)?))).await?;
        let secret = raw.get("callbackSecret").and_then(Value::as_str).map(str::to_owned);
        let mut approval = Approval::from_raw(self.http.clone(), raw)?;
        approval.callback_secret = secret;
        Ok(approval)
    }

    pub async fn get(&self, id: &str) -> Result<Approval> {
        let raw = self.http.request_value(RequestOptions::get(format!("/approvals/{}", encode(id)))).await?;
        Approval::from_raw(self.http.clone(), raw)
    }

    /// The organisation's approvals, newest first. With no `limit` this
    /// follows the cursor to the end; with one it is a single page.
    pub async fn list(&self, filter: ListApprovals) -> Result<Vec<Approval>> {
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

    /// One page, and the cursor to continue from.
    pub async fn list_page(&self, filter: &ListApprovals) -> Result<Page<Approval>> {
        let options = RequestOptions::get("/approvals")
            .query("status", filter.status.map(|s| s.as_str()))
            .query("externalId", filter.external_id.as_deref())
            .query("approver", filter.approver.as_deref())
            .query("limit", filter.limit)
            .query("cursor", filter.cursor.as_deref());
        let raw = self.http.request_value(options).await?;
        Page::read(&raw, "approvals", |item| Approval::from_raw(self.http.clone(), item))
    }

    /// Ask and wait, for when there is nothing to do in between.
    pub async fn request(&self, request: ApprovalRequest, options: WaitOptions<ApprovalData>) -> Result<Approval> {
        let mut approval = self.create(request).await?;
        approval.wait(options).await?;
        Ok(approval)
    }

    /// The request already filed under this `external_id`, if there is one —
    /// so a restarted agent does not ask twice. Best effort: two concurrent
    /// calls can still both find nothing and both create.
    pub async fn find_by_external_id(&self, external_id: &str) -> Result<Option<Approval>> {
        let filter = ListApprovals { external_id: Some(external_id.to_owned()), limit: Some(1), ..Default::default() };
        Ok(self.list(filter).await?.into_iter().next())
    }
}
