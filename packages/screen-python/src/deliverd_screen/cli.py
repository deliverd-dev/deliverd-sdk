"""deliverd-screen: the check from a terminal, a pre-commit hook or CI.

    deliverd-screen notes.txt
    cat prompt.txt | deliverd-screen --redact
    deliverd-screen --fail fixtures/*.json

Reads files, or standard input when there are none. Nothing is sent anywhere.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional, TextIO

from . import __version__, detect
from .data_screen import describe_counts, redact


def main(argv: Optional[List[str]] = None, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    parser = argparse.ArgumentParser(
        prog="deliverd-screen",
        description="Find personal data, secrets and confidential terms in text before it goes to an AI model. Runs locally; nothing is sent anywhere.",
    )
    parser.add_argument("files", nargs="*", help="files to check; standard input when none")
    parser.add_argument("--redact", action="store_true", help="print the text with what was found replaced by placeholders (one input)")
    parser.add_argument("--json", action="store_true", help="print what was found as JSON: kinds, offsets and counts, never values")
    parser.add_argument("--fail", action="store_true", help="exit 1 when anything is found")
    parser.add_argument("--terms", metavar="FILE", help="your own words not to send, one per line")
    parser.add_argument("-v", "--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    if args.redact and len(args.files) > 1:
        stderr.write("--redact takes one input.\n")
        return 2

    terms: List[str] = []
    if args.terms:
        with open(args.terms, encoding="utf-8") as f:
            terms = [t.strip() for t in f if t.strip() and not t.strip().startswith("#")]

    if not args.files or args.files == ["-"]:
        inputs = [("stdin", stdin.read())]
    else:
        inputs = []
        for name in args.files:
            with open(name, encoding="utf-8") as f:
                inputs.append((name, f.read()))

    found = 0
    report = []
    for name, text in inputs:
        findings, counts = detect(text, terms)
        found += len(findings)
        if args.redact:
            stdout.write(redact(text, findings).text)
        if args.json:
            report.append(
                {"file": name, "counts": counts, "findings": [{"kind": f.kind, "label": f.label, "start": f.start, "end": f.end} for f in findings]}
            )
        elif findings:
            stderr.write("{}: {}\n".format(name, describe_counts(counts)))
    if args.json:
        stdout.write(json.dumps(report[0] if len(report) == 1 else report, indent=2) + "\n")
    elif found == 0 and not args.redact:
        stderr.write("Nothing found.\n")
    return 1 if args.fail and found else 0
