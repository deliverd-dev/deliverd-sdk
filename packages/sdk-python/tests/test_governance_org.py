"""Compliance Mode across the organisation, as the wire sees it.

``deliverd.governance`` and the governance calls on tasks beyond evidence and
the gate: the routes, the methods and the bodies, with the Python names turned
into the API's. ``packages/sdk/src/governance.test.ts`` holds the TypeScript
SDK to the same routes.
"""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd import AiIncidentDetail, AiSystem, Deliverd, DeliverdError  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402
from test_governance import GOVERNANCE  # noqa: E402
from test_namespaces import Spy, client  # noqa: E402
from test_tasks import task  # noqa: E402

SYSTEM = {
    "id": "sys_1",
    "orgId": "org_1",
    "name": "Claims triage",
    "provider": "Anthropic",
    "model": "claude",
    "modelVersion": None,
    "promptHash": "sha256:ab",
    "guardrailsHash": None,
    "purpose": None,
    "businessOwner": None,
    "technicalOwner": None,
    "environment": "production",
    "risk": "high",
    "oversight": None,
    "dataClassification": None,
    "personalData": True,
    "customerFacing": False,
    "status": "active",
    "ictArrangementId": None,
    "createdByLabel": "Agent",
    "createdAt": "2026-10-20T00:00:00Z",
    "updatedAt": "2026-10-20T00:00:00Z",
}

INCIDENT = {
    "id": "inc_1",
    "taskId": "tsk_1",
    "aiSystemId": "sys_1",
    "title": "Wrong payout",
    "description": "",
    "severity": "high",
    "status": "open",
    "reportedByLabel": "Agent",
    "reportedByAgentId": None,
    "reportedAt": "2026-10-20T00:00:00Z",
    "resolution": None,
    "resolvedByLabel": None,
    "resolvedAt": None,
    "detectedAt": "2026-10-20T00:00:00Z",
    "dora": None,
    "doraMajorAt": None,
    "doraClassifiedAt": None,
    "doraClassifiedBy": None,
}

STEP = {"kind": "initial", "dueAt": "2026-10-20T04:00:00Z", "submittedAt": None, "overdue": False, "late": False}
DETAIL = dict(
    INCIDENT,
    url="https://deliverd.dev/governance/incidents/inc_1",
    reports=[],
    schedule={"required": True, "steps": [STEP], "next": STEP},
    reclassificationOwed=False,
)


class TheRegister(unittest.TestCase):
    def test_lists_gets_registers_updates_and_records_a_model_change(self):
        spy = Spy(
            {"aiSystems": [SYSTEM]},
            {"system": SYSTEM, "governedTaskIds": ["tsk_1"]},
            SYSTEM,
            SYSTEM,
            {"system": SYSTEM, "reassessments": [], "changed": ["modelVersion"]},
        )
        systems = client(spy).governance.ai_systems
        listed = systems.list(status="active")
        detail = systems.get("sys 1")
        systems.register("Claims triage", provider="Anthropic", prompt_hash="sha256:ab", personal_data=True)
        systems.update("sys_1", risk="critical", ict_arrangement_id="arr_1")
        change = systems.record_model_change("sys_1", model_version="2026-10", note="New version")
        self.assertIsInstance(listed[0], AiSystem)
        self.assertEqual(detail.system.name, "Claims triage")
        self.assertEqual(detail.governed_task_ids, ["tsk_1"])
        self.assertEqual(change.changed, ["modelVersion"])
        self.assertEqual(
            spy.paths,
            [
                "GET /ai-systems",
                "GET /ai-systems/sys%201",
                "POST /ai-systems",
                "PATCH /ai-systems/sys_1",
                "POST /ai-systems/sys_1/model-change",
            ],
        )
        self.assertEqual(spy.calls[0]["query"], {"status": "active"})
        self.assertEqual(spy.calls[2]["body"], {"name": "Claims triage", "provider": "Anthropic", "promptHash": "sha256:ab", "personalData": True})
        self.assertEqual(spy.calls[3]["body"], {"risk": "critical", "ictArrangementId": "arr_1"})
        self.assertEqual(spy.calls[4]["body"], {"modelVersion": "2026-10", "note": "New version"})


class Authority(unittest.TestCase):
    def test_asks_what_an_agent_may_do(self):
        spy = Spy({"action": "send", "mode": "approval", "source": "organisation", "reason": "…", "agentId": None, "agentName": None})
        decision = client(spy).governance.check_authority("send")
        self.assertEqual(decision.mode, "approval")
        self.assertEqual(spy.paths, ["POST /governance/authority/evaluate"])
        self.assertEqual(spy.calls[0]["body"], {"action": "send"})


class TheIncidents(unittest.TestCase):
    def test_reports_reads_lists_and_drafts(self):
        spy = Spy(
            INCIDENT,
            DETAIL,
            {"items": [INCIDENT], "nextCursor": "c2"},
            {"items": [INCIDENT], "nextCursor": None},
            {"incident": DETAIL, "reportId": "rep_1", "approvalId": "apr_1", "approvalUrl": "https://deliverd.dev/a/apr_1"},
        )
        incidents = client(spy).governance.incidents
        incidents.report("Wrong payout", "high", task_id="tsk_1", detected_at="2026-10-20T00:00:00Z")
        detail = incidents.get("inc_1")
        listed = incidents.list(status="open", ai_system_id="sys_1")
        drafted = incidents.draft_report("inc_1", "initial", "What happened", fields={"memberStates": ["IE"]}, approvers=["cro@example.com"])
        self.assertIsInstance(detail, AiIncidentDetail)
        self.assertEqual(detail.schedule.next.kind, "initial")
        self.assertEqual(len(listed), 2)
        self.assertEqual(drafted.approval_id, "apr_1")
        self.assertEqual(drafted.incident.title, "Wrong payout")
        self.assertEqual(
            spy.paths,
            [
                "POST /governance/incidents",
                "GET /governance/incidents/inc_1",
                "GET /governance/incidents",
                "GET /governance/incidents",
                "POST /governance/incidents/inc_1/reports",
            ],
        )
        self.assertEqual(spy.calls[0]["body"], {"taskId": "tsk_1", "title": "Wrong payout", "severity": "high", "detectedAt": "2026-10-20T00:00:00Z"})
        self.assertEqual(spy.calls[2]["query"], {"status": "open", "aiSystemId": "sys_1"})
        self.assertEqual(spy.calls[3]["query"]["cursor"], "c2")
        self.assertEqual(
            spy.calls[4]["body"],
            {"kind": "initial", "content": "What happened", "fields": {"memberStates": ["IE"]}, "approvers": ["cro@example.com"]},
        )


class TheReadOnlyViews(unittest.TestCase):
    def test_frameworks_mapping_custom_register_and_summary(self):
        spy = Spy({"frameworks": []})
        governance = client(spy).governance
        governance.frameworks()
        governance.framework_mapping(task_id="tsk_1", framework="eu_ai_act")
        governance.create_custom_framework(
            "custom_underwriting",
            "1.0",
            "Underwriting AI standard",
            [{"ref": "UW-1", "title": "A person signs off every decline", "controls": ["human_oversight"], "applies_when": {"min_risk": "high"}}],
        )
        governance.ict_register()
        governance.summary(risk="high", data_classification="confidential")
        self.assertEqual(
            spy.paths,
            [
                "GET /governance/frameworks",
                "GET /governance/frameworks/mapping",
                "POST /governance/frameworks",
                "GET /governance/ict-register",
                "GET /governance/summary",
            ],
        )
        self.assertEqual(spy.calls[1]["query"], {"taskId": "tsk_1", "framework": "eu_ai_act"})
        self.assertEqual(
            spy.calls[2]["body"]["requirements"],
            [{"ref": "UW-1", "title": "A person signs off every decline", "controls": ["human_oversight"], "appliesWhen": {"minRisk": "high"}}],
        )
        self.assertEqual(spy.calls[4]["query"], {"risk": "high", "dataClassification": "confidential"})


class GovernanceOnTasks(unittest.TestCase):
    def test_governs_updates_asks_reassesses_and_exports(self):
        result = {"governance": GOVERNANCE, "approvalId": "apr_1", "approvalUrl": "https://deliverd.dev/a/apr_1"}
        reassessed = {
            "reassessment": {
                "id": "rea_1",
                "taskId": "tsk_1",
                "trigger": "manual",
                "changes": [],
                "recheck": [],
                "reason": "The data source changed",
                "status": "open",
                "openedByLabel": "Agent",
                "openedByAgentId": None,
                "openedAt": "2026-10-20T00:00:00Z",
                "completedByLabel": None,
                "completedAt": None,
                "completionNote": None,
            },
            "governance": GOVERNANCE,
        }
        spy = Spy(GOVERNANCE, GOVERNANCE, result, reassessed, {"packKind": "ai_governance"}, task())
        tasks = client(spy).tasks
        tasks.govern("tsk_1", ai_system_id="sys_1", risk="high")
        tasks.update_governance_profile("tsk_1", personal_data=True, expected_version=3)
        asked = tasks.request_control_approval("tsk_1", "deployment_approval", approvers=["cto@example.com"])
        again = tasks.trigger_reassessment("tsk_1", "The data source changed")
        pack = tasks.evidence_pack("tsk_1")
        self.assertEqual(asked.approval_id, "apr_1")
        self.assertEqual(again.reassessment.status, "open")
        self.assertEqual(again.governance.task_id, "tsk_1")
        self.assertEqual(pack["packKind"], "ai_governance")
        handle = tasks.get("tsk_1")
        spy.answers = [GOVERNANCE]
        handle.govern()
        handle.update_governance_profile(customer_facing=True)
        self.assertEqual(
            spy.paths,
            [
                "POST /tasks/tsk_1/governance",
                "PATCH /tasks/tsk_1/governance",
                "POST /tasks/tsk_1/governance/controls/deployment_approval/approval",
                "POST /tasks/tsk_1/governance/reassessments",
                "GET /tasks/tsk_1/governance/pack",
                "GET /tasks/tsk_1",
                "POST /tasks/tsk_1/governance",
                "PATCH /tasks/tsk_1/governance",
            ],
        )
        self.assertEqual(spy.calls[0]["body"], {"aiSystemId": "sys_1", "risk": "high"})
        self.assertEqual(spy.calls[1]["body"], {"personalData": True, "expectedVersion": 3})
        self.assertEqual(spy.calls[2]["body"], {"approvers": ["cto@example.com"]})
        self.assertEqual(spy.calls[3]["body"], {"reason": "The data source changed"})
        self.assertEqual(spy.calls[6]["body"], {})
        self.assertEqual(spy.calls[7]["body"], {"customerFacing": True})


class Awaited(unittest.TestCase):
    def test_the_nested_namespaces_are_awaited_too(self):
        spy = Spy({"aiSystems": [SYSTEM]}, INCIDENT)
        deliverd = AsyncDeliverd(api_key="dlv_t", transport=spy)
        systems = asyncio.run(deliverd.governance.ai_systems.list())
        incident = asyncio.run(deliverd.governance.incidents.report("Wrong payout", "high", task_id="tsk_1"))
        self.assertEqual(systems[0].id, "sys_1")
        self.assertEqual(incident.id, "inc_1")


class DevelopmentMode(unittest.TestCase):
    def test_does_not_simulate_it_and_says_so(self):
        deliverd = Deliverd(mode="development", development=DevelopmentOptions(log=False))
        with self.assertRaises(DeliverdError) as caught:
            deliverd.governance.check_authority("send")
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
