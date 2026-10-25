"""The one place a request is made.

No dependencies: the standard library has HTTP, and an SDK that drags
``requests`` into every agent runtime for the sake of four verbs is a tax on
everyone who installs it.

Retries are deliberately narrow. A 429 or a 5xx or a dropped connection is
worth repeating; a 4xx is the API saying the request itself is wrong, and it
will be just as wrong in a second. ``Retry-After`` is honoured when the server
sends one, because guessing against a server that has told you the answer is
how a client turns a rate limit into an outage.

The transport is a single callable, so development mode swaps it and everything
above — the retries, the error mapping, the polling in ``wait()`` — runs
unchanged. A simulator that bypassed all that would prove your integration works
against the simulator.
"""

from __future__ import annotations

import http.client
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Mapping, NamedTuple, Optional

from .errors import DeliverdError

DEFAULT_BASE_URL = "https://deliverd.dev"
USER_AGENT = "deliverd-python"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3


class Reply(NamedTuple):
    """What a transport hands back: a status, the headers, and the raw body."""

    status: int
    headers: Mapping[str, str]
    body: str


#: A transport takes a fully-formed request and returns a :class:`Reply`.
Transport = Callable[[str, str, Optional[bytes], Mapping[str, str], float], Reply]


def urllib_transport(
    url: str,
    method: str,
    body: Optional[bytes],
    headers: Mapping[str, str],
    timeout: float,
) -> Reply:
    """The real one. ``urllib`` because it is already installed everywhere."""
    request = urllib.request.Request(url, data=body, method=method)
    for key, value in headers.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return Reply(response.status, dict(response.headers), response.read().decode(charset))
    except urllib.error.HTTPError as err:
        # An error status is an answer, not a failure: the body carries the
        # API's own code and message, which is the whole point of reading it.
        charset = err.headers.get_content_charset() or "utf-8" if err.headers else "utf-8"
        return Reply(err.code, dict(err.headers or {}), err.read().decode(charset, "replace"))


def _backoff_seconds(attempt: int) -> float:
    """Exponential from 500ms with jitter, so a fleet of agents does not resonate."""
    base = min(8.0, 0.5 * (2 ** (attempt - 1)))
    return base / 2 + random.random() * (base / 2)


def _parse_retry_after(header: Optional[str]) -> Optional[float]:
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - time.time())


def _describe_network_error(cause: BaseException) -> str:
    """A dropped connection says nothing useful on its own.

    The first thing anyone wonders is whether they typed the host wrong.
    """
    message = str(cause) or type(cause).__name__
    if "timed out" in message.lower() or isinstance(cause, TimeoutError):
        return "The request timed out: {}".format(message)
    return "Could not reach Deliverd: {}".format(message)


class HttpClient:
    """Every call the SDK makes goes through :meth:`request`."""

    def __init__(
        self,
        api_key: str,
        base_url: Optional[str] = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[Transport] = None,
        backoff: Optional[Callable[[int], float]] = None,
    ) -> None:
        if not api_key:
            raise DeliverdError(0, "no_api_key", "An api_key is required.")
        self._api_key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.max_retries = max(1, max_retries)
        self.timeout = timeout
        self._transport: Transport = transport or urllib_transport
        # A seam, not a hack: a caller running a fleet may want a different
        # curve, and a test suite wants none at all. `Retry-After` still wins
        # over whatever this returns, because the server knows better.
        self._backoff = backoff or _backoff_seconds

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        text: bool = False,
    ) -> Any:
        """The JSON the API answered with; with ``text``, the body as it came, for a route that returns a file."""
        url = "{}/api/v1{}".format(self.base_url, path)
        if query:
            pairs = [(k, str(v)) for k, v in query.items() if v is not None]
            if pairs:
                url = "{}?{}".format(url, urllib.parse.urlencode(pairs))

        # One id per logical request, kept across retries: it is the thing to
        # quote when something went wrong, and generating it here means nobody
        # has to remember to.
        correlation_id = str(uuid.uuid4())
        """
        One key per logical request, held across every attempt below — which is
        the whole point. These retries are why the server needs replay
        protection at all: a POST that arrived and lost its response on the way
        back would otherwise be retried as a second create, and for an approval
        that means two people asked to authorise one act.

        Only on POST: nothing else here creates anything.
        """
        key = (idempotency_key or str(uuid.uuid4())) if method == "POST" else None

        encoded = None if body is None else json.dumps(body).encode("utf-8")
        headers: Dict[str, str] = {
            "Authorization": "Bearer {}".format(self._api_key),
            "Accept": "text/markdown, application/json" if text else "application/json",
            "User-Agent": USER_AGENT,
            "deliverd-correlation-id": correlation_id,
        }
        if key is not None:
            headers["Idempotency-Key"] = key
        if encoded is not None:
            headers["Content-Type"] = "application/json"

        last_error: Optional[DeliverdError] = None
        for attempt in range(1, self.max_retries + 1):
            if attempt > 1:
                time.sleep(_retry_delay(last_error, attempt, self._backoff))

            try:
                reply = self._transport(url, method, encoded, headers, self.timeout)
            except (OSError, http.client.HTTPException) as cause:
                """
                Only the failures that are actually the network.

                `OSError` covers `URLError`, the socket errors and the timeout;
                `HTTPException` covers a truncated or malformed response, which
                `urllib` does not report as an `OSError`. Catching bare
                `Exception` here was worse than it looks: a `ValueError` from a
                mistyped development option came back as "Could not reach
                Deliverd — check your network", after being retried three times.
                A programming error must surface as itself, immediately.
                """
                last_error = DeliverdError(
                    0, "network_error", _describe_network_error(cause), cause=cause
                )
                if attempt == self.max_retries:
                    raise last_error
                continue

            if reply.status == 204:
                return None
            if text and 200 <= reply.status < 300:
                return reply.body

            try:
                payload = json.loads(reply.body) if reply.body else {}
            except ValueError:
                last_error = DeliverdError(
                    reply.status,
                    "invalid_response",
                    "Expected JSON from {} and got {}".format(path, reply.body[:120]),
                )
                if _is_retryable(reply.status) and attempt < self.max_retries:
                    continue
                raise last_error

            if 200 <= reply.status < 300:
                return payload

            envelope = payload.get("error") if isinstance(payload, dict) else None
            envelope = envelope if isinstance(envelope, dict) else {}
            last_error = DeliverdError(
                reply.status,
                envelope.get("code") or "error",
                envelope.get("message") or "Request failed ({})".format(reply.status),
                envelope.get("details"),
            )
            last_error.retry_after = _parse_retry_after(_header(reply.headers, "retry-after"))
            if _is_retryable(reply.status) and attempt < self.max_retries:
                continue
            raise last_error

        raise last_error or DeliverdError(0, "error", "Request failed.")


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    """Header lookup that does not care about case, because HTTP does not."""
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


#: A 5xx the server might get right next time. 501 is not one of them: it means
#: "I do not do that", which will be just as true in a second — the same
#: argument as a 4xx. Found by a development-mode test taking two and a half
#: seconds to be told three times that a call is not implemented.
RETRYABLE_5XX_EXCEPTIONS = (501,)


def _is_retryable(status: int) -> bool:
    """429 and most 5xx: a 4xx will be just as wrong on the next attempt."""
    if status == 429:
        return True
    return status >= 500 and status not in RETRYABLE_5XX_EXCEPTIONS


def _retry_delay(
    error: Optional[DeliverdError], attempt: int, backoff: Callable[[int], float]
) -> float:
    """How long before the next attempt.

    ``Retry-After`` beats the curve whenever the server sent one: guessing
    against a server that has told you the answer is how a client turns a rate
    limit into an outage.
    """
    if error is not None and error.retry_after is not None:
        return error.retry_after
    return backoff(attempt)
