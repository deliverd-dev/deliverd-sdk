import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

/**
 * The parts of Deliverd that run on a customer's own machines, shipped inside
 * this CLI so `npx deliverd …` runs them with nothing else to install and no
 * container: the MCP gate and the coding-agent hooks, and the gateway runtime.
 *
 * `vendor/` is a copy of `integrations/agent-hooks/deliverd` and
 * `integrations/gateway-runtime` in Deliverd's repository, made by
 * `scripts/build-local-kits.mjs`; a test there fails when the copy is stale.
 * Each runs as its own Node process with this terminal's stdin and stdout,
 * because the MCP gate speaks MCP over them and must not share them with
 * anything this CLI prints.
 *
 * `../../vendor/` holds from both `src/commands/` and `dist/commands/`.
 */
export const VENDOR = fileURLToPath(new URL("../../vendor/", import.meta.url));

/** Files `hooks install` copies into a project; the rules files only when missing, because they are the project's own once there. */
export const HOOK_SCRIPTS = ["gate.mjs", "mcp-gate.mjs", "register.mjs", "ledgers.mjs"] as const;
export const HOOK_RULES = ["rules.json", "kiteworks.rules.json"] as const;

/** Rule sets that ship with the gate, by short name. */
const BUILT_IN_RULES: Record<string, string> = {
  default: "rules.json",
  kiteworks: "kiteworks.rules.json",
};

/** `--rules kiteworks` → the bundled file; anything else is a path. */
export function rulesPath(value: string, cwd = process.cwd()): string {
  const builtIn = BUILT_IN_RULES[value];
  if (builtIn) return join(VENDOR, "mcp-gate", builtIn);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Takes `--rules <x>` out of the gate's own flags (before `--`), leaving the server's command as it was. */
export function splitRules(args: string[]): { rules: string | null; rest: string[] } {
  const at = args.indexOf("--");
  const own = at === -1 ? args : args.slice(0, at);
  const i = own.indexOf("--rules");
  if (i === -1) return { rules: null, rest: args };
  const value = own[i + 1];
  if (!value || value === "--") throw new Error("--rules takes a file, or kiteworks.");
  const kept = [...own.slice(0, i), ...own.slice(i + 2)];
  return { rules: value, rest: at === -1 ? kept : [...kept, ...args.slice(at)] };
}

/** `--env-file <path>` for the gateway runtime, read by Node itself, so a value never passes through this process's arguments. */
export function splitEnvFile(args: string[]): { envFile: string | null; rest: string[] } {
  const i = args.indexOf("--env-file");
  if (i === -1) return { envFile: null, rest: args };
  const value = args[i + 1];
  if (!value) throw new Error("--env-file takes the path of a settings file, such as runtime.env.");
  return { envFile: value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

/** Runs a vendored script as a child with this terminal, and exits with its code. */
function runVendored(script: string, args: string[], { nodeArgs = [] as string[], env = process.env } = {}): void {
  const child = spawn(process.execPath, [...nodeArgs, script, ...args], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/**
 * Everything after `mcp-gate` or `gateway-runtime` belongs to the script, `--`
 * and all, so these two are dispatched before commander parses anything.
 * Returns true when it took the command.
 */
export function runPassthrough(argv: string[]): boolean {
  const [command, ...args] = argv;
  try {
    if (command === "mcp-gate") {
      const { rules, rest } = splitRules(args);
      const env = { ...process.env };
      if (rules) env.DELIVERD_HOOK_RULES = rulesPath(rules);
      runVendored(join(VENDOR, "mcp-gate", "mcp-gate.mjs"), rest, { env });
      return true;
    }
    if (command === "gateway-runtime") {
      if (nodeMajor() < 22) throw new Error(`The gateway runtime needs Node.js 22 or later; this is ${process.version}.`);
      const { envFile, rest } = splitEnvFile(args);
      // `register` is its own script (it registers the action once, with an administrator's key); the rest are cli.mjs's.
      const [script, scriptArgs] = rest[0] === "register" ? ["register.mjs", rest.slice(1)] : ["cli.mjs", rest];
      runVendored(join(VENDOR, "gateway-runtime", script), scriptArgs, { nodeArgs: envFile ? [`--env-file=${envFile}`] : [] });
      return true;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  return false;
}

/** Copies the hooks and the MCP gate into a project folder. Returns what it did, for the caller to print. */
export function installHooks(dir: string): { copied: string[]; kept: string[] } {
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const kept: string[] = [];
  for (const f of HOOK_SCRIPTS) {
    copyFileSync(join(VENDOR, "mcp-gate", f), join(dir, f));
    copied.push(f);
  }
  for (const f of HOOK_RULES) {
    if (existsSync(join(dir, f))) kept.push(f);
    else {
      copyFileSync(join(VENDOR, "mcp-gate", f), join(dir, f));
      copied.push(f);
    }
  }
  return { copied, kept };
}

export function localCommands(program: Command): void {
  // Registered for --help; runPassthrough runs them before commander parses.
  program
    .command("mcp-gate")
    .description(
      "Run a local MCP server behind your Deliverd rules: deliverd mcp-gate --name <server> [--rules kiteworks|<file>] -- <the server's command>. Needs DELIVERD_API_KEY (an agent key)."
    )
    .helpOption(false);

  program
    .command("gateway-runtime")
    .description(
      "Run the gateway runtime beside an in-house application: deliverd gateway-runtime [--env-file runtime.env] register|draft|list|approve|revoke|serve. Needs Node.js 22."
    )
    .helpOption(false);

  const hooks = program.command("hooks").description("The coding-agent hooks and the MCP gate, as files in your project");

  hooks
    .command("install")
    .description("Copy the hooks and the MCP gate into a folder of this project (default .deliverd); your rules files are kept when run again")
    .argument("[dir]", "Where to put them", ".deliverd")
    .action((dir: string) => {
      const { copied, kept } = installHooks(dir);
      console.log(`Installed in ${dir}: ${copied.join(", ")}`);
      if (kept.length) console.log(`Kept your ${kept.join(", ")}`);
      console.log(`Next: DELIVERD_API_KEY=dlv_… node ${join(dir, "register.mjs")} (an owner's or administrator's key with actions:write)`);
    });

  hooks
    .command("register")
    .description("Register the actions the rules name, with an owner's or administrator's key (DELIVERD_API_KEY, actions:write)")
    .option("--rules <rules>", "kiteworks, or a rules file (default: the general rules)")
    .action((opts: { rules?: string }) => {
      const env = { ...process.env };
      if (opts.rules) env.DELIVERD_HOOK_RULES = rulesPath(opts.rules);
      runVendored(join(VENDOR, "mcp-gate", "register.mjs"), [], { env });
    });
}
