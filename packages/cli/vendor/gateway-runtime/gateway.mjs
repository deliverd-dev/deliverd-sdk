// The Deliverd gateway runtime: an MCP server that runs inside your own
// network, beside an application that has a REST API, and turns the operations
// someone has approved into tools an agent can call. Every call is checked with
// a Deliverd gate before the application sees it.
//
// This file is the part with no network and no clock of its own: reading the
// tools file, which tools are switched on and for whom, checking arguments,
// building the request to the application, and the gate request and answer.
// `server.mjs` serves it over HTTP, `cli.mjs` drafts and approves tools.
//
// What it promises, and where each promise is kept:
//
// - Nothing is exposed by default. A tool is listed and callable only once a
//   named person approved it, and only while its definition is still the one
//   they approved (`isApproved`). Edit the definition, or let a new draft of
//   the API change it, and the tool switches itself off until approved again.
// - An agent only sees the tools it may call (`visibleTools`).
// - No call reaches the application without a Deliverd decision for that call
//   (`server.mjs`, `callTool`). Reads included: a rule can let reads through,
//   but the rule is Deliverd's, not this file's.
// - Fails closed. If Deliverd cannot be asked, nothing is called.
//
// No dependencies, Node.js 22 or later.

import { createHash } from "node:crypto";

export const HOSTED = "https://deliverd.dev";
export const ACTION_ID = "gateway_runtime.tool_call";
export const TOKEN_META = "dev.deliverd/decision-token";
export const DECISION_HEADER = "deliverd-decision";
export const RISKS = ["low", "medium", "high", "critical"];
export const ACCESS = ["read", "write"];
export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
export const LOCATIONS = ["path", "query", "header", "body"];
/** Where a database tool keeps its statement (sql.mjs). Covered by the fingerprint, never shown to an agent. */
export const SQL_KEY = "x-deliverd-sql";
const SQL_DIALECTS = ["postgres", "sqlserver"];
const RESERVED_HEADERS = new Set(["authorization", "cookie", "host", "content-length", "content-type", "transfer-encoding", "deliverd-decision", "x-api-key", "proxy-authorization"]);
/** A gate is asked again at most this many times for one call, when an earlier yes was already used. */
export const MAX_ATTEMPTS = 5;

/** Keys sorted at every depth, so the same arguments are always the same text. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The parts of a tool that an approval covers. Change any of them and the
 * approval no longer matches, so the tool is off again. The risk, who may
 * call it and the rate limit are the approver's own settings and are not in
 * here: changing them does not need a second approval of the same API call.
 */
export function definitionOf(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    method: tool.method,
    path: tool.path,
    access: tool.access,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    in: tool.in ?? {},
  };
}

/** The fingerprint an approval is bound to. */
export function fingerprint(tool) {
  return sha256(canonicalJson(definitionOf(tool)));
}

/**
 * Reads and checks a tools file. Throws with every problem at once, because a
 * runtime that starts with half its tools quietly dropped is worse than one
 * that refuses to start.
 */
export function loadConfig(text) {
  const config = typeof text === "string" ? JSON.parse(text) : text;
  const problems = [];
  if (!config || typeof config !== "object") throw new Error("The tools file must be a JSON object.");
  if (!SLUG.test(config.application ?? "")) problems.push("`application` is the application's short name: lower case letters, digits and hyphens, up to 40.");
  let base;
  if (config.database !== undefined) {
    // A database instead of a REST API (sql.mjs): every tool carries its own statement.
    if (!SQL_DIALECTS.includes(config.database?.dialect)) problems.push(`\`database.dialect\` is one of ${SQL_DIALECTS.join(", ")}.`);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(config.database?.env ?? "")) problems.push("`database.env` names the environment variable that holds the connection string, such as DATABASE_URL.");
    if (config.baseUrl !== undefined) problems.push("A tools file has a `database` or a `baseUrl`, not both.");
  } else {
    try {
      base = new URL(config.baseUrl);
      if (!["http:", "https:"].includes(base.protocol)) throw new Error();
    } catch {
      problems.push("`baseUrl` is the application's address, such as http://claims.internal:8080.");
    }
  }
  const tools = Array.isArray(config.tools) ? config.tools : [];
  if (!Array.isArray(config.tools)) problems.push("`tools` is a list.");
  const seen = new Set();
  for (const [i, tool] of tools.entries()) {
    const at = `tools[${i}]${tool?.name ? ` (${tool.name})` : ""}`;
    if (!NAME.test(tool?.name ?? "")) problems.push(`${at}: \`name\` starts with a letter, then letters, digits, _ . or -, up to 64.`);
    if (seen.has(tool?.name)) problems.push(`${at}: two tools are called ${tool.name}.`);
    seen.add(tool?.name);
    if (!METHODS.includes(tool?.method)) problems.push(`${at}: \`method\` is one of ${METHODS.join(", ")}.`);
    if (typeof tool?.path !== "string" || !tool.path.startsWith("/") || tool.path.includes("..")) problems.push(`${at}: \`path\` starts with /.`);
    if (!ACCESS.includes(tool?.access)) problems.push(`${at}: \`access\` is read or write.`);
    if (tool?.risk !== undefined && !RISKS.includes(tool.risk)) problems.push(`${at}: \`risk\` is one of ${RISKS.join(", ")}.`);
    if (tool?.callers !== undefined && !(Array.isArray(tool.callers) && tool.callers.every((c) => typeof c === "string"))) problems.push(`${at}: \`callers\` is a list of agent ids, or ["*"].`);
    for (const [field, where] of Object.entries(tool?.in ?? {})) {
      if (!LOCATIONS.includes(where)) problems.push(`${at}: \`in.${field}\` is one of ${LOCATIONS.join(", ")}.`);
    }
    if (config.database !== undefined && !removedOrOff(tool) && tool?.inputSchema?.[SQL_KEY]?.dialect !== config.database?.dialect) problems.push(`${at}: a database tool carries its statement for ${config.database?.dialect} under inputSchema.${SQL_KEY}.`);
    if (config.database === undefined && tool?.inputSchema?.[SQL_KEY] !== undefined) problems.push(`${at}: has a database statement, but the tools file has no \`database\`.`);
    for (const field of pathFields(tool?.path ?? "")) {
      if (!tool?.inputSchema?.properties?.[field]) problems.push(`${at}: the path names {${field}}, which the input schema does not have.`);
    }
  }
  if (problems.length) throw new Error(`The tools file has problems:\n- ${problems.join("\n- ")}`);
  return config.database !== undefined ? { ...config, tools } : { ...config, baseUrl: base.href.replace(/\/+$/, ""), tools };
}

const removedOrOff = (tool) => tool?.removed === true;

/** `{id}` segments in a path. */
export function pathFields(path) {
  return [...String(path).matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((m) => m[1]);
}

/**
 * Whether a tool is switched on: a named person approved it, with a risk, and
 * the definition has not changed since. Anything else is off.
 */
export function isApproved(tool) {
  const a = tool.approval;
  if (!a || typeof a.by !== "string" || !a.by.trim()) return false;
  if (!RISKS.includes(tool.risk)) return false;
  if (tool.removed === true) return false;
  return a.fingerprint === fingerprint(tool);
}

/** Why a tool is off, for `cli.mjs list`. Null when it is on. */
export function whyOff(tool) {
  if (tool.removed === true) return "no longer in the API's description";
  if (!tool.approval?.by) return "not approved yet";
  if (!RISKS.includes(tool.risk)) return "has no risk level";
  if (tool.approval.fingerprint !== fingerprint(tool)) return "changed since it was approved";
  return null;
}

/** Whether this caller may use this tool. An empty or missing list is nobody. */
export function mayCall(tool, caller) {
  const callers = tool.callers ?? [];
  return callers.includes("*") || (!!caller?.agent && callers.includes(caller.agent));
}

/** The tools this caller sees: approved, and named for them. */
export function visibleTools(config, caller) {
  return config.tools.filter((t) => isApproved(t) && mayCall(t, caller));
}

/** A tool as `tools/list` describes it. The description is the approved text, never the application's. */
export function listing(tool) {
  // What the runtime needs to make the call (x-deliverd-sql, x-deliverd-soap) is covered by the approval, not shown to the agent.
  const inputSchema = Object.fromEntries(Object.entries(tool.inputSchema ?? { type: "object", properties: {} }).filter(([k]) => !k.startsWith("x-deliverd-")));
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema,
    annotations: { readOnlyHint: tool.access === "read", destructiveHint: tool.access === "write" && tool.method === "DELETE" },
  };
}

const TYPE = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Checks arguments against the approved input schema. A subset of JSON Schema:
 * type, required, properties, enum, items, minimum/maximum, minLength/maxLength
 * and pattern. Properties the schema does not name are refused unless it says
 * `additionalProperties: true`: an approval covers the fields someone read,
 * not whatever else an agent thinks to send.
 */
export function validate(schema, value, at = "arguments") {
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some((t) => TYPE[t]?.(value))) {
    problems.push(`${at} should be ${types.join(" or ")}`);
    return problems;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => canonicalJson(e) === canonicalJson(value))) problems.push(`${at} should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) problems.push(`${at} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string") {
      let re = null;
      try {
        re = new RegExp(schema.pattern, "u");
      } catch {
        problems.push(`${at} has a pattern that does not compile`);
      }
      if (re && !re.test(value)) problems.push(`${at} does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${at} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${at} is above ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => problems.push(...validate(schema.items, v, `${at}[${i}]`)));
  if (TYPE.object(value) && (schema.properties || schema.required)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (value[key] === undefined) problems.push(`${at}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) problems.push(...validate(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties !== true) problems.push(`${at}.${key} is not a field this tool takes`);
    }
  }
  return problems;
}

/**
 * The request to the application, from a tool and its checked arguments.
 * Fields go where `in` says; anything unplaced goes in the query for a GET or
 * HEAD and in a JSON body otherwise. Path values are encoded, so an argument
 * cannot walk out of the approved path.
 */
export function buildRequest(config, tool, args) {
  const where = (field) => tool.in?.[field] ?? (pathFields(tool.path).includes(field) ? "path" : ["GET", "HEAD", "DELETE"].includes(tool.method) ? "query" : "body");
  let path = tool.path;
  const query = new URLSearchParams();
  const headers = {};
  const body = {};
  for (const [field, value] of Object.entries(args ?? {})) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const place = where(field);
    if (place === "path") path = path.replaceAll(`{${field}}`, encodeURIComponent(text));
    else if (place === "query") query.append(field, text);
    else if (place === "header") {
      // The runtime's own headers are never the agent's to set.
      if (RESERVED_HEADERS.has(field.toLowerCase())) throw Object.assign(new Error(`${field} is a header the runtime sets itself`), { code: "invalid" });
      headers[field.toLowerCase()] = text.replace(/[\r\n]/g, " ");
    }
    else body[field] = value;
  }
  if (/\{[^}]+\}/.test(path)) throw Object.assign(new Error("a value for the path is missing"), { code: "invalid" });
  const qs = query.toString();
  const url = `${config.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  if (!url.startsWith(`${config.baseUrl}/`)) throw Object.assign(new Error("the path leaves the application's address"), { code: "invalid" });
  const hasBody = Object.keys(body).length > 0 && !["GET", "HEAD"].includes(tool.method);
  return { method: tool.method, url, headers: { ...headers, ...(hasBody ? { "content-type": "application/json" } : {}) }, body: hasBody ? JSON.stringify(body) : undefined };
}

/** The schema the action is registered with: exactly what `gateBody` sends as `input`, so rules can read every field. */
export const INPUT_SCHEMA = {
  type: "object",
  required: ["application", "tool", "access", "caller", "arguments"],
  additionalProperties: false,
  properties: {
    application: { type: "string", minLength: 1, maxLength: 40 },
    tool: { type: "string", minLength: 1, maxLength: 64 },
    access: { type: "string", enum: ACCESS },
    caller: { type: "string", minLength: 1, maxLength: 200 },
    onBehalfOf: { type: "string", maxLength: 200 },
    arguments: { type: "string", maxLength: 4000 },
  },
};

/**
 * The gate's external id. The same caller making the same call in the same
 * session names the same gate, so asking again once a person approved re-reads
 * their yes. `attempt` moves on once that yes has been used, so a call
 * genuinely made twice is asked about twice.
 */
export function externalIdFor(application, sessionId, caller, digest, attempt = 0) {
  const session = String(sessionId ?? "none").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "none";
  const who = sha256(`${caller.agent}\n${caller.user ?? ""}`).slice(0, 12);
  return `gwrt:${application}:${session}:${who}:${digest.slice(0, 32)}${attempt ? `:${attempt}` : ""}`;
}

/** The digest of one call: the tool, the version approved, and the exact arguments. */
export function callDigest(tool, args) {
  return sha256(`${tool.name}\n${fingerprint(tool)}\n${canonicalJson(args ?? {})}`);
}

export function gateBody({ config, tool, args, caller, sessionId, attempt = 0, environment }) {
  const argsText = canonicalJson(args ?? {});
  const digest = callDigest(tool, args);
  const who = caller.user ? `${caller.label ?? caller.agent}, for ${caller.user},` : caller.label ?? caller.agent;
  return {
    actionId: config.actionId ?? ACTION_ID,
    externalId: externalIdFor(config.application, sessionId, caller, digest, attempt),
    input: {
      application: config.application,
      tool: tool.name,
      access: tool.access,
      caller: String(caller.agent).slice(0, 200),
      ...(caller.user ? { onBehalfOf: String(caller.user).slice(0, 200) } : {}),
      arguments: argsText.slice(0, 4000),
    },
    risk: tool.risk,
    description: `${who} wants to ${tool.access === "read" ? "read from" : "change something in"} ${config.title ?? config.application} with ${tool.name}: ${argsText.slice(0, 300)}`,
    ...(environment ? { environment: String(environment).slice(0, 60) } : {}),
    metadata: {
      source: "gateway-runtime",
      application: config.application,
      toolVersion: fingerprint(tool).slice(0, 16),
      approvedBy: tool.approval?.by,
      callSha256: digest,
      ...(sessionId ? { sessionId: String(sessionId).slice(0, 100) } : {}),
    },
  };
}

/** The gate's answer, as the runtime acts on it. Only `canExecute` lets a call through. */
export function verdict(gate, toolName) {
  if (gate?.canExecute === true) return { allow: true };
  const status = gate?.status ?? "unknown";
  if (status === "used") return { allow: false, retry: true, reason: "" };
  const why = {
    pending: `needs a person's approval, and Deliverd has asked for it${gate.approvalUrl ? ` at ${gate.approvalUrl}` : ""}. Stop here and tell the user. Once it is approved, make exactly the same call again`,
    denied: `is refused by your organisation's policy${gate.reason ? `: ${gate.reason}` : ""}`,
    rejected: "was rejected by the person who decided",
    changes_requested: "was sent back by the person who decided. Change it, then try again",
    expired: "was not decided in time. Try again to ask again",
    cancelled: "was withdrawn",
    revoked: "had its permission taken back",
  };
  return { allow: false, retry: false, reason: `Deliverd: the call to ${toolName} ${why[status] ?? `was not allowed (${status})`}. Do not look for another way to do the same thing.` };
}

/** A JSON-RPC answer the model reads as the tool having failed, with why. */
export function toolError(id, reason) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reason }], isError: true } };
}

export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * A fixed-window rate limit per tool and caller. `limits` comes from the tool
 * (`rateLimitPerMinute`); no limit set is no limit. In memory: a restart
 * starts the window again, which errs on the side of the application's own
 * limits rather than ours.
 */
export function rateLimiter(now = () => Date.now()) {
  const windows = new Map();
  return (tool, caller) => {
    const limit = Number(tool.rateLimitPerMinute ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const key = `${tool.name}\n${caller.agent}`;
    const minute = Math.floor(now() / 60_000);
    const w = windows.get(key);
    if (!w || w.minute !== minute) {
      windows.set(key, { minute, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  };
}

/**
 * Registry mode (DELIVERD_REGISTRY=true): the approvals come from Deliverd,
 * not from the file. A tool is on only when Deliverd sent an approval whose
 * fingerprint is the tool's own, so an approval made for another version of
 * the definition switches nothing on. Approvals written in the file are
 * ignored in this mode: whoever can edit the file cannot approve.
 */
export function applyRegistry(config, approvals) {
  const byName = new Map((approvals ?? []).map((a) => [a.name, a]));
  return {
    ...config,
    tools: config.tools.map((tool) => {
      const { approval, ...rest } = tool;
      const a = byName.get(tool.name);
      if (!a || a.fingerprint !== fingerprint(rest) || !RISKS.includes(a.risk)) return { ...rest, callers: [] };
      return {
        ...rest,
        risk: a.risk,
        callers: Array.isArray(a.callers) ? a.callers : [],
        rateLimitPerMinute: a.rateLimitPerMinute ?? undefined,
        approval: { by: a.approvedBy, at: a.approvedAt, fingerprint: a.fingerprint, via: "deliverd" },
      };
    }),
  };
}

/** What the runtime reports about its tools: their definitions, never their approvals. */
export function syncBody(config, { version, queuedOutcomes = 0 } = {}) {
  let host = null;
  try {
    host = config.database ? `${config.database.dialect} database` : new URL(config.baseUrl).host;
  } catch {}
  return {
    application: config.application,
    title: config.title ?? config.application,
    ...(host ? { baseUrlHost: host } : {}),
    ...(version ? { version } : {}),
    queuedOutcomes,
    tools: config.tools
      .filter((t) => t.removed !== true)
      .map((t) => ({ ...definitionOf(t), ...(RISKS.includes(t.risk) ? { proposedRisk: t.risk } : {}) })),
  };
}
