// An MCP gateway: put it in front of any stdio MCP server, and every tool call
// your rules name is checked with a Deliverd gate before the server sees it.
//
//   node .deliverd/mcp-gate.mjs --name stripe -- npx -y @stripe/mcp --tools=all
//
// Configure it in your agent where you would have configured the server, with
// the same command after `--`. Every message passes through unchanged except
// `tools/call`:
//
// - no rule names the tool: forwarded as it is;
// - a rule names it and Deliverd says yes: forwarded, with the signed decision
//   token in `params._meta["dev.deliverd/decision-token"]` so a server that
//   checks it can, and the result is recorded against the gate;
// - anything else: answered here as a tool error the model reads, with the
//   reason and the approval link, and the server never sees the call.
//
// Unlike a hook, this works with any MCP client, because it is the server the
// client talks to. It is a check on the calls that pass through it, not a
// sandbox: a client configured to talk to the real server directly is outside
// it.
//
// In front of Xero's or QuickBooks Online's MCP server, add `--ledger xero` or
// `--ledger quickbooks`: every tool that changes the books (approve a bill,
// record a payment, post a journal, change a supplier's bank details...) is
// then a finance gate with its amount and counterparty, whatever rules.json
// says, and reads pass straight through. The finance actions are the
// "Agents in the books" starter kit's.
//
//   node .deliverd/mcp-gate.mjs --ledger xero -- npx -y @xeroapi/xero-mcp-server@latest
//
// No dependencies. Messages are newline-delimited JSON-RPC, as the stdio
// transport defines them.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { api, canonicalJson, externalId, gateBody, loadRules, match, verdict } from "./gate.mjs";
import { LEDGERS, LEDGER_LABEL, classifyLedgerTool } from "./ledgers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOKEN_META = "dev.deliverd/decision-token";

/** `--name stripe -- command args…`, or the name from `DELIVERD_MCP_SERVER`; `--ledger xero|quickbooks` for a ledger's server. */
export function parseArgs(argv, env = {}) {
  const at = argv.indexOf("--");
  const own = at === -1 ? [] : argv.slice(0, at);
  const command = at === -1 ? argv : argv.slice(at + 1);
  const i = own.indexOf("--name");
  const l = own.indexOf("--ledger");
  const ledger = (l !== -1 ? own[l + 1] : env.DELIVERD_LEDGER) || null;
  if (ledger && !LEDGERS.includes(ledger)) throw new Error(`--ledger is one of ${LEDGERS.join(", ")}.`);
  const name = (i !== -1 ? own[i + 1] : env.DELIVERD_MCP_SERVER) ?? ledger ?? "";
  if (!command.length) throw new Error("Give the MCP server's command after --.");
  return { name, ledger, command: command[0], args: command.slice(1) };
}

/** A ledger tool call as a finance gate: the action, amount and counterparty read from the call. */
export function ledgerRule(ledger, message) {
  const found = classifyLedgerTool(ledger, String(message.params?.name ?? ""), message.params?.arguments ?? {});
  if (!found) return null;
  return { action: found.actionId, name: found.summary, ledgerCall: found };
}

function ledgerGateBody(ledger, call, rule, env, uses) {
  const { ledgerCall } = rule;
  return {
    actionId: ledgerCall.actionId,
    externalId: externalId("mcp-gate", call.sessionId, rule, call.command, uses),
    input: ledgerCall.input,
    description: `An agent wants to ${ledgerCall.summary.charAt(0).toLowerCase()}${ledgerCall.summary.slice(1)}, through ${LEDGER_LABEL[ledger]}'s MCP server.`,
    ...(env.DELIVERD_ENVIRONMENT ? { environment: env.DELIVERD_ENVIRONMENT.slice(0, 60) } : {}),
    metadata: { source: "mcp-gate", ledger, sessionId: call.sessionId || undefined },
  };
}

/** A `tools/call` as the hook's call shape, so the same rules and gate apply. */
export function callFrom(server, message, sessionId) {
  const tool = String(message.params?.name ?? "");
  const args = message.params?.arguments ?? {};
  const name = server ? `${server}__${tool}` : tool;
  return { kind: "mcp", tool: "mcp", name, arguments: args, command: `${name} ${canonicalJson(args)}`, sessionId, cwd: process.cwd() };
}

/** A JSON-RPC answer the model reads as the tool having failed, with why. */
export function toolError(id, reason) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reason }], isError: true } };
}

/**
 * The gate itself, for one `tools/call`. Returns what to send on: the message
 * for the server (with the token added), or the answer for the client.
 * Fails closed, like the hooks.
 */
export async function decide({ server, ledger = null, message, rules, env, sessionId, uses, fetch: fetchImpl = fetch }) {
  const call = callFrom(server, message, sessionId);
  const rule = (ledger ? ledgerRule(ledger, message) : null) ?? match(rules, call);
  if (!rule) return { forward: message, gateId: null };
  if (!env.DELIVERD_API_KEY) {
    return { reply: toolError(message.id, `Deliverd: ${rule.name ?? rule.action} must be checked first, and DELIVERD_API_KEY is not set for this gateway.`) };
  }
  let gate;
  try {
    const body = rule.ledgerCall ? ledgerGateBody(ledger, call, rule, env, uses) : gateBody("mcp-gate", call, rule, env, uses);
    gate = await api(env, "POST", "/gates", body, fetchImpl);
  } catch (error) {
    return { reply: toolError(message.id, `Deliverd: could not check ${rule.name ?? rule.action}, so it does not go ahead (${error.message}).`) };
  }
  const decision = verdict(gate, rule);
  if (!decision.allow) return { reply: toolError(message.id, decision.reason), key: call.command };
  const params = { ...message.params, _meta: { ...(message.params?._meta ?? {}), ...(gate.decisionToken ? { [TOKEN_META]: gate.decisionToken } : {}) } };
  return { forward: { ...message, params }, gateId: gate.id, key: call.command };
}

/** Records how a forwarded call ended. Never in the way of the answer. */
export async function record(env, gateId, response, fetchImpl = fetch) {
  const bad = !!response.error || response.result?.isError === true;
  await api(
    env,
    "POST",
    `/gates/${gateId}/execution`,
    { phase: bad ? "failed" : "completed", executedAt: new Date().toISOString(), result: { agent: "mcp-gate", tool: "mcp", outcome: bad ? "failed" : "success" } },
    fetchImpl
  ).catch(() => {});
}

async function main() {
  const { name, ledger, command, args } = parseArgs(process.argv.slice(2), process.env);
  const rulesPath = process.env.DELIVERD_HOOK_RULES || join(HERE, "rules.json");
  const rules = existsSync(rulesPath) ? loadRules(readFileSync(rulesPath, "utf8")) : [];
  const sessionId = process.env.DELIVERD_SESSION_ID || randomUUID();
  const uses = new Map();
  const pending = new Map();

  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
  const send = (stream, message) => stream.write(JSON.stringify(message) + "\n");

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(line + "\n");
      return;
    }
    const waiting = message.id !== undefined ? pending.get(message.id) : undefined;
    if (waiting) {
      pending.delete(message.id);
      void record(process.env, waiting.gateId, message);
    }
    send(process.stdout, message);
  });

  // In order: a call waits for its gate, and nothing behind it overtakes it.
  let queue = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        child.stdin.write(line + "\n");
        return;
      }
      if (message.method !== "tools/call") return send(child.stdin, message);
      const key = callFrom(name, message, sessionId).command;
      const out = await decide({ server: name, ledger, message, rules, env: process.env, sessionId, uses: uses.get(key) ?? 0 });
      if (out.reply) return send(process.stdout, out.reply);
      if (out.gateId) {
        uses.set(key, (uses.get(key) ?? 0) + 1);
        pending.set(message.id, { gateId: out.gateId });
      }
      send(child.stdin, out.forward);
    });
  });
  process.stdin.on("end", () => queue.then(() => child.stdin.end()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Deliverd MCP gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
