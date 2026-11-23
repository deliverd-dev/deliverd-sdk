#!/usr/bin/env node
// The Deliverd gateway runtime's commands.
//
//   node cli.mjs draft --openapi openapi.json [--tools gateway.json] [--application claims --base-url http://claims.internal:8080]
//       Drafts a tool per operation into the tools file. New tools start off.
//       Run it again when the API changes: a changed tool switches itself off
//       until it is approved again.
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
//   node cli.mjs serve [--tools gateway.json]
//       Runs the MCP server. Settings come from the environment (README.md).

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { authSettings } from "./auth.mjs";
import { RISKS, fingerprint, loadConfig, whyOff } from "./gateway.mjs";
import { draftTools, mergeDraft } from "./openapi.mjs";
import { start } from "./server.mjs";

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
  const lines = [`${config.application} at ${config.baseUrl}`];
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
    case "draft": {
      if (!flags.openapi) throw new Error("Give the API's description: --openapi openapi.json (or a URL).");
      const source = String(flags.openapi);
      const doc = /^https?:\/\//.test(source) ? await (await fetch(source, { signal: AbortSignal.timeout(20_000) })).json() : readJson(source);
      const { tools, notes } = draftTools(doc);
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
      const { stop } = start({ config, env, auth });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop().then(() => process.exit(0)));
      return;
    }
    default:
      throw new Error("Commands: draft, list, approve, revoke, serve. See the top of cli.mjs.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
