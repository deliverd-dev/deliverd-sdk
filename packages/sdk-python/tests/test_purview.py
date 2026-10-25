"""Microsoft Purview, in Python: the same rules as ``packages/core/src/purview.ts``."""

from __future__ import annotations

import json
import unittest

from deliverd import Deliverd, DevelopmentOptions, entra_app_token, purview_check
from deliverd.purview import apply_purview, purview_outcome_from_response, purview_unavailable

APP = {"name": "Claims assistant", "entra_app_id": "11111111-2222-3333-4444-555555555555"}
USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def graph(status, body=None, etag=None):
    calls = []

    def transport(url, headers, raw, timeout):
        calls.append((url, headers, json.loads(raw.decode("utf-8"))))
        return status, ({"ETag": etag} if etag else {}), json.dumps(body or {}).encode("utf-8")

    return transport, calls


class PurviewRulesTest(unittest.TestCase):
    def test_takes_the_strictest_action_and_blocks_on_the_unknown(self):
        o = purview_outcome_from_response({"policyActions": [{"restrictionAction": "audit"}, {"restrictionAction": "warn"}]})
        self.assertEqual((o.restriction, o.actions), ("warn", 2))
        self.assertEqual(purview_outcome_from_response({"policyActions": [{"action": "somethingNew"}]}).restriction, "block")
        self.assertIsNone(purview_outcome_from_response({"policyActions": []}).restriction)

    def test_unreachable_is_the_callers_choice(self):
        self.assertEqual(purview_unavailable("deny").restriction, "block")
        self.assertEqual(purview_unavailable("ask").restriction, "warn")
        self.assertIsNone(purview_unavailable("allow").restriction)

    def test_a_block_stands_even_in_report_only(self):
        verdict, reasons = apply_purview("allow", [], purview_outcome_from_response({"policyActions": [{"restrictionAction": "block"}]}), False)
        self.assertEqual(verdict, "deny")
        self.assertIn("Purview policy blocks", reasons[0])

    def test_a_warn_asks_and_never_lowers_a_verdict(self):
        warn = purview_outcome_from_response({"policyActions": [{"restrictionAction": "warn"}]})
        self.assertEqual(apply_purview("allow", [], warn)[0], "ask")
        self.assertEqual(apply_purview("deny", [], warn)[0], "deny")


class PurviewCheckTest(unittest.TestCase):
    def test_asks_graph_for_the_user_with_the_app_named(self):
        transport, calls = graph(200, {"policyActions": [{"restrictionAction": "block"}]}, etag='W/"1"')
        check = purview_check(token=lambda: "t0k", app=APP, user_id=USER, transport=transport)
        self.assertEqual(check("the merger code name").restriction, "block")
        check("again")
        url, headers, body = calls[0]
        self.assertIn("/users/{}/dataSecurityAndGovernance/processContent".format(USER), url)
        self.assertEqual(headers["Authorization"], "Bearer t0k")
        app = body["contentToProcess"]["protectedAppMetadata"]["applicationLocation"]["value"]
        self.assertEqual(app, APP["entra_app_id"])
        self.assertEqual(calls[1][1]["If-None-Match"], 'W/"1"')

    def test_an_error_from_graph_is_unavailable_not_allowed(self):
        transport, _ = graph(403)
        outcome = purview_check(token="t", app=APP, transport=transport)("x")
        self.assertTrue(outcome.unavailable)
        self.assertEqual(outcome.restriction, "warn")

    def test_refuses_an_app_id_that_is_not_a_guid(self):
        with self.assertRaises(ValueError):
            purview_check(token="t", app={"name": "x", "entra_app_id": "claims"})


class EntraAppTokenTest(unittest.TestCase):
    def test_asks_entra_once_and_caches(self):
        calls = []

        def transport(url, headers, raw, timeout):
            calls.append(raw.decode("utf-8"))
            return 200, {}, json.dumps({"access_token": "app", "expires_in": 3600}).encode("utf-8")

        token = entra_app_token("99999999-8888-7777-6666-555555555555", "c", "s", transport=transport)
        self.assertEqual(token(), "app")
        self.assertEqual(token(), "app")
        self.assertEqual(len(calls), 1)
        self.assertIn("grant_type=client_credentials", calls[0])


class ScreenWithPurviewTest(unittest.TestCase):
    def test_sends_deliverd_only_purviews_answer(self):
        sent = []
        from deliverd._http import Reply

        def transport(method, url, body, headers, timeout):
            sent.append(json.loads(body.decode("utf-8")))
            return Reply(200, {"content-type": "application/json"}, json.dumps({
                "verdict": "deny", "allowed": False, "classification": "internal", "personalData": False,
                "categories": [], "counts": {}, "offending": [], "reasons": ["blocked"], "target": None,
                "findings": None, "redactedText": None, "approval": None,
                "purview": {"restriction": "block", "actions": 1, "scopeModified": False, "unavailable": False},
            }))

        purview_transport, _ = graph(200, {"policyActions": [{"restrictionAction": "block"}]})
        purview = purview_check(token="t", app=APP, transport=purview_transport)
        screened = Deliverd(api_key="dlv_test", transport=transport).screen("Project Falcon terms", purview=purview)
        self.assertNotIn("Falcon", json.dumps(sent[0]))
        self.assertEqual(sent[0]["purview"]["restriction"], "block")
        self.assertFalse(screened.allowed)
        self.assertEqual(screened.data.purview.restriction, "block")

    def test_development_mode_honours_a_purview_block(self):
        purview_transport, _ = graph(200, {"policyActions": [{"restrictionAction": "block"}]})
        purview = purview_check(token="t", app=APP, transport=purview_transport)
        client = Deliverd(mode="development", development=DevelopmentOptions(log=False))
        screened = client.screen("Summarise the board pack.", purview=purview)
        self.assertEqual(screened.verdict, "deny")


if __name__ == "__main__":
    unittest.main()
