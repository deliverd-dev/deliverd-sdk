"""``expires_in="4h"`` rather than an ISO timestamp the caller has to compute.

Numbers are accepted too, and **a bare number is seconds** — which is the one
place this package deliberately differs from the TypeScript SDK, where it is
milliseconds.

The reason is that the number gets compared against, and passed to, the rest of
the language: ``time.sleep`` takes seconds, ``socket`` timeouts are seconds,
``timedelta.total_seconds()`` is seconds. A Python caller who writes
``timeout=30`` means half a minute, and a library that read it as a thirtieth of
a second would fail in the least helpful way available — instantly, with a
timeout error, on a call that was correct. Milliseconds are right for
JavaScript for the mirror-image reason: ``setTimeout`` takes them.

Every string form means the same thing in both languages, which is the form the
documentation and the examples use.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Union

#: What a duration may be written as: seconds, a ``timedelta``, or ``"30m"``.
Duration = Union[int, float, timedelta, str]

_UNITS = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}
_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)([smhd])$")


def duration_seconds(value: Duration) -> float:
    """Seconds, from whichever way the caller wrote it."""
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, bool):
        # bool is an int in Python, and `expires_in=True` is a mistake rather
        # than one second. Caught here because the arithmetic below would
        # otherwise succeed and produce a request that expires immediately.
        raise TypeError("A duration cannot be a boolean.")
    if isinstance(value, (int, float)):
        return float(value)
    match = _PATTERN.match(value.strip())
    if not match:
        raise ValueError(
            'Could not read "{}" as a duration. Use a number of seconds, a '
            'timedelta, or a string like "30m", "4h" or "2d".'.format(value)
        )
    return float(match.group(1)) * _UNITS[match.group(2)]
