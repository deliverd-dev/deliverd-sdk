// A database as a source of tools: learn the application from its schema,
// have a person confirm what was learned, and serve it as typed tools.
//
// 1. Learn (`learnModel`). From the catalogue a database reports (tables,
//    columns, keys, foreign keys, indexes, the values a status column may
//    take) and, if given, queries the application already runs, draft a model
//    of the application: its entities (Claim, Customer), how they relate,
//    which fields an agent may filter on, and the changes the application
//    itself makes (a claim's status moving to approved becomes
//    `approve_claim`). Relations are taken from foreign keys first, then from
//    the joins in the queries, then from names (`customer_id` and
//    `customers`), and each says where it came from. Columns that hold
//    secrets are never exposed; columns that look like personal data are
//    marked, so the person confirming sees them.
// 2. Confirm (`confirmModel`). A named person says the model is right. The
//    confirmation is bound to the model's fingerprint: learn again and get a
//    different model, and it needs confirming again before tools are drafted
//    from it.
// 3. Serve (`draftSqlTools`, `compileCall`, `shapeResult`). Each entity
//    becomes `find_` and `get_` tools that return records in the
//    application's own shape (a claim with its customer and its payments),
//    and each action a tool that changes exactly one record. Agents never
//    write SQL. Every tool carries its statements in its input schema, under
//    `x-deliverd-sql`, so the approval of a tool covers the exact SQL that
//    runs; the runtime runs that text and nothing else. Tools start off, like
//    every drafted tool, and every call is checked by a Deliverd gate: reads
//    can flow by rule, writes wait for a yes.
//
// Pure: no database, no network. `db.mjs` connects and introspects.

import { SQL_KEY, canonicalJson, sha256 } from "./gateway.mjs";

export const DIALECTS = ["postgres", "sqlserver"];
export { SQL_KEY };
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const CHILD_LIMIT = 20;

const HIDDEN = /(pass(word|wd)?|pwd|secret|token|api_?key|hash|salt|private_?key|otp|mfa|totp|credential)/i;
const PERSONAL =
  /(ssn|social_security|national_id|ppsn|nino|passport|dob|date_of_birth|birth_?date|iban|bic|account_?(number|no)|sort_?code|card_?(number|no)|^pan$|phone|mobile|e_?mail|address|post_?code|zip|salary|income|tax_?(id|number)|medical|health|diagnos|ethnic|religio|gender|first_?name|last_?name|surname|full_?name)/i;
const STATE = /(^|_)(status|state|stage|phase)$/i;

// ── Names ──────────────────────────────────────────────────────────────────

const words = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export const snake = (s) => words(s).join("_");
export const pascal = (s) =>
  words(s)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

export function singular(word) {
  const w = String(word);
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/ies$/i.test(w)) return w.slice(0, -3) + "y";
  if (/(xes|ches|shes|sses|zes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}

export function plural(word) {
  const w = String(word);
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + "es";
  return w + "s";
}

/** An entity's name from its table: `policy_holders` is PolicyHolder. */
export function entityName(table) {
  const parts = words(table);
  if (!parts.length) return "Record";
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return pascal(parts.join("_"));
}

const VERB = {
  approved: "approve",
  rejected: "reject",
  declined: "decline",
  accepted: "accept",
  closed: "close",
  opened: "open",
  reopened: "reopen",
  completed: "complete",
  cancelled: "cancel",
  canceled: "cancel",
  paid: "pay",
  refunded: "refund",
  submitted: "submit",
  escalated: "escalate",
  archived: "archive",
  verified: "verify",
  confirmed: "confirm",
  settled: "settle",
  suspended: "suspend",
  resolved: "resolve",
  shipped: "ship",
  delivered: "deliver",
  released: "release",
  flagged: "flag",
  blocked: "block",
  activated: "activate",
  deactivated: "deactivate",
  assigned: "assign",
  published: "publish",
  withdrawn: "withdraw",
  voided: "void",
  terminated: "terminate",
};

/** The action a status value names: `approved` on a claim is approve_claim; a value that is not a verb is mark_claim_in_review. */
export function actionName(value, entity) {
  const v = snake(value);
  const verb = VERB[v];
  return (verb ? `${verb}_${snake(entity)}` : `mark_${snake(entity)}_${v}`).slice(0, 64);
}

// ── Types ──────────────────────────────────────────────────────────────────

/** JSON Schema for a database type, or null for a column an agent is not shown (binary). */
export function jsonType(dbType) {
  const t = String(dbType ?? "").toLowerCase();
  if (/^(bytea|binary|varbinary|image|blob|rowversion|geometry|geography|hierarchyid)/.test(t)) return null;
  if (/^(bigint|int8|bigserial)/.test(t)) return { type: ["integer", "string"] };
  if (/^(int|integer|int2|int4|smallint|tinyint|serial|smallserial|mediumint)/.test(t)) return { type: "integer" };
  if (/^(numeric|decimal|money|smallmoney|real|float|double)/.test(t)) return { type: "number" };
  if (/^(bool|bit)/.test(t)) return { type: "boolean" };
  if (/^(uuid|uniqueidentifier)/.test(t)) return { type: "string", format: "uuid" };
  if (/^(timestamp|datetime|smalldatetime|datetimeoffset)/.test(t)) return { type: "string", format: "date-time" };
  if (/^date$/.test(t)) return { type: "string", format: "date" };
  if (/json|xml|array|^_/.test(t)) return {};
  return { type: "string" };
}

const filterable = (schema) => !!schema && schema.type !== undefined;

// ── Learning from queries ──────────────────────────────────────────────────

const IDENT = String.raw`(?:"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;
const KEYWORDS = new Set(["on", "where", "join", "inner", "left", "right", "full", "cross", "outer", "group", "order", "limit", "using", "set", "values", "select", "having", "union", "with", "as", "and", "or"]);
const unquote = (s) => s.replace(/^["[\x60]|["\]\x60]$/g, "");
const lastPart = (s) => unquote(s.split(/\s*\.\s*/).pop());

/**
 * What the application's own queries say: which tables it uses most, which
 * columns it filters on, and which columns it joins on. Read with regular
 * expressions, so it is a hint, not a parser: anything it misreads only
 * shows up as a suggestion the person confirming the model can remove.
 */
export function readQueries(text) {
  const usage = new Map();
  const filters = new Map();
  const joins = [];
  const clean = String(text ?? "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "?");
  for (const statement of clean.split(";")) {
    const aliases = new Map();
    const refRe = new RegExp(String.raw`\b(from|join|update|into)\s+(${QUALIFIED})(?:\s+(?:as\s+)?(${IDENT}))?`, "gi");
    for (const m of statement.matchAll(refRe)) {
      const table = lastPart(m[2]).toLowerCase();
      usage.set(table, (usage.get(table) ?? 0) + 1);
      aliases.set(table, table);
      const alias = m[3] && !KEYWORDS.has(unquote(m[3]).toLowerCase()) ? unquote(m[3]).toLowerCase() : null;
      if (alias) aliases.set(alias, table);
    }
    const tableOf = (alias) => aliases.get(alias.toLowerCase()) ?? null;
    const onRe = new RegExp(String.raw`(${IDENT})\s*\.\s*(${IDENT})\s*=\s*(${IDENT})\s*\.\s*(${IDENT})`, "g");
    for (const m of statement.matchAll(onRe)) {
      const a = tableOf(unquote(m[1]));
      const b = tableOf(unquote(m[3]));
      if (a && b && a !== b) joins.push({ left: { table: a, column: unquote(m[2]).toLowerCase() }, right: { table: b, column: unquote(m[4]).toLowerCase() } });
    }
    const where = statement.split(/\bwhere\b/i).slice(1).join(" ");
    const condRe = new RegExp(String.raw`(?:(${IDENT})\s*\.\s*)?(${IDENT})\s*(?:=|\bin\b)`, "gi");
    for (const m of where.matchAll(condRe)) {
      const column = unquote(m[2]).toLowerCase();
      if (KEYWORDS.has(column)) continue;
      const table = m[1] ? tableOf(unquote(m[1])) : aliases.size === 2 || aliases.size === 1 ? [...aliases.values()][0] : null;
      if (!table) continue;
      if (!filters.has(table)) filters.set(table, new Set());
      filters.get(table).add(column);
    }
  }
  return { usage, filters, joins };
}

// ── The model ──────────────────────────────────────────────────────────────

const tableKey = (t) => `${t.schema}.${t.name}`.toLowerCase();

/**
 * Draft a model of the application from a database catalogue:
 *
 *   { dialect, tables: [{ schema, name, rows?, columns: [{ name, type, nullable, enum? }],
 *     primaryKey: [col], foreignKeys: [{ columns, refSchema, refTable, refColumns }], indexed: [col] }] }
 *
 * `queries` is the text of queries the application runs, if you have them.
 */
export function learnModel(catalog, { queries = "", now = new Date(), source = null } = {}) {
  if (!DIALECTS.includes(catalog?.dialect)) throw new Error(`The dialect is one of ${DIALECTS.join(", ")}.`);
  const dialect = catalog.dialect;
  const tables = (catalog.tables ?? []).filter((t) => t?.name && Array.isArray(t.columns) && t.columns.length);
  const hints = readQueries(queries);
  const notes = [];

  const byKey = new Map(tables.map((t) => [tableKey(t), t]));
  const byName = new Map();
  for (const t of tables) {
    const n = t.name.toLowerCase();
    byName.set(n, byName.has(n) ? null : t); // the same name in two schemas is ambiguous by name alone
  }
  const nameCounts = new Map();
  for (const t of tables) nameCounts.set(entityName(t.name), (nameCounts.get(entityName(t.name)) ?? 0) + 1);
  const entityOf = new Map(
    tables.map((t) => {
      const base = entityName(t.name);
      return [tableKey(t), nameCounts.get(base) > 1 ? pascal(`${t.schema}_${base}`) : base];
    })
  );

  // Relations: declared foreign keys, then the application's joins, then names.
  const relations = [];
  const covered = new Set();
  const addRelation = (from, columns, to, refColumns, how) => {
    const id = `${tableKey(from)}:${columns.join(",").toLowerCase()}`;
    if (covered.has(id)) return;
    covered.add(id);
    relations.push({ from, columns, to, refColumns, how });
  };
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      const to = byKey.get(`${fk.refSchema}.${fk.refTable}`.toLowerCase());
      if (to) addRelation(t, fk.columns, to, fk.refColumns, "foreign key");
    }
  }
  const colOf = (t, name) => t.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const singleKey = (t) => ((t.primaryKey ?? []).length === 1 ? t.primaryKey[0].toLowerCase() : null);
  for (const j of hints.joins) {
    const a = byName.get(j.left.table);
    const b = byName.get(j.right.table);
    if (!a || !b || !colOf(a, j.left.column) || !colOf(b, j.right.column)) continue;
    if (singleKey(b) === j.right.column && singleKey(a) !== j.left.column) addRelation(a, [colOf(a, j.left.column).name], b, [colOf(b, j.right.column).name], "the application's queries");
    else if (singleKey(a) === j.left.column && singleKey(b) !== j.right.column) addRelation(b, [colOf(b, j.right.column).name], a, [colOf(a, j.left.column).name], "the application's queries");
  }
  for (const t of tables) {
    for (const c of t.columns) {
      const m = /^(.+?)_?id$/i.exec(c.name);
      if (!m || c.name.toLowerCase() === singleKey(t)) continue;
      const stem = snake(m[1]);
      if (!stem) continue;
      const candidates = [plural(stem), stem, `${stem}s`].map((n) => byName.get(n)).filter(Boolean);
      const to = candidates.find((x) => x !== t && singleKey(x));
      if (to) addRelation(t, [c.name], to, [to.primaryKey[0]], "column names");
    }
  }

  const entities = [];
  for (const t of tables) {
    const name = entityOf.get(tableKey(t));
    const fields = [];
    const hidden = [];
    for (const c of t.columns) {
      const schema = jsonType(c.type);
      if (HIDDEN.test(c.name)) {
        hidden.push({ column: c.name, why: "looks like a secret" });
        continue;
      }
      if (schema === null) {
        hidden.push({ column: c.name, why: "binary" });
        continue;
      }
      fields.push({
        column: c.name,
        schema: { ...schema, ...(Array.isArray(c.enum) && c.enum.length ? { enum: [...c.enum] } : {}) },
        ...(c.nullable ? { nullable: true } : {}),
        ...(PERSONAL.test(c.name) ? { personal: true } : {}),
      });
    }
    const visible = new Set(fields.map((f) => f.column.toLowerCase()));
    const pk = t.primaryKey ?? [];
    const key = pk.every((k) => visible.has(k.toLowerCase())) ? [...pk] : [];
    if (pk.length && !key.length) notes.push(`${name}: part of its key is hidden, so it has no get or action tools.`);
    if (!(t.primaryKey ?? []).length) notes.push(`${name}: no primary key, so only find_${snake(t.name)}. Add a key in the model to get the rest.`);

    const filterCols = new Set([...(t.indexed ?? []), ...[...(hints.filters.get(t.name.toLowerCase()) ?? [])]].map((c) => c.toLowerCase()));
    for (const r of relations) if (r.from === t) for (const c of r.columns) filterCols.add(c.toLowerCase());
    for (const f of fields) if (STATE.test(f.column) || f.schema.enum) filterCols.add(f.column.toLowerCase());
    // The key is what get_ is for, so find_ leaves it out.
    const keyCols = new Set(key.map((k) => k.toLowerCase()));
    const filters = fields.filter((f) => filterCols.has(f.column.toLowerCase()) && !keyCols.has(f.column.toLowerCase()) && filterable(f.schema)).map((f) => f.column);

    const relationName = (columns, target) => {
      const stem = columns.length === 1 ? snake(columns[0].replace(/_?id$/i, "")) : "";
      return stem && stem !== snake(columns[0]) ? stem : snake(entityOf.get(tableKey(target)));
    };
    const parents = relations
      .filter((r) => r.from === t && r.columns.every((c) => visible.has(c.toLowerCase())))
      .map((r) => ({ as: relationName(r.columns, r.to), entity: entityOf.get(tableKey(r.to)), columns: r.columns, refColumns: r.refColumns, how: r.how }));
    const children = relations
      .filter((r) => r.to === t && r.from !== t && r.refColumns.every((c) => visible.has(c.toLowerCase())))
      .map((r) => ({ as: snake(r.from.name), entity: entityOf.get(tableKey(r.from)), columns: r.columns, refColumns: r.refColumns, how: r.how }));
    dedupeNames(parents);
    dedupeNames(children);

    entities.push({
      name,
      table: { schema: t.schema, name: t.name },
      plural: snake(t.name) === snake(name) ? plural(snake(name)) : snake(t.name),
      description: "",
      key,
      fields,
      hidden,
      filters,
      parents,
      children,
      ...(hints.usage.get(t.name.toLowerCase()) ? { usedByQueries: hints.usage.get(t.name.toLowerCase()) } : {}),
      ...(typeof t.rows === "number" && t.rows >= 0 ? { approximateRows: Math.round(t.rows) } : {}),
    });
  }
  entities.sort((a, b) => (b.usedByQueries ?? 0) - (a.usedByQueries ?? 0) || a.name.localeCompare(b.name));

  const actions = [];
  for (const e of entities) {
    if (!e.key.length) continue;
    for (const f of e.fields) {
      if (!STATE.test(f.column) || !Array.isArray(f.schema.enum)) continue;
      for (const value of f.schema.enum) {
        if (typeof value !== "string" || !snake(value)) continue;
        actions.push({ name: actionName(value, e.name), entity: e.name, description: "", set: { [f.column]: value }, learnedFrom: `the values ${e.name}.${f.column} may take` });
      }
    }
  }
  dedupeNames(actions, "name");

  return {
    dialect,
    learnedAt: now.toISOString(),
    ...(source ? { learnedFrom: source } : {}),
    entities,
    actions,
    notes,
  };
}

function dedupeNames(list, field = "as") {
  const seen = new Map();
  for (const item of list) {
    const base = item[field];
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) item[field] = `${base}_${n}`.slice(0, 64);
  }
}

/** The parts of a model a confirmation covers: what it says, not when or how it was learned. */
export function modelFingerprint(model) {
  const { learnedAt, learnedFrom, notes, confirmation, ...rest } = model ?? {};
  const entities = (rest.entities ?? []).map(({ usedByQueries, approximateRows, ...e }) => e);
  return sha256(canonicalJson({ ...rest, entities }));
}

/** Checks a model a person may have edited. Every problem at once. */
export function modelProblems(model) {
  const problems = [];
  if (!model || typeof model !== "object") return ["There is no model. Run learn first."];
  if (!DIALECTS.includes(model.dialect)) problems.push(`dialect is one of ${DIALECTS.join(", ")}.`);
  const names = new Map();
  for (const [i, e] of (model.entities ?? []).entries()) {
    const at = `entities[${i}]${e?.name ? ` (${e.name})` : ""}`;
    if (!/^[A-Za-z][A-Za-z0-9]{0,47}$/.test(e?.name ?? "")) problems.push(`${at}: name is letters and digits, starting with a letter.`);
    if (names.has(e?.name)) problems.push(`${at}: two entities are called ${e.name}.`);
    names.set(e?.name, e);
    if (!e?.table?.name || !e?.table?.schema) problems.push(`${at}: table needs schema and name.`);
    if (!Array.isArray(e?.fields) || !e.fields.length) problems.push(`${at}: has no fields.`);
    const cols = new Set((e?.fields ?? []).map((f) => f.column?.toLowerCase()));
    for (const k of e?.key ?? []) if (!cols.has(String(k).toLowerCase())) problems.push(`${at}: key ${k} is not one of its fields.`);
    for (const f of e?.filters ?? []) if (!cols.has(String(f).toLowerCase())) problems.push(`${at}: filter ${f} is not one of its fields.`);
    for (const r of [...(e?.parents ?? []), ...(e?.children ?? [])]) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(r?.as ?? "")) problems.push(`${at}: relation name ${r?.as} is lower case letters, digits and _.`);
      if (!Array.isArray(r?.columns) || !Array.isArray(r?.refColumns) || r.columns.length !== r.refColumns.length || !r.columns.length) problems.push(`${at}: relation ${r?.as} needs matching columns and refColumns.`);
    }
  }
  for (const e of model.entities ?? []) {
    for (const r of [...(e.parents ?? []), ...(e.children ?? [])]) if (!names.has(r.entity)) problems.push(`${e.name}: relation ${r.as} is to ${r.entity}, which is not in the model.`);
  }
  const actionNames = new Set();
  for (const [i, a] of (model.actions ?? []).entries()) {
    const at = `actions[${i}]${a?.name ? ` (${a.name})` : ""}`;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(a?.name ?? "")) problems.push(`${at}: name is lower case letters, digits and _.`);
    if (actionNames.has(a?.name)) problems.push(`${at}: two actions are called ${a.name}.`);
    actionNames.add(a?.name);
    const e = names.get(a?.entity);
    if (!e) {
      problems.push(`${at}: entity ${a?.entity} is not in the model.`);
      continue;
    }
    if (!(e.key ?? []).length) problems.push(`${at}: ${e.name} has no key, so an action cannot say which record it changes.`);
    const cols = new Map((e.fields ?? []).map((f) => [f.column.toLowerCase(), f]));
    const set = Object.entries(a.set ?? {});
    if (!set.length) problems.push(`${at}: set says which fields it changes.`);
    for (const [col, value] of set) {
      if (!cols.has(col.toLowerCase())) problems.push(`${at}: ${col} is not a field of ${e.name}.`);
      if ((e.key ?? []).some((k) => k.toLowerCase() === col.toLowerCase())) problems.push(`${at}: an action cannot change ${e.name}'s key.`);
      if (typeof value === "string" && value.startsWith(":") && !/^:[a-z][a-z0-9_]{0,47}$/.test(value)) problems.push(`${at}: ${value} is not an argument name (:lower_case).`);
    }
  }
  return problems;
}

/** A named person says the model is right. Bound to exactly this model. */
export function confirmModel(model, { by, now = new Date() }) {
  if (typeof by !== "string" || !by.trim()) throw new Error('Say who is confirming it: --by "Name <email>".');
  const problems = modelProblems(model);
  if (problems.length) throw new Error(`The model has problems:\n- ${problems.join("\n- ")}`);
  return { ...model, confirmation: { by: by.trim(), at: now.toISOString(), fingerprint: modelFingerprint(model) } };
}

/** Why the model cannot be drafted from, or null. */
export function whyUnconfirmed(model) {
  if (!model) return "there is no model yet: run learn";
  if (!model.confirmation?.by) return "nobody has confirmed the model yet: run confirm-model";
  if (model.confirmation.fingerprint !== modelFingerprint(model)) return "the model changed after it was confirmed: run confirm-model again";
  return null;
}

/**
 * Learning again keeps what a person wrote: descriptions, entities and
 * actions they removed, fields they hid, filters they took away, actions they
 * added by hand. Everything else is the database's new answer.
 */
export function mergeModel(previous, fresh) {
  if (!previous) return { model: fresh, report: { added: fresh.entities.map((e) => e.name), removed: [], kept: [] } };
  const old = new Map((previous.entities ?? []).map((e) => [`${e.table?.schema}.${e.table?.name}`.toLowerCase(), e]));
  const removedByPerson = new Set(previous.removedEntities ?? []);
  const report = { added: [], removed: [], kept: [] };
  const entities = [];
  for (const e of fresh.entities) {
    const id = `${e.table.schema}.${e.table.name}`.toLowerCase();
    if (removedByPerson.has(id)) continue;
    const before = old.get(id);
    if (!before) {
      report.added.push(e.name);
      entities.push(e);
      continue;
    }
    report.kept.push(e.name);
    const hiddenByPerson = new Set((before.hidden ?? []).filter((h) => h.why === "hidden by a person").map((h) => h.column.toLowerCase()));
    const fields = e.fields.filter((f) => !hiddenByPerson.has(f.column.toLowerCase()));
    const was = new Set((before.filters ?? []).map((f) => f.toLowerCase()));
    const knewOf = new Set((before.fields ?? []).map((f) => f.column.toLowerCase()));
    entities.push({
      ...e,
      name: before.name ?? e.name,
      description: before.description ?? "",
      fields,
      hidden: [...e.hidden, ...[...hiddenByPerson].map((column) => ({ column, why: "hidden by a person" }))],
      // A filter the person took away stays away; a new column's filter arrives.
      filters: e.filters.filter((f) => was.has(f.toLowerCase()) || !knewOf.has(f.toLowerCase())),
    });
  }
  for (const id of old.keys()) if (!fresh.entities.some((e) => `${e.table.schema}.${e.table.name}`.toLowerCase() === id)) report.removed.push(old.get(id).name);
  const oldActions = new Map((previous.actions ?? []).map((a) => [a.name, a]));
  const removedActions = new Set(previous.removedActions ?? []);
  const actions = fresh.actions.filter((a) => !removedActions.has(a.name)).map((a) => ({ ...a, description: oldActions.get(a.name)?.description ?? "" }));
  for (const a of previous.actions ?? []) if (!a.learnedFrom && !actions.some((x) => x.name === a.name)) actions.push(a);
  const model = { ...fresh, entities, actions, ...(previous.removedEntities ? { removedEntities: previous.removedEntities } : {}), ...(previous.removedActions ? { removedActions: previous.removedActions } : {}) };
  if (previous.confirmation && previous.confirmation.fingerprint === modelFingerprint(model)) model.confirmation = previous.confirmation;
  return { model, report };
}

// ── Statements ─────────────────────────────────────────────────────────────

export const quote = (dialect, ident) => (dialect === "sqlserver" ? `[${String(ident).replace(/]/g, "]]")}]` : `"${String(ident).replace(/"/g, '""')}"`);
const qtable = (d, t) => `${quote(d, t.schema)}.${quote(d, t.name)}`;
const param = (name) => `:${name}`;
const argName = (column) => snake(column) || "value";

function selectList(d, alias, entity, prefix = "") {
  return entity.fields.map((f) => `${alias}.${quote(d, f.column)} AS ${quote(d, `${prefix}${f.column}`)}`);
}

function limitClause(d, order) {
  return d === "sqlserver" ? `ORDER BY ${order} OFFSET 0 ROWS FETCH NEXT :__limit ROWS ONLY` : `ORDER BY ${order} LIMIT :__limit`;
}

function fieldSchema(field, description) {
  const s = { ...field.schema };
  if (description) s.description = description;
  return s;
}

const describeEntity = (e) => (e.description ? ` ${e.description}` : "");

/**
 * The tools a confirmed model serves. Each carries its statements under
 * `x-deliverd-sql` in its input schema, so the fingerprint, and the approval,
 * cover the exact SQL. Start off, like every drafted tool.
 */
export function draftSqlTools(model) {
  const why = whyUnconfirmed(model);
  if (why) throw new Error(`Tools are drafted from a confirmed model, and ${why}.`);
  const d = model.dialect;
  const byName = new Map(model.entities.map((e) => [e.name, e]));
  const tools = [];
  const notes = [];
  const source = (operation) => ({ kind: "sql", operation, model: model.confirmation.fingerprint.slice(0, 16) });

  for (const e of model.entities) {
    const fieldByCol = new Map(e.fields.map((f) => [f.column.toLowerCase(), f]));
    const order = (e.key.length ? e.key : [e.fields[0].column]).map((c) => `e.${quote(d, c)}`).join(", ");

    // find_<plural>
    const props = {};
    const where = {};
    for (const col of e.filters ?? []) {
      const f = fieldByCol.get(col.toLowerCase());
      if (!f) continue;
      const arg = argName(f.column);
      props[arg] = fieldSchema(f, `Only ${e.plural.replace(/_/g, " ")} whose ${f.column} is this.`);
      where[arg] = `e.${quote(d, f.column)} = ${param(arg)}`;
    }
    props.limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `How many to return, up to ${MAX_LIMIT}. ${DEFAULT_LIMIT} if not given.` };
    const filterWords = Object.keys(where).length ? ` Filter by ${Object.keys(where).join(", ")}.` : "";
    tools.push({
      name: `find_${e.plural}`.slice(0, 64),
      description: `Find ${e.plural.replace(/_/g, " ")} in ${model.title ?? "the application"}.${filterWords} Returns up to ${MAX_LIMIT}, in key order.${describeEntity(e)}`,
      method: "GET",
      path: `/sql/${snake(e.name)}/find`,
      access: "read",
      inputSchema: {
        type: "object",
        properties: props,
        additionalProperties: false,
        [SQL_KEY]: { dialect: d, kind: "find", entity: e.name, as: e.plural, select: `SELECT ${selectList(d, "e", e).join(", ")} FROM ${qtable(d, e.table)} e`, where, limit: limitClause(d, order), defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
      },
      in: {},
      source: source(`find:${e.name}`),
    });

    if (!e.key.length) continue;

    // get_<entity>: the record with its parents in it and its children under it.
    const keyProps = {};
    const keyWhere = [];
    for (const k of e.key) {
      const f = fieldByCol.get(k.toLowerCase());
      keyProps[argName(k)] = fieldSchema(f, `The ${snake(e.name).replace(/_/g, " ")}'s ${k}.`);
      keyWhere.push(`e.${quote(d, k)} = ${param(argName(k))}`);
    }
    const columns = selectList(d, "e", e);
    const joins = [];
    const embeds = [];
    e.parents.forEach((p, i) => {
      const target = byName.get(p.entity);
      if (!target) return;
      const alias = `p${i}`;
      columns.push(...selectList(d, alias, target, `${p.as}.`));
      joins.push(`LEFT JOIN ${qtable(d, target.table)} ${alias} ON ${p.columns.map((c, j) => `${alias}.${quote(d, p.refColumns[j])} = e.${quote(d, c)}`).join(" AND ")}`);
      embeds.push(p.as);
    });
    const include = [];
    for (const c of e.children) {
      const target = byName.get(c.entity);
      if (!target) continue;
      const childOrder = (target.key.length ? target.key : [target.fields[0].column]).map((x) => `c.${quote(d, x)}`).join(", ");
      const rowParams = {};
      const cond = c.columns.map((col, j) => {
        const name = `row_${argName(c.refColumns[j])}`;
        rowParams[name] = c.refColumns[j];
        return `c.${quote(d, col)} = ${param(name)}`;
      });
      include.push({
        as: c.as,
        select: `SELECT ${selectList(d, "c", target).join(", ")} FROM ${qtable(d, target.table)} c WHERE ${cond.join(" AND ")} ${limitClause(d, childOrder)}`,
        fromRow: rowParams,
        limit: CHILD_LIMIT,
      });
    }
    const related = [...embeds, ...include.map((i) => i.as)];
    tools.push({
      name: `get_${snake(e.name)}`.slice(0, 64),
      description: `One ${snake(e.name).replace(/_/g, " ")} by its ${e.key.join(" and ")}${related.length ? `, with its ${related.join(", ").replace(/_/g, " ")}` : ""}.${describeEntity(e)}`,
      method: "GET",
      path: `/sql/${snake(e.name)}/get`,
      access: "read",
      inputSchema: {
        type: "object",
        properties: keyProps,
        required: e.key.map(argName),
        additionalProperties: false,
        [SQL_KEY]: { dialect: d, kind: "get", entity: e.name, as: snake(e.name), select: `SELECT ${columns.join(", ")} FROM ${qtable(d, e.table)} e ${joins.join(" ")}${joins.length ? " " : ""}WHERE ${keyWhere.join(" AND ")}`.replace(/\s+/g, " "), embeds, include },
      },
      in: {},
      source: source(`get:${e.name}`),
    });
  }

  for (const a of model.actions ?? []) {
    const e = byName.get(a.entity);
    if (!e?.key.length) {
      notes.push(`${a.name}: ${a.entity} has no key, so it was not drafted.`);
      continue;
    }
    const fieldByCol = new Map(e.fields.map((f) => [f.column.toLowerCase(), f]));
    const props = {};
    const constants = {};
    const sets = [];
    for (const k of e.key) props[argName(k)] = fieldSchema(fieldByCol.get(k.toLowerCase()), `Which ${snake(e.name).replace(/_/g, " ")}: its ${k}.`);
    const fromAgent = [];
    for (const [col, value] of Object.entries(a.set)) {
      const f = fieldByCol.get(col.toLowerCase());
      if (typeof value === "string" && value.startsWith(":")) {
        const arg = value.slice(1);
        props[arg] = fieldSchema(f, `The new ${f.column}.`);
        fromAgent.push(arg);
        sets.push(`${quote(d, f.column)} = ${param(arg)}`);
      } else {
        const name = `set_${argName(col)}`;
        constants[name] = value;
        sets.push(`${quote(d, f.column)} = ${param(name)}`);
      }
    }
    const fixed = Object.entries(a.set).filter(([, v]) => !(typeof v === "string" && v.startsWith(":")));
    const says = fixed.map(([c, v]) => `${c} to ${JSON.stringify(v)}`).join(" and ");
    tools.push({
      name: a.name,
      description: `${a.description || `Sets one ${snake(e.name).replace(/_/g, " ")}'s ${says || Object.keys(a.set).join(", ")}${fromAgent.length ? `${says ? ", and " : ""}${fromAgent.join(", ")} as given` : ""}.`} Changes exactly one ${snake(e.name).replace(/_/g, " ")}, or nothing.`,
      method: "POST",
      path: `/sql/${snake(e.name)}/${a.name}`,
      access: "write",
      inputSchema: {
        type: "object",
        properties: props,
        required: [...e.key.map(argName), ...fromAgent],
        additionalProperties: false,
        [SQL_KEY]: { dialect: d, kind: "action", entity: e.name, statement: `UPDATE ${qtable(d, e.table)} SET ${sets.join(", ")} WHERE ${e.key.map((k) => `${quote(d, k)} = ${param(argName(k))}`).join(" AND ")}`, constants, expectRows: 1 },
      },
      in: {},
      source: source(`action:${a.name}`),
    });
  }
  return { tools, notes };
}

// ── Calls ──────────────────────────────────────────────────────────────────

/** Turns `:name` into the dialect's placeholders, outside quoted text. */
export function bind(dialect, text, params) {
  const values = dialect === "sqlserver" ? {} : [];
  const index = new Map();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const close = ch === '"' ? '"' : ch === "[" ? "]" : ch === "'" ? "'" : null;
    if (close) {
      const end = text.indexOf(close, i + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const m = ch === ":" && /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
    if (m) {
      const name = m[1];
      if (!(name in params)) throw Object.assign(new Error(`a value for ${name} is missing`), { code: "invalid" });
      if (dialect === "sqlserver") {
        values[name] = params[name];
        out += `@${name}`;
      } else {
        if (!index.has(name)) {
          values.push(params[name]);
          index.set(name, values.length);
        }
        out += `$${index.get(name)}`;
      }
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, values };
}

/** The statements one call runs, from the approved spec and checked arguments. */
export function compileCall(tool, args) {
  const spec = tool.inputSchema?.[SQL_KEY];
  if (!spec || !DIALECTS.includes(spec.dialect)) throw Object.assign(new Error(`${tool.name} has no statement`), { code: "invalid" });
  const a = args ?? {};
  if (spec.kind === "find") {
    const conds = Object.entries(spec.where ?? {})
      .filter(([arg]) => a[arg] !== undefined)
      .map(([, cond]) => cond);
    const limit = Math.min(Number.isInteger(a.limit) ? a.limit : spec.defaultLimit ?? DEFAULT_LIMIT, spec.maxLimit ?? MAX_LIMIT);
    const params = { ...a, __limit: limit };
    delete params.limit;
    return { kind: "read", main: { text: `${spec.select}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ${spec.limit}`, params }, include: [], spec };
  }
  if (spec.kind === "get") return { kind: "read", main: { text: spec.select, params: { ...a } }, include: spec.include ?? [], spec };
  if (spec.kind === "action") return { kind: "write", main: { text: spec.statement, params: { ...a, ...(spec.constants ?? {}) } }, include: [], spec };
  throw Object.assign(new Error(`${tool.name} has a statement of a kind the runtime does not know`), { code: "invalid" });
}

/** `{"customer.name": "Ana"}` is `{customer: {name: "Ana"}}`; a parent with nothing in it is null. */
export function nest(row, embeds = []) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    const dot = k.indexOf(".");
    if (dot > 0 && embeds.includes(k.slice(0, dot))) {
      const p = k.slice(0, dot);
      out[p] ??= {};
      out[p][k.slice(dot + 1)] = v;
    } else out[k] = v;
  }
  for (const p of embeds) if (out[p] && Object.values(out[p]).every((v) => v === null || v === undefined)) out[p] = null;
  return out;
}

const plainValue = (v) => (typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : Buffer.isBuffer?.(v) ? undefined : v);
const plainRow = (row) => Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, plainValue(v)]));

/**
 * Runs one compiled call on a database (`db.mjs`): reads in a read-only
 * transaction, an action in a transaction that is rolled back unless it
 * changed exactly the rows it should. Returns the result in the
 * application's shape.
 */
export async function runCall(db, compiled) {
  const { spec } = compiled;
  if (compiled.kind === "write") {
    return db.transaction(async (q) => {
      const { text, values } = bind(spec.dialect, compiled.main.text, compiled.main.params);
      const res = await q(text, values);
      if (res.rowCount !== spec.expectRows) throw Object.assign(new Error(res.rowCount === 0 ? `no ${spec.entity} matched, so nothing changed` : `it would have changed ${res.rowCount} records, so nothing changed`), { code: "no_change", rowCount: res.rowCount });
      return { done: true, changed: res.rowCount };
    });
  }
  return db.readOnly(async (q) => {
    const { text, values } = bind(spec.dialect, compiled.main.text, compiled.main.params);
    const rows = (await q(text, values)).rows.map(plainRow);
    if (spec.kind === "find") return { [spec.as]: rows.map((r) => nest(r)), count: rows.length, more: rows.length === compiled.main.params.__limit };
    if (!rows.length) return { found: false };
    const record = nest(rows[0], spec.embeds);
    for (const inc of compiled.include) {
      const params = { __limit: inc.limit ?? CHILD_LIMIT };
      for (const [name, column] of Object.entries(inc.fromRow)) params[name] = rows[0][column];
      const b = bind(spec.dialect, inc.select, params);
      const children = (await q(b.text, b.values)).rows.map(plainRow);
      record[inc.as] = children;
      if (children.length === params.__limit) record[`${inc.as}_more`] = true;
    }
    return { found: true, [spec.as]: record };
  });
}

/** What the person confirming reads: the model in words. */
export function describeModel(model) {
  const lines = [];
  const state = whyUnconfirmed(model);
  lines.push(state ? `Model: not confirmed (${state}).` : `Model: confirmed by ${model.confirmation.by} on ${model.confirmation.at.slice(0, 10)}.`);
  for (const e of model.entities ?? []) {
    lines.push("");
    lines.push(`${e.name}  (${e.table.schema}.${e.table.name}${e.approximateRows !== undefined ? `, about ${e.approximateRows} rows` : ""}${e.usedByQueries ? `, in ${e.usedByQueries} of the application's queries` : ""})`);
    if (e.description) lines.push(`  ${e.description}`);
    lines.push(`  key: ${e.key.length ? e.key.join(", ") : "none"}`);
    lines.push(`  fields: ${e.fields.map((f) => `${f.column}${f.personal ? " [personal]" : ""}${f.schema.enum ? ` (${f.schema.enum.join("|")})` : ""}`).join(", ")}`);
    if (e.hidden.length) lines.push(`  never shown: ${e.hidden.map((h) => `${h.column} (${h.why})`).join(", ")}`);
    if (e.filters.length) lines.push(`  agents filter by: ${e.filters.join(", ")}`);
    for (const p of e.parents) lines.push(`  belongs to ${p.entity} as ${p.as} (${p.columns.join(", ")}; from ${p.how})`);
    for (const c of e.children) lines.push(`  has ${c.entity} as ${c.as} (${c.columns.join(", ")}; from ${c.how})`);
  }
  if ((model.actions ?? []).length) {
    lines.push("");
    lines.push("Actions (each changes one record, and waits for whatever your rules say):");
    for (const a of model.actions) lines.push(`  ${a.name}: ${a.entity} ${Object.entries(a.set).map(([c, v]) => `${c} = ${JSON.stringify(v)}`).join(", ")}${a.learnedFrom ? `  (from ${a.learnedFrom})` : "  (added by hand)"}`);
  }
  for (const n of model.notes ?? []) lines.push(`Note: ${n}`);
  return lines.join("\n");
}

/** The model as a Deliverd Context proposal, so the organisation records who said it is right. */
export function contextProposal(model, application) {
  const body = [`What the ${application} database holds, as learned by the Deliverd gateway runtime and confirmed by ${model.confirmation?.by ?? "nobody yet"}.`, "", describeModel(model)].join("\n");
  return {
    kind: "fact",
    title: `${application}: data model for agents`.slice(0, 200),
    body: body.length > 8000 ? `${body.slice(0, 7900)}\n[cut: the full model is in the runtime's tools file]` : body,
    tags: ["gateway-runtime", "data-model", application.slice(0, 40)],
    externalId: `gwrt-model:${application}:${modelFingerprint(model).slice(0, 16)}`,
  };
}
