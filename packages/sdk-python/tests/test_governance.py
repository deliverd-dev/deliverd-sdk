"""Compliance Mode on tasks, as the wire sees it.

The routes, the methods and the bodies each call sends, with the Python names
turned into the API's. What the API does with them — thresholds, the newest
run deciding, an agent refused — is proved against a real database in the web
app (``scored-evidence.integration.test.ts``); this holds the SDK to the routes
that test exercises.
"""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd import Deliverd, DeliverdError  # noqa: E402
from deliverd.aio import AsyncDeliverd  # noqa: E402
from deliverd.dev import DevelopmentOptions  # noqa: E402
from test_namespaces import Spy, client  # noqa: E402
from test_tasks import task  # noqa: E402

GOVERNANCE = {
    "taskId": "tsk_1",
    "title": "Credit memos",
    "url": "https://deliverd.dev/tasks/tsk_1",
    "profile": {"risk": "high", "jurisdictions": ["EU"]},
    "controls": [
        {
            "key": "resilience_testing",
            "title": "Resilience testing",
            "family": "resilience",
            "kind": "evidence",
            "custom": False,
            "status": "outstanding",
            "required": True,
            "evidence": 1,
            "otherRelease": 1,
            "thresholds": {"rules": [{"metric": "attack_success_rate", "comparator": "<=", "value": 0.05}], "failOnSeverity": "high"},
            "thresholdsSetBy": "risk@bank.example",
            "scores": {"passed": False, "reason": "1 failed result at high severity or above.", "evidenceId": "ev_1"},
            "sources": [{"framework": "dora", "version": "2026.10", "ref": "Art. 24"}],
        }
    ],
    "evidence": [
        {
            "id": "ev_1",
            "type": "red_team",
            "title": "Red-team run",
            "description": "",
            "url": None,
            "controls": ["resilience_testing"],
            "results": [
                {"metric": "attack_success_rate", "value": 0.02},
                {"metric": "pi-indirect", "value": 1, "passed": False, "severity": "critical"},
            ],
            "run": {"tool": "garak", "runId": "r-1", "url": "https://ci.example/r/1"},
            "otherRelease": None,
            "createdByLabel": "Credit agent",
            "createdAt": "2026-10-13T09:00:00Z",
        },
        {
            "id": "ev_0",
            "type": "red_team",
            "title": "Red-team run of v11",
            "description": "",
            "url": None,
            "controls": ["resilience_testing"],
            "results": [{"metric": "attack_success_rate", "value": 0.01}],
            "run": {"tool": "garak", "release": {"modelVersion": "2026-09", "promptHash": "sha256:" + "1a" * 32}},
            "otherRelease": "prompt sha256:1a1a1a1a1a1a… where the system now runs sha256:ffeeddccbbaa…",
            "createdByLabel": "Credit agent",
            "createdAt": "2026-10-12T09:00:00Z",
        },
    ],
    "readiness": {"required": 12, "done": 7, "missing": ["resilience_testing"], "percent": 58},
    "gate": {"allowed": False, "reason": "Required governance controls incomplete", "missingControls": ["resilience_testing"], "blockers": []},
    "frameworks": [{"key": "dora", "name": "DORA", "version": "2026.10", "applies": True, "covered": 9, "applicable": 14}],
    "statement": "Governance readiness is the share of required controls satisfied or waived.",
}

GATE = {
    "taskId": "tsk_1",
    "allowed": False,
    "reason": "Required governance controls incomplete",
    "missingControls": ["resilience_testing"],
    "blockers": [{"kind": "incident", "message": "Open high incident: outage", "id": "inc_1"}],
    "scores": [{"control": "resilience_testing", "passed": False, "reason": "attack_success_rate was 0.2", "evidenceId": "ev_2"}],
    "readiness": {"required": 12, "done": 7, "missing": ["resilience_testing"], "percent": 58},
}


class TheWire(unittest.TestCase):
    def test_reads_governance_into_python_names(self):
        spy = Spy(GOVERNANCE)
        gov = client(spy).tasks.governance("tsk_1")
        self.assertEqual(spy.paths, ["GET /tasks/tsk_1/governance"])
        control = gov.controls[0]
        self.assertEqual(control.thresholds.fail_on_severity, "high")
        self.assertEqual(control.thresholds.rules[0].comparator, "<=")
        self.assertEqual(control.thresholds_set_by, "risk@bank.example")
        self.assertEqual(control.scores.evidence_id, "ev_1")
        self.assertEqual(control.sources[0].ref, "Art. 24")
        evidence = gov.evidence[0]
        self.assertEqual(evidence.run.run_id, "r-1")
        self.assertEqual(evidence.results[1].severity, "critical")
        self.assertFalse(evidence.results[1].passed)
        self.assertEqual(gov.readiness.percent, 58)
        self.assertEqual(gov.gate.missing_controls, ["resilience_testing"])
        self.assertEqual(gov.frameworks[0].applicable, 14)

    def test_submits_results_or_a_report_with_the_api_s_names(self):
        spy = Spy(GOVERNANCE)
        tasks = client(spy).tasks
        tasks.submit_evidence(
            "tsk_1",
            type="red_team",
            title="Red-team run",
            controls=["resilience_testing"],
            run={"tool": "garak", "run_id": "r-1", "url": "https://ci.example/r/1"},
            results=[{"metric": "attack_success_rate", "value": 0.02}],
            finding_id="fnd_1",
        )
        tasks.submit_evidence(
            "tsk_1", type="model_evaluation", title="promptfoo run", controls=["model_evaluation"],
            report={"format": "promptfoo", "content": "{}"},
        )
        self.assertEqual(spy.paths, ["POST /tasks/tsk_1/governance/evidence"] * 2)
        self.assertEqual(
            spy.calls[0]["body"],
            {
                "type": "red_team",
                "title": "Red-team run",
                "controls": ["resilience_testing"],
                "findingId": "fnd_1",
                "results": [{"metric": "attack_success_rate", "value": 0.02}],
                "run": {"tool": "garak", "runId": "r-1", "url": "https://ci.example/r/1"},
            },
        )
        self.assertEqual(spy.calls[1]["body"]["report"], {"format": "promptfoo", "content": "{}"})

    def test_names_a_langfuse_experiment_to_pull_with_the_api_s_names(self):
        spy = Spy(GOVERNANCE)
        client(spy).tasks.submit_evidence(
            "tsk_1",
            type="model_evaluation",
            title="Prompt v12 evaluation",
            controls=["model_evaluation"],
            pull={"source": "langfuse", "experiment_id": "exp-7a1c2e", "since": "2026-10-01T00:00:00Z"},
        )
        self.assertEqual(
            spy.calls[0]["body"]["pull"],
            {"source": "langfuse", "experimentId": "exp-7a1c2e", "since": "2026-10-01T00:00:00Z"},
        )
        self.assertNotIn("results", spy.calls[0]["body"])

    def test_names_the_release_a_run_tested_with_the_api_s_names_and_reads_it_back(self):
        spy = Spy(GOVERNANCE, GOVERNANCE)
        release = {"model": "claude", "model_version": "2026-10", "prompt_hash": "sha256:" + "ab" * 32}
        gov = client(spy).tasks.submit_evidence(
            "tsk_1", type="model_evaluation", title="promptfoo run", controls=["model_evaluation"],
            report={"format": "promptfoo", "content": "{}"}, release=release,
        )
        asyncio.run(
            AsyncDeliverd(api_key="dlv_t", transport=spy).tasks.submit_evidence(
                "tsk_1", type="model_evaluation", title="promptfoo run", release=release
            )
        )
        wire = {"model": "claude", "modelVersion": "2026-10", "promptHash": "sha256:" + "ab" * 32}
        self.assertEqual(spy.calls[0]["body"]["release"], wire)
        self.assertEqual(spy.calls[1]["body"]["release"], wire)
        self.assertEqual(gov.controls[0].other_release, 1)
        self.assertIsNone(gov.evidence[0].other_release)
        self.assertIsNone(gov.evidence[0].run.release)
        old = gov.evidence[1]
        self.assertEqual(old.run.release.model_version, "2026-09")
        self.assertIsNone(old.run.release.guardrails_hash)
        self.assertIn("where the system now runs", old.other_release)

    def test_asks_the_gate_with_an_action_when_given(self):
        spy = Spy(GATE)
        tasks = client(spy).tasks
        gate = tasks.check_governance_gate("tsk_1")
        tasks.check_governance_gate("tsk_1", action="customer_decision")
        self.assertEqual(spy.paths, ["GET /tasks/tsk_1/governance/gate"] * 2)
        self.assertEqual(spy.calls[0]["query"], {})
        self.assertEqual(spy.calls[1]["query"], {"action": "customer_decision"})
        self.assertFalse(gate.allowed)
        self.assertEqual(gate.scores[0].evidence_id, "ev_2")
        self.assertEqual(gate.blockers[0].kind, "incident")
        self.assertEqual(gate.readiness.missing, ["resilience_testing"])

    def test_cannot_set_thresholds_a_person_does_in_the_app(self):
        # No key sets them, a person's own included, so neither client offers it.
        self.assertFalse(hasattr(client(Spy()).tasks, "set_thresholds"))
        self.assertFalse(hasattr(AsyncDeliverd(api_key="dlv_t", transport=Spy()).tasks, "set_thresholds"))

    def test_does_the_same_from_a_task_handle(self):
        spy = Spy(task(), GOVERNANCE, GOVERNANCE, GATE, GOVERNANCE)
        handle = client(spy).tasks.get("tsk_1")
        handle.governance()
        handle.submit_evidence("test_result", "Tests", report={"format": "junit", "content": "<testsuite/>"})
        handle.check_governance_gate()
        self.assertFalse(hasattr(handle, "set_thresholds"))
        self.assertEqual(
            spy.paths,
            [
                "GET /tasks/tsk_1",
                "GET /tasks/tsk_1/governance",
                "POST /tasks/tsk_1/governance/evidence",
                "GET /tasks/tsk_1/governance/gate",
            ],
        )

    def test_runs_awaited_too(self):
        spy = Spy(GATE)
        gate = asyncio.run(AsyncDeliverd(api_key="dlv_t", transport=spy).tasks.check_governance_gate("tsk_1"))
        self.assertFalse(gate.allowed)


class DevelopmentMode(unittest.TestCase):
    def test_does_not_simulate_governance_and_says_so(self):
        deliverd = Deliverd(mode="development", development=DevelopmentOptions(log=False))
        with self.assertRaises(DeliverdError) as caught:
            deliverd.tasks.check_governance_gate("tsk_1")
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
