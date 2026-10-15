import { readFileSync } from "node:fs";

/**
 * What `deliverd ask --input` accepts, and what an approval hands back.
 *
 * Approve with changes (0.9.0 of the SDK, and the REST API since September
 * 2026) lets a request carry the arguments it will run with, and lets the
 * approver correct named fields before saying yes. From a shell that means two
 * things: getting a JSON object in without fighting the quoting, and getting
 * the approved one back out in a form the next command can read.
 */

/**
 * `--input` as an object: inline JSON, or `@path` to read it from a file, or
 * `@-` for standard input — the three ways a shell script already has the
 * value. Anything but a JSON object is refused here, before a request is
 * raised that nobody can approve with meaning.
 */
export function parseInput(
  raw: string,
  read: (path: string) => string = (path) => readFileSync(path === "-" ? 0 : path, "utf8")
): Record<string, unknown> {
  const text = raw.startsWith("@") ? read(raw.slice(1)) : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      raw.startsWith("@")
        ? `--input ${raw}: that file is not JSON.`
        : `--input is not JSON. Quote it for the shell, e.g. --input '{"amount": 1240}', or pass a file with --input @input.json`
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("--input must be a JSON object of named arguments, e.g. {\"amount\": 1240}.");
  }
  return value as Record<string, unknown>;
}

/**
 * Fields an approver may correct. Refused without `--input`, and a name the
 * input does not have is refused too: the API would reject both, and saying so
 * before the request is raised names the flag rather than a field path.
 */
export function checkEditable(editable: string[] | undefined, input: Record<string, unknown> | undefined): void {
  if (!editable || editable.length === 0) return;
  if (!input) throw new Error("--editable needs --input: there is nothing for an approver to correct.");
  const missing = editable.filter((field) => !(field in input));
  if (missing.length > 0) {
    throw new Error(`--editable names ${missing.join(", ")}, which --input does not have.`);
  }
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** One line per correction, as a person would read it: `amount: 1240 → 1000`. */
export function changeLines(changes: FieldChange[] | undefined): string[] {
  return (changes ?? []).map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
}
