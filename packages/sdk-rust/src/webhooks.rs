//! Verifying what Deliverd sends you.
//!
//! The scheme is Stripe's — a timestamp and a signature in one header, the
//! timestamp inside the signed material — so this is the verification everyone
//! has written before. It is here anyway because a receiver that skips it is
//! accepting anything anyone posts at the URL.
//!
//! ```
//! use deliverd::webhooks;
//!
//! # let (secret, raw_body, header) = ("whsec_…", "{}", None::<&str>);
//! // `raw_body` is the request body exactly as it arrived: a re-encoded
//! // object is a different string and will never verify.
//! match webhooks::construct_event(secret, raw_body, header) {
//!     Ok(event) => println!("{}", event.event),
//!     Err(error) => eprintln!("refused: {error}"),
//! }
//! ```

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::error::{DeliverdError, Result};
use crate::types::{CallbackEnvelope, WebhookEvent};

pub const SIGNATURE_HEADER: &str = "deliverd-signature";
pub const EVENT_HEADER: &str = "deliverd-event";
pub const DELIVERY_HEADER: &str = "deliverd-delivery";

/// How old a signature may be, in seconds. Five minutes, as the server sends.
pub const TOLERANCE_SECONDS: i64 = 300;

/// Whether `header` is this secret's signature over this body, signed within
/// the last five minutes.
pub fn verify_signature(secret: &str, body: &str, header: Option<&str>) -> bool {
    verify_signature_at(secret, body, header, now(), TOLERANCE_SECONDS)
}

/// [`verify_signature`] with the clock and the window given: for tests, and
/// for replaying a delivery you stored.
pub fn verify_signature_at(secret: &str, body: &str, header: Option<&str>, now: i64, tolerance_seconds: i64) -> bool {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return false;
    };
    let parts: HashMap<&str, &str> = header
        .split(',')
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (key.trim(), value.trim()),
            None => (part.trim(), ""),
        })
        .collect();
    let Some(timestamp) = parts.get("t").and_then(|t| t.parse::<i64>().ok()) else {
        return false;
    };
    let Some(v1) = parts.get("v1").filter(|v| !v.is_empty()) else {
        return false;
    };
    if (now - timestamp).abs() > tolerance_seconds {
        return false;
    }
    let expected = sign(secret, timestamp, body);
    // Length first, then every byte compared whatever the first mismatch, so
    // the time taken says nothing about how close a guess was.
    expected.len() == v1.len() && expected.bytes().zip(v1.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// The hex HMAC-SHA256 of `"{timestamp}.{body}"`: what the `v1` part carries.
pub fn sign(secret: &str, timestamp: i64, body: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(format!("{timestamp}.{body}").as_bytes());
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// Verify and parse in one step, the way a handler wants it.
///
/// Fails rather than returning `None`, because a webhook route that treats an
/// unverifiable body as "no event" answers 200 and tells the sender everything
/// is fine.
pub fn construct_event(secret: &str, body: &str, header: Option<&str>) -> Result<WebhookEvent> {
    verified(secret, body, header)?;
    serde_json::from_str(body)
        .map_err(|e| DeliverdError::new(400, "invalid_json", format!("The body verified but is not an event: {e}")))
}

/// Verify and parse a per-request callback: what Deliverd POSTs to the
/// `callback_url` you gave, signed with that request's own `callback_secret`.
pub fn construct_callback(callback_secret: &str, body: &str, header: Option<&str>) -> Result<CallbackEnvelope> {
    verified(callback_secret, body, header)?;
    serde_json::from_str(body)
        .map_err(|e| DeliverdError::new(400, "invalid_json", format!("The body verified but is not a callback: {e}")))
}

fn verified(secret: &str, body: &str, header: Option<&str>) -> Result<()> {
    if verify_signature(secret, body, header) {
        Ok(())
    } else {
        Err(DeliverdError::new(
            400,
            "invalid_signature",
            "The signature did not verify. Check the endpoint's secret, and that you passed the raw request body rather than a re-encoded object.",
        ))
    }
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}
