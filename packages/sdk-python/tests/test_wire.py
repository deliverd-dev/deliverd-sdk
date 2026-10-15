"""The boundary between ``decidedById`` and ``decided_by_id``.

Every test here is about something a blanket recursive camelising walk would
have got wrong, because that is the shortcut this module exists to refuse.
"""

import unittest
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from deliverd._wire import Model, body_from, build, to_camel, to_snake
from deliverd.types import ApprovalData, CollectionData


@dataclass
class Simple(Model):
    id: str
    decided_by_id: Optional[str]
    approvals_so_far: int


@dataclass
class Plain:
    label: str
    status: Optional[str] = None


class NameConversion(unittest.TestCase):
    def test_round_trips_every_field_name_the_api_uses(self):
        # Taken from the field names the API actually sends, not invented: a
        # conversion that is right for `externalId` and wrong for `approvalsSoFar`
        # would pass a test written from one example.
        for camel, snake in [
            ("id", "id"),
            ("url", "url"),
            ("externalId", "external_id"),
            ("decidedById", "decided_by_id"),
            ("approvalsSoFar", "approvals_so_far"),
            ("requiredApprovals", "required_approvals"),
            ("threadCount", "thread_count"),
            ("lastActivityAt", "last_activity_at"),
            ("currentVersion", "current_version"),
        ]:
            self.assertEqual(to_snake(camel), snake, camel)
            self.assertEqual(to_camel(snake), camel, snake)


class Conversion(unittest.TestCase):
    def test_reads_camel_case_off_the_wire(self):
        row = Simple.from_wire({"id": "a", "decidedById": "u1", "approvalsSoFar": 2})
        self.assertEqual(row.decided_by_id, "u1")
        self.assertEqual(row.approvals_so_far, 2)

    def test_keeps_the_payload_it_came_from(self):
        row = Simple.from_wire({"id": "a", "decidedById": "u1", "approvalsSoFar": 2, "extra": 9})
        # A field the API adds tomorrow is reachable today, without an upgrade.
        self.assertEqual(row.raw["extra"], 9)

    def test_a_missing_field_is_none_rather_than_an_error(self):
        # Forward compatibility in the direction that matters: the API dropping
        # a field should not take an agent down mid-run.
        row = Simple.from_wire({"id": "a"})
        self.assertIsNone(row.decided_by_id)

    def test_builds_plain_dataclasses_too(self):
        # Factors and links travel both ways, so they are not Models.
        self.assertEqual(build(Plain, {"label": "x", "status": "ok"}), Plain("x", "ok"))


class WhatMustNotBeConverted(unittest.TestCase):
    def test_metadata_keys_are_the_callers_own(self):
        row = ApprovalData.from_wire(
            {"id": "a", "metadata": {"order_id": 4821, "camelCaseKey": 1, "a-b": 2}}
        )
        self.assertEqual(row.metadata, {"order_id": 4821, "camelCaseKey": 1, "a-b": 2})

    def test_metadata_goes_out_unchanged_as_well(self):
        body = body_from({"metadata": {"order_id": 1}}, passthrough=("metadata",))
        self.assertEqual(body["metadata"], {"order_id": 1})

    def test_an_answer_is_keyed_by_the_question_somebody_typed(self):
        data = CollectionData.from_wire(
            {
                "id": "c",
                "status": "complete",
                "responses": [
                    {
                        "respondent": "Finance",
                        "status": "submitted",
                        "answers": [
                            {"question": "Headcount at 30 September", "kind": "number", "value": 42}
                        ],
                    }
                ],
            }
        )
        answer = data.responses[0].answers[0]
        self.assertEqual(answer.question, "Headcount at 30 September")


class RequestBodies(unittest.TestCase):
    def test_drops_unset_arguments_rather_than_sending_null(self):
        # The API distinguishes "not given" from "given as null" on several
        # fields; a client that sent every unset argument as null would be
        # making a statement the caller never made.
        self.assertEqual(body_from({"title": "t", "risk": None}), {"title": "t"})

    def test_converts_nested_structures_the_caller_built(self):
        body = body_from({"factors": [{"label": "x", "status": "ok"}]})
        self.assertEqual(body["factors"], [{"label": "x", "status": "ok"}])

    def test_sends_dataclass_inputs_as_the_api_spells_them(self):
        from deliverd.types import Question

        body = body_from({"questions": [Question(prompt="How many?", kind="number")]})
        self.assertEqual(body["questions"], [{"prompt": "How many?", "kind": "number"}])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
