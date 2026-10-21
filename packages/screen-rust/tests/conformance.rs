//! The behaviour the screening packages share, read from one table.
//!
//! `packages/conformance/screening.json` is generated from the TypeScript
//! detectors and read by the TypeScript and Python suites too. This crate is a
//! port rather than a copy, so this table is what keeps it the same.

use std::sync::LazyLock;

use deliverd_screen::{
    assess_counts, describe_counts, redact, screen_text, Classification, Counts, DataKind, DetectedSpan, Policy,
    Target, Term,
};
use serde_json::Value;

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/screening.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors are beside this package"))
        .expect("the vectors are JSON")
});

fn kind(v: &Value) -> DataKind {
    let key = v.as_str().expect("a kind");
    DataKind::from_key(key).unwrap_or_else(|| panic!("unknown kind {key}"))
}

fn classification(v: &Value) -> Classification {
    Classification::from_key(v.as_str().expect("a classification")).expect("a known classification")
}

/// The table's offsets are TypeScript's, in UTF-16 units; this crate's are
/// bytes. One past the end stays past the end, for the detector to drop.
fn byte_offset(text: &str, utf16: u64) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16() as u64;
    }
    if units >= utf16 {
        text.len()
    } else {
        text.len() + 1
    }
}

fn counts(v: &Value) -> Counts {
    v.as_object()
        .expect("counts")
        .iter()
        .map(|(k, n)| (kind(&Value::from(k.as_str())), n.as_u64().unwrap() as usize))
        .collect()
}

#[test]
fn finds_and_redacts_every_text() {
    let texts = VECTORS["texts"].as_array().expect("texts");
    assert!(!texts.is_empty());
    for case in texts {
        let text = case["text"].as_str().unwrap();
        let terms: Vec<Term> = case["terms"]
            .as_array()
            .map(|ts| {
                ts.iter()
                    .map(|t| Term {
                        term: t["term"].as_str().unwrap().to_string(),
                        label: t["label"].as_str().map(String::from),
                        classification: t.get("classification").map(classification),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let spans: Vec<DetectedSpan> = case["spans"]
            .as_array()
            .map(|ss| {
                // A kind this crate does not know cannot be a DataKind at all:
                // the type drops it, where TypeScript checks at run time.
                ss.iter()
                    .filter_map(|s| {
                        Some(DetectedSpan::new(
                            DataKind::from_key(s["kind"].as_str()?)?,
                            byte_offset(text, s["start"].as_u64()?),
                            byte_offset(text, s["end"].as_u64()?),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let found = screen_text(text, &terms, &spans);
        let got: Vec<(String, String)> =
            found.iter().map(|f| (f.kind.key().to_string(), text[f.start..f.end].to_string())).collect();
        let want: Vec<(String, String)> = case["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["kind"].as_str().unwrap().to_string(), f["value"].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(got, want, "findings in {text:?}");
        assert_eq!(redact(text, &found).text, case["redacted"].as_str().unwrap(), "redaction of {text:?}");
    }
}

#[test]
fn decides_every_case() {
    for (i, d) in VECTORS["decisions"].as_array().expect("decisions").iter().enumerate() {
        let target = d["target"].as_object().map(|t| Target {
            name: t["name"].as_str().unwrap().to_string(),
            approved_classification: t["approvedClassification"].as_str().and_then(Classification::from_key),
            personal_data: t["personalData"].as_bool().unwrap(),
            active: t["active"].as_bool().unwrap(),
        });
        let term_classification = d.get("termClassification").map_or(Classification::Confidential, classification);
        let a = assess_counts(&counts(&d["counts"]), target.as_ref(), &Policy::default(), term_classification);
        assert_eq!(a.verdict.key(), d["verdict"], "verdict of case {i}");
        assert_eq!(a.classification.key(), d["classification"], "classification of case {i}");
        assert_eq!(a.personal_data, d["personalData"], "personal data in case {i}");
        let offending: Vec<&str> = a.offending.iter().map(|k| k.key()).collect();
        let want: Vec<&str> = d["offending"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(offending, want, "offending kinds in case {i}");
    }
}

#[test]
fn describes_counts_the_same_way() {
    for d in VECTORS["descriptions"].as_array().expect("descriptions") {
        assert_eq!(describe_counts(&counts(&d["counts"])), d["text"].as_str().unwrap());
    }
}

#[test]
fn knows_every_kind_the_table_uses() {
    for case in VECTORS["texts"].as_array().unwrap() {
        for f in case["findings"].as_array().unwrap() {
            kind(&f["kind"]);
        }
    }
}
