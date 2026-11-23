import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_RULES, HOOK_SCRIPTS, VENDOR, installHooks, rulesPath, splitEnvFile, splitRules } from "./commands/local";

/**
 * `npx deliverd mcp-gate` and `npx deliverd gateway-runtime`: the MCP gate and
 * the gateway runtime, shipped in `vendor/` so they run with nothing else
 * installed. Deliverd's own repository checks the copy against the source.
 */
const root = join(__dirname, "..");

describe("the vendored parts", () => {
  it("ship in the package, with everything each script imports", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("vendor");
    for (const kit of ["mcp-gate", "gateway-runtime"]) {
      const entry = kit === "mcp-gate" ? "mcp-gate.mjs" : "cli.mjs";
      const seen = new Set<string>();
      const walk = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        expect(existsSync(join(VENDOR, kit, file)), `${kit}/${file}`).toBe(true);
        const src = readFileSync(join(VENDOR, kit, file), "utf8");
        for (const m of src.matchAll(/from "\.\/([a-z-]+\.mjs)"/g)) walk(m[1]!);
        // Nothing beyond Node itself.
        for (const m of src.matchAll(/from "([^".][^"]*)"/g)) expect(m[1]!.startsWith("node:"), `${kit}/${file} imports ${m[1]}`).toBe(true);
      };
      walk(entry);
    }
    for (const f of [...HOOK_SCRIPTS, ...HOOK_RULES]) expect(existsSync(join(VENDOR, "mcp-gate", f)), f).toBe(true);
  });
});

describe("the gate's own flags", () => {
  it("takes --rules out and leaves the server's command alone", () => {
    expect(splitRules(["--name", "kw", "--rules", "kiteworks", "--", "kiteworks-mcp", "--rules", "x"])).toEqual({
      rules: "kiteworks",
      rest: ["--name", "kw", "--", "kiteworks-mcp", "--rules", "x"],
    });
    expect(splitRules(["--name", "s", "--", "npx", "@stripe/mcp"])).toEqual({ rules: null, rest: ["--name", "s", "--", "npx", "@stripe/mcp"] });
    expect(() => splitRules(["--rules", "--", "x"])).toThrow(/--rules/);
  });

  it("knows the bundled rule sets by name and resolves anything else as a path", () => {
    expect(rulesPath("kiteworks")).toBe(join(VENDOR, "mcp-gate", "kiteworks.rules.json"));
    expect(existsSync(rulesPath("kiteworks"))).toBe(true);
    expect(rulesPath("default")).toBe(join(VENDOR, "mcp-gate", "rules.json"));
    expect(rulesPath("my.rules.json", "/work")).toBe(join("/work", "my.rules.json"));
  });

  it("hands the runtime's settings file to Node, not to the script", () => {
    expect(splitEnvFile(["--env-file", "runtime.env", "serve"])).toEqual({ envFile: "runtime.env", rest: ["serve"] });
    expect(splitEnvFile(["list"])).toEqual({ envFile: null, rest: ["list"] });
  });
});

describe("hooks install", () => {
  it("copies the scripts and keeps rules a person edited", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hooks-")), ".deliverd");
    expect(installHooks(dir).kept).toEqual([]);
    for (const f of [...HOOK_SCRIPTS, ...HOOK_RULES]) expect(existsSync(join(dir, f)), f).toBe(true);
    writeFileSync(join(dir, "rules.json"), '{"rules":[]}');
    expect(installHooks(dir).kept).toEqual(["rules.json", "kiteworks.rules.json"]);
    expect(readFileSync(join(dir, "rules.json"), "utf8")).toBe('{"rules":[]}');
  });
});

/** Runs the CLI from source with stdin, and collects what it prints. */
function cli(args: string[], stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(root, "src/index.ts"), ...args], {
      env: { ...process.env, ...env },
      cwd: root,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => done({ code, out, err }));
    child.stdin.end(stdin);
  });
}

describe("npx deliverd mcp-gate", () => {
  it("speaks MCP over stdio to the server behind it, printing nothing of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-"));
    // A server that answers anything with its own name.
    const server = join(dir, "server.mjs");
    writeFileSync(
      server,
      `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { from: "server", method: m.method } }) + "\\n");
});`
    );
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
    const { code, out } = await cli(["mcp-gate", "--name", "test", "--rules", "kiteworks", "--", process.execPath, server], request, {
      DELIVERD_API_KEY: "dlv_test",
      DELIVERD_URL: "http://127.0.0.1:9",
    });
    expect(code).toBe(0);
    // Every line is MCP: the server's answer, and nothing else.
    const lines = out.trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 1, result: { from: "server", method: "tools/list" } }]);
  }, 30_000);
});

describe.skipIf(Number(process.versions.node.split(".")[0]) < 22)("npx deliverd gateway-runtime", () => {
  it("runs the runtime's own commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-"));
    const tools = join(dir, "gateway.json");
    writeFileSync(tools, JSON.stringify({ application: "claims", baseUrl: "http://claims.internal", tools: [] }));
    const { code, err } = await cli(["gateway-runtime", "list", "--tools", tools], "");
    expect(err).toBe("");
    expect(code).toBe(0);
  }, 30_000);

  it("refuses to serve with no way for agents to sign in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-"));
    const tools = join(dir, "gateway.json");
    writeFileSync(tools, JSON.stringify({ application: "claims", baseUrl: "http://claims.internal", tools: [] }));
    const env = join(dir, "runtime.env");
    writeFileSync(env, "DELIVERD_API_KEY=dlv_test\nPORT=0\n");
    const { code } = await cli(["gateway-runtime", "--env-file", env, "serve", "--tools", tools], "");
    expect(code).not.toBe(0);
  }, 30_000);
});
