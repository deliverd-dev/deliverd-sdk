"""Screening, in Python.

The vectors are shared with the TypeScript SDK: the same text has to give the
same findings, the same redaction and the same verdict in both, or the answer
an organisation tested is not the one its Python agent got.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from deliverd import Deliverd, DevelopmentOptions, redact, screen_text
from deliverd.data_screen import ScreenTarget, assess_counts

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "conformance" / "screening.json").read_text("utf-8"))


def check_text(case):
    found = screen_text(case["text"], case.get("terms") or [])
    assert [{"kind": f.kind, "value": case["text"][f.start : f.end]} for f in found] == case["findings"], case["text"]
    assert redact(case["text"], found).text == case["redacted"]


def check_decision(case):
    t = case["target"]
    target = (
        ScreenTarget(
            name=t["name"],
            approved_classification=t["approvedClassification"],
            personal_data=t["personalData"],
            active=t["active"],
        )
        if t
        else None
    )
    a = assess_counts(case["counts"], target, None, case.get("termClassification") or "confidential")
    assert (a.verdict, a.classification, a.personal_data, a.offending) == (
        case["verdict"],
        case["classification"],
        case["personalData"],
        case["offending"],
    )


def quiet(**kwargs):
    return Deliverd(mode="development", development=DevelopmentOptions(log=False, **kwargs))


def _t_sends_counts_never_the_text():
    sent = []

    def transport(method, url, body, headers, timeout):
        from deliverd._http import Reply

        sent.append(body.decode("utf-8"))
        return Reply(
            200,
            {"content-type": "application/json"},
            json.dumps(
                {
                    "verdict": "redact",
                    "allowed": True,
                    "classification": "confidential",
                    "personalData": True,
                    "categories": ["personal"],
                    "counts": {"email": 1},
                    "offending": ["email"],
                    "reasons": ["It contains 1 email address."],
                    "target": None,
                    "findings": None,
                    "redactedText": None,
                    "approval": None,
                }
            ),
        )

    client = Deliverd(api_key="dlv_test", transport=transport)
    screened = client.screen("Reply to mary@example.ie")
    assert "mary" not in sent[0]
    assert json.loads(sent[0])["counts"] == {"email": 1}
    assert screened.allowed
    assert screened.text == "Reply to [EMAIL_1]"
    assert screened.restore("Sent to [EMAIL_1].") == "Sent to mary@example.ie."


def _t_allows_an_ordinary_prompt_offline():
    screened = quiet().screen("Summarise the board pack in three bullets.")
    assert screened.verdict == "allow"
    assert screened.text == "Summarise the board pack in three bullets."


def _t_refuses_a_secret_offline():
    screened = quiet().screen("use AKIAIOSFODNN7EXAMPLE")
    assert screened.verdict == "deny"
    assert not screened
    assert screened.text is None


def _t_asks_a_person_and_sends_the_original_once_they_agree_offline():
    screened = quiet().screen("Her diagnosis was confirmed")
    assert screened.verdict == "ask"
    assert screened.allowed
    assert screened.text == "Her diagnosis was confirmed"


def _t_does_not_send_when_the_person_says_no_offline():
    screened = quiet(outcome="rejected").screen("Her diagnosis was confirmed")
    assert not screened.allowed
    assert screened.text is None


class ScreeningTest(unittest.TestCase):
    def test_finds_and_redacts_like_typescript(self):
        for case in VECTORS["texts"]:
            with self.subTest(case["text"]):
                check_text(case)

    def test_decides_like_typescript(self):
        for i, case in enumerate(VECTORS["decisions"]):
            with self.subTest(i):
                check_decision(case)

    def test_sends_counts_never_the_text(self):
        _t_sends_counts_never_the_text()

    def test_allows_an_ordinary_prompt_offline(self):
        _t_allows_an_ordinary_prompt_offline()

    def test_refuses_a_secret_offline(self):
        _t_refuses_a_secret_offline()

    def test_asks_a_person_and_sends_the_original_once_they_agree_offline(self):
        _t_asks_a_person_and_sends_the_original_once_they_agree_offline()

    def test_does_not_send_when_the_person_says_no_offline(self):
        _t_does_not_send_when_the_person_says_no_offline()


if __name__ == "__main__":
    unittest.main()
