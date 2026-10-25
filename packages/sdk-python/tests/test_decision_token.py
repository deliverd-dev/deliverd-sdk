"""Decision tokens, against the table the server signs and every SDK verifies."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from deliverd import DecisionTokens, verify_decision_token
from deliverd.decision_token import canonical_json, ed25519_verify

TABLE = json.loads(
    (Path(__file__).resolve().parents[2] / "conformance" / "decision-tokens.json").read_text(encoding="utf-8")
)


def _expected(case):
    e = case["expected"]
    return {
        "action": e["action"],
        "input": e["input"],
        "destination": e.get("destination"),
        "artifact_sha256": e.get("artifactSha256"),
    }


class DecisionTokenTests(unittest.TestCase):
    def test_every_case(self):
        for case in TABLE["cases"]:
            for key in (TABLE["testKey"]["publicKeyPem"], TABLE["testKey"]["publicKeyRaw"]):
                with self.subTest(case=case["name"], key=key[:10]):
                    out = verify_decision_token(
                        case["token"],
                        public_key=key,
                        issuer=case.get("issuer", TABLE["issuer"]),
                        now=case["now"],
                        **_expected(case),
                    )
                    self.assertEqual(out.reason or "ok", case["result"])

    def test_rfc8032_vector(self):
        # RFC 8032, section 7.1, test 2.
        pub = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
        sig = bytes.fromhex(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
            "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
        )
        self.assertTrue(ed25519_verify(pub, bytes([0x72]), sig))
        self.assertFalse(ed25519_verify(pub, bytes([0x73]), sig))

    def test_writes_whole_floats_as_javascript_does(self):
        self.assertEqual(canonical_json({"b": 1.0, "a": [2.5, 3.0]}), '{"a":[2.5,3],"b":1}')

    def test_client_pins_issuer_to_its_own_base_url(self):
        seen = []

        def fetch(url):
            seen.append(url)
            return {"publicKeyRaw": TABLE["testKey"]["publicKeyRaw"]}

        good = TABLE["cases"][0]
        tokens = DecisionTokens(TABLE["issuer"] + "/", fetch_key=fetch)
        self.assertTrue(tokens.verify(good["token"], now=good["now"], **_expected(good)).ok)
        self.assertTrue(tokens.verify(good["token"], now=good["now"], **_expected(good)).ok)
        self.assertEqual(seen, [TABLE["issuer"] + "/.well-known/deliverd-evidence-key"])

        elsewhere = DecisionTokens("https://other.example", fetch_key=fetch)
        self.assertEqual(
            elsewhere.verify(good["token"], now=good["now"], **_expected(good)).reason, "wrong_issuer"
        )


if __name__ == "__main__":
    unittest.main()
