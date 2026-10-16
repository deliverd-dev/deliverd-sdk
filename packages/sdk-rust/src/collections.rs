//! Ask people for what you do not have: a figure, a date, a choice.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{AnswerValue, CollectedAnswers, CollectionData, CollectionRequest, CollectionStatus};
use crate::wait::{Poller, WaitOptions};
use crate::{resolve_expiry, Page};

/// A request for information, and what you can do with it.
#[derive(Debug, Clone)]
pub struct Collection {
    http: HttpClient,
    data: CollectionData,
    raw: Value,
    /// The secret this request's callbacks are signed with, when you gave a
    /// `callback_url`. Only on the handle `create()` returned.
    pub callback_secret: Option<String>,
}

impl Collection {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        Ok(Self { http, data: parse(&raw)?, raw, callback_secret: None })
    }

    pub fn data(&self) -> &CollectionData {
        &self.data
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn status(&self) -> CollectionStatus {
        self.data.status
    }
    pub fn url(&self) -> &str {
        &self.data.url
    }
    /// The one to branch on. False for expired and cancelled.
    pub fn complete(&self) -> bool {
        self.data.status == CollectionStatus::Complete
    }
    pub fn pending(&self) -> bool {
        self.data.status == CollectionStatus::Pending
    }

    /// The first submitted answer to each question, keyed by its prompt.
    ///
    /// When several people answered the same question, the earliest
    /// submission is kept rather than a blend of them: use `responses` when you
    /// need every answer.
    pub fn answers(&self) -> BTreeMap<String, AnswerValue> {
        let mut out = BTreeMap::new();
        for reply in self.data.responses.iter().filter(|r| r.status == "submitted") {
            for answer in &reply.answers {
                out.entry(answer.question.clone()).or_insert_with(|| answer.value.clone());
            }
        }
        out
    }

    pub fn to_collected(&self) -> CollectedAnswers {
        let data = &self.data;
        CollectedAnswers {
            complete: data.status == CollectionStatus::Complete,
            status: if data.status == CollectionStatus::Pending { CollectionStatus::Expired } else { data.status },
            responses: data.responses.iter().filter(|r| r.status == "submitted").cloned().collect(),
            answers: self.answers(),
            id: data.id.clone(),
            url: data.url.clone(),
            collection: data.clone(),
        }
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw =
            self.http.request_value(RequestOptions::get(format!("/collections/{}", encode(&self.data.id)))).await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Withdraw it. The row stays as evidence of what was asked and dropped.
    pub async fn cancel(&mut self) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/collections/{}/cancel", encode(&self.data.id)), None))
            .await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Wait until enough people reply, or it expires.
    pub async fn wait(&mut self, options: WaitOptions<CollectionData>) -> Result<&mut Self> {
        if !self.pending() {
            return Ok(self);
        }
        let mut poller = Poller::new(&options);
        loop {
            if poller.expired() {
                return Err(DeliverdError::timeout(format!(
                    "Not enough people answered \"{}\" within the timeout. It is still open at {}.",
                    self.data.title, self.data.url
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

fn parse(raw: &Value) -> Result<CollectionData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("A request was not the shape expected: {e}")))
}

/// Filters for [`Collections::list`]. Leave `limit` unset to get every row.
#[derive(Debug, Clone, Default)]
pub struct ListCollections {
    pub status: Option<CollectionStatus>,
    pub external_id: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The requests-for-information API.
#[derive(Debug, Clone)]
pub struct Collections {
    pub(crate) http: HttpClient,
}

impl Collections {
    pub async fn create(&self, request: CollectionRequest) -> Result<Collection> {
        let request =
            CollectionRequest { expires_at: resolve_expiry(request.expires_at, &request.expires_in, None)?, ..request };
        let raw = self.http.request_value(RequestOptions::post("/collections", Some(to_value(&request)?))).await?;
        let secret = raw.get("callbackSecret").and_then(Value::as_str).map(str::to_owned);
        let mut collection = Collection::from_raw(self.http.clone(), raw)?;
        collection.callback_secret = secret;
        Ok(collection)
    }

    pub async fn get(&self, id: &str) -> Result<Collection> {
        let raw = self.http.request_value(RequestOptions::get(format!("/collections/{}", encode(id)))).await?;
        Collection::from_raw(self.http.clone(), raw)
    }

    pub async fn list(&self, filter: ListCollections) -> Result<Vec<Collection>> {
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

    pub async fn list_page(&self, filter: &ListCollections) -> Result<Page<Collection>> {
        let options = RequestOptions::get("/collections")
            .query("status", filter.status.map(|s| s.as_str()))
            .query("externalId", filter.external_id.as_deref())
            .query("limit", filter.limit)
            .query("cursor", filter.cursor.as_deref());
        let raw = self.http.request_value(options).await?;
        Page::read(&raw, "collections", |item| Collection::from_raw(self.http.clone(), item))
    }

    pub async fn find_by_external_id(&self, external_id: &str) -> Result<Option<Collection>> {
        let filter =
            ListCollections { external_id: Some(external_id.to_owned()), limit: Some(1), ..Default::default() };
        Ok(self.list(filter).await?.into_iter().next())
    }
}
