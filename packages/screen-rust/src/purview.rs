//! Microsoft Purview's answer on a text, held beside the screen's own.
//!
//! An organisation that runs Microsoft Purview has already written its data
//! loss prevention (DLP) policies there. An app can ask Purview about a text
//! before it is sent to a model, through Microsoft Graph's `processContent`,
//! and Purview answers with what the app must do: nothing, or a restriction
//! of `audit`, `warn` or `block`. The stricter of Purview's answer and the
//! screen's own wins:
//!
//! - `block`: nothing is sent. Your organisation's own policy said so.
//! - `warn`: a person decides ([`Verdict::Ask`]), which nobody here can.
//! - `audit`: no hold. Purview has recorded the activity itself.
//!
//! When Purview cannot be reached, you choose in advance what that means with
//! [`OnUnavailable`], and the reason says honestly that Purview did not answer.
//!
//! The rules here are the Rust half of `packages/core/src/purview.ts`, rule
//! for rule. With the `purview` feature, [`PurviewClient`] makes the call too:
//! from where your code runs, straight to Microsoft Graph, with your own Entra
//! app, so the text goes to Microsoft and nowhere else. Without it, call
//! `processContent` with an HTTP client of your own, read the answer with
//! [`outcome_from_actions`], and hand the check to
//! [`Screen::purview`](crate::Screen::purview).

use crate::Verdict;

/// What a Purview policy action says to do with the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Restriction {
    Audit,
    Warn,
    Block,
}

impl Restriction {
    pub fn key(self) -> &'static str {
        match self {
            Self::Audit => "audit",
            Self::Warn => "warn",
            Self::Block => "block",
        }
    }

    /// Anything Purview says that this code does not know is a block: a DLP
    /// rule not understood is not a reason to send the text.
    pub fn from_key(key: Option<&str>) -> Self {
        match key {
            Some("audit") => Self::Audit,
            Some("warn") => Self::Warn,
            _ => Self::Block,
        }
    }
}

/// What to do when Purview cannot be reached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OnUnavailable {
    /// Send it, unchecked by Purview, and say so.
    Allow,
    /// A person decides whether to send it unchecked. The default.
    #[default]
    Ask,
    /// Send nothing Purview has not checked.
    Deny,
}

impl OnUnavailable {
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// Purview's answer on one text. Never the text itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PurviewOutcome {
    /// The strictest restriction among Purview's policy actions; `None` when
    /// there were none.
    pub restriction: Option<Restriction>,
    /// How many policy actions Purview returned.
    pub actions: usize,
    /// Purview said the organisation's policies changed since the last check.
    pub scope_modified: bool,
    /// Purview could not be reached; `restriction` is what you chose for that.
    pub unavailable: bool,
}

/// The outcome of a `processContent` response, from the `restrictionAction`
/// of each of its `policyActions` and its `protectionScopeState`.
pub fn outcome_from_actions<'s>(
    restriction_actions: impl IntoIterator<Item = Option<&'s str>>,
    scope_state: Option<&str>,
) -> PurviewOutcome {
    let mut restriction: Option<Restriction> = None;
    let mut actions = 0;
    for given in restriction_actions {
        actions += 1;
        let r = Restriction::from_key(given);
        if restriction.is_none_or(|have| r > have) {
            restriction = Some(r);
        }
    }
    PurviewOutcome { restriction, actions, scope_modified: scope_state == Some("modified"), unavailable: false }
}

/// The outcome when Purview could not be reached, by your choice.
pub fn unavailable(on_unavailable: OnUnavailable) -> PurviewOutcome {
    let restriction = match on_unavailable {
        OnUnavailable::Deny => Some(Restriction::Block),
        OnUnavailable::Ask => Some(Restriction::Warn),
        OnUnavailable::Allow => None,
    };
    PurviewOutcome { restriction, actions: 0, scope_modified: false, unavailable: true }
}

fn rank(v: Verdict) -> u8 {
    match v {
        Verdict::Allow => 0,
        Verdict::Redact => 1,
        Verdict::Ask => 2,
        Verdict::Deny => 3,
    }
}

/// The screen's verdict with Purview's held beside it: the stricter wins, and
/// the reason says it was Purview.
pub fn apply(verdict: Verdict, reasons: &mut Vec<String>, outcome: &PurviewOutcome) -> Verdict {
    let mut v = verdict;
    let mut raise = |to: Verdict| {
        if rank(to) > rank(v) {
            v = to;
        }
    };
    let reason = if outcome.unavailable {
        match outcome.restriction {
            Some(Restriction::Block) => {
                raise(Verdict::Deny);
                "Microsoft Purview could not be reached, and this agent is set not to send text Purview has not checked."
            }
            Some(Restriction::Warn) => {
                raise(Verdict::Ask);
                "Microsoft Purview could not be reached, so a person decides whether to send it unchecked."
            }
            _ => "Microsoft Purview could not be reached, so this was not checked against your Purview policies.",
        }
    } else {
        match outcome.restriction {
            Some(Restriction::Block) => {
                raise(Verdict::Deny);
                "Your organisation's Microsoft Purview policy blocks sending this text."
            }
            Some(Restriction::Warn) => {
                raise(Verdict::Ask);
                "Your organisation's Microsoft Purview policy warns about this text, so a person decides."
            }
            _ => return v,
        }
    };
    reasons.push(reason.to_string());
    v
}

#[cfg(feature = "purview")]
mod client {
    use super::{outcome_from_actions, unavailable, OnUnavailable, PurviewOutcome};
    use serde_json::{json, Value};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const GRAPH: &str = "https://graph.microsoft.com/v1.0";

    fn is_guid(s: &str) -> bool {
        let parts: Vec<&str> = s.split('-').collect();
        parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12])
            && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    fn uuid() -> String {
        // A version 4 shape from the clock and a counter: an identifier for
        // Purview to group texts by, not a secret.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) as u64;
        let n = N.fetch_add(1, Ordering::Relaxed);
        let a = t ^ n.rotate_left(17) ^ 0x9e37_79b9_7f4a_7c15;
        let b = t.rotate_left(29).wrapping_mul(0xbf58_476d_1ce4_e5b9) ^ n;
        format!(
            "{:08x}-{:04x}-4{:03x}-{:x}{:03x}-{:012x}",
            (a >> 32) as u32,
            (a >> 16) as u16,
            (a & 0xfff) as u16,
            8 + (b >> 62) as u8,
            ((b >> 48) & 0xfff) as u16,
            b & 0xffff_ffff_ffff
        )
    }

    fn now_iso() -> String {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let days = secs / 86_400;
        let rem = secs % 86_400;
        // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
    }

    /// The body `processContent` takes for a prompt about to be sent to a
    /// model.
    pub fn process_content_body(
        text: &str,
        app_name: &str,
        entra_app_id: &str,
        correlation_id: &str,
        sequence: u64,
    ) -> Value {
        let now = now_iso();
        json!({
            "contentToProcess": {
                "contentEntries": [{
                    "@odata.type": "microsoft.graph.processConversationMetadata",
                    "identifier": uuid(),
                    "content": { "@odata.type": "microsoft.graph.textContent", "data": text },
                    "name": format!("{app_name} prompt"),
                    "correlationId": correlation_id,
                    "sequenceNumber": sequence,
                    "isTruncated": false,
                    "createdDateTime": now,
                    "modifiedDateTime": now,
                }],
                "activityMetadata": { "activity": "uploadText" },
                "deviceMetadata": {},
                "protectedAppMetadata": {
                    "name": app_name,
                    "version": "1.0",
                    "applicationLocation": { "@odata.type": "microsoft.graph.policyLocationApplication", "value": entra_app_id },
                },
                "integratedAppMetadata": { "name": app_name, "version": "1.0" },
            }
        })
    }

    /// The outcome of a `processContent` response body.
    pub fn outcome_from_response(body: &Value) -> PurviewOutcome {
        let actions = body.get("policyActions").and_then(Value::as_array).cloned().unwrap_or_default();
        outcome_from_actions(
            actions.iter().map(|a| a.get("restrictionAction").and_then(Value::as_str)),
            body.get("protectionScopeState").and_then(Value::as_str),
        )
    }

    struct State {
        token: Option<(String, Instant)>,
        etag: Option<String>,
        sequence: u64,
    }

    /// Asks your organisation's Purview about a text, as an Entra app acting
    /// as itself (client credentials) on behalf of one user.
    ///
    /// The app needs the Microsoft Graph application permission
    /// `Content.Process.All` with admin consent. Purview applies DLP policies
    /// to an Entra-registered app only when they were created with
    /// `New-DlpComplianceRule`; one made in the portal alone does not apply.
    pub struct PurviewClient {
        tenant_id: String,
        client_id: String,
        client_secret: String,
        user_id: String,
        app_name: String,
        on_unavailable: OnUnavailable,
        correlation_id: String,
        agent: ureq::Agent,
        state: Mutex<State>,
    }

    impl PurviewClient {
        /// `tenant_id`, `client_id` and `user_id` are GUIDs: your Entra
        /// tenant, the app, and the object id of the person the text is for.
        pub fn new(tenant_id: &str, client_id: &str, client_secret: &str, user_id: &str) -> Result<Self, String> {
            for (name, v) in [("tenant id", tenant_id), ("client id", client_id), ("user id", user_id)] {
                if !is_guid(v) {
                    return Err(format!("Microsoft Purview: the {name} is a GUID."));
                }
            }
            let agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(10)))
                .http_status_as_error(false)
                .build()
                .into();
            Ok(Self {
                tenant_id: tenant_id.to_string(),
                client_id: client_id.to_string(),
                client_secret: client_secret.to_string(),
                user_id: user_id.to_string(),
                app_name: "Deliverd Screen".to_string(),
                on_unavailable: OnUnavailable::default(),
                correlation_id: uuid(),
                agent,
                state: Mutex::new(State { token: None, etag: None, sequence: 0 }),
            })
        }

        /// How Purview names the app. Default "Deliverd Screen".
        pub fn app_name(mut self, name: impl Into<String>) -> Self {
            self.app_name = name.into();
            self
        }

        /// What to do when Purview cannot be reached. Default ask.
        pub fn on_unavailable(mut self, choice: OnUnavailable) -> Self {
            self.on_unavailable = choice;
            self
        }

        /// From `DELIVERD_PURVIEW_TENANT_ID`, `_CLIENT_ID`, `_CLIENT_SECRET`
        /// and `_USER_ID`, with optional `_APP_NAME` and `_ON_UNAVAILABLE`:
        /// the same variables as the TypeScript and Python packages. `None`
        /// when none is set; an error when only some are.
        pub fn from_env() -> Result<Option<Self>, String> {
            Self::from_vars(|k| std::env::var(k).ok())
        }

        pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
            const REQUIRED: [&str; 4] = [
                "DELIVERD_PURVIEW_TENANT_ID",
                "DELIVERD_PURVIEW_CLIENT_ID",
                "DELIVERD_PURVIEW_CLIENT_SECRET",
                "DELIVERD_PURVIEW_USER_ID",
            ];
            let v = |k: &str| get(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let set: Vec<&str> = REQUIRED.iter().copied().filter(|k| v(k).is_some()).collect();
            if set.is_empty() {
                return Ok(None);
            }
            if set.len() < REQUIRED.len() {
                let missing: Vec<&str> = REQUIRED.iter().copied().filter(|k| !set.contains(k)).collect();
                return Err(format!(
                    "Microsoft Purview needs all of {}; missing {}.",
                    REQUIRED.join(", "),
                    missing.join(", ")
                ));
            }
            let on = match v("DELIVERD_PURVIEW_ON_UNAVAILABLE") {
                None => OnUnavailable::Ask,
                Some(s) => {
                    OnUnavailable::from_key(&s).ok_or("DELIVERD_PURVIEW_ON_UNAVAILABLE is allow, ask or deny.")?
                }
            };
            let mut c = Self::new(
                &v(REQUIRED[0]).unwrap_or_default(),
                &v(REQUIRED[1]).unwrap_or_default(),
                &v(REQUIRED[2]).unwrap_or_default(),
                &v(REQUIRED[3]).unwrap_or_default(),
            )?
            .on_unavailable(on);
            if let Some(name) = v("DELIVERD_PURVIEW_APP_NAME") {
                c = c.app_name(name);
            }
            Ok(Some(c))
        }

        fn token(&self, state: &mut State) -> Option<String> {
            if let Some((t, until)) = &state.token {
                if Instant::now() < *until {
                    return Some(t.clone());
                }
            }
            let url = format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", self.tenant_id);
            let mut res = self
                .agent
                .post(&url)
                .send_form([
                    ("grant_type", "client_credentials"),
                    ("client_id", self.client_id.as_str()),
                    ("client_secret", self.client_secret.as_str()),
                    ("scope", "https://graph.microsoft.com/.default"),
                ])
                .ok()?;
            if !res.status().is_success() {
                return None;
            }
            let body: Value = res.body_mut().read_json().ok()?;
            let token = body.get("access_token")?.as_str()?.to_string();
            let life = body.get("expires_in").and_then(Value::as_u64).unwrap_or(3600).saturating_sub(300);
            state.token = Some((token.clone(), Instant::now() + Duration::from_secs(life)));
            Some(token)
        }

        /// Ask Purview about one text.
        pub fn check(&self, text: &str) -> PurviewOutcome {
            let Ok(mut state) = self.state.lock() else { return unavailable(self.on_unavailable) };
            let Some(token) = self.token(&mut state) else { return unavailable(self.on_unavailable) };
            let body =
                process_content_body(text, &self.app_name, &self.client_id, &self.correlation_id, state.sequence);
            state.sequence += 1;
            let url = format!("{GRAPH}/users/{}/dataSecurityAndGovernance/processContent", self.user_id);
            let mut req = self.agent.post(&url).header("Authorization", &format!("Bearer {token}"));
            if let Some(etag) = &state.etag {
                req = req.header("If-None-Match", etag);
            }
            let Ok(mut res) = req.send_json(&body) else { return unavailable(self.on_unavailable) };
            let status = res.status().as_u16();
            if status == 202 || status == 204 {
                return PurviewOutcome::default();
            }
            if !res.status().is_success() {
                return unavailable(self.on_unavailable);
            }
            if let Some(etag) = res.headers().get("ETag").and_then(|v| v.to_str().ok()) {
                state.etag = Some(etag.to_string());
            }
            match res.body_mut().read_json::<Value>() {
                Ok(v) => outcome_from_response(&v),
                Err(_) => unavailable(self.on_unavailable),
            }
        }
    }
}

#[cfg(feature = "purview")]
pub use client::{outcome_from_response, process_content_body, PurviewClient};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_strictest_action_wins_and_an_unknown_one_is_a_block() {
        let o = outcome_from_actions([Some("audit"), Some("warn")], Some("notModified"));
        assert_eq!(o.restriction, Some(Restriction::Warn));
        assert_eq!(o.actions, 2);
        assert!(!o.scope_modified);
        assert_eq!(
            outcome_from_actions([Some("audit"), Some("restrictAccess")], None).restriction,
            Some(Restriction::Block)
        );
        assert_eq!(
            outcome_from_actions([], Some("modified")),
            PurviewOutcome { scope_modified: true, ..Default::default() }
        );
    }

    #[test]
    fn a_block_denies_a_warn_asks_and_an_audit_holds_nothing() {
        let mut r = vec![];
        assert_eq!(apply(Verdict::Redact, &mut r, &outcome_from_actions([Some("block")], None)), Verdict::Deny);
        assert_eq!(apply(Verdict::Allow, &mut r, &outcome_from_actions([Some("warn")], None)), Verdict::Ask);
        assert_eq!(apply(Verdict::Deny, &mut r, &outcome_from_actions([Some("warn")], None)), Verdict::Deny);
        let before = r.len();
        assert_eq!(apply(Verdict::Allow, &mut r, &outcome_from_actions([Some("audit")], None)), Verdict::Allow);
        assert_eq!(r.len(), before);
    }

    #[test]
    fn when_purview_is_away_the_choice_made_beforehand_stands_and_says_so() {
        let mut r = vec![];
        assert_eq!(apply(Verdict::Allow, &mut r, &unavailable(OnUnavailable::Deny)), Verdict::Deny);
        assert_eq!(apply(Verdict::Allow, &mut r, &unavailable(OnUnavailable::Ask)), Verdict::Ask);
        assert_eq!(apply(Verdict::Redact, &mut r, &unavailable(OnUnavailable::Allow)), Verdict::Redact);
        assert!(r.iter().all(|s| s.contains("could not be reached")));
        assert_eq!(r.len(), 3);
    }

    #[cfg(feature = "purview")]
    #[test]
    fn reads_a_process_content_answer_and_builds_a_body_with_the_app() {
        let o = outcome_from_response(
            &serde_json::json!({ "policyActions": [{ "restrictionAction": "block" }], "protectionScopeState": "modified" }),
        );
        assert_eq!((o.restriction, o.actions, o.scope_modified), (Some(Restriction::Block), 1, true));
        let b = process_content_body("hello", "Claims assistant", "11111111-1111-1111-1111-111111111111", "c", 3);
        let entry = &b["contentToProcess"]["contentEntries"][0];
        assert_eq!(entry["content"]["data"], "hello");
        assert_eq!(entry["sequenceNumber"], 3);
        assert_eq!(
            b["contentToProcess"]["protectedAppMetadata"]["applicationLocation"]["value"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert!(entry["createdDateTime"].as_str().is_some_and(|s| s.len() == 20 && s.ends_with('Z')));
    }

    #[cfg(feature = "purview")]
    #[test]
    fn from_vars_wants_all_four_or_none() {
        assert!(PurviewClient::from_vars(|_| None).is_ok_and(|c| c.is_none()));
        let some = PurviewClient::from_vars(|k| (k == "DELIVERD_PURVIEW_TENANT_ID").then(|| "x".to_string()));
        assert!(some.is_err_and(|e| e.contains("missing")));
    }
}
