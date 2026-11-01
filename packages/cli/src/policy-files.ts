import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Policy files, as kept in a repository.
 *
 * One policy per file, JSON or YAML, with its rules and, optionally, the test
 * cases that say what those rules must do. `--file` takes one file or a
 * directory of them (`deliverd/policies/`), so a repository can hold one file
 * per policy and CI can test, replay and push them all.
 */

export interface PolicyTest {
  name: string;
  action: string;
  input?: Record<string, unknown>;
  agentId?: string;
  environment?: string;
  risk?: string;
  expect: { effect: string; rule?: string | null };
  [key: string]: unknown;
}

export interface PolicyFile {
  /** Where it was read from, relative to where the command ran. */
  path: string;
  name: string;
  description?: string;
  note?: string;
  rules: Record<string, unknown>[];
  tests: PolicyTest[];
}

const EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

/** Parse one file's text. The path picks the format and names the file in every error. */
export function parsePolicyText(path: string, raw: string): PolicyFile {
  let parsed: unknown;
  const ext = extname(path).toLowerCase();
  try {
    parsed = ext === ".yaml" || ext === ".yml" ? parseYaml(raw) : JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid ${ext === ".json" ? "JSON" : "YAML"}: ${(err as Error).message}`);
  }
  const file = parsed as Partial<PolicyFile> | null;
  if (!file || typeof file !== "object" || typeof file.name !== "string" || !Array.isArray(file.rules)) {
    throw new Error(`${path} needs a \`name\` and a \`rules\` list at the top level.`);
  }
  if (file.tests !== undefined && !Array.isArray(file.tests)) {
    throw new Error(`${path}: \`tests\` must be a list.`);
  }
  return {
    path,
    name: file.name,
    description: file.description,
    note: file.note,
    rules: file.rules,
    tests: (file.tests ?? []) as PolicyTest[],
  };
}

/** Every policy file at `target`: the file itself, or each JSON or YAML file in the directory, sorted. */
export function readPolicies(target: string): PolicyFile[] {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new Error(`Could not read ${target}. Point --file at a policy file or a directory of them.`);
  }
  const paths = stat.isDirectory()
    ? readdirSync(target)
        .filter((f) => EXTENSIONS.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(target, f))
    : [target];
  if (paths.length === 0) throw new Error(`${target} has no .json, .yaml or .yml policy files.`);
  const files = paths.map((p) => parsePolicyText(p, readFileSync(p, "utf8")));
  const seen = new Map<string, string>();
  for (const f of files) {
    const other = seen.get(f.name);
    if (other) throw new Error(`${f.path} and ${other} both describe "${f.name}". One file per policy.`);
    seen.set(f.name, f.path);
  }
  return files;
}

// ── Reports ─────────────────────────────────────────────────────────────────

export interface TestRun {
  policyName: string;
  passed: number;
  failed: number;
  results: { name: string; passed: boolean; effect: string; rule: string | null; problem: string | null }[];
  notes: string[];
}

export interface Replay {
  policyName: string;
  days: number;
  replayed: number;
  changed: number;
  loosened: number;
  tightened: number;
  rejectedNowAllowed: number;
  ruleChanged: number;
  transitions: { from: string; to: string; count: number }[];
  examples: {
    id: string;
    createdAt: string;
    actionId: string;
    from: string;
    to: string;
    toRule: string | null;
    outcome: string | null;
  }[];
  notes: string[];
  fail: boolean;
  failReason: string | null;
}

const WORDS: Record<string, string> = {
  allow: "allowed",
  require_review: "reviewed",
  require_human: "a person",
  deny: "refused",
};

const word = (effect: string) => WORDS[effect] ?? effect;

/** One line for a replay, the headline in a terminal and a PR comment alike. */
export function replayHeadline(r: Replay): string {
  if (r.replayed === 0) return `No gated requests in the last ${r.days} days to replay.`;
  if (r.changed === 0) return `None of ${r.replayed} requests from the last ${r.days} days would be decided differently.`;
  return (
    `${r.changed} of ${r.replayed} requests from the last ${r.days} days would be decided differently: ` +
    `${r.loosened} would ask less, ${r.tightened} would ask more.`
  );
}

/** The summary CI writes for a pull request: tests, then replay, per policy. */
export function markdownReport(sections: { file: PolicyFile; test?: TestRun; replay?: Replay }[]): string {
  const out: string[] = ["## Deliverd policy check", ""];
  for (const { file, test, replay } of sections) {
    out.push(`### ${file.name}`, "", `\`${file.path}\``, "");
    if (test) {
      out.push(
        test.results.length === 0
          ? "No test cases in this file."
          : `**Tests:** ${test.passed} passed, ${test.failed} failed.`
      );
      for (const r of test.results.filter((x) => !x.passed)) out.push(`- ❌ ${r.name}: ${r.problem}`);
      out.push("");
    }
    if (replay) {
      out.push(`**Replay:** ${replayHeadline(replay)}`);
      if (replay.rejectedNowAllowed > 0) {
        out.push(
          "",
          `> ⚠️ ${replay.rejectedNowAllowed} ${replay.rejectedNowAllowed === 1 ? "request" : "requests"} a person rejected would now be allowed without asking.`
        );
      }
      if (replay.transitions.length > 0) {
        out.push("", "| From | To | Requests |", "| --- | --- | --- |");
        for (const t of replay.transitions) out.push(`| ${word(t.from)} | ${word(t.to)} | ${t.count} |`);
      }
      if (replay.examples.length > 0) {
        out.push("", "<details><summary>Examples</summary>", "");
        for (const e of replay.examples.slice(0, 10)) {
          out.push(
            `- \`${e.actionId}\` ${e.createdAt.slice(0, 10)}: ${word(e.from)} → ${word(e.to)}` +
              `${e.toRule ? ` (“${e.toRule}”)` : " (no rule matches)"}${e.outcome ? `, ${e.outcome} at the time` : ""}`
          );
        }
        out.push("", "</details>");
      }
      if (replay.fail && replay.failReason) out.push("", `**Failing:** ${replay.failReason}`);
      for (const n of replay.notes) out.push("", `_${n}_`);
      out.push("");
    }
  }
  return out.join("\n");
}
