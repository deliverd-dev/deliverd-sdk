"""MCP Events over REST: the opt-in wait that reads a cursor."""

import json
import unittest
from typing import Any, Dict, List
from urllib.parse import urlparse

from deliverd import Deliverd
from deliverd._http import Reply


class FakeApi:
    def __init__(self, events: bool = True, decide_after: int = 1, status: str = "approved") -> None:
        self.events = events
        self.decide_after = decide_after
        self.status = status
        self.polls = 0
        self.approval = {"id": "a1", "status": "pending"}
        self.calls: List[str] = []

    def __call__(self, url, method, body, headers, timeout) -> Reply:
        path = urlparse(url).path.split("/api/v1", 1)[-1]
        self.calls.append("{} {}".format(method, path))
        if path == "/events/poll":
            if not self.events:
                return Reply(404, {}, json.dumps({"error": {"code": "not_found", "message": "Not found"}}))
            payload: Dict[str, Any] = json.loads(body.decode())
            if payload["cursor"] is None:
                return self.ok({"events": [], "cursor": "c0", "truncated": False, "hasMore": False, "nextPollMs": 1})
            self.polls += 1
            if self.polls >= self.decide_after:
                self.approval["status"] = self.status
                event = {"eventId": "evt_9", "name": "approval.decided", "timestamp": "2026-11-21T12:00:00Z",
                         "data": {"approvalId": "a1", "status": self.status}, "cursor": None}
                return self.ok({"events": [event], "cursor": "c1", "truncated": False, "hasMore": False, "nextPollMs": 1})
            return self.ok({"events": [], "cursor": "c", "truncated": False, "hasMore": False, "nextPollMs": 1})
        if path == "/approvals/a1":
            if not self.events:
                self.polls += 1
                if self.polls >= self.decide_after:
                    self.approval["status"] = self.status
            return self.ok(self.approval)
        if path == "/events":
            return self.ok({"events": [{"name": "approval.decided"}]})
        return Reply(404, {}, json.dumps({"error": {"code": "not_found", "message": "Not found"}}))

    @staticmethod
    def ok(payload: Any) -> Reply:
        return Reply(200, {}, json.dumps(payload))


class WaitForDecision(unittest.TestCase):
    def test_hears_the_decision_on_the_event(self):
        api = FakeApi(decide_after=3)
        d = Deliverd(api_key="dlv_t", transport=api)
        decided = d.events.wait_for_decision(approval_id="a1", min_poll_seconds=0)
        self.assertEqual(decided["status"], "approved")
        self.assertEqual(decided["via"], "event")
        self.assertEqual(api.calls.count("GET /approvals/a1"), 1)

    def test_falls_back_to_reading_without_events(self):
        api = FakeApi(events=False, decide_after=2, status="rejected")
        d = Deliverd(api_key="dlv_t", transport=api)
        decided = d.events.wait_for_decision(approval_id="a1", min_poll_seconds=0)
        self.assertEqual(decided, {"status": "rejected", "data": api.approval, "via": "read"})

    def test_lists_and_polls_from_now(self):
        api = FakeApi()
        d = Deliverd(api_key="dlv_t", transport=api)
        self.assertEqual([e["name"] for e in d.events.list()], ["approval.decided"])
        self.assertEqual(d.events.poll("approval.decided", {"id": "a1"})["cursor"], "c0")

    def test_needs_exactly_one_target(self):
        d = Deliverd(api_key="dlv_t", transport=FakeApi())
        with self.assertRaises(ValueError):
            d.events.wait_for_decision()


if __name__ == "__main__":
    unittest.main()
