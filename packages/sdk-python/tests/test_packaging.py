"""The PyPI page, held to what a reader of it can actually follow.

``README.md`` and ``pyproject.toml`` are the page at pypi.org/project/deliverd.
Its readers have never signed in and cannot see this repository, and PyPI
renders the README without heading anchors. Each check here is something the
0.14.0 page got wrong while every other test passed.
"""

import os
import re
import unittest

HERE = os.path.dirname(__file__)

# Where this package is published from, and the one repository a link may name.
PUBLIC_REPO = "https://github.com/deliverd-dev/deliverd-sdk/"


def _read(name: str) -> str:
    with open(os.path.join(HERE, "..", name), encoding="utf-8") as handle:
        return handle.read()


def _project_urls() -> dict:
    section = _read("pyproject.toml").split("[project.urls]", 1)[1].split("\n[", 1)[0]
    return dict(re.findall(r'^\s*"?([^="\n]+?)"?\s*=\s*"([^"]+)"', section, re.M))


class ThePyPIPage(unittest.TestCase):
    def test_project_links_are_public_pages(self):
        """Source and Issues once pointed at a private repository: a 404 for every reader."""
        urls = _project_urls()
        self.assertGreaterEqual(len(urls), 3, "the project links are gone, so this checks nothing")
        for name, url in urls.items():
            self.assertTrue(
                url.startswith("https://deliverd.dev") or url.startswith(PUBLIC_REPO),
                "{} = {} is neither a deliverd.dev page nor the public repository".format(name, url),
            )

    def test_the_source_link_is_the_public_repository(self):
        """The sidebar's Source link, which reviewers and package scanners look for first."""
        urls = _project_urls()
        self.assertEqual(urls.get("Source"), PUBLIC_REPO + "tree/main/packages/sdk-python")
        self.assertEqual(urls.get("Changelog"), PUBLIC_REPO + "blob/main/packages/sdk-python/CHANGELOG.md")

    def test_the_licence_is_an_expression(self):
        """The table form put the whole licence text in the sidebar."""
        pyproject = _read("pyproject.toml")
        self.assertRegex(pyproject, r'(?m)^license = "MIT"$')
        # PEP 639 forbids the classifier alongside an expression; PyPI rejects the upload.
        self.assertNotIn("License ::", pyproject)

    def test_readme_has_no_in_page_links(self):
        """PyPI gives headings no ids, so ``[x](#y)`` goes nowhere there."""
        self.assertEqual(re.findall(r"\]\(#[^)]*\)", _read("README.md")), [])

    def test_readme_links_nothing_a_reader_cannot_open(self):
        readme = _read("README.md")
        self.assertNotIn("github.com/davidpreid/deliverd", readme)
        # A path in this repository, printed as if a reader had it.
        self.assertNotRegex(readme, r"`(docs|packages|apps)/[^`]+\.(md|ts|py)`")

    def test_readme_imports_what_it_uses(self):
        """The development-mode example used ``DevelopmentOptions`` without importing it."""
        import ast
        import sys

        sys.path.insert(0, os.path.join(HERE, "..", "src"))
        import deliverd

        blocks = re.findall(r"```python\n(.*?)```", _read("README.md"), re.S)
        self.assertGreater(len(blocks), 10, "the README has lost its examples, so this checks nothing")
        imported = set()
        for group in re.findall(r"from deliverd(?:\.\w+)* import ([\w, ]+)", "\n".join(blocks)):
            imported.update(n.strip() for n in group.split(","))
        # The module-level client is the one name a reader may use bare.
        exported = set(deliverd.__all__) - {"deliverd"}
        used = set()
        for block in blocks:
            tree = compile(block, "README.md", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)
            used.update(n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id in exported)
        self.assertIn("Deliverd", used)
        self.assertEqual(sorted(used - imported), [], "the README uses these and never imports them")


if __name__ == "__main__":
    unittest.main()


class RunningWithoutAKey(unittest.TestCase):
    """The one reader guaranteed to need an account is told where a free one is."""

    def test_the_hint_ends_with_the_tagged_sign_up_link(self):
        import sys

        sys.path.insert(0, os.path.join(HERE, "..", "src"))
        from deliverd.errors import DeliverdError
        from deliverd.messages import SIGN_UP_URL

        self.assertEqual(
            SIGN_UP_URL,
            "https://deliverd.dev/sign-up?utm_source=pypi&utm_medium=package"
            "&utm_campaign=python-sdk&utm_content=no-api-key",
        )
        error = DeliverdError(0, "no_api_key", "An api_key is required.")
        # Last, so a terminal that turns it into a link takes nothing after it.
        self.assertTrue(error.hint.endswith(" " + SIGN_UP_URL), error.hint)
        self.assertIn('Deliverd(mode="development")', error.hint)
