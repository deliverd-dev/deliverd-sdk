"""Every failure the SDK raises, with the API's own code on it.

One class rather than a hierarchy: callers branch on ``code``, which is the
string the API document lists, and an exception tree would make that the second
way to ask the same question. The properties below name the handful of cases
worth branching on so nobody has to memorise the codes.
"""

from __future__ import annotations

from typing import Any, Optional

from .messages import explain


class DeliverdError(Exception):
    """Something the API refused, or a request that never got there."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        explained, hint = explain(code, message)
        super().__init__(explained)
        #: HTTP status, or 0 when the request never got a response.
        self.status = status
        #: The API's error code: ``not_found``, ``rate_limited``, ``self_approval``…
        self.code = code
        #: Whatever the API attached — validation issues, the unknown approvers.
        self.details = details
        #: The one thing to do next, when we know it. Also the tail of the message.
        self.hint = hint
        #: How long the server asked us to wait, in seconds, when it said.
        self.retry_after: Optional[float] = None
        if cause is not None:
            self.__cause__ = cause

    @property
    def is_auth(self) -> bool:
        """The key is missing, wrong, or lacks the scope the call needs."""
        return self.status in (401, 403)

    @property
    def is_rate_limit(self) -> bool:
        """Slow down; the client already retried and gave up."""
        return self.status == 429

    @property
    def is_not_found(self) -> bool:
        """Nothing there, or nothing this key may see."""
        return self.status == 404

    @property
    def is_conflict(self) -> bool:
        """The request was fine and the state was not.

        Someone published between your read and your write, a version is
        awaiting approval, a question was already answered. Re-read and try
        again.
        """
        return self.status == 409

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "DeliverdError(status={!r}, code={!r})".format(self.status, self.code)


class DeliverdTimeoutError(DeliverdError):
    """Raised when a wait is abandoned rather than answered."""

    def __init__(self, message: str) -> None:
        super().__init__(0, "timeout", message)
