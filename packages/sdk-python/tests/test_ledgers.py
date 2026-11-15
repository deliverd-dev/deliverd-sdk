"""The Xero and QuickBooks tool map agrees with the TypeScript one, case for case."""

import json
import unittest
from pathlib import Path

from deliverd.ledgers import FINANCE_ACTION_IDS, LedgerCall, classify_ledger_tool, mask_account, tool_key

CASES = Path(__file__).resolve().parents[2] / "core" / "src" / "ledgers.cases.json"


def _cases():
    if not CASES.exists():  # the public SDK repository has no packages/core
        return []
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


class LedgerToolMap(unittest.TestCase):
    def test_matches_the_typescript(self):
        for case in _cases():
            with self.subTest(f"{case['ledger']} {case['tool']}"):
                got = classify_ledger_tool(case["ledger"], case["tool"], case["args"])
                want = case["expect"]
                if want is None:
                    self.assertIsNone(got)
                    continue
                self.assertIsInstance(got, LedgerCall)
                self.assertEqual(got.action_id, want["actionId"])
                self.assertEqual(got.input, want["input"])
                self.assertEqual(got.summary, want["summary"])

    def test_reads_ask_nobody(self):
        self.assertIsNone(classify_ledger_tool("xero", "list-invoices", {}))
        self.assertIsNone(classify_ledger_tool("quickbooks", "get_bill", {"id": "1"}))

    def test_a_bank_detail_change_is_its_own_action_and_masked(self):
        call = classify_ledger_tool("quickbooks", "update_vendor", {"vendor": {"Id": "56", "DisplayName": "Bob", "AcctNum": "99887766"}})
        self.assertEqual(call.action_id, "finance.change_supplier_bank_details")
        self.assertEqual(call.input["newBankDetails"], "•••• 7766")
        self.assertIn(call.action_id, FINANCE_ACTION_IDS)

    def test_helpers(self):
        self.assertEqual(tool_key("mcp__qbo__create-bill"), "create_bill")
        self.assertEqual(mask_account(None), "none on file")
        with self.assertRaises(ValueError):
            classify_ledger_tool("sage", "create_bill", {})


if __name__ == "__main__":
    unittest.main()
