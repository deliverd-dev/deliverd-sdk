"""The ledger, and the two claims it can actually hold.

No test reaches PyPI — the same limit ``released.ts`` states about npm — so what
this file proves is internal consistency: that the working version is not one
the registry has already taken, and that the ledger and the changelog agree
about what went out.

The failure it exists for is specific and has happened three times on the
TypeScript side: a release goes out, nobody records it, and every surface that
reads the ledger keeps describing the version before it. The registry check
itself lives in ``.github/workflows/ci.yml``, which unlike a test has a network.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from deliverd._released import PUBLISHED_TO_PYPI, newest_published  # noqa: E402

HERE = os.path.dirname(__file__)
PACKAGE = os.path.join(HERE, "..")


def _version() -> str:
    """The version in pyproject.toml, read rather than imported.

    ``__version__`` is a second copy of this number and could disagree with it;
    the one that decides what a publish is named is the one in the build config.
    """
    with open(os.path.join(PACKAGE, "pyproject.toml"), encoding="utf-8") as handle:
        found = re.search(r'^version = "([^"]+)"', handle.read(), re.MULTILINE)
    assert found, "pyproject.toml has no version"
    return found.group(1)


def _as_numbers(version: str):
    return tuple(int(part) for part in version.split("."))


class LedgerTest(unittest.TestCase):
    def test_parses_to_something(self):
        # A guard over an empty list permits everything, and vacuous looks
        # exactly like passing.
        self.assertGreater(len(PUBLISHED_TO_PYPI), 2)
        for version in PUBLISHED_TO_PYPI:
            self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        self.assertEqual(len(set(PUBLISHED_TO_PYPI)), len(PUBLISHED_TO_PYPI))

    def test_is_in_release_order(self):
        ordered = sorted(PUBLISHED_TO_PYPI, key=_as_numbers)
        self.assertEqual(
            list(PUBLISHED_TO_PYPI),
            ordered,
            "newest_published() takes the last entry, so the order is load-bearing",
        )

    def test_working_version_is_not_already_published(self):
        self.assertNotIn(
            _version(),
            PUBLISHED_TO_PYPI,
            f"pyproject.toml is at {_version()}, which PyPI has already served. "
            "PyPI refuses a re-upload of a version, so this has to be a new one "
            "— and the code under the old number is what nobody can install.",
        )

    def test_agrees_with_the_changelog(self):
        """Held against the one file a release always touches.

        This is what makes staleness fail rather than rot: the ledger and the
        changelog are two records of the same event, kept by different hands.
        """
        with open(os.path.join(PACKAGE, "CHANGELOG.md"), encoding="utf-8") as handle:
            entries = re.findall(r"^## (\d+\.\d+\.\d+)$", handle.read(), re.MULTILINE)
        self.assertGreater(len(entries), 1, "CHANGELOG.md has no version headings")

        for version in PUBLISHED_TO_PYPI:
            self.assertIn(
                version,
                entries,
                f"{version} is recorded as published and has no CHANGELOG.md "
                "entry. One of the two is wrong.",
            )

        working = _version()
        for entry in entries:
            if entry == working:
                continue
            self.assertIn(
                entry,
                PUBLISHED_TO_PYPI,
                f"CHANGELOG.md describes {entry}, which is neither the working "
                "version nor recorded as published. If it shipped, add it to "
                "PUBLISHED_TO_PYPI; if it did not, it should not have an entry yet.",
            )

    def test_newest_published_is_the_last_entry(self):
        self.assertEqual(newest_published(), PUBLISHED_TO_PYPI[-1])


    def test_changelog_names_codes_that_exist(self):
        """The 0.4.1 entry lists error codes; a typo sends a reader grepping
        for a string the package never emits.

        Sliced to the two bullets that do the listing, because the prose
        around them names ``upload_id``, ``deliverd.http`` and four
        predicates, none of which is a code. Inside those bullets every
        backticked token is one.
        """
        import re as _re

        from deliverd.messages import EXPLANATIONS

        with open(os.path.join(PACKAGE, "CHANGELOG.md"), encoding="utf-8") as handle:
            changelog = handle.read()
        entry = changelog[changelog.index("## 0.4.1") : changelog.index("## 0.4.0")]
        self.assertGreater(len(entry), 400, "CHANGELOG.md has no 0.4.1 entry to check")

        bullets = _re.findall(
            r"^- \*\*(?:The gate|Five 404s)[\s\S]*?(?=\n\n)", entry, _re.M
        )
        self.assertEqual(
            len(bullets), 2, "The two listing bullets were not found, so this checks nothing"
        )

        named = [c for b in bullets for c in _re.findall(r"`([a-z][a-z_]+)`", b)]
        for code in named:
            self.assertIn(
                code,
                EXPLANATIONS,
                f"CHANGELOG.md's 0.4.1 entry names {code}, which the package does not explain",
            )
        self.assertIn("ten codes", entry, "The entry no longer says how many codes it changed")
        self.assertEqual(
            len(set(named)), 10, f"The entry says ten codes and lists {len(set(named))}"
        )


if __name__ == "__main__":
    unittest.main()
