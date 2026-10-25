"""Checking a decision token where the action happens.

A gate that may be acted on carries ``decision_token``: the yes, signed with the
deployment's Ed25519 evidence key. Hand it to the service that performs the
action, and that service checks it against what it is about to do before it
does it::

    check = client.decision_tokens.verify(
        request.headers.get("deliverd-decision"),
        action="finance.refund",
        input={"customer_id": customer_id, "amount": amount, "currency": currency},
    )
    if not check.ok:
        abort(403, check.reason)

It fails when the token was not signed by your Deliverd, has expired, is for
another action, or was agreed for a different input. It needs no API key and
makes no call beyond fetching the public key once. It does not count uses:
record the execution against the gate to spend the use.

Ed25519 verification is written out here (RFC 8032, section 5.1.7) because the
package has no dependencies and the standard library has no Ed25519. It
verifies only, so it holds no secret and its speed is not a side channel.

Kept byte-for-byte with the server's ``lib/governance/decision-token.ts`` and
the TypeScript SDK; ``decision-token.test.ts`` on the server signs there and
verifies with this file.
"""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

from .errors import DeliverdError

DECISION_TOKEN_PREFIX = "dlv_dt1"
DECISION_TOKEN_CONTEXT = "deliverd-decision-token:v1:"
EVIDENCE_KEY_PATH = "/.well-known/deliverd-evidence-key"


@dataclass(frozen=True)
class DecisionTokenResult:
    ok: bool
    #: Why it failed: missing, malformed, bad_signature, wrong_issuer, expired,
    #: wrong_action, input_mismatch, destination_mismatch or artifact_mismatch.
    reason: Optional[str] = None
    claims: Optional[Dict[str, Any]] = None


def _plain(value: Any) -> Any:
    # JavaScript writes 1.0 as 1; the server hashed what JavaScript wrote.
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def canonical_json(value: Any) -> str:
    """Keys sorted at every depth: the server's ``canonicalJson``."""
    return json.dumps(_plain(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def decision_input_hash(input: Any) -> str:
    return hashlib.sha256(canonical_json({} if input is None else input).encode("utf-8")).hexdigest()


def _b64url(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


# --- Ed25519 verification (RFC 8032) -------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _add(a: tuple, b: tuple) -> tuple:
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    A = (y1 - x1) * (y2 - x2) % _P
    B = (y1 + x1) * (y2 + x2) % _P
    C = 2 * t1 * t2 * _D % _P
    D = 2 * z1 * z2 % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _mul(s: int, p: tuple) -> tuple:
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _equal(a: tuple, b: tuple) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


def _decompress(s: bytes) -> Optional[tuple]:
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        if sign:
            return None
        x = 0
    else:
        x = pow(x2, (_P + 3) // 8, _P)
        if (x * x - x2) % _P != 0:
            x = x * _SQRT_M1 % _P
        if (x * x - x2) % _P != 0:
            return None
        if (x & 1) != sign:
            x = _P - x
    return (x, y, 1, x * y % _P)


_GY = 4 * pow(5, _P - 2, _P) % _P
_G = _decompress(_GY.to_bytes(32, "little"))


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(signature) != 64:
        return False
    a = _decompress(public_key)
    r = _decompress(signature[:32])
    if a is None or r is None or _G is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _L
    return _equal(_mul(s, _G), _add(r, _mul(h, a)))


def _raw_key(public_key: Any) -> bytes:
    """32 raw bytes from raw bytes, base64url text, or an SPKI PEM."""
    if isinstance(public_key, (bytes, bytearray)):
        return bytes(public_key)
    text = str(public_key).strip()
    if text.startswith("-----BEGIN"):
        body = "".join(line for line in text.splitlines() if not line.startswith("-----"))
        der = base64.b64decode(body)
        return der[-32:]
    return _b64url(text)


def _same_destination(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    if a.get("type") != b.get("type"):
        return False
    fold = a.get("type") in ("email", "domain")
    x, y = str(a.get("id", "")).strip(), str(b.get("id", "")).strip()
    return x.lower() == y.lower() if fold else x == y


def verify_decision_token(
    token: Optional[str],
    *,
    action: str,
    input: Any,
    public_key: Any,
    issuer: str,
    destination: Optional[Dict[str, Any]] = None,
    artifact_sha256: Optional[str] = None,
    now: Optional[float] = None,
    skew_seconds: int = 30,
) -> DecisionTokenResult:
    """Verify with a key you already hold (raw bytes, base64url or PEM).

    ``issuer`` is the origin of the deployment you trust, such as
    ``https://deliverd.dev``.
    """
    if not token:
        return DecisionTokenResult(False, "missing")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != DECISION_TOKEN_PREFIX:
        return DecisionTokenResult(False, "malformed")
    try:
        claims = json.loads(_b64url(parts[1]).decode("utf-8"))
        signature = _b64url(parts[2])
    except Exception:
        return DecisionTokenResult(False, "malformed")
    if not isinstance(claims, dict) or claims.get("v") != 1:
        return DecisionTokenResult(False, "malformed")
    try:
        good = ed25519_verify(_raw_key(public_key), (DECISION_TOKEN_CONTEXT + parts[1]).encode("utf-8"), signature)
    except Exception:
        good = False
    if not good:
        return DecisionTokenResult(False, "bad_signature")
    if claims.get("iss") != issuer.rstrip("/"):
        return DecisionTokenResult(False, "wrong_issuer")
    stamp = int(time.time() if now is None else now)
    if int(claims.get("exp", 0)) + skew_seconds <= stamp:
        return DecisionTokenResult(False, "expired")
    if claims.get("action") != action:
        return DecisionTokenResult(False, "wrong_action")
    if claims.get("input") != decision_input_hash(input):
        return DecisionTokenResult(False, "input_mismatch")
    dest = claims.get("dest")
    if dest:
        if not destination or not _same_destination(destination, dest):
            return DecisionTokenResult(False, "destination_mismatch")
    if claims.get("artifact") and artifact_sha256 != claims.get("artifact"):
        return DecisionTokenResult(False, "artifact_mismatch")
    return DecisionTokenResult(True, None, claims)


class DecisionTokens:
    """``client.decision_tokens``: verification against the deployment this
    client talks to. The key comes from that deployment's well-known address
    and the issuer must be that deployment, never whatever the token names."""

    def __init__(self, base_url: str, fetch_key: Optional[Callable[[str], Dict[str, Any]]] = None) -> None:
        self._base_url = base_url.rstrip("/")
        parts = urlsplit(self._base_url)
        self._issuer = "{}://{}".format(parts.scheme, parts.netloc)
        self._fetch_key = fetch_key or _fetch_json
        self._key: Optional[bytes] = None
        self._lock = threading.Lock()

    def verify(
        self,
        token: Optional[str],
        *,
        action: str,
        input: Any,
        destination: Optional[Dict[str, Any]] = None,
        artifact_sha256: Optional[str] = None,
        now: Optional[float] = None,
    ) -> DecisionTokenResult:
        if not token:
            return DecisionTokenResult(False, "missing")
        return verify_decision_token(
            token,
            action=action,
            input=input,
            public_key=self._public_key(),
            issuer=self._issuer,
            destination=destination,
            artifact_sha256=artifact_sha256,
            now=now,
        )

    def _public_key(self) -> bytes:
        with self._lock:
            if self._key is None:
                body = self._fetch_key(self._base_url + EVIDENCE_KEY_PATH)
                raw = body.get("publicKeyRaw") or body.get("publicKey")
                if not raw:
                    raise DeliverdError(0, "no_signing_key", "This deployment does not publish a signing key.")
                self._key = _raw_key(raw)
            return self._key


def _fetch_json(url: str) -> Dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=10) as res:  # noqa: S310 - the client's own base URL
            return json.loads(res.read().decode("utf-8"))
    except Exception as err:
        raise DeliverdError(0, "no_signing_key", "Could not fetch the signing key: {}".format(err)) from err
