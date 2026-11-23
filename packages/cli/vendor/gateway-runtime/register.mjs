// Registers the action the runtime's gates are checked against. Run it once,
// with a key that belongs to an owner or administrator and carries
// actions:write (an agent key is refused on purpose):
//
//   DELIVERD_API_KEY=dlv_… node register.mjs

import { pathToFileURL } from "node:url";
import { ACTION_ID, INPUT_SCHEMA } from "./gateway.mjs";
import { deliverdApi } from "./server.mjs";

export function actionBody(actionId = ACTION_ID) {
  return {
    actionId,
    name: "Call a tool on an in-house application",
    description: "A tool call an agent made through the Deliverd gateway runtime, inside your own network, checked before the application sees it.",
    displayTitle: "{{tool}} on {{application}} for {{caller}}",
    defaultRisk: "high",
    inputSchema: INPUT_SCHEMA,
  };
}

async function main() {
  if (!process.env.DELIVERD_API_KEY) throw new Error("Set DELIVERD_API_KEY to an owner's or administrator's key with actions:write.");
  const body = actionBody(process.env.DELIVERD_ACTION_ID || ACTION_ID);
  await deliverdApi(process.env)("POST", "/actions", body);
  console.log(
    `Registered ${body.actionId}. Now say what it needs under Agents → Rules → Publishing & request rules. ` +
      "A common start: allow when access is read, a person decides when access is write. Until a rule says otherwise, a person decides every call."
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
