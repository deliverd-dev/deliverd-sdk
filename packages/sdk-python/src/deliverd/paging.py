"""What the SDK does about a list that does not fit in one answer.

The API says where it stopped: a response carries ``nextCursor``, null when the
page is the end of the list and a string to pass back when it is not. That
leaves the client one decision, and it is worth stating rather than leaving to
whoever reads the call:

**``limit`` set means one page of that size. ``limit`` unset means all of
them.** ``list()`` with no limit follows the cursor until the API stops offering
one, so ``len()`` is the real count rather than a page size that happens to look
like one. A caller who wants to page by hand asks for a ``limit``, or uses
``list_page`` and drives the cursor themselves.

The alternative — return a page and let the caller notice — reads fine and fails
quietly, because a full page and a complete list are indistinguishable until
somebody counts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Generic, Iterator, List, Optional, TypeVar

T = TypeVar("T")


@dataclass
class Page(Generic[T]):
    """One page, and the cursor to continue from — ``None`` when it is the end.

    A generic dataclass rather than a generic ``NamedTuple``: the latter needs
    Python 3.11, and this package claims 3.9. It raised on *import*, so every
    call in the package was broken on the two oldest versions it advertises —
    found by running the suite on the floor rather than on the newest.

    ``__iter__`` keeps ``items, cursor = page`` working, which is how a tuple
    would have read.
    """

    items: List[T]
    next_cursor: Optional[str]

    def __iter__(self) -> Iterator[object]:
        return iter((self.items, self.next_cursor))


def collect(fetch_page: Callable[[Optional[str]], "Page[T]"]) -> List[T]:
    """Follow the cursor to the end, collecting as we go.

    A page that comes back empty while still offering a cursor ends the loop as
    well — a server that did that would otherwise spin here for ever.
    """
    out: List[T] = []
    cursor: Optional[str] = None
    while True:
        page = fetch_page(cursor)
        out.extend(page.items)
        if not page.next_cursor or not page.items:
            return out
        cursor = page.next_cursor


def list_or_collect(
    limit: Optional[int],
    cursor: Optional[str],
    fetch_page: Callable[[Optional[int], Optional[str]], "Page[T]"],
) -> List[T]:
    """One page, or every page, depending on whether a limit was asked for."""
    if limit is not None:
        return fetch_page(limit, cursor).items
    return collect(lambda c: fetch_page(None, c))
