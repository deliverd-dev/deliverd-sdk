import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { collect, listing } from "../paging.js";
import { day, emit, run } from "../ui.js";

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

interface PolicyFile {
  name: string;
  description?: string;
  note?: string;
  rules: Record<string, unknown>[];
}

/**
 * Read the file, and say which one when it is wrong.
 *
 * `JSON.parse` on a missing or malformed file throws a message naming neither
 * the path nor what was expected, which in CI is a red build and no hint.
 */
function readPolicy(path: string): PolicyFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read ${path}. Point --file at your policy file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const file = parsed as PolicyFile;
  if (!file || typeof file.name !== "string" || !Array.isArray(file.rules)) {
    throw new Error(`${path} needs a \`name\` and a \`rules\` array at the top level.`);
  }
  return file;
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
    .description("Store a policy file as a new version. Add --activate to put it in force")
    .option("--file <path>", "The policy file", "deliverd.policy.json")
    .option(
      "--activate",
      "Put this version in force immediately, superseding the one that was"
    )
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { file: string; activate?: boolean; json?: boolean }) => {
        const config = requireConfig();
        const file = readPolicy(options.file);

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
        const existing = items.find((p) => p.name === file.name);

        let version: Version;
        if (existing) {
          version = await api<Version>(config, "POST", `/policies/${existing.id}/versions`, {
            rules: file.rules,
            note: file.note,
            activate: options.activate ?? false,
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
            }
          );
          if (!created.version) throw new Error(`${options.file} stored no rules.`);
          version = created.version;
        }

        emit(options.json, version, () => {
          console.log(`${file.name}  version ${version.version}`);
          for (const line of describe(file.rules)) console.log(line);
          console.log(
            version.active
              ? `\nVersion ${version.version} is now in force. ${file.rules.length} rules.`
              : `\nStored as a draft. \`deliverd policy simulate\` tries the rules in force; ` +
                  `\`deliverd policy activate --version ${version.version}\` puts these ones there.`
          );
        });
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
