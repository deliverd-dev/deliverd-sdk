import { appendFileSync } from "node:fs";
import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { collect, listing } from "../paging.js";
import { day, emit, run } from "../ui.js";
import {
  markdownReport,
  readPolicies,
  replayHeadline,
  type PolicyFile,
  type Replay,
  type TestRun,
} from "../policy-files.js";

/**
 * Gate policy as code.
 *
 * What an action *costs* — allowed, refused, or a person decides — belongs in
 * the repository for the same reason the action's schema does: a rule kept in
 * a web form has no history anybody can review, no diff, and no way to be
 * wrong in a pull request rather than in production. `push` is the point of
 * the file, and `simulate` is what makes pushing it safe.
 *
 * **Not an upsert, unlike `actions push`.** Registering an action again is the
 * normal case and overwrites only what the code owns. A policy is different:
 * silently replacing the rules an organisation is running under is the one
 * write nobody should make by accident. So `push` adds a **version** to a
 * policy that already exists and creates it only the first time, which is also
 * what makes the change reviewable afterwards — the old version stays readable
 * by every decision that pointed at it.
 *
 * **An administrator's key.** The API refuses an agent principal, and refuses
 * anybody who is not an owner or an administrator of the organisation. Writing
 * a rule is how authority is granted: `effect: "allow"` on `finance.refund` is
 * the sentence that removes the human, so it is not something a key can confer
 * on somebody who does not already hold it.
 */

interface Policy {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  activeVersion: number | null;
  activeVersionId: string | null;
  versions: number;
  createdAt: string;
}

interface Version {
  id: string;
  version: number;
  active: boolean;
  unchanged?: boolean;
}

interface Source {
  repository: string;
  commit?: string;
  path?: string;
}

/**
 * The repository a push comes from, which marks the version "Managed in Git"
 * in the app. `--git` reads it from the CI environment (GitHub Actions sets
 * `GITHUB_REPOSITORY` and `GITHUB_SHA`); `--source-repo` names it outright.
 */
function sourceFor(
  options: { git?: boolean; sourceRepo?: string; sourceCommit?: string },
  path: string
): Source | undefined {
  const repository = options.sourceRepo ?? (options.git ? process.env.GITHUB_REPOSITORY : undefined);
  if (!repository) {
    if (options.git) throw new Error("--git needs GITHUB_REPOSITORY in the environment, or --source-repo.");
    return undefined;
  }
  const commit = options.sourceCommit ?? (options.git ? process.env.GITHUB_SHA : undefined);
  return { repository, ...(commit ? { commit } : {}), path };
}

/** Append to a file when one was named: `$GITHUB_STEP_SUMMARY`, or a comment body for a later step. */
function writeMarkdown(path: string | undefined, sections: Parameters<typeof markdownReport>[0]): void {
  if (path) appendFileSync(path, `${markdownReport(sections)}\n`);
}

interface Simulation {
  effect: "allow" | "deny" | "require_human";
  rule: { name: string; priority: number; effect: string } | null;
  reason: string | null;
  requiredApprovals: number;
  approvers: string[];
  expiresInMinutes: number | null;
  escalateAfterMinutes: number | null;
  policyVersionId: string | null;
  input: Record<string, unknown>;
  governed: boolean;
}

/** One line per rule, in the order the evaluator will consider them. */
function describe(rules: Record<string, unknown>[]): string[] {
  return [...rules]
    .sort((a, b) => ((a.priority as number) ?? 100) - ((b.priority as number) ?? 100))
    .map((rule) => {
      const match = (rule.match as Record<string, unknown> | undefined) ?? {};
      const actions = Array.isArray(match.actions) ? match.actions.join(", ") : "any action";
      return `  ${(rule.priority as number) ?? 100}  ${rule.effect}  ${rule.name}  (${actions})`;
    });
}

export function policyCommands(program: Command): void {
  const policy = program
    .command("policy")
    .description("What a registered action costs: allowed, refused, or a person decides");

  policy
    .command("push")
    .description("Store a policy file (or a directory of them) as new versions. Add --activate to put them in force")
    .option("--file <path>", "A policy file (JSON or YAML), or a directory of them", "deliverd.policy.json")
    .option(
      "--activate",
      "Put this version in force immediately, superseding the one that was"
    )
    .option("--git", "Mark the versions as managed in Git, reading the repository and commit from CI")
    .option("--source-repo <repo>", "The repository the files are kept in (owner/name). Implies managed in Git")
    .option("--source-commit <sha>", "The commit the files were read at")
    .option("--skip-unchanged", "Store nothing for a policy whose version in force already has exactly these rules")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (options: {
          file: string;
          activate?: boolean;
          git?: boolean;
          sourceRepo?: string;
          sourceCommit?: string;
          skipUnchanged?: boolean;
          json?: boolean;
        }) => {
          const config = requireConfig();
          const files = readPolicies(options.file);

          /*
           * Find the policy before writing anything. Creating it blind would
           * fail on the second run of a pipeline that is meant to be repeatable,
           * and the failure — "a policy called X already exists" — is correct
           * and useless: what the caller wanted was the next version of it.
           *
           * `collect` rather than `listing`, and rather than one page: the walk
           * to the end is the whole point here, so it is named. Reading page one
           * and concluding the policy is new would, past the fiftieth policy,
           * create a second one under a name the organisation already had and
           * report that the push succeeded.
           */
          const items = await collect<Policy>(config, "/policies", "policies");
          const pushed: { file: PolicyFile; version: Version }[] = [];

          for (const file of files) {
            const existing = items.find((p) => p.name === file.name);
            const source = sourceFor(options, file.path);
            let version: Version;
            if (existing) {
              version = await api<Version>(config, "POST", `/policies/${existing.id}/versions`, {
                rules: file.rules,
                note: file.note,
                activate: options.activate ?? false,
                source,
                skipUnchanged: options.skipUnchanged ?? false,
              });
            } else {
              const created = await api<{ id: string; name: string; version: Version | null }>(
                config,
                "POST",
                "/policies",
                {
                  name: file.name,
                  description: file.description,
                  rules: file.rules,
                  note: file.note,
                  activate: options.activate ?? false,
                  source,
                }
              );
              if (!created.version) throw new Error(`${file.path} stored no rules.`);
              version = created.version;
            }
            pushed.push({ file, version });
          }

          emit(options.json, files.length === 1 && pushed[0] ? pushed[0].version : pushed.map((p) => ({ name: p.file.name, ...p.version })), () => {
            for (const { file, version } of pushed) {
              if (version.unchanged) {
                console.log(`${file.name}  unchanged: version ${version.version} in force already says this.`);
                continue;
              }
              console.log(`${file.name}  version ${version.version}`);
              for (const line of describe(file.rules)) console.log(line);
              console.log(
                version.active
                  ? `Version ${version.version} is now in force. ${file.rules.length} rules.\n`
                  : `Stored as a draft. \`deliverd policy replay\` shows what it would change; ` +
                      `\`deliverd policy activate --version ${version.version}\` puts it in force.\n`
              );
            }
          });
        }
      )
    );

  policy
    .command("test")
    .description("Run the test cases in a policy file (or a directory of them) against its rules. Writes nothing")
    .option("--file <path>", "A policy file (JSON or YAML), or a directory of them", "deliverd.policy.json")
    .option("--markdown <path>", "Also append a Markdown summary to this file, e.g. $GITHUB_STEP_SUMMARY")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { file: string; markdown?: string; json?: boolean }) => {
        const config = requireConfig();
        const files = readPolicies(options.file);
        const runs: { file: PolicyFile; test: TestRun }[] = [];
        for (const file of files) {
          const test = await api<TestRun>(config, "POST", "/policies/test", {
            name: file.name,
            rules: file.rules,
            tests: file.tests,
          });
          runs.push({ file, test });
        }
        writeMarkdown(options.markdown, runs);
        const failed = runs.reduce((n, r) => n + r.test.failed, 0);
        emit(options.json, runs.map((r) => ({ file: r.file.path, ...r.test })), () => {
          for (const { file, test } of runs) {
            if (test.results.length === 0) {
              console.log(`${file.name}  no test cases in ${file.path}`);
              continue;
            }
            console.log(`${file.name}  ${test.passed} passed, ${test.failed} failed`);
            for (const r of test.results) console.log(`  ${r.passed ? "ok  " : "FAIL"}  ${r.name}${r.problem ? `: ${r.problem}` : ""}`);
            for (const n of test.notes) console.log(`  ${n}`);
          }
        });
        if (failed > 0) process.exit(1);
      })
    );

  policy
    .command("replay")
    .description("What a policy file would have done to the decisions already made, beside the rules in force. Writes nothing")
    .option("--file <path>", "A policy file (JSON or YAML), or a directory of them", "deliverd.policy.json")
    .option("--days <n>", "How far back, up to 90", "30")
    .option(
      "--fail-on <what>",
      "Exit 1 when: rejected_allowed (a request a person rejected would now be allowed), loosened, changed, or never",
      "rejected_allowed"
    )
    .option("--markdown <path>", "Also append a Markdown summary to this file, e.g. $GITHUB_STEP_SUMMARY")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { file: string; days: string; failOn: string; markdown?: string; json?: boolean }) => {
        const config = requireConfig();
        const files = readPolicies(options.file);
        const runs: { file: PolicyFile; replay: Replay }[] = [];
        for (const file of files) {
          const replay = await api<Replay>(config, "POST", "/policies/replay", {
            name: file.name,
            rules: file.rules,
            days: Number(options.days),
            failOn: options.failOn,
          });
          runs.push({ file, replay });
        }
        writeMarkdown(options.markdown, runs);
        emit(options.json, runs.map((r) => ({ file: r.file.path, ...r.replay })), () => {
          for (const { file, replay } of runs) {
            console.log(`${file.name}  ${replayHeadline(replay)}`);
            for (const t of replay.transitions) console.log(`  ${t.count}  ${t.from} → ${t.to}`);
            if (replay.rejectedNowAllowed > 0) {
              console.log(`  ${replay.rejectedNowAllowed} that a person rejected would now be allowed without asking.`);
            }
            for (const e of replay.examples.slice(0, 5)) {
              console.log(`  e.g. ${e.actionId} ${day(e.createdAt)}: ${e.from} → ${e.to}${e.outcome ? ` (${e.outcome} at the time)` : ""}`);
            }
            if (replay.fail && replay.failReason) console.log(`  FAIL  ${replay.failReason}`);
            for (const n of replay.notes) console.log(`  ${n}`);
          }
        });
        if (runs.some((r) => r.replay.fail)) process.exit(1);
      })
    );

  policy
    .command("list")
    .description("The policies this organisation has, and which version is in force")
    .option("--limit <n>", "How many to fetch per page")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Policy>(config, "/policies", "policies", {
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { policies: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log(
              "No policy yet, so every gated action asks a person. " +
                "`deliverd policy push` writes one."
            );
            return;
          }
          for (const p of items) {
            const inForce =
              p.activeVersion === null ? "no version in force" : `v${p.activeVersion} in force`;
            console.log(
              `${p.name}  ${inForce}  ${p.versions} version${p.versions === 1 ? "" : "s"}  ` +
                `${p.enabled ? "enabled" : "disabled"}  ${day(p.createdAt)}`
            );
          }
        });
      })
    );

  policy
    .command("activate")
    .description("Put a stored version in force, superseding the one that was")
    .requiredOption("--policy <id>", "The policy")
    .requiredOption("--version <n>", "The version number")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { policy: string; version: string; json?: boolean }) => {
        const config = requireConfig();
        const version = await api<Version>(
          config,
          "POST",
          `/policies/${options.policy}/activate`,
          { version: Number(options.version) }
        );
        emit(options.json, version, () => {
          console.log(`Version ${version.version} is now in force.`);
        });
      })
    );

  policy
    .command("simulate")
    .description("What would happen to this request, with nothing happening")
    .requiredOption("--action <id>", "The registered action, e.g. finance.refund")
    .requiredOption("--input <json>", "The arguments, as JSON")
    .option("--agent <id>", "Test as a particular agent")
    .option("--environment <name>", "Test in a particular environment")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (options: {
          action: string;
          input: string;
          agent?: string;
          environment?: string;
          json?: boolean;
        }) => {
          const config = requireConfig();
          let input: unknown;
          try {
            input = JSON.parse(options.input);
          } catch (err) {
            throw new Error(`--input is not valid JSON: ${(err as Error).message}`);
          }

          const result = await api<Simulation>(config, "POST", "/policies/simulate", {
            actionId: options.action,
            input,
            agentId: options.agent,
            environment: options.environment,
          });

          emit(options.json, result, () => {
            console.log(`${options.action}  →  ${result.effect}`);
            /*
             * "Nothing matched" is printed differently from "a rule said so",
             * because they are the same effect and very different facts about
             * an organisation's policy — and telling them apart is usually the
             * reason somebody ran this.
             */
            console.log(
              result.governed
                ? `Rule: ${result.rule?.name} (priority ${result.rule?.priority})`
                : "No rule covers this action, so the fail-closed default asks a person."
            );
            if (result.reason) console.log(result.reason);
            if (result.effect === "require_human") {
              const who =
                result.approvers.length > 0
                  ? result.approvers.join(", ")
                  : "the owners and administrators";
              console.log(
                `Approvals needed: ${result.requiredApprovals}, from ${who}.` +
                  (result.expiresInMinutes ? ` Expires in ${result.expiresInMinutes} minutes.` : "")
              );
            }
            console.log("\nNothing was recorded. This changed no production decision.");
          });
        }
      )
    );
}
