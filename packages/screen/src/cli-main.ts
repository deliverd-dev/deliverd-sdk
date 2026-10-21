/**
 * deliverd-screen: the check from a terminal, a pre-commit hook or CI.
 *
 *   deliverd-screen notes.txt               what is in it
 *   cat prompt.txt | deliverd-screen --redact   the text with it replaced
 *   deliverd-screen --fail fixtures/*.json  exit 1 if anything is found
 *   deliverd-screen mcp                     a local MCP server over stdio
 *
 * Reads files, or standard input when there are none. Nothing is sent
 * anywhere.
 */

import { readFileSync } from "node:fs";
import { describeCounts, redact, type ScreenTerm } from "./data-screen.js";
import { detect } from "./index.js";
import { serve } from "./mcp.js";
import { VERSION } from "./version.js";

const HELP = `deliverd-screen ${VERSION}: find personal data, secrets and confidential terms in text before it goes to an AI model.

Usage:
  deliverd-screen [options] [file...]   check files, or standard input
  deliverd-screen mcp                   run a local MCP server over stdio

Options:
  --redact         print the text with what was found replaced by placeholders (one input)
  --json           print what was found as JSON: kinds, offsets and counts, never values
  --fail           exit 1 when anything is found (for pre-commit hooks and CI)
  --terms <file>   your own words not to send, one per line
  -h, --help       this help
  -v, --version    the version

Runs locally. Nothing is sent anywhere. A net, not a guarantee: names are not
found unless you plug in a model (see the README).`;

export async function main(argv: string[], io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  if (argv[0] === "mcp") {
    await serve(io.stdin, io.stdout);
    return 0;
  }
  const files: string[] = [];
  let redactOut = false;
  let json = false;
  let failOnFind = false;
  let terms: ScreenTerm[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      io.stdout.write(HELP + "\n");
      return 0;
    }
    if (a === "-v" || a === "--version") {
      io.stdout.write(VERSION + "\n");
      return 0;
    }
    if (a === "--redact") redactOut = true;
    else if (a === "--json") json = true;
    else if (a === "--fail") failOnFind = true;
    else if (a === "--terms") {
      const path = argv[++i];
      if (!path) {
        io.stderr.write("--terms needs a file.\n");
        return 2;
      }
      terms = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter((t) => t && !t.startsWith("#"))
        .map((term) => ({ term }));
    } else if (a.startsWith("-") && a !== "-") {
      io.stderr.write(`Unknown option ${a}. See --help.\n`);
      return 2;
    } else files.push(a);
  }
  if (redactOut && files.length > 1) {
    io.stderr.write("--redact takes one input.\n");
    return 2;
  }

  const inputs = files.length === 0 || (files.length === 1 && files[0] === "-") ? [{ name: "stdin", text: await readAll(io.stdin) }] : files.map((f) => ({ name: f, text: readFileSync(f, "utf8") }));
  let found = 0;
  const report: object[] = [];
  for (const input of inputs) {
    const { findings, counts } = await detect(input.text, { terms });
    found += findings.length;
    if (redactOut) io.stdout.write(redact(input.text, findings).text);
    if (json) report.push({ file: input.name, counts, findings: findings.map(({ kind, start, end, label }) => ({ kind, label, start, end })) });
    else if (findings.length > 0) io.stderr.write(`${input.name}: ${describeCounts(counts)}\n`);
  }
  if (json) io.stdout.write(JSON.stringify(inputs.length === 1 ? report[0] : report, null, 2) + "\n");
  else if (found === 0 && !redactOut) io.stderr.write("Nothing found.\n");
  return failOnFind && found > 0 ? 1 : 0;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return out;
}

