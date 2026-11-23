// Registers the actions rules.json names, so the hook's gates have something
// to be checked against. Run it once, and again whenever you edit the rules:
//
//   DELIVERD_API_KEY=dlv_… node .deliverd/register.mjs
//
// The key must belong to an owner or administrator and carry actions:write.
// An agent key is refused on purpose: an agent that could name actions could
// write the vocabulary its own policy is checked against.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { api, loadRules } from "./gate.mjs";

/** The schema the hook's `input` is held to. Unknown fields are refused, so this is exactly what gate.mjs sends. */
export const INPUT_SCHEMA = {
  type: "object",
  required: ["agent", "tool", "command", "repository"],
  properties: {
    agent: { type: "string", enum: ["claude", "codex", "cursor", "antigravity", "mcp-gate"] },
    tool: { type: "string", enum: ["bash", "powershell", "mcp"] },
    command: { type: "string", minLength: 1, maxLength: 4000 },
    repository: { type: "string", minLength: 1, maxLength: 200 },
  },
};

export function actionBody(rule) {
  return {
    actionId: rule.action,
    name: rule.name ?? rule.action,
    displayTitle: rule.tool ? "Call {{command}} from {{agent}}" : "Run {{command}} in {{repository}}",
    description: rule.tool
      ? "An MCP tool call a coding agent wants to make, checked by the Deliverd hook or MCP gate."
      : "A shell command a coding agent wants to run, checked by the Deliverd hook.",
    defaultRisk: "high",
    inputSchema: INPUT_SCHEMA,
  };
}

async function main() {
  if (!process.env.DELIVERD_API_KEY) throw new Error("Set DELIVERD_API_KEY to an owner's or administrator's key with actions:write.");
  const here = dirname(fileURLToPath(import.meta.url));
  const rules = loadRules(readFileSync(process.env.DELIVERD_HOOK_RULES || join(here, "rules.json"), "utf8"));
  for (const rule of rules) {
    await api(process.env, "POST", "/actions", actionBody(rule));
    console.log(`Registered ${rule.action}`);
  }
  console.log("Now say what each one needs under Agents → Rules → Publishing & request rules: allowed, refused, or a person decides.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
