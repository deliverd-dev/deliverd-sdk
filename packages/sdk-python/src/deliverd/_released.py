"""Every version of this package PyPI has served.

The mirror of ``packages/sdk/src/released.ts`` for the Python half, written
after the TypeScript ledger proved its worth by going stale three times and the
Python half had nothing at all.

``docs/api.md`` states which versions the two registries serve. The npm half of
that sentence has been machine-checked since the ledger existed; the Python half
was a number somebody typed, with a comment in ``docs.test.ts`` saying so
plainly rather than implying it was guarded — *"if the Python package gets a
ledger, this is where the second half goes."* This is that ledger.

**Add the version here when you publish it, not before.** An entry is a claim
that ``pip install deliverd==x`` works today.

Two things it deliberately does not copy from the TypeScript side.

There is no ``RELEASED`` surface map and no ``FROZEN`` fingerprint. Over there
those exist because the marketing site asks *which namespace did the newest
published version carry* before it will print an SDK call; nothing asks that of
Python yet, and a surface map nobody reads is a list that rots quietly while
looking like a fact. The version list is the part that has a reader.

And nothing here is exported from ``__init__``. It is a fact about releases, not
API — a caller has ``__version__`` for the version they installed, which is a
different question from what the registry serves.
"""

PUBLISHED_TO_PYPI = (
    "0.1.0",
    "0.2.0",
    "0.2.1",
    "0.3.0",
    "0.4.0",
    "0.4.1",
    "0.5.0",
    "0.6.0",
    "0.7.0",
    "0.7.1",
    "0.8.0",
    "0.9.0",
    "0.10.0",
    "0.11.0",
    "0.12.0",
    "0.13.0",
    "0.14.0",
    "0.15.0",
    "0.16.0",
    "0.17.0",
    "0.18.0",
    "0.18.1",
)
"""In release order. The last entry is what ``pip install deliverd`` gets."""


def newest_published() -> str:
    """The version PyPI serves.

    Raises rather than returning a default when the list is empty: a reader that
    answers "nothing is published" permits every claim downstream, which is the
    wrong direction for this to fail in.
    """
    if not PUBLISHED_TO_PYPI:
        raise ValueError("PUBLISHED_TO_PYPI is empty")
    return PUBLISHED_TO_PYPI[-1]
