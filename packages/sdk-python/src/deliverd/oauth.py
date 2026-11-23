"""OAuth for agents: short-lived access tokens instead of a key on every request.

An agent with an OAuth client (Agents → Agents → an agent → OAuth in Deliverd)
asks the token endpoint for an access token with the client credentials grant,
proving itself with a client secret or with a JWT it signs with its own private
key (``private_key_jwt``). An agent that already has a token from its platform
(a Microsoft Entra Agent ID, an Azure managed identity, AWS, Google Cloud,
GitHub Actions, Kubernetes) exchanges that instead (token exchange, RFC 8693).

The token is cached and renewed a minute before it runs out, and once more if
the API says it is no longer valid.

Still no dependencies for a client secret or token exchange. Signing with a
private key needs the ``cryptography`` package, imported only when a key is
given: ``pip install cryptography``.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Union

from .errors import DeliverdError

TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt"
CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"


@dataclass
class AgentOAuth:
    """How the agent gets its tokens. Give a client (``client_id`` with
    ``client_secret`` or ``private_key``), or a ``subject_token`` to exchange."""

    #: The client ID from the agent's page (``dlvac_…``). Not needed for token exchange.
    client_id: Optional[str] = None
    #: For a client that proves itself with a secret (``dlvacs_…``).
    client_secret: Optional[str] = None
    #: For a client that signs: a PEM private key (RSA, EC P-256 or Ed25519).
    private_key: Optional[Union[str, bytes]] = None
    #: The ``kid`` of that key, when its public key set holds more than one.
    key_id: Optional[str] = None
    #: The platform's own token for this agent, or a function returning a fresh one.
    subject_token: Optional[Union[str, Callable[[], str]]] = None
    #: Space-separated scopes, to ask for fewer than the client holds.
    scope: Optional[str] = None

    def mode(self) -> str:
        if self.subject_token:
            return "token_exchange"
        if not self.client_id:
            raise DeliverdError(0, "no_client_id", "OAuth needs a client_id (dlvac_…), or a subject_token to exchange.")
        if self.private_key:
            return "private_key_jwt"
        if self.client_secret:
            return "secret"
        raise DeliverdError(0, "no_client_credentials", "OAuth needs a client_secret or a private_key for the client.")

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> Optional["AgentOAuth"]:
        """``DELIVERD_CLIENT_ID`` with ``DELIVERD_CLIENT_SECRET`` or
        ``DELIVERD_PRIVATE_KEY`` (a PEM; ``DELIVERD_KEY_ID`` for its kid).
        None when there is no client ID."""
        e = os.environ if env is None else env
        client_id = e.get("DELIVERD_CLIENT_ID")
        if not client_id:
            return None
        key = e.get("DELIVERD_PRIVATE_KEY") or None
        return cls(
            client_id=client_id,
            client_secret=e.get("DELIVERD_CLIENT_SECRET") or None,
            private_key=key.replace("\\n", "\n") if key else None,
            key_id=e.get("DELIVERD_KEY_ID") or None,
            scope=e.get("DELIVERD_SCOPE") or None,
        )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def client_assertion(
    client_id: str,
    audience: str,
    private_key: Union[str, bytes],
    key_id: Optional[str] = None,
    now: Optional[float] = None,
) -> str:
    """A signed client assertion (RFC 7523): one minute long, single use."""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    except ImportError as cause:  # pragma: no cover - depends on the environment
        raise DeliverdError(
            0,
            "cryptography_required",
            "Signing with a private key needs the cryptography package: pip install cryptography. Or use a client secret.",
            cause=cause,
        )
    pem = private_key.encode("utf-8") if isinstance(private_key, str) else private_key
    try:
        key: Any = serialization.load_pem_private_key(pem, password=None)
    except (ValueError, TypeError) as cause:
        raise DeliverdError(0, "invalid_private_key", "The private key could not be read: give an unencrypted PEM.", cause=cause)

    if isinstance(key, rsa.RSAPrivateKey):
        alg = "RS256"
    elif isinstance(key, ec.EllipticCurvePrivateKey):
        if key.curve.name != "secp256r1":
            raise DeliverdError(0, "invalid_private_key", "An EC key must be on P-256 (ES256).")
        alg = "ES256"
    elif isinstance(key, ed25519.Ed25519PrivateKey):
        alg = "EdDSA"
    else:
        raise DeliverdError(0, "invalid_private_key", "Use an RSA, EC P-256 or Ed25519 key.")

    issued = int(now if now is not None else time.time())
    header: Dict[str, Any] = {"alg": alg, "typ": "JWT"}
    if key_id:
        header["kid"] = key_id
    claims = {"iss": client_id, "sub": client_id, "aud": audience, "iat": issued, "exp": issued + 60, "jti": str(uuid.uuid4())}
    signing_input = "{}.{}".format(
        _b64url(json.dumps(header, separators=(",", ":")).encode()),
        _b64url(json.dumps(claims, separators=(",", ":")).encode()),
    ).encode("ascii")

    if alg == "RS256":
        signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    elif alg == "ES256":
        r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    else:
        signature = key.sign(signing_input)
    return "{}.{}".format(signing_input.decode("ascii"), _b64url(signature))


class TokenSource:
    """A cached access token from the token endpoint. Thread-safe: concurrent
    callers share one request."""

    def __init__(self, oauth: AgentOAuth, base_url: str, transport: Callable[..., Any], timeout: float, user_agent: str) -> None:
        self._oauth = oauth
        self._mode = oauth.mode()
        base = base_url.rstrip("/")
        self.token_endpoint = "{}/api/oauth/token".format(base)
        self._resource = "{}/api/v1".format(base)
        self._transport = transport
        self._timeout = timeout
        self._user_agent = user_agent
        self._lock = threading.Lock()
        self._token: Optional[str] = None
        self._until = 0.0

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._until = 0.0

    def token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._until:
                return self._token
            self._token, lifetime = self._fetch()
            # Renewed a minute early, or at half-life for a token shorter than two minutes.
            self._until = time.time() + max(lifetime / 2, lifetime - 60)
            return self._token

    def _fetch(self) -> "tuple[str, float]":
        o = self._oauth
        form: Dict[str, str] = {"resource": self._resource}
        if o.scope:
            form["scope"] = o.scope
        if self._mode == "token_exchange":
            subject = o.subject_token() if callable(o.subject_token) else o.subject_token
            form.update({"grant_type": TOKEN_EXCHANGE_GRANT, "subject_token": str(subject), "subject_token_type": JWT_TOKEN_TYPE})
        else:
            form.update({"grant_type": "client_credentials", "client_id": str(o.client_id)})
            if self._mode == "secret":
                form["client_secret"] = str(o.client_secret)
            else:
                form["client_assertion_type"] = CLIENT_ASSERTION_TYPE
                form["client_assertion"] = client_assertion(str(o.client_id), self.token_endpoint, o.private_key or "", o.key_id)
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": self._user_agent,
        }
        try:
            reply = self._transport(self.token_endpoint, "POST", urllib.parse.urlencode(form).encode("utf-8"), headers, self._timeout)
        except OSError as cause:
            raise DeliverdError(0, "network_error", "Could not reach {}.".format(self.token_endpoint), cause=cause)
        try:
            body = json.loads(reply.body) if reply.body else {}
        except ValueError:
            body = {}
        token = body.get("access_token") if isinstance(body, dict) else None
        if not (200 <= reply.status < 300) or not token:
            error = body.get("error", "error") if isinstance(body, dict) else "error"
            description = body.get("error_description") if isinstance(body, dict) else None
            raise DeliverdError(
                reply.status or 401,
                "oauth_token_refused",
                "The token endpoint refused: {}{}. Check the client on the agent's page in Deliverd (Agents → Agents → the agent → OAuth).".format(
                    error, ": {}".format(description) if description else ""
                ),
                {"oauth_error": error},
            )
        return str(token), max(30.0, float(body.get("expires_in") or 900))
