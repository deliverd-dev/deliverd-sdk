// Drafting tools from an OpenAPI 3.x description, and keeping them in step
// with it.
//
// Every drafted tool starts switched off: it has no approval and nobody may
// call it. A person reads it, edits the description if it would mislead a
// model, sets who may call it, and approves it (`cli.mjs approve`).
//
// Drafting again later is how a changed API is noticed. A tool whose operation
// changed keeps its old approval, which no longer matches, so it switches
// itself off until somebody approves the new shape. An operation that has
// gone is marked `removed` and is off too. New operations arrive off.
//
// JSON only: convert a YAML description first (any YAML-to-JSON tool will do).

import { pathFields } from "./gateway.mjs";

const VERBS = ["get", "head", "post", "put", "patch", "delete"];
const MAX_DEPTH = 12;

/** Resolves local `$ref`s (`#/components/...`), to a depth, so a cycle cannot hang the draft. */
export function deref(doc, node, depth = 0) {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, depth + 1));
  if (typeof node.$ref === "string") {
    if (!node.$ref.startsWith("#/")) return {};
    const target = node.$ref
      .slice(2)
      .split("/")
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((at, key) => (at && typeof at === "object" ? at[key] : undefined), doc);
    return deref(doc, target ?? {}, depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, depth + 1);
  return out;
}

/** The parts of a JSON Schema the runtime checks, so the approved schema says no more than is enforced. */
export function plainSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  const out = {};
  for (const key of ["type", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "format"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  if (schema.items) out.items = plainSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, plainSchema(v)]));
    if (Array.isArray(schema.required) && schema.required.length) out.required = [...schema.required];
  }
  if (out.type === undefined && out.properties) out.type = "object";
  return out;
}

/** A tool name from an operation id, or from the method and path. */
export function toolName(method, path, operationId) {
  const raw = operationId || `${method}_${path.replace(/\{([^}]+)\}/g, "by_$1")}`;
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return /^[a-z]/.test(name) ? name : `op_${name}`.slice(0, 64);
}

/** A first guess at the risk, for a person to change: reads low, deletes high, other changes medium. */
export function proposedRisk(method) {
  if (method === "GET" || method === "HEAD") return "low";
  if (method === "DELETE") return "high";
  return "medium";
}

/**
 * One candidate tool per operation. Parameters in the path, query or headers
 * become fields placed there; a JSON request body's own fields become fields
 * sent in the body. Cookies and non-JSON bodies are left out, with a note.
 */
export function draftTools(doc) {
  if (!doc || typeof doc !== "object" || !String(doc.openapi ?? "").startsWith("3.")) throw new Error("This is not an OpenAPI 3.x description in JSON.");
  const tools = [];
  const notes = [];
  const taken = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = deref(doc, item.parameters ?? []);
    for (const verb of VERBS) {
      const op = item[verb];
      if (!op) continue;
      const method = verb.toUpperCase();
      let name = toolName(method, path, op.operationId);
      for (let n = 2; taken.has(name); n++) name = `${toolName(method, path, op.operationId).slice(0, 60)}_${n}`;
      taken.add(name);
      const properties = {};
      const required = [];
      const placed = {};
      const params = [...shared, ...deref(doc, op.parameters ?? [])];
      for (const p of params) {
        if (!p?.name || !["path", "query", "header"].includes(p.in)) {
          if (p?.in === "cookie") notes.push(`${name}: the cookie parameter ${p.name} is left out.`);
          continue;
        }
        properties[p.name] = { ...plainSchema(p.schema ?? { type: "string" }), ...(p.description ? { description: p.description } : {}) };
        placed[p.name] = p.in;
        if (p.required || p.in === "path") required.push(p.name);
      }
      const body = deref(doc, op.requestBody);
      const json = body?.content?.["application/json"]?.schema;
      if (json) {
        const schema = plainSchema(json);
        if (schema.type === "object" && schema.properties) {
          for (const [k, v] of Object.entries(schema.properties)) {
            if (properties[k]) {
              notes.push(`${name}: the body field ${k} has the same name as a parameter and is left out.`);
              continue;
            }
            properties[k] = v;
            placed[k] = "body";
          }
          if (body.required !== false) for (const k of schema.required ?? []) if (placed[k] === "body") required.push(k);
        } else notes.push(`${name}: the request body is not a JSON object, so this tool sends no body.`);
      } else if (body?.content) notes.push(`${name}: the request body is not JSON, so this tool sends no body.`);
      for (const field of pathFields(path)) {
        if (!properties[field]) {
          properties[field] = { type: "string" };
          placed[field] = "path";
          required.push(field);
        }
      }
      const description = [op.summary, op.description].filter(Boolean).join(". ").replace(/\s+/g, " ").trim().slice(0, 1000);
      tools.push({
        name,
        description: description || `${method} ${path}`,
        method,
        path,
        access: method === "GET" || method === "HEAD" ? "read" : "write",
        risk: proposedRisk(method),
        callers: [],
        inputSchema: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
        in: placed,
        source: { operation: `${method} ${path}` },
      });
    }
  }
  return { tools, notes };
}

/**
 * The tools file after a fresh draft. What a person set is kept: the
 * description they edited, the risk, who may call it, the rate limit and the
 * approval. The API's shape (method, path, schema, where fields go) is taken
 * from the draft, so a changed operation no longer matches its approval.
 */
export function mergeDraft(config, drafted) {
  const byOperation = new Map(drafted.map((t) => [t.source.operation, t]));
  const kept = [];
  const report = { added: [], changed: [], removed: [], unchanged: [] };
  const seen = new Set();
  for (const tool of config.tools ?? []) {
    const op = tool.source?.operation;
    if (!op) {
      kept.push(tool);
      continue;
    }
    const fresh = byOperation.get(op);
    if (!fresh) {
      kept.push({ ...tool, removed: true });
      if (tool.removed !== true) report.removed.push(tool.name);
      continue;
    }
    seen.add(op);
    const next = { ...tool, method: fresh.method, path: fresh.path, access: fresh.access, inputSchema: fresh.inputSchema, in: fresh.in, source: fresh.source };
    delete next.removed;
    const before = JSON.stringify([tool.method, tool.path, tool.access, tool.inputSchema, tool.in]);
    const after = JSON.stringify([next.method, next.path, next.access, next.inputSchema, next.in]);
    (before === after && tool.removed !== true ? report.unchanged : report.changed).push(tool.name);
    kept.push(next);
  }
  const names = new Set(kept.map((t) => t.name));
  for (const tool of drafted) {
    if (seen.has(tool.source.operation)) continue;
    let name = tool.name;
    for (let n = 2; names.has(name); n++) name = `${tool.name.slice(0, 60)}_${n}`;
    names.add(name);
    kept.push({ ...tool, name });
    report.added.push(name);
  }
  return { config: { ...config, tools: kept }, report };
}
