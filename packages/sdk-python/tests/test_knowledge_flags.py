"""knowledge.flag / list_flags / import_okf: what goes on the wire."""

import base64
import unittest

from deliverd.context import Knowledge


class FakeHttp:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def request(self, method, path, query=None, body=None, text=False):
        self.calls.append({"method": method, "path": path, "query": query, "body": body})
        return self.reply


FLAG = {
    "id": "f1",
    "reason": "out_of_date",
    "reasonLabel": "Out of date",
    "note": "The column was renamed.",
    "suggestion": None,
    "evidenceUrl": None,
    "status": "open",
    "entry": {"id": "e1", "title": "ARR", "status": "confirmed", "url": "https://deliverd.dev/context/knowledge/e1"},
    "workspaceId": None,
    "proposal": None,
    "flaggedBy": "Growth agent",
    "flaggedAt": "2026-11-22T06:00:00Z",
    "resolvedAt": None,
    "resolvedBy": None,
    "resolutionNote": None,
}


class KnowledgeFlags(unittest.TestCase):
    def test_flag_posts_camel_case(self):
        http = FakeHttp({"flag": FLAG, "resumed": False})
        out = Knowledge(http).flag("out_of_date", "The column was renamed.", entry_id="e1", evidence_url="https://x.example/run")
        self.assertEqual(http.calls[0]["path"], "/knowledge/flags")
        self.assertEqual(http.calls[0]["body"], {"entryId": "e1", "reason": "out_of_date", "note": "The column was renamed.", "evidenceUrl": "https://x.example/run"})
        self.assertEqual(out.flag.reason_label, "Out of date")
        self.assertFalse(out.resumed)

    def test_list_flags_pages(self):
        http = FakeHttp({"flags": [FLAG], "nextCursor": "abc"})
        page = Knowledge(http).list_flags(status="all", cursor="xyz")
        self.assertEqual(http.calls[0]["query"]["cursor"], "xyz")
        self.assertEqual(page.next_cursor, "abc")
        self.assertEqual(page.flags[0].entry["id"], "e1")

    def test_propose_names_the_flags_it_answers(self):
        http = FakeHttp({"entry": {}, "resumed": False, "screening": None})
        Knowledge(http).propose("fact", "t", "b", supersedes_id="e1", answers_flag_ids=["f1"])
        self.assertEqual(http.calls[0]["body"]["answersFlagIds"], ["f1"])
        self.assertEqual(http.calls[0]["body"]["supersedesId"], "e1")

    def test_import_okf_files_or_zip(self):
        http = FakeHttp({"created": [], "skipped": [], "format": "okf"})
        k = Knowledge(http)
        out = k.import_okf(files={"metrics/revenue.md": "---\ntype: Metric\n---\nNet."})
        self.assertEqual(http.calls[0]["body"]["files"], [{"path": "metrics/revenue.md", "content": "---\ntype: Metric\n---\nNet."}])
        self.assertEqual(out.format, "okf")
        k.import_okf(zip_bytes=b"PK\x03\x04")
        self.assertEqual(base64.b64decode(http.calls[1]["body"]["zipBase64"]), b"PK\x03\x04")
        with self.assertRaises(ValueError):
            k.import_okf()


if __name__ == "__main__":
    unittest.main()
