// A hook for Claude Code, Codex, Cursor and Google Antigravity that checks a Deliverd gate before
// the agent runs a shell command or calls an MCP tool your rules name, and
// records what ran afterwards.
//
//   node .deliverd/gate.mjs claude pre     (Claude Code PreToolUse)
//   node .deliverd/gate.mjs claude post    (Claude Code PostToolUse)
//   node .deliverd/gate.mjs codex pre      (Codex PreToolUse)
//   node .deliverd/gate.mjs codex post     (Codex PostToolUse)
//   node .deliverd/gate.mjs cursor pre     (Cursor beforeShellExecution, beforeMCPExecution)
//   node .deliverd/gate.mjs antigravity pre   (Antigravity PreToolUse)
//   node .deliverd/gate.mjs antigravity post  (Antigravity PostToolUse)
//
// No dependencies: every one of these agents already runs Node, and a hook
// that installs packages before every tool call is slow and has a supply chain.
//
// The same pack as the GitHub Copilot hooks, for the other three agents. It
// asks once and answers inside 20 seconds; when the answer is "a person
// decides" it refuses the call with the link, and the same call in the same
// session finds the same decision once somebody has approved it. Claude Code
// and Codex give a hook ten minutes, so `DELIVERD_HOOK_WAIT_SECONDS` lets the
// hook wait for the person instead.
//
// Allowing never overrides the agent's own permission prompts: a yes from
// Deliverd is your organisation's authorisation, and the agent may still ask
// its user. Only a refusal is ever written back.
//
// Exported functions are pure where they can be, so the tests exercise them
// without a network; `main()` is the only part that reads stdin and exits.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOSTED = "https://deliverd.dev";
export const TIMEOUT_MS = 20_000;
/** The longest a hook may wait for a person: under the ten minutes Claude Code and Codex allow. */
export const MAX_WAIT_SECONDS = 540;
export const AGENTS = ["claude", "codex", "cursor", "antigravity"];
const SHELLS = new Set(["bash", "shell", "local_shell", "exec_command", "powershell"]);
/**
 * Antigravity's own tools, as its hooks name them (antigravity.google/docs/hooks)
 * and as its SDK does (`BuiltinTools`). `run_command` is the shell; the rest
 * are never gated. Anything not listed is taken to be an MCP tool.
 */
export const ANTIGRAVITY_BUILTINS = new Set([
  "view_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "list_dir", "find_by_name",
  "grep_search", "search_web", "read_url_content", "manage_task", "schedule", "list_permissions", "ask_permission",
  "invoke_subagent", "define_subagent", "send_message", "manage_subagents", "ask_question", "generate_image",
  "list_directory", "search_directory", "find_file", "create_file", "edit_file", "run_workflow", "finish", "start_subagent",
]);
const HERE = dirname(fileURLToPath(import.meta.url));

/** The rules file, compiled. A pattern that does not compile is a mistake to hear about, not skip. */
export function loadRules(text) {
  const { rules } = JSON.parse(text);
  return rules.map((rule) => ({
    ...rule,
    pattern: rule.match ? new RegExp(rule.match, "i") : null,
    toolPattern: rule.tool ? new RegExp(rule.tool, "i") : null,
  }));
}

/** Keys sorted at every depth, so the same arguments are always the same text. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function parseMaybe(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

/**
 * An MCP tool's server and name, from `mcp__server__tool` (Claude Code,
 * Codex) or a bare name with the server beside it (Cursor). Deliverd's own
 * tools are never gated: asking the gate whether you may ask the gate is a
 * loop, not a control.
 */
export function mcpTool(name, server) {
  const parts = String(name).split("__");
  const [srv, tool] = parts[0] === "mcp" && parts.length >= 3 ? [parts[1], parts.slice(2).join("__")] : [server ?? "", String(name)];
  if (/^deliverd$/i.test(srv ?? "")) return null;
  return { server: srv ?? "", tool, qualified: srv ? `${srv}__${tool}` : tool };
}

/**
 * An Antigravity tool call: `toolCall` with `name` and `args` (PascalCase,
 * `CommandLine` for a shell command), the conversation as the session.
 * Antigravity does not document how an MCP tool is named to a hook, so the
 * server is read from the call when it says (`serverName`, as its SDK carries
 * it), else from `server/tool` or `mcp__server__tool`, else left empty and the
 * rules match the bare tool name. A name in Deliverd's own namespace
 * (`deliverd_…`, as a plugin's tools are prefixed) is never gated.
 */
export function readAntigravityCall(event) {
  const toolCall = event.toolCall ?? {};
  const name = String(toolCall.name ?? "");
  const args = parseMaybe(toolCall.args);
  const sessionId = String(event.conversationId ?? "");
  const cwd = String(args.Cwd ?? event.workspacePaths?.[0] ?? "");
  const result = event.error ? { is_error: true, error: String(event.error) } : null;
  if (!name) return null;
  if (name === "run_command") {
    const command = typeof args.CommandLine === "string" ? args.CommandLine : "";
    if (!command.trim()) return null;
    // "bash" in the gate input: the registered schema names shells, not tools.
    return { kind: "shell", tool: "bash", command, sessionId, cwd, result };
  }
  if (ANTIGRAVITY_BUILTINS.has(name) || /^browser_/.test(name)) return null;
  const slash = name.indexOf("/");
  const server = toolCall.serverName ?? toolCall.server_name ?? (slash > 0 ? name.slice(0, slash) : undefined);
  const bare = slash > 0 && !toolCall.serverName && !toolCall.server_name ? name.slice(slash + 1) : name;
  if (/^deliverd_/i.test(bare)) return null;
  const mcp = mcpTool(bare, server);
  if (!mcp) return null;
  return { kind: "mcp", tool: "mcp", name: mcp.qualified, arguments: args, command: `${mcp.qualified} ${canonicalJson(args)}`, sessionId, cwd, result };
}

/**
 * The call, from what each agent sends. Claude Code and Codex send
 * `tool_name` and `tool_input`; Cursor sends `command` for a shell and
 * `tool_name` with `tool_input` as a JSON string for MCP. Anything that is
 * neither a shell command nor an MCP tool comes back null.
 */
export function readCall(agent, event) {
  if (agent === "antigravity") return readAntigravityCall(event);
  const sessionId = String(event.session_id ?? event.conversation_id ?? event.sessionId ?? "");
  const cwd = String(event.cwd ?? event.workspace_roots?.[0] ?? "");
  const result = event.tool_response ?? null;
  const toolName = String(event.tool_name ?? "");
  const cursorShell = agent === "cursor" && (event.hook_event_name === "beforeShellExecution" || (typeof event.command === "string" && !toolName));

  if (cursorShell || SHELLS.has(toolName.toLowerCase())) {
    const input = parseMaybe(event.tool_input);
    const raw = cursorShell ? event.command : input.command;
    const command = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "";
    if (!command.trim()) return null;
    return { kind: "shell", tool: toolName.toLowerCase() === "powershell" ? "powershell" : "bash", command, sessionId, cwd, result };
  }

  const mcp = toolName.startsWith("mcp__") || (agent === "cursor" && toolName) ? mcpTool(toolName, event.server ?? event.mcp_server) : null;
  if (!mcp) return null;
  const args = parseMaybe(event.tool_input);
  return {
    kind: "mcp",
    tool: "mcp",
    name: mcp.qualified,
    arguments: args,
    // What the rule's description and the person deciding read: the tool, then its arguments.
    command: `${mcp.qualified} ${canonicalJson(args)}`,
    sessionId,
    cwd,
    result,
  };
}

/** The first rule that names this call, or null when none does. */
export function match(rules, call) {
  return (
    rules.find((rule) =>
      call.kind === "mcp" ? rule.toolPattern?.test(call.name) : rule.pattern?.test(call.command)
    ) ?? null
  );
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

export function repository(env, cwd) {
  return (env.DELIVERD_REPOSITORY || env.GITHUB_REPOSITORY || basename(cwd || process.cwd()) || "unknown").slice(0, 200);
}

/**
 * The unit of work, so a retry finds the decision rather than raising a second
 * one: this agent, this session, this exact call, and how many times it has
 * already been made with a permission.
 */
export function externalId(agent, sessionId, rule, command, uses) {
  const session = sessionId ? digest(sessionId).slice(0, 16) : "nosession";
  return `${agent}:${session}:${digest(`${rule.action}\n${command}`).slice(0, 24)}:${uses}`;
}

const LABEL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", "mcp-gate": "An agent, through the Deliverd MCP gate," };

/** The gate request. `input` is exactly the registered schema: unknown fields are refused. */
export function gateBody(agent, call, rule, env, uses) {
  const repo = repository(env, call.cwd);
  const what = call.kind === "mcp" ? `call the MCP tool ${call.name}` : `run this ${call.tool} command`;
  return {
    actionId: rule.action,
    externalId: externalId(agent, call.sessionId, rule, call.command, uses),
    input: { agent, tool: call.tool, command: call.command.slice(0, 4000), repository: repo },
    description: `${LABEL[agent] ?? agent} wants to ${what} in ${repo}: ${call.command.slice(0, 300)}`,
    ...(env.DELIVERD_ENVIRONMENT ? { environment: env.DELIVERD_ENVIRONMENT.slice(0, 60) } : {}),
    metadata: { source: `${agent}-hook`, sessionId: call.sessionId || undefined },
  };
}

/** What to tell the agent, from the gate's answer. Only `canExecute` lets the call through. */
export function verdict(gate, rule) {
  if (gate.canExecute === true) return { allow: true, gateId: gate.id };
  const why = {
    pending: `needs a person's approval, and Deliverd has asked for it${gate.approvalUrl ? ` at ${gate.approvalUrl}` : ""}. Stop here and tell the user. Once it is approved, make exactly the same call again`,
    denied: `is refused by your organisation's policy${gate.reason ? `: ${gate.reason}` : ""}`,
    rejected: "was rejected by the person who decided",
    changes_requested: "was sent back by the person who decided. Change it, then try again",
    expired: "was not decided in time. Try again to ask again",
    cancelled: "was withdrawn",
    revoked: "had its permission taken back",
    used: "has already been done once with its permission",
  }[gate.status] ?? `was not allowed (${gate.status})`;
  return { allow: false, reason: `Deliverd: ${rule.name ?? rule.action} ${why}. Do not look for another way to do the same thing.` };
}

export function stateFile(env, agent, sessionId) {
  const dir = env.DELIVERD_HOOK_STATE || join(tmpdir(), "deliverd-agent-hook");
  return join(dir, `${agent}-${sessionId ? digest(sessionId).slice(0, 16) : "nosession"}.json`);
}
function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { uses: {}, granted: {} };
  }
}
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

export async function api(env, method, path, body, fetchImpl = fetch) {
  const base = (env.DELIVERD_URL || HOSTED).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.DELIVERD_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message ?? json.message ?? `HTTP ${response.status}`);
  return json;
}

/**
 * How long to wait for a person: `DELIVERD_HOOK_WAIT_SECONDS`, never for
 * Cursor, never past the cap. Antigravity gives a hook 30 seconds unless its
 * `timeout` says more, so raise that too when you set this for Antigravity.
 */
export function waitSeconds(agent, env) {
  if (agent === "cursor") return 0;
  const n = Number(env.DELIVERD_HOOK_WAIT_SECONDS ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_SECONDS) : 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Before the call. Returns the decision rather than exiting, so it can be
 * tested. Fails closed: a call a rule names does not go ahead unless Deliverd
 * said yes, whether the key is missing, the network is down or the action is
 * not registered.
 */
export async function pre(agent, event, env, rules, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const call = readCall(agent, event);
  if (!call) return { allow: true, checked: false };
  const rule = match(rules, call);
  if (!rule) return { allow: true, checked: false };
  if (!env.DELIVERD_API_KEY) {
    return { allow: false, reason: `Deliverd: ${rule.name ?? rule.action} must be checked first, and DELIVERD_API_KEY is not set for this agent.` };
  }

  const path = stateFile(env, agent, call.sessionId);
  const state = readState(path);
  const key = digest(`${rule.action}\n${call.command}`);
  const uses = state.uses[key] ?? 0;
  let gate;
  try {
    gate = await api(env, "POST", "/gates", gateBody(agent, call, rule, env, uses), fetchImpl);
    const until = Date.now() + waitSeconds(agent, env) * 1000;
    while (gate.status === "pending" && Date.now() < until) {
      await (options.sleep ?? sleep)(Math.min(3000, Math.max(0, until - Date.now())));
      gate = await api(env, "GET", `/gates/${gate.id}`, undefined, fetchImpl);
    }
  } catch (error) {
    return { allow: false, reason: `Deliverd: could not check ${rule.name ?? rule.action}, so it does not go ahead (${error.message}).` };
  }
  const decision = verdict(gate, rule);
  if (!decision.allow) return decision;

  if (agent === "cursor") {
    // Cursor sends nothing after a call, so the use is claimed here, as
    // started: the record says it was let through, and does not claim to
    // know how it ended.
    state.uses[key] = uses + 1;
    writeState(path, state);
    await api(
      env,
      "POST",
      `/gates/${gate.id}/execution`,
      { phase: "started", executedAt: new Date().toISOString(), detail: "Cursor reports no outcome after a call; recorded when it was let through." },
      fetchImpl
    ).catch(() => {});
    return { ...decision, checked: true };
  }
  state.granted[key] = gate.id;
  writeState(path, state);
  return { ...decision, checked: true };
}

/** Whether the tool said it failed. Claude Code and Codex shape a response differently per tool. */
export function failed(result) {
  if (!result || typeof result !== "object") return false;
  return result.is_error === true || (typeof result.error === "string" && result.error !== "") || result.isError === true || result.interrupted === true || (typeof result.exit_code === "number" && result.exit_code !== 0);
}

/**
 * After the call (Claude Code, Codex and Antigravity). Reports it against the permission it
 * used, so the record says what happened and the permission is spent. Never
 * refuses anything: the call has already happened.
 */
export async function post(agent, event, env, rules, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const call = readCall(agent, event);
  if (!call || !env.DELIVERD_API_KEY) return;
  const rule = match(rules, call);
  if (!rule) return;
  const path = stateFile(env, agent, call.sessionId);
  const state = readState(path);
  const key = digest(`${rule.action}\n${call.command}`);
  const gateId = state.granted[key];
  if (!gateId) return;

  delete state.granted[key];
  state.uses[key] = (state.uses[key] ?? 0) + 1;
  writeState(path, state);
  const bad = failed(call.result);
  await api(
    env,
    "POST",
    `/gates/${gateId}/execution`,
    {
      phase: bad ? "failed" : "completed",
      executedAt: new Date().toISOString(),
      result: { agent, tool: call.tool, outcome: bad ? "failed" : "success" },
    },
    fetchImpl
  ).catch(() => {});
}

/**
 * What the hook writes, and how it exits, to refuse. Each agent reads a
 * refusal its own way; allowing writes nothing, so the agent's own prompts
 * still apply.
 */
export function refusal(agent, event, reason) {
  if (agent === "cursor") {
    return { stdout: JSON.stringify({ continue: true, permission: "deny", userMessage: reason, agentMessage: reason }), exitCode: 0 };
  }
  if (agent === "antigravity") {
    // "deny" hard-blocks the call; the reason is what the agent reads.
    return { stdout: JSON.stringify({ decision: "deny", reason }), exitCode: 0 };
  }
  if (agent === "claude") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      }),
      exitCode: 0,
    };
  }
  // Codex: exit 2 with the reason on stderr is the refusal it documents for every tool.
  return { stderr: reason, exitCode: 2 };
}

/**
 * The environment, with the agent key read from a file when it is not set:
 * `DELIVERD_API_KEY_FILE`, or `agent-key` beside this file. A fleet install
 * (integrations/fleet-rollout) puts the key there, readable by the people on
 * the machine, because a device manager can place a file but not set a
 * variable in every agent's environment.
 */
export function withKeyFile(env, here = HERE) {
  if (env.DELIVERD_API_KEY) return env;
  const file = env.DELIVERD_API_KEY_FILE || join(here, "agent-key");
  try {
    const key = readFileSync(file, "utf8").trim();
    return key ? { ...env, DELIVERD_API_KEY: key } : env;
  } catch {
    return env;
  }
}

async function main() {
  const [agent, phase] = process.argv.slice(2);
  if (!AGENTS.includes(agent)) throw new Error(`The first argument is the agent: ${AGENTS.join(", ")}.`);
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const event = text.trim() ? JSON.parse(text) : {};
  const env = withKeyFile(process.env);
  const rulesPath = env.DELIVERD_HOOK_RULES || join(HERE, "rules.json");
  const rules = existsSync(rulesPath) ? loadRules(readFileSync(rulesPath, "utf8")) : [];

  if (phase === "post") {
    await post(agent, event, env, rules);
    // Antigravity reads an object back from every PostToolUse hook.
    if (agent === "antigravity") process.stdout.write("{}\n");
    return;
  }
  const decision = await pre(agent, event, env, rules);
  if (decision.allow) {
    // Cursor waits for an answer on stdout; continuing without a permission
    // leaves its own prompt in charge.
    if (agent === "cursor") process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    // Antigravity requires a decision; "allow" hands the call on to its own
    // permission rules, so its prompts still apply.
    if (agent === "antigravity") process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }
  const out = refusal(agent, event, decision.reason);
  if (out.stdout) process.stdout.write(out.stdout + "\n");
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  process.exitCode = out.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    // A hook that crashes before deciding refuses, rather than letting through
    // a call it never looked at. After the call there is nothing to refuse.
    const [agent, phase] = process.argv.slice(2);
    const reason = `Deliverd hook failed: ${error.message}`;
    if (phase === "post") {
      process.stderr.write(reason + "\n");
      if (agent === "antigravity") process.stdout.write("{}\n");
      return;
    }
    const out = refusal(AGENTS.includes(agent) ? agent : "codex", {}, reason);
    if (out.stdout) process.stdout.write(out.stdout + "\n");
    process.stderr.write(reason + "\n");
    process.exitCode = out.exitCode || 2;
  });
}
