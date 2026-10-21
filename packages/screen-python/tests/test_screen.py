"""Deliverd Screen in Python, held to the vectors the TypeScript package and both SDKs share."""

from __future__ import annotations

import io
import json
import re
import unittest
from pathlib import Path

from deliverd_screen import __version__, screen
from deliverd_screen.adapters import presidio, token_classifier
from deliverd_screen.cli import main
from deliverd_screen.data_screen import DetectedSpan, ScreenTarget, assess_counts, describe_counts, redact, screen_text

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT.parent / "conformance" / "screening.json").read_text("utf-8"))


class Vectors(unittest.TestCase):
    def test_texts(self):
        for case in VECTORS["texts"]:
            found = screen_text(case["text"], case.get("terms") or [], case.get("spans") or [])
            self.assertEqual([{"kind": f.kind, "value": case["text"][f.start : f.end]} for f in found], case["findings"], case["text"])
            self.assertEqual(redact(case["text"], found).text, case["redacted"])

    def test_decisions(self):
        for case in VECTORS["decisions"]:
            t = case["target"]
            target = ScreenTarget(t["name"], t["approvedClassification"], t["personalData"], t["active"]) if t else None
            a = assess_counts(case["counts"], target, None, case.get("termClassification") or "confidential")
            self.assertEqual((a.verdict, a.classification, a.personal_data, a.offending), (case["verdict"], case["classification"], case["personalData"], case["offending"]))

    def test_descriptions(self):
        for case in VECTORS["descriptions"]:
            self.assertEqual(describe_counts(case["counts"]), case["text"])


class Screen(unittest.TestCase):
    def test_allow(self):
        s = screen("Summarise the quarterly plan")
        self.assertEqual((s.verdict, s.text, s.reasons), ("allow", "Summarise the quarterly plan", []))

    def test_redact_and_restore(self):
        s = screen("Reply to mary@example.ie about the renewal")
        self.assertEqual(s.text, "Reply to [EMAIL_1] about the renewal")
        self.assertEqual(s.restore("Sent to [EMAIL_1]."), "Sent to mary@example.ie.")

    def test_allowed_personal_data(self):
        self.assertEqual(screen("Reply to mary@example.ie", personal_data=True, classification="confidential").verdict, "allow")

    def test_deny_secret(self):
        s = screen("key sk-ant-abcdefghijklmnopqrstuvwxyz0123", personal_data=True, classification="restricted")
        self.assertEqual((s.verdict, s.allowed, s.text), ("deny", False, None))

    def test_ask_cannot_be_answered_here(self):
        s = screen("Her diagnosis came back on Friday")
        self.assertEqual((s.verdict, s.allowed), ("ask", False))
        self.assertIn("Data Gate", s.reasons[-1])

    def test_detector_for_names(self):
        def names(text):
            return [DetectedSpan("person_name", m.start(), m.end()) for m in re.finditer("Mary Byrne", text)]

        self.assertEqual(screen("Mary Byrne called; ring Mary Byrne back", detectors=[names]).text, "[NAME_1] called; ring [NAME_1] back")


class Adapters(unittest.TestCase):
    def test_token_classifier(self):
        text = "Ring Mary Byrne today"
        with_offsets = token_classifier(lambda _: [
            {"entity": "B-PER", "start": 5, "end": 9, "score": 0.99},
            {"entity": "I-PER", "start": 10, "end": 15, "score": 0.98},
            {"entity": "B-MISC", "start": 16, "end": 21, "score": 0.9},
        ])
        aggregated = token_classifier(lambda _: [{"entity_group": "PER", "start": 5, "end": 15, "score": 0.97, "word": "Mary Byrne"}])
        words_only = token_classifier(lambda _: [{"entity": "B-PER", "word": "Mary", "score": 0.9}, {"entity": "I-PER", "word": "Byrne", "score": 0.9}])
        unsure = token_classifier(lambda _: [{"entity_group": "PER", "start": 5, "end": 15, "score": 0.2}])
        for d in (with_offsets, aggregated, words_only):
            self.assertEqual(d(text), [DetectedSpan("person_name", 5, 15)])
        self.assertEqual(unsure(text), [])

    def test_presidio(self):
        class Result:
            def __init__(self, entity_type, start, end, score):
                self.entity_type, self.start, self.end, self.score = entity_type, start, end, score

        class Analyzer:
            def analyze(self, text, language, entities):
                return [Result("PERSON", 0, 4, 0.85), Result("LOCATION", 8, 14, 0.9)]

        self.assertEqual(presidio(Analyzer())("Mary in Dublin"), [DetectedSpan("person_name", 0, 4)])


class Cli(unittest.TestCase):
    def run_cli(self, args, text):
        out, err = io.StringIO(), io.StringIO()
        code = main(args, stdin=io.StringIO(text), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def test_redact(self):
        self.assertEqual(self.run_cli(["--redact"], "Ring +353 87 123 4567")[:2], (0, "Ring [PHONE_1]"))

    def test_fail_never_prints_values(self):
        code, out, _ = self.run_cli(["--fail", "--json"], "mary@example.ie")
        self.assertEqual(code, 1)
        self.assertNotIn("mary", out)
        self.assertEqual(json.loads(out)["counts"], {"email": 1})

    def test_pass(self):
        self.assertEqual(self.run_cli(["--fail"], "nothing here")[0], 0)


class Packaging(unittest.TestCase):
    def test_version(self):
        self.assertIn('version = "{}"'.format(__version__), (ROOT / "pyproject.toml").read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
