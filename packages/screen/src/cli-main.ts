/**
 * deliverd-screen: the check from a terminal, a pre-commit hook or CI.
 *
 *   deliverd-screen notes.txt               what is in it
 *   cat prompt.txt | deliverd-screen --redact   the text with it replaced
 *   deliverd-screen --fail fixtures/*.json  exit 1 if anything is found
 *   deliverd-screen mcp                     a local MCP server over stdio
 *   deliverd-screen proxy --upstream URL    a local proxy that screens every model request
 *   deliverd-screen history export.zip      what you have already pasted into ChatGPT or Claude
 *
 * Reads files, or standard input when there are none. Nothing is sent
 * anywhere.
 */

import { readFileSync } from "node:fs";
import { describeCounts, redact, type ScreenTerm } from "./data-screen.js";
import { names } from "./adapters.js";
import { detect } from "./index.js";
import { serve } from "./mcp.js";
import { startProxy } from "./proxy.js";
import { formatHistoryReport, scanHistory } from "./history.js";
import { readExport } from "./history-file.js";
import { purviewFromEnv } from "./purview-env.js";
import { SCREEN_CLASSIFICATIONS, type ScreenClassification } from "./data-screen.js";
import { VERSION } from "./version.js";

const HELP = `deliverd-screen ${VERSION}: find personal data, secrets and confidential terms in text before it goes to an AI model.

Usage:
  deliverd-screen [options] [file...]   check files, or standard input
  deliverd-screen mcp                   run a local MCP server over stdio
  deliverd-screen proxy [options]       screen every request to a model API
      --upstream <url>   where to send screened requests (default https://api.openai.com)
      --port <n>         where to listen on localhost (default 8787)
      --personal-data    the model may receive personal data
      --classification <public|internal|confidential|restricted>   the most it may receive (default internal)
      --terms <file>, --names   as below
  deliverd-screen history <export>      what you have already pasted into ChatGPT or Claude:
                                        their data export (.zip, folder or conversations.json)
      --assistant        read the assistant's answers too
      --top <n>          how many conversations to list (default 10)
      --json, --terms <file>   as below

Options:
  --redact         print the text with what was found replaced by placeholders (one input)
  --json           print what was found as JSON: kinds, offsets and counts, never values
  --fail           exit 1 when anything is found (for pre-commit hooks and CI)
  --terms <file>   your own words not to send, one per line
  --names          also find people's names, with a model that runs on this machine
                   (needs: npm install @huggingface/transformers; downloaded once)
  -h, --help       this help
  -v, --version    the version

Runs locally. Nothing is sent anywhere. A net, not a guarantee: names are not
found unless you add --names or plug in a model (see the README).`;

export async function main(argv: string[], io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  if (argv[0] === "proxy") return proxy(argv.slice(1), io);
  if (argv[0] === "history") return history(argv.slice(1), io);
  if (argv[0] === "mcp") {
    await serve(io.stdin, io.stdout);
    return 0;
  }
  const files: string[] = [];
  let redactOut = false;
  let json = false;
  let failOnFind = false;
  let terms: ScreenTerm[] = [];
  let withNames = false;
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
    else if (a === "--names") withNames = true;
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
  const detectors = withNames
    ? [names({ onLoad: (m) => io.stderr.write(`Loading the name model ${m}. It is downloaded once, then runs on this machine.\n`) })]
    : [];
  let found = 0;
  const report: object[] = [];
  for (const input of inputs) {
    const { findings, counts } = await detect(input.text, { terms, detectors });
    found += findings.length;
    if (redactOut) io.stdout.write(redact(input.text, findings).text);
    if (json) report.push({ file: input.name, counts, findings: findings.map(({ kind, start, end, label }) => ({ kind, label, start, end })) });
    else if (findings.length > 0) io.stderr.write(`${input.name}: ${describeCounts(counts)}\n`);
  }
  if (json) io.stdout.write(JSON.stringify(inputs.length === 1 ? report[0] : report, null, 2) + "\n");
  else if (found === 0 && !redactOut) io.stderr.write("Nothing found.\n");
  return failOnFind && found > 0 ? 1 : 0;
}

function readTerms(path: string): ScreenTerm[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"))
    .map((term) => ({ term }));
}

async function history(argv: string[], io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }): Promise<number> {
  let path = "";
  let assistant = false;
  let json = false;
  let top = 10;
  let terms: ScreenTerm[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--assistant") assistant = true;
    else if (a === "--json") json = true;
    else if (a === "--top") top = Number(argv[++i]);
    else if (a === "--terms") terms = readTerms(argv[++i] ?? "");
    else if (a.startsWith("-")) {
      io.stderr.write(`Unknown option ${a}. See --help.\n`);
      return 2;
    } else path = a;
  }
  if (!path) {
    io.stderr.write("history needs the export: the .zip ChatGPT or Claude sent you, its folder, or conversations.json.\n");
    return 2;
  }
  let report;
  try {
    report = scanHistory(readExport(path), { assistant, terms, top: Number.isInteger(top) && top >= 0 ? top : 10 });
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  io.stdout.write((json ? JSON.stringify(report, null, 2) : formatHistoryReport(report)) + "\n");
  return 0;
}

async function proxy(argv: string[], io: { stderr: NodeJS.WritableStream }): Promise<number> {
  let upstream = "https://api.openai.com";
  let port = 8787;
  let personalData = false;
  let classification: ScreenClassification = "internal";
  let terms: ScreenTerm[] = [];
  let withNames = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--upstream") upstream = next();
    else if (a === "--port") port = Number(next());
    else if (a === "--personal-data") personalData = true;
    else if (a === "--classification") classification = next() as ScreenClassification;
    else if (a === "--terms") terms = readTerms(next());
    else if (a === "--names") withNames = true;
    else {
      io.stderr.write(`Unknown option ${a}. See --help.\n`);
      return 2;
    }
  }
  if (!/^https?:\/\//.test(upstream)) {
    io.stderr.write("--upstream is a URL, such as https://api.openai.com.\n");
    return 2;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    io.stderr.write("--port is a number from 1 to 65535.\n");
    return 2;
  }
  if (!SCREEN_CLASSIFICATIONS.includes(classification)) {
    io.stderr.write(`--classification is one of ${SCREEN_CLASSIFICATIONS.join(", ")}.\n`);
    return 2;
  }
  const purview = purviewFromEnv();
  await startProxy({
    upstream,
    port,
    model: upstream,
    allow: { personalData, classification },
    terms,
    detectors: withNames ? [names()] : [],
    ...(purview ? { purview } : {}),
    log: (line) => io.stderr.write(line + "\n"),
  });
  io.stderr.write(`Deliverd Screen is screening requests to ${upstream} at http://127.0.0.1:${port}. Point your tool's base URL there.\n`);
  await new Promise(() => undefined);
  return 0;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return out;
}

