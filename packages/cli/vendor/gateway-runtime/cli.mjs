#!/usr/bin/env node
// The Deliverd gateway runtime's commands.
//
//   node cli.mjs draft --openapi openapi.json [--tools gateway.json] [--application claims --base-url http://claims.internal:8080]
//       Drafts a tool per operation into the tools file. New tools start off.
//       Run it again when the API changes: a changed tool switches itself off
//       until it is approved again.
//
//   node cli.mjs learn --dialect postgres|sqlserver [--schemas public,claims] [--queries queries.sql] [--application claims] [--database-env DATABASE_URL]
//       Reads a database's schema (and, if given, queries the application
//       runs) and drafts a model of the application: entities, relations,
//       filters and actions. Learning again keeps what a person changed.
//
//   node cli.mjs model [--tools gateway.json]
//       The model in words, as the person confirming it reads it.
//
//   node cli.mjs confirm-model --by "Name <email>" [--context]
//       Says the model is right, for exactly the model it is now. --context
//       also proposes it to your organisation's Context in Deliverd, with
//       DELIVERD_API_KEY set to a key of your own with tasks:write.
//
//   node cli.mjs draft --sql [--tools gateway.json]
//       Drafts find_, get_ and action tools from the confirmed model. New and
//       changed tools start off, as with --openapi.
//
//   node cli.mjs draft --wsdl service.wsdl [--tools gateway.json] [--application billing --base-url http://billing.internal]
//       The same, for a SOAP service, from its WSDL 1.1 (a file or a URL).
//
//   node cli.mjs list [--tools gateway.json]
//       Every tool, whether it is on, and why not.
//
//   node cli.mjs approve <tool> --by "Name <email>" [--risk high] [--callers "*" | --callers <app id>,<app id>] [--tools gateway.json]
//       Switches a tool on, as approved by a named person, for exactly the
//       definition it has now.
//
//   node cli.mjs revoke <tool> [--tools gateway.json]
//       Switches a tool off.
//
//   node cli.mjs files [--tools gateway.json]
//       For a files runtime: writes the four tools for each root in `files`
//       into the tools file. New tools start off. Run it again after changing
//       the roots: a tool whose folder moved switches itself off until it is
//       approved again.
//
//   node cli.mjs serve [--tools gateway.json]
//       Runs the MCP server. Settings come from the environment (README.md).

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { authSettings } from "./auth.mjs";
import { RISKS, fingerprint, loadConfig, whyOff } from "./gateway.mjs";
import { introspect, openDatabase } from "./db.mjs";
import { draftTools, mergeDraft } from "./openapi.mjs";
import { loadScreen, mergeFileTools } from "./files.mjs";
import { draftSoapTools } from "./soap.mjs";
import { deliverdApi, start } from "./server.mjs";
import { confirmModel, contextProposal, describeModel, draftSqlTools, learnModel, mergeModel } from "./sql.mjs";

export function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

const toolsPath = (flags, env) => flags.tools || env.GATEWAY_TOOLS || "gateway.json";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, config) => writeFileSync(path, JSON.stringify(config, null, 2) + "\n");

export function approve(config, name, { by, risk, callers, now = new Date() }) {
  const tool = config.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`There is no tool called ${name}.`);
  if (tool.removed) throw new Error(`${name} is no longer in the API's description, so it cannot be switched on.`);
  if (typeof by !== "string" || !by.trim()) throw new Error("Say who is approving it: --by \"Name <email>\".");
  const nextRisk = risk ?? tool.risk;
  if (!RISKS.includes(nextRisk)) throw new Error(`--risk is one of ${RISKS.join(", ")}.`);
  const next = { ...tool, risk: nextRisk, ...(callers ? { callers } : {}) };
  next.approval = { by: by.trim(), at: now.toISOString(), fingerprint: fingerprint(next) };
  return { ...config, tools: config.tools.map((t) => (t.name === name ? next : t)) };
}

export function revoke(config, name) {
  if (!config.tools.some((t) => t.name === name)) throw new Error(`There is no tool called ${name}.`);
  return { ...config, tools: config.tools.map((t) => (t.name === name ? (({ approval, ...rest }) => rest)(t) : t)) };
}

export function describe(config) {
  const lines = [config.files ? `${config.application}: ${config.files.roots.map((r) => `${r.name} (${r.path})`).join(", ")}` : `${config.application} at ${config.database ? `a ${config.database.dialect} database (${config.database.env})` : config.baseUrl}`];
  for (const t of config.tools) {
    const off = whyOff(t);
    const who = (t.callers ?? []).length ? (t.callers.includes("*") ? "any agent" : t.callers.join(", ")) : "nobody";
    lines.push(`${off ? "off" : "ON "}  ${t.name.padEnd(32)} ${t.access.padEnd(5)} ${(t.risk ?? "-").padEnd(8)} ${t.method} ${t.path}${off ? `  (${off})` : `  for ${who}, approved by ${t.approval.by}`}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  const { flags, rest } = parseFlags(args);
  const path = toolsPath(flags, env);
  switch (command) {
    case "learn": {
      let existing = null;
      try {
        existing = readJson(path);
      } catch {}
      const dialect = flags.dialect || existing?.database?.dialect;
      const envName = flags["database-env"] || existing?.database?.env || "DATABASE_URL";
      if (!dialect) throw new Error("Say which database: --dialect postgres or --dialect sqlserver.");
      if (existing && existing.baseUrl) throw new Error(`${path} is for an application with a REST API. Give the database its own: --tools ${flags.application ?? "database"}.json`);
      if (!existing && !flags.application) throw new Error(`No ${path} yet: give --application <short name> to start one.`);
      const schemas = typeof flags.schemas === "string" ? flags.schemas.split(",").map((x) => x.trim()).filter(Boolean) : [];
      const db = await openDatabase(dialect, env[envName]);
      let catalog;
      try {
        catalog = await introspect(db, { schemas });
      } finally {
        await db.close();
      }
      const queries = typeof flags.queries === "string" ? readFileSync(flags.queries, "utf8") : "";
      const fresh = learnModel(catalog, { queries, source: { schemas, queries: !!queries } });
      const config = existing ?? { application: flags.application, title: flags.title ?? flags.application, database: { dialect, env: envName }, tools: [] };
      const { model, report } = mergeModel(config.model ?? null, { ...fresh, title: config.title });
      write(path, { ...config, model });
      console.log(describeModel(model));
      const say = (label, names) => names.length && console.log(`${label}: ${names.join(", ")}`);
      say("\nNew", report.added);
      say("Gone from the database", report.removed);
      console.log(`\nWrote the model to ${path}. Read it, edit what is wrong (names, descriptions, relations, hidden fields, actions), then: node cli.mjs confirm-model --by "Your Name <you@example.com>"`);
      return;
    }
    case "model": {
      const config = readJson(path);
      if (!config.model) throw new Error(`${path} has no model yet. Run learn first.`);
      console.log(describeModel(config.model));
      return;
    }
    case "confirm-model": {
      const config = readJson(path);
      const model = confirmModel(config.model, { by: flags.by });
      write(path, { ...config, model });
      console.log(`Confirmed by ${model.confirmation.by}. Now draft the tools: node cli.mjs draft --sql`);
      if (flags.context) {
        if (!env.DELIVERD_API_KEY) throw new Error("Set DELIVERD_API_KEY to a key of your own with tasks:write to propose the model to Context.");
        const out = await deliverdApi(env)("POST", "/knowledge", contextProposal(model, config.title ?? config.application));
        console.log(`Proposed to Context${out?.entry?.id || out?.id ? ` (${out.entry?.id ?? out.id})` : ""}. It is a proposal until a person confirms it in Deliverd.`);
      }
      return;
    }
    case "draft": {
      if (flags.sql) {
        const existing = readJson(path);
        if (!existing.database) throw new Error(`${path} has no database. Run learn first.`);
        const { tools, notes } = draftSqlTools({ ...existing.model, title: existing.title });
        const { config, report } = mergeDraft(existing, tools);
        loadConfig(config);
        write(path, config);
        const say = (label, names) => names.length && console.log(`${label}: ${names.join(", ")}`);
        say("New, off until approved", report.added);
        say("Changed, off until approved again", report.changed.filter((n) => config.tools.find((t) => t.name === n)?.approval));
        say("No longer in the model, off", report.removed);
        for (const note of notes) console.log(`Note: ${note}`);
        console.log(`Wrote ${path}. Approve the tools you want on. Reads can flow by rule in Deliverd; actions wait for whatever your rules say.`);
        return;
      }
      if (!flags.openapi && !flags.wsdl) throw new Error("Give the API's description: --openapi openapi.json or --wsdl service.wsdl (a file or a URL), or --sql to draft from a confirmed database model.");
      const source = String(flags.openapi || flags.wsdl);
      const raw = /^https?:\/\//.test(source) ? await (await fetch(source, { signal: AbortSignal.timeout(20_000) })).text() : readFileSync(source, "utf8");
      const doc = flags.wsdl ? { info: { title: null } } : JSON.parse(raw);
      const drafted = flags.wsdl ? draftSoapTools(raw) : draftTools(doc);
      if (flags.wsdl) doc.info.title = drafted.title;
      const { tools, notes } = drafted;
      let existing;
      try {
        existing = readJson(path);
      } catch {
        if (!flags.application || !flags["base-url"]) throw new Error(`No ${path} yet: give --application <short name> and --base-url <the application's address> to start one.`);
        existing = { application: flags.application, title: doc.info?.title ?? flags.application, baseUrl: flags["base-url"], credential: { header: "authorization", env: "APP_CREDENTIAL" }, tools: [] };
      }
      const { config, report } = mergeDraft(existing, tools);
      loadConfig(config);
      write(path, config);
      const say = (label, names) => names.length && console.log(`${label}: ${names.join(", ")}`);
      say("New, off until approved", report.added);
      say("Changed, off until approved again", report.changed.filter((n) => config.tools.find((t) => t.name === n)?.approval));
      say("Changed, not approved yet", report.changed.filter((n) => !config.tools.find((t) => t.name === n)?.approval));
      say("No longer in the API, off", report.removed);
      for (const note of notes) console.log(`Note: ${note}`);
      console.log(`Wrote ${path}. Read each tool, fix any description that would mislead a model, then approve the ones you want on.`);
      return;
    }
    case "files": {
      const existing = readJson(path);
      if (!existing.files) throw new Error(`${path} has no \`files\` section. See README.md, "Windows file shares".`);
      const { config, report } = mergeFileTools(loadConfig(existing));
      loadConfig(config);
      write(path, config);
      const say = (label, names) => names.length && console.log(`${label}: ${names.join(", ")}`);
      say("New, off until approved", report.added);
      say("Changed, off until approved again", report.changed);
      say("Root gone, off", report.removed);
      console.log(`Wrote ${path}. Approve the tools you want on, here or in Deliverd (DELIVERD_REGISTRY=true).`);
      return;
    }
    case "list":
      console.log(describe(loadConfig(readJson(path))));
      return;
    case "approve": {
      const callers = typeof flags.callers === "string" ? flags.callers.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const config = approve(loadConfig(readJson(path)), rest[0], { by: flags.by, risk: typeof flags.risk === "string" ? flags.risk : undefined, callers });
      write(path, config);
      const tool = config.tools.find((t) => t.name === rest[0]);
      if (!(tool.callers ?? []).length) console.log(`Approved ${rest[0]}, but nobody may call it yet: add --callers.`);
      else console.log(`Approved ${rest[0]}. Restart the runtime to pick it up.`);
      return;
    }
    case "revoke":
      write(path, revoke(loadConfig(readJson(path)), rest[0]));
      console.log(`${rest[0]} is off. Restart the runtime to pick it up.`);
      return;
    case "serve": {
      if (!env.DELIVERD_API_KEY) throw new Error("Set DELIVERD_API_KEY to the runtime's agent key (gates:write and gates:execute).");
      const config = loadConfig(readJson(path));
      const auth = authSettings(env);
      if (!auth.entra && !auth.clientKeys.size) throw new Error("Set ENTRA_TENANT_ID and ENTRA_AUDIENCE, or GATEWAY_CLIENT_KEYS for a trial, so the runtime knows who is calling.");
      if (config.credential?.env && !env[config.credential.env]) console.warn(`[gateway-runtime] ${config.credential.env} is not set, so calls go to the application with no credential.`);
      let screen = null;
      if (config.files) {
        screen = await loadScreen(config.files);
        if (!screen && config.files.screening !== "off") throw new Error("This runtime reads files, and screening is on, but @deliverd/screen is not installed. Run npm install @deliverd/screen beside it (the Docker image has it), or set files.screening to off.");
        if (!env.FILES_CACHE_DIR) console.warn("[gateway-runtime] FILES_CACHE_DIR is not set, so every file is converted again each time it is read.");
      }
      const db = config.database ? await openDatabase(config.database.dialect, env[config.database.env]) : null;
      const { stop } = start({ config, env, auth, db, screen });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop().then(() => process.exit(0)));
      return;
    }
    default:
      throw new Error("Commands: learn, model, confirm-model, draft, files, list, approve, revoke, serve. See the top of cli.mjs.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
