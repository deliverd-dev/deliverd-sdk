"""Context: knowledge and playbooks on the wire.

The names are the Python ones and the routes are not, so only the request that
goes out can prove ``supersedes_id`` arrives as ``supersedesId`` and that a
step's own keys (``knowledgeIds``) are left as the caller wrote them.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd import Deliverd  # noqa: E402
from deliverd._http import Reply  # noqa: E402
from test_namespaces import Spy, client  # noqa: E402

ENTRY = {
    "id": "k1",
    "url": "https://deliverd.dev/context/knowledge/k1",
    "kind": "convention",
    "kindLabel": "Convention",
    "title": "Bank details are confirmed by phone",
    "body": "Call the number on file.",
    "tags": ["payments"],
    "status": "proposed",
    "source": {"kind": "agent"},
}


class TheKnowledge(unittest.TestCase):
    def test_propose_sends_camel_case_and_reads_the_entry_back(self):
        spy = Spy({"entry": ENTRY, "resumed": False, "screening": None})
        out = client(spy).knowledge.propose(
            kind="convention", title=ENTRY["title"], body=ENTRY["body"], supersedes_id="k0", source_url="https://x.test/a"
        )
        self.assertEqual(spy.paths, ["POST /knowledge"])
        self.assertEqual(spy.calls[0]["body"]["supersedesId"], "k0")
        self.assertEqual(spy.calls[0]["body"]["sourceUrl"], "https://x.test/a")
        self.assertNotIn("tags", spy.calls[0]["body"])
        self.assertEqual(out.entry.kind_label, "Convention")

    def test_search_asks_with_the_api_s_names(self):
        spy = Spy({"entries": [ENTRY], "more": True})
        out = client(spy).knowledge.search(q="bank details", workspace_id="w1")
        self.assertEqual(spy.calls[0]["query"], {"q": "bank details", "workspaceId": "w1"})
        self.assertTrue(out.more)
        self.assertEqual(out.entries[0].title, ENTRY["title"])

    def test_a_promoted_finding_goes_under_its_task(self):
        spy = Spy({"entry": ENTRY, "resumed": False, "screening": None})
        client(spy).knowledge.promote_finding("t1", "f1", kind="decision")
        self.assertEqual(spy.paths, ["POST /tasks/t1/findings/f1/knowledge"])

    def test_the_export_and_agents_md_come_back_as_text(self):
        sent = []

        def transport(url, method, body, headers, timeout):
            sent.append((url, headers["Accept"]))
            return Reply(200, {"content-type": "text/markdown"}, "# Acme\n\n## Use UTC\n")

        deliverd = Deliverd(api_key="dlv_t", transport=transport)
        self.assertTrue(deliverd.knowledge.agents_md().startswith("# Acme"))
        self.assertIn("## Use UTC", deliverd.knowledge.export_markdown())
        self.assertIn("/knowledge/agents-md", sent[0][0])
        self.assertIn("format=markdown", sent[1][0])
        self.assertTrue(sent[0][1].startswith("text/markdown"))


class ThePlaybooks(unittest.TestCase):
    def test_a_step_keeps_the_keys_it_was_written_with(self):
        spy = Spy({"id": "p1", "status": "draft", "steps": []})
        client(spy).playbooks.draft(
            title="Onboard a supplier",
            purpose="Set up and paid safely.",
            steps=[{"title": "Pay", "instruction": "Pay.", "rule": "gate", "action": "payments.send", "knowledgeIds": ["k1"]}],
            knowledge_ids=["k2"],
        )
        body = spy.calls[0]["body"]
        self.assertEqual(body["steps"][0]["knowledgeIds"], ["k1"])
        self.assertEqual(body["knowledgeIds"], ["k2"])

    def test_start_runs_and_reads_the_objective(self):
        spy = Spy(
            {
                "objective": {"id": "tsk_1", "title": "Onboard Northwind"},
                "resumed": False,
                "playbook": {"id": "p1", "title": "Onboard a supplier", "version": 2},
                "steps": [{"key": "pay", "taskId": "tsk_2", "title": "1. Pay", "rule": "gate"}],
                "ranOlderVersion": False,
            }
        )
        out = client(spy).playbooks.start("p1", inputs={"supplier_name": "Northwind"}, external_id="onboard-northwind")
        self.assertEqual(spy.paths, ["POST /playbooks/p1/start"])
        # An input's name is the playbook's, not a Python argument: it is sent as written.
        self.assertEqual(spy.calls[0]["body"]["inputs"], {"supplier_name": "Northwind"})
        self.assertEqual(spy.calls[0]["body"]["externalId"], "onboard-northwind")
        self.assertEqual(out.objective.id, "tsk_1")
        self.assertEqual(out.steps[0]["taskId"], "tsk_2")


if __name__ == "__main__":
    unittest.main()
