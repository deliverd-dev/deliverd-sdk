//! `screen()` and the adapters, the way a caller uses them.

use deliverd_screen::adapters::{
    char_to_byte, default_labels, presidio_spans, token_spans, ClassifiedToken, PresidioResult,
};
use deliverd_screen::{screen, Classification, DataKind, DetectedSpan, Policy, Screen, Term, Verdict};

#[test]
fn allows_text_with_nothing_in_it_as_it_is() {
    let s = screen("Summarise the quarterly plan");
    assert_eq!((s.verdict, s.allowed, s.text.as_deref()), (Verdict::Allow, true, Some("Summarise the quarterly plan")));
    assert!(s.reasons.is_empty());
}

#[test]
fn redacts_personal_data_by_default_and_puts_it_back_in_the_answer() {
    let s = screen("Reply to mary@example.ie about the renewal");
    assert_eq!(s.verdict, Verdict::Redact);
    assert_eq!(s.text.as_deref(), Some("Reply to [EMAIL_1] about the renewal"));
    assert_eq!(s.counts.get(&DataKind::Email), Some(&1));
    assert_eq!(s.restore("Sent to [EMAIL_1]."), "Sent to mary@example.ie.");
}

#[test]
fn sends_personal_data_to_a_model_allowed_it() {
    let s = Screen::new().allow(Classification::Confidential, true).check("Reply to mary@example.ie");
    assert_eq!((s.verdict, s.text.as_deref()), (Verdict::Allow, Some("Reply to mary@example.ie")));
}

#[test]
fn denies_secrets_whatever_the_model_may_receive() {
    let s = Screen::new().allow(Classification::Restricted, true).check("key sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    assert_eq!((s.verdict, s.allowed, s.text, s.redacted), (Verdict::Deny, false, None, None));
}

#[test]
fn cannot_say_yes_to_an_ask_and_says_who_can() {
    let s = screen("Her diagnosis came back on Friday");
    assert_eq!((s.verdict, s.allowed, s.text), (Verdict::Ask, false, None));
    assert!(s.reasons.last().unwrap().contains("Data Gate"));
    assert_eq!(s.redacted.as_deref(), Some("Her diagnosis came back on Friday"));
}

#[test]
fn a_policy_can_ask_about_a_secret_instead() {
    let policy = Policy { secrets: deliverd_screen::Action::Ask, ..Policy::default() };
    assert_eq!(Screen::new().policy(policy).check("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").verdict, Verdict::Ask);
}

#[test]
fn uses_a_plugged_in_detector_for_names() {
    let names = |text: &str| {
        text.match_indices("Mary Byrne").map(|(i, m)| DetectedSpan::new(DataKind::PersonName, i, i + m.len())).collect()
    };
    let s = Screen::new().detector(names).check("Mary Byrne called; ring Mary Byrne back");
    assert_eq!(s.text.as_deref(), Some("[NAME_1] called; ring [NAME_1] back"));
}

#[test]
fn takes_terms_with_labels_and_says_which_reason() {
    let s = Screen::new().term(Term::new("Kestrel").labelled("Code name").restricted()).check("Kestrel ships Friday");
    assert_eq!(s.text.as_deref(), Some("[CODE_NAME_1] ships Friday"));
    assert!(s.reasons[0].contains("1 confidential term"), "{:?}", s.reasons);
}

#[test]
fn offsets_are_bytes_so_a_finding_slices_the_text() {
    let text = "Grüße von Zoë: zoe@example.ie, IBAN IE29 AIBK 9311 5212 3456 78 ✓";
    let s = screen(text);
    let values: Vec<&str> = s.findings.iter().map(|f| &text[f.start..f.end]).collect();
    assert_eq!(values, ["zoe@example.ie", "IE29 AIBK 9311 5212 3456 78"]);
    assert_eq!(s.text.as_deref(), Some("Grüße von Zoë: [EMAIL_1], IBAN [IBAN_1] ✓"));
}

#[test]
fn drops_a_span_that_is_not_on_a_character_boundary() {
    let text = "Zoë rang";
    let mid = text.find('ë').unwrap() + 1;
    let (findings, _) = Screen::new().detect(text, &[DetectedSpan::new(DataKind::PersonName, 0, mid)]);
    assert!(findings.is_empty());
}

#[test]
fn restores_the_longest_placeholder_first() {
    let mut s = screen("");
    s.replacements.insert("[EMAIL_1]".into(), "a@x.ie".into());
    s.replacements.insert("[EMAIL_11]".into(), "k@x.ie".into());
    assert_eq!(s.restore("[EMAIL_11] [EMAIL_1] [EMAIL_2]"), "k@x.ie a@x.ie [EMAIL_2]");
}

#[test]
fn joins_a_token_classifiers_pieces_into_one_name_with_or_without_offsets() {
    let text = "Ring Mary Byrne today";
    let tok = |label: &str, start, end, word: &str, score| ClassifiedToken {
        label: label.into(),
        score: Some(score),
        start,
        end,
        word: Some(word.into()),
    };
    let with_offsets = [
        tok("B-PER", Some(5), Some(9), "", 0.99),
        tok("I-PER", Some(10), Some(15), "", 0.98),
        tok("B-MISC", Some(16), Some(21), "", 0.9),
    ];
    let words_only = [tok("B-PER", None, None, "Mary", 0.99), tok("I-PER", None, None, "##Byrne", 0.99)];
    let unsure = [tok("PER", Some(5), Some(15), "", 0.2)];
    let name = vec![DetectedSpan::new(DataKind::PersonName, 5, 15)];
    assert_eq!(token_spans(text, &with_offsets, 0.5, default_labels), name);
    assert_eq!(token_spans(text, &words_only, 0.5, default_labels), name);
    assert!(token_spans(text, &unsure, 0.5, default_labels).is_empty());
}

#[test]
fn maps_the_common_labels() {
    for (label, kind) in [
        ("PERSON", Some(DataKind::PersonName)),
        ("private_person", Some(DataKind::PersonName)),
        ("GIVENNAME", Some(DataKind::PersonName)),
        ("EMAIL_ADDRESS", Some(DataKind::Email)),
        ("TELEPHONENUM", Some(DataKind::Phone)),
        ("CREDIT_CARD_NUMBER", Some(DataKind::PaymentCard)),
        ("ip", Some(DataKind::IpAddress)),
        ("LOC", None),
        ("person_name_x", None),
    ] {
        assert_eq!(default_labels(label), kind, "{label}");
    }
}

#[test]
fn reads_presidio_results_counting_characters() {
    let text = "Zoë in Dublin with Mary";
    let results = [
        PresidioResult { entity_type: "PERSON".into(), start: 0, end: 3, score: 0.85 },
        PresidioResult { entity_type: "LOCATION".into(), start: 7, end: 13, score: 0.9 },
        PresidioResult { entity_type: "PERSON".into(), start: 19, end: 23, score: 0.3 },
    ];
    let spans = presidio_spans(text, &results, 0.5);
    assert_eq!(spans, [DetectedSpan::new(DataKind::PersonName, 0, 4)]);
    assert_eq!(&text[spans[0].start..spans[0].end], "Zoë");
    assert_eq!(char_to_byte(text, 99), None);
}
