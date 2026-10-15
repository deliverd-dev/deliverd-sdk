import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { day, emit, run } from "../ui.js";

/**
 * The action registry from a deploy.
 *
 * `push` is the point of this file. An action's id, its input schema and which
 * of its fields an approver may correct belong beside the function that
 * performs them, and the only way to keep those two in step is for the deploy
 * that ships the function to also ship the description of it. A registry
 * maintained by hand in a web form drifts from the code on the first refactor
 * and nobody finds out until a policy stops matching.
 *
 * So: a file in the repository, pushed by CI. It is an upsert, so running it
 * on every deploy is the normal case rather than an error, and it overwrites
 * only the half the code owns — an administrator's title, risk and sensitivity
 * survive it.
 *
 * **A person's key, not an agent's.** The API refuses an agent principal here,
 * because policy is keyed on the action id: an agent able to name actions
 * could name its way around the rule that governs it.
 */

interface Action {
  id: string;
  actionId: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  editableFields: string[];
  displayTitle: string | null;
  riskCategory: string;
  defaultRisk: string;
  source: "code" | "admin";
  createdAt: string;
}

interface ActionFile {
  actions: {
    actionId: string;
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    editableFields?: string[];
    displayTitle?: string;
    riskCategory?: string;
    defaultRisk?: string;
  }[];
}

/**
 * Read the file, and say which one when it is wrong.
 *
 * `JSON.parse` on a missing or malformed file throws a message naming neither
 * the path nor what was expected, which in CI is a red build and no hint.
 */
function readActions(path: string): ActionFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Could not read ${path}. Point --file at your actions file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const file = parsed as ActionFile;
  if (!file || !Array.isArray(file.actions)) {
    throw new Error(`${path} needs an \`actions\` array at the top level.`);
  }
  return file;
}

export function actionCommands(program: Command): void {
  const actions = program
    .command("actions")
    .description("The consequential things your software may do, named once");

  actions
    .command("push")
    .description("Register every action in a file. Run it on deploy; it is an upsert")
    .option("--file <path>", "The actions file", "deliverd.actions.json")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { file: string; json?: boolean }) => {
        const config = requireConfig();
        const file = readActions(options.file);

        /*
         * One at a time, and the first failure stops the run. A partial
         * registry is worse than none: half the actions updated and half not
         * is a state nobody can reason about, and the deploy that produced it
         * has already reported success for the ones that landed.
         */
        const pushed: Action[] = [];
        for (const definition of file.actions) {
          pushed.push(await api<Action>(config, "POST", "/actions", definition));
        }

        emit(options.json, pushed, () => {
          for (const action of pushed) {
            console.log(`${action.actionId}  ${action.name}`);
          }
          console.log(
            `\n${pushed.length} registered from ${options.file}. ` +
              `Policy is written against these ids.`
          );
        });
      })
    );

  actions
    .command("list")
    .description("What this organisation has registered")
    .option("--limit <n>", "How many to fetch per page")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Action>(config, "/actions", "actions", {
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { actions: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("Nothing registered yet. `deliverd actions push` registers from a file.");
            return;
          }
          for (const action of items) {
            const editable = action.editableFields.length
              ? `editable: ${action.editableFields.join(", ")}`
              : "approve or reject only";
            console.log(
              `${action.actionId}  ${action.name}  ${action.defaultRisk}  ${editable}  ${day(action.createdAt)}`
            );
          }
        });
      })
    );
}
