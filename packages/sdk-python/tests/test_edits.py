"""Approve with changes, through ``approve()``, in development mode.

The imaginary approver applies ``edits`` the way production does: only to
fields you offered, and only on an approval.
"""

import unittest

from deliverd import Deliverd, DevelopmentOptions

PROPOSAL = dict(
    title="Refund order 1042",
    input={"orderId": "1042", "amount": 420},
    editable_fields=["amount"],
)


def client(**options) -> Deliverd:
    return Deliverd(mode="development", development=DevelopmentOptions(log=False, **options))


class ApproveWithChanges(unittest.TestCase):
    def test_returns_what_to_run_with_corrected_and_what_changed(self) -> None:
        decision = client(edits={"amount": 300, "orderId": "9999"}).approve(**PROPOSAL)
        self.assertTrue(decision.approved)
        # orderId was not offered, so it stands; and the caller's keys are not renamed.
        self.assertEqual(decision.input, {"orderId": "1042", "amount": 300})
        self.assertEqual(decision.changes, [{"field": "amount", "from": 420, "to": 300}])

    def test_returns_the_proposal_when_approved_as_it_stood(self) -> None:
        decision = client().approve(**PROPOSAL)
        self.assertEqual(decision.input, PROPOSAL["input"])
        self.assertEqual(decision.changes, [])

    def test_returns_nothing_to_run_on_a_no(self) -> None:
        decision = client(outcome="rejected", edits={"amount": 300}).approve(**PROPOSAL)
        self.assertFalse(decision.approved)
        self.assertIsNone(decision.input)

    def test_returns_none_when_no_input_was_sent(self) -> None:
        self.assertIsNone(client().approve(title="Deploy").input)


if __name__ == "__main__":
    unittest.main()
