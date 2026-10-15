# Releasing to PyPI

Moved out of `README.md`, which is the PyPI page and is read by people
installing the package rather than publishing it.

The package is published from
[deliverd-dev/deliverd-sdk](https://github.com/deliverd-dev/deliverd-sdk), the
public repository it is copied to. There, GitHub Actions
(`.github/workflows/publish-python.yml`) builds, re-runs the suite on Python
3.9, checks that the tag and `pyproject.toml` agree, and uploads through PyPI
Trusted Publishing: there is no API token anywhere.

Tag and push in that repository, or run the workflow by hand on `main`:

```bash
git tag python-v0.18.2 && git push origin python-v0.18.2
```

Then record the version in `src/deliverd/_released.py` and the date and commit
in `CHANGELOG.md`, and open the next patch version.
