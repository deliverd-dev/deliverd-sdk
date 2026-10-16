//! The publishing half: get what the agent wrote to the people who need it,
//! at an address that does not change.
//!
//! Thin on purpose. The service decides what a publish means, and an SDK that
//! reimplemented any of it would be a second answer to the same question.

use serde_json::Value;

use crate::error::Result;
use crate::http::{encode, HttpClient, RequestOptions};
use crate::types::{PublishRequest, PublishResult};

/// The reports API.
#[derive(Debug, Clone)]
pub struct Reports {
    pub(crate) http: HttpClient,
}

impl Reports {
    /// Publish HTML to a secure URL.
    ///
    /// Check `result.status`: a publishing policy can hold the version for a
    /// person's approval, in which case nothing is live yet and
    /// `result.approval` names the request.
    pub async fn publish(&self, request: PublishRequest) -> Result<PublishResult> {
        self.http.post("/reports", &request).await
    }

    /// A new version of an existing report, keeping its URL and its audience.
    pub async fn update(&self, id_or_slug: &str, request: PublishRequest) -> Result<PublishResult> {
        self.http.post(format!("/reports/{}/versions", encode(id_or_slug)), &request).await
    }

    /// One report, as JSON.
    pub async fn get(&self, id_or_slug: &str) -> Result<Value> {
        self.http.request_value(RequestOptions::get(format!("/reports/{}", encode(id_or_slug)))).await
    }
}
