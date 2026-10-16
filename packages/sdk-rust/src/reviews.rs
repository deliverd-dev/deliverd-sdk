//! Ask people to read what you made and say whether it is right.

use serde_json::Value;

use crate::error::{DeliverdError, Result};
use crate::http::{encode, to_value, HttpClient, RequestOptions};
use crate::types::{ReviewData, ReviewOutcome, ReviewRequest, ReviewStatus};
use crate::wait::{Poller, WaitOptions};
use crate::{resolve_expiry, Page};

/// A review, and what you can do with it.
#[derive(Debug, Clone)]
pub struct Review {
    http: HttpClient,
    data: ReviewData,
    raw: Value,
    /// The secret this request's callbacks are signed with, when you gave a
    /// `callback_url`. Only on the handle `create()` returned.
    pub callback_secret: Option<String>,
}

impl Review {
    pub(crate) fn from_raw(http: HttpClient, raw: Value) -> Result<Self> {
        Ok(Self { http, data: parse(&raw)?, raw, callback_secret: None })
    }

    pub fn data(&self) -> &ReviewData {
        &self.data
    }
    pub fn raw(&self) -> &Value {
        &self.raw
    }
    pub fn id(&self) -> &str {
        &self.data.id
    }
    pub fn status(&self) -> ReviewStatus {
        self.data.status
    }
    pub fn url(&self) -> &str {
        &self.data.url
    }
    /// The one to branch on. False for changes requested, expired and cancelled.
    pub fn approved(&self) -> bool {
        self.data.status == ReviewStatus::Approved
    }
    pub fn pending(&self) -> bool {
        self.data.status == ReviewStatus::Pending
    }

    pub fn to_outcome(&self) -> ReviewOutcome {
        let data = &self.data;
        ReviewOutcome {
            approved: data.status == ReviewStatus::Approved,
            status: if data.status == ReviewStatus::Pending { ReviewStatus::Expired } else { data.status },
            verdicts: data.verdicts.clone(),
            thread_count: data.thread_count,
            id: data.id.clone(),
            url: data.url.clone(),
            review: data.clone(),
        }
    }

    pub async fn refresh(&mut self) -> Result<&mut Self> {
        let raw = self.http.request_value(RequestOptions::get(format!("/reviews/{}", encode(&self.data.id)))).await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Withdraw it. The row stays as evidence of what was asked and dropped.
    pub async fn cancel(&mut self) -> Result<&mut Self> {
        let raw = self
            .http
            .request_value(RequestOptions::post(format!("/reviews/{}/cancel", encode(&self.data.id)), None))
            .await?;
        self.data = parse(&raw)?;
        self.raw = raw;
        Ok(self)
    }

    /// Wait until the reviewers settle it, changes requested included: that
    /// is an answer, and usually the more useful one.
    pub async fn wait(&mut self, options: WaitOptions<ReviewData>) -> Result<&mut Self> {
        if !self.pending() {
            return Ok(self);
        }
        let mut poller = Poller::new(&options);
        loop {
            if poller.expired() {
                return Err(DeliverdError::timeout(format!(
                    "Nobody finished reviewing \"{}\" within the timeout. It is still open at {}.",
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

fn parse(raw: &Value) -> Result<ReviewData> {
    serde_json::from_value(raw.clone())
        .map_err(|e| DeliverdError::new(0, "invalid_response", format!("A review was not the shape expected: {e}")))
}

/// Filters for [`Reviews::list`]. Leave `limit` unset to get every row.
#[derive(Debug, Clone, Default)]
pub struct ListReviews {
    pub status: Option<ReviewStatus>,
    pub external_id: Option<String>,
    pub report_id: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// The reviews API.
#[derive(Debug, Clone)]
pub struct Reviews {
    pub(crate) http: HttpClient,
}

impl Reviews {
    pub async fn create(&self, request: ReviewRequest) -> Result<Review> {
        let request =
            ReviewRequest { expires_at: resolve_expiry(request.expires_at, &request.expires_in, None)?, ..request };
        let raw = self.http.request_value(RequestOptions::post("/reviews", Some(to_value(&request)?))).await?;
        let secret = raw.get("callbackSecret").and_then(Value::as_str).map(str::to_owned);
        let mut review = Review::from_raw(self.http.clone(), raw)?;
        review.callback_secret = secret;
        Ok(review)
    }

    pub async fn get(&self, id: &str) -> Result<Review> {
        let raw = self.http.request_value(RequestOptions::get(format!("/reviews/{}", encode(id)))).await?;
        Review::from_raw(self.http.clone(), raw)
    }

    pub async fn list(&self, filter: ListReviews) -> Result<Vec<Review>> {
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

    pub async fn list_page(&self, filter: &ListReviews) -> Result<Page<Review>> {
        let options = RequestOptions::get("/reviews")
            .query("status", filter.status.map(|s| s.as_str()))
            .query("externalId", filter.external_id.as_deref())
            .query("reportId", filter.report_id.as_deref())
            .query("limit", filter.limit)
            .query("cursor", filter.cursor.as_deref());
        let raw = self.http.request_value(options).await?;
        Page::read(&raw, "reviews", |item| Review::from_raw(self.http.clone(), item))
    }

    pub async fn find_by_external_id(&self, external_id: &str) -> Result<Option<Review>> {
        let filter = ListReviews { external_id: Some(external_id.to_owned()), limit: Some(1), ..Default::default() };
        Ok(self.list(filter).await?.into_iter().next())
    }
}
