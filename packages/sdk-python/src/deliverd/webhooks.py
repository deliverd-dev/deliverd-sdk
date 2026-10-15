"""Verifying what Deliverd sends you.

The scheme is Stripe's — a timestamp and a signature in one header, the
timestamp inside the signed material — so this is the verification everyone has
written before. It is here anyway because a receiver that skips it is accepting
anything anyone posts at the URL, and "write your own HMAC check" is the step
every integration guide shows and half of them get wrong.

Kept byte-for-byte with the server's own ``lib/webhooks/signature.ts`` and with
the TypeScript SDK; ``sdk-parity.test.ts`` on the server holds all three
together.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional

from .errors import DeliverdError
from .types import CallbackEnvelope, WebhookEvent

SIGNATURE_HEADER = "deliverd-signature"
EVENT_HEADER = "deliverd-event"
DELIVERY_HEADER = "deliverd-delivery"

#: How old a signature may be. Five minutes, as the server sends.
TOLERANCE_SECONDS = 300


def signed_payload(timestamp: int, body: str) -> str:
    return "{}.{}".format(timestamp, body)


def verify_signature(
    secret: str,
    body: str,
    header: Optional[str],
    now: Optional[int] = None,
    tolerance_seconds: int = TOLERANCE_SECONDS,
) -> bool:
    """Whether the header is this secret's signature over this body, recently.

    ``body`` must be the raw request body, before any JSON parsing — a
    re-encoded object is a different string and will never verify. In Flask that
    means ``request.get_data(as_text=True)``; in FastAPI ``(await
    request.body()).decode()``; in Django ``request.body.decode()``.
    """
    if not header:
        return False
    stamp = int(time.time()) if now is None else now

    parts: Dict[str, str] = {}
    for piece in header.split(","):
        key, sep, value = piece.partition("=")
        if sep:
            parts[key.strip()] = value.strip()

    try:
        sent_at = int(parts["t"])
    except (KeyError, ValueError):
        return False
    signature = parts.get("v1")
    if not signature:
        return False
    if abs(stamp - sent_at) > tolerance_seconds:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        signed_payload(sent_at, body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    # compare_digest, not ==: a byte-by-byte comparison that stops at the first
    # difference tells an attacker how much of a forged signature was right.
    return hmac.compare_digest(expected, signature)


def construct_event(
    secret: str,
    body: str,
    header: Optional[str],
    now: Optional[int] = None,
    tolerance_seconds: int = TOLERANCE_SECONDS,
) -> WebhookEvent:
    """Verify and parse in one step, the way a handler wants it.

    Raises rather than returning ``None``, because a webhook route that treats
    an unverifiable body as "no event" answers 200 and tells the sender
    everything is fine.
    """
    if not verify_signature(secret, body, header, now=now, tolerance_seconds=tolerance_seconds):
        raise DeliverdError(
            400,
            "invalid_signature",
            "The signature did not verify. Check the endpoint's secret, and that you "
            "passed the raw request body rather than a re-encoded object.",
        )
    try:
        payload: Any = json.loads(body)
    except ValueError as cause:
        raise DeliverdError(
            400, "invalid_json", "The body verified but is not JSON.", cause=cause
        ) from cause
    return WebhookEvent.from_wire(payload)


def construct_callback(
    callback_secret: str,
    body: str,
    header: Optional[str],
    now: Optional[int] = None,
    tolerance_seconds: int = TOLERANCE_SECONDS,
) -> CallbackEnvelope:
    """Verify and parse a per-request callback.

    What Deliverd POSTs to the ``callback_url`` you gave when you asked, once a
    person answers. Signed exactly as a webhook is, with the request's own
    ``callback_secret`` (returned once, by the call that made the request) in
    place of an endpoint's. Raises on a body that does not verify.
    """
    if not verify_signature(callback_secret, body, header, now=now, tolerance_seconds=tolerance_seconds):
        raise DeliverdError(
            400,
            "invalid_signature",
            "The signature did not verify. Check the request's callback_secret, and that "
            "you passed the raw request body rather than a re-encoded object.",
        )
    try:
        payload: Any = json.loads(body)
    except ValueError as cause:
        raise DeliverdError(
            400, "invalid_json", "The body verified but is not JSON.", cause=cause
        ) from cause
    return CallbackEnvelope.from_wire(payload)


class Webhooks:
    """The verification helpers, reachable from the client as ``deliverd.webhooks``."""

    signature_header = SIGNATURE_HEADER
    event_header = EVENT_HEADER
    delivery_header = DELIVERY_HEADER
    tolerance_seconds = TOLERANCE_SECONDS

    @staticmethod
    def verify_signature(*args: Any, **kwargs: Any) -> bool:
        return verify_signature(*args, **kwargs)

    @staticmethod
    def construct_event(*args: Any, **kwargs: Any) -> WebhookEvent:
        return construct_event(*args, **kwargs)

    @staticmethod
    def construct_callback(*args: Any, **kwargs: Any) -> CallbackEnvelope:
        return construct_callback(*args, **kwargs)
