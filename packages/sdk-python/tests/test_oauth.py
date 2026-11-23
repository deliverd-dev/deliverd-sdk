"""OAuth for agents: tokens from the token endpoint, cached, renewed, and a key still wins."""

import base64
import json
import unittest
import urllib.parse
from typing import Any, Dict, List, Mapping, Optional

from deliverd import AgentOAuth, Deliverd, client_assertion
from deliverd._http import Reply
from deliverd.errors import DeliverdError


class Wire:
    """Answers the token endpoint and the API from two scripts."""

    def __init__(self, tokens: List[Reply], api: List[Reply]) -> None:
        self.tokens = tokens
        self.api = api
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, url: str, method: str, body: Optional[bytes], headers: Mapping[str, str], timeout: float) -> Reply:
        self.calls.append({"url": url, "body": body, "headers": dict(headers)})
        return (self.tokens if url.endswith("/api/oauth/token") else self.api).pop(0)

    def token_forms(self) -> List[Dict[str, str]]:
        return [dict(urllib.parse.parse_qsl(c["body"].decode())) for c in self.calls if c["url"].endswith("/api/oauth/token")]

    def bearers(self) -> List[str]:
        return [c["headers"]["Authorization"] for c in self.calls if "/api/v1/" in c["url"]]


def reply(payload: Any, status: int = 200) -> Reply:
    return Reply(status, {}, json.dumps(payload))


class OAuthTests(unittest.TestCase):
    def test_client_credentials_token_is_fetched_once_and_sent(self) -> None:
        wire = Wire([reply({"access_token": "dlvat_1", "expires_in": 900})], [reply({}), reply({})])
        d = Deliverd(oauth=AgentOAuth(client_id="dlvac_abc", client_secret="dlvacs_s"), transport=wire, base_url="https://example.test")
        d.http.request("GET", "/approvals")
        d.http.request("GET", "/approvals")
        forms = wire.token_forms()
        self.assertEqual(len(forms), 1)
        self.assertEqual(forms[0]["grant_type"], "client_credentials")
        self.assertEqual(forms[0]["client_id"], "dlvac_abc")
        self.assertEqual(forms[0]["client_secret"], "dlvacs_s")
        self.assertEqual(forms[0]["resource"], "https://example.test/api/v1")
        self.assertEqual(wire.bearers(), ["Bearer dlvat_1", "Bearer dlvat_1"])

    def test_a_refused_token_is_renewed_once(self) -> None:
        wire = Wire(
            [reply({"access_token": "dlvat_1", "expires_in": 900}), reply({"access_token": "dlvat_2", "expires_in": 900})],
            [reply({"error": {"code": "auth_error", "message": "expired"}}, 401), reply({})],
        )
        d = Deliverd(oauth=AgentOAuth(client_id="dlvac_abc", client_secret="s"), transport=wire)
        d.http.request("GET", "/approvals")
        self.assertEqual(wire.bearers(), ["Bearer dlvat_1", "Bearer dlvat_2"])

    def test_a_key_wins(self) -> None:
        wire = Wire([], [reply({})])
        d = Deliverd(api_key="dlv_key", oauth=AgentOAuth(client_id="dlvac_abc", client_secret="s"), transport=wire)
        d.http.request("GET", "/approvals")
        self.assertEqual(wire.bearers(), ["Bearer dlv_key"])
        self.assertEqual(wire.token_forms(), [])

    def test_the_token_endpoints_reason_is_kept(self) -> None:
        wire = Wire([reply({"error": "invalid_client", "error_description": "Client authentication failed"}, 401)], [])
        d = Deliverd(oauth=AgentOAuth(client_id="dlvac_abc", client_secret="wrong"), transport=wire)
        with self.assertRaises(DeliverdError) as caught:
            d.http.request("GET", "/approvals")
        self.assertIn("invalid_client: Client authentication failed", str(caught.exception))

    def test_token_exchange(self) -> None:
        wire = Wire([reply({"access_token": "dlvat_x", "expires_in": 900})], [reply({})])
        d = Deliverd(oauth=AgentOAuth(subject_token=lambda: "eyJplatform"), transport=wire)
        d.http.request("GET", "/approvals")
        form = wire.token_forms()[0]
        self.assertEqual(form["grant_type"], "urn:ietf:params:oauth:grant-type:token-exchange")
        self.assertEqual(form["subject_token"], "eyJplatform")
        self.assertEqual(form["subject_token_type"], "urn:ietf:params:oauth:token-type:jwt")

    def test_environment(self) -> None:
        self.assertIsNone(AgentOAuth.from_env({}))
        o = AgentOAuth.from_env({"DELIVERD_CLIENT_ID": "dlvac_abc", "DELIVERD_PRIVATE_KEY": "a\\nb"})
        assert o is not None
        self.assertEqual(o.private_key, "a\nb")
        self.assertEqual(o.mode(), "private_key_jwt")
        with self.assertRaises(DeliverdError):
            AgentOAuth(client_id="dlvac_abc").mode()


try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    HAVE_CRYPTO = False


def _unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


@unittest.skipUnless(HAVE_CRYPTO, "cryptography is not installed")
class AssertionTests(unittest.TestCase):
    def _check(self, key: Any, alg: str) -> None:
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        jwt = client_assertion("dlvac_abc", "https://example.test/api/oauth/token", pem, key_id="k1")
        h, p, s = jwt.split(".")
        header, claims, sig = json.loads(_unb64(h)), json.loads(_unb64(p)), _unb64(s)
        self.assertEqual(header, {"alg": alg, "typ": "JWT", "kid": "k1"})
        self.assertEqual(claims["iss"], "dlvac_abc")
        self.assertEqual(claims["sub"], "dlvac_abc")
        self.assertEqual(claims["exp"] - claims["iat"], 60)
        data = "{}.{}".format(h, p).encode()
        public = key.public_key()
        if alg == "RS256":
            public.verify(sig, data, padding.PKCS1v15(), hashes.SHA256())
        elif alg == "ES256":
            r, s_ = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
            public.verify(encode_dss_signature(r, s_), data, ec.ECDSA(hashes.SHA256()))
        else:
            public.verify(sig, data)

    def test_es256(self) -> None:
        self._check(ec.generate_private_key(ec.SECP256R1()), "ES256")

    def test_rs256(self) -> None:
        self._check(rsa.generate_private_key(public_exponent=65537, key_size=2048), "RS256")

    def test_eddsa(self) -> None:
        self._check(ed25519.Ed25519PrivateKey.generate(), "EdDSA")


if __name__ == "__main__":
    unittest.main()
