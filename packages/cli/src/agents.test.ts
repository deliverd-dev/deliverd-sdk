import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigUnreadable,
  agentPaths,
  allAgents,
  mcpEntry,
  mergeMcpConfig,
  mergeMuseSettings,
  writeAgentConfig,
} from "./agents";

/**
 * The whole risk of this feature is in one place: these files already contain
 * other people's MCP servers. Losing them is worse than never having offered
 * to write the config at all — and the loss is silent, because a client that
 * cannot parse its config ignores the file rather than complaining.
 */
describe("mergeMcpConfig", () => {
  const entry = mcpEntry("https://deliverd.dev/api/mcp");

  it("creates a config when there is none", () => {
    const result = JSON.parse(mergeMcpConfig(null, "deliverd", entry));
    expect(result.mcpServers.deliverd).toEqual(entry);
  });

  it("treats an empty file as no config", () => {
    // A touched-but-empty file is common and is not a parse failure.
    expect(() => mergeMcpConfig("   \n", "deliverd", entry)).not.toThrow();
  });

  it("keeps every other server", () => {
    const before = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "github-mcp"] },
        postgres: { url: "https://example.test/mcp" },
      },
    });
    const after = JSON.parse(mergeMcpConfig(before, "deliverd", entry));
    expect(Object.keys(after.mcpServers).sort()).toEqual([
      "deliverd",
      "github",
      "postgres",
    ]);
    expect(after.mcpServers.github.args).toEqual(["-y", "github-mcp"]);
  });

  it("keeps unrelated top-level settings", () => {
    // Claude Desktop keeps more than servers in this file.
    const before = JSON.stringify({
      globalShortcut: "Cmd+Space",
      mcpServers: {},
    });
    const after = JSON.parse(mergeMcpConfig(before, "deliverd", entry));
    expect(after.globalShortcut).toBe("Cmd+Space");
  });

  it("replaces our own entry rather than duplicating it", () => {
    const before = JSON.stringify({
      mcpServers: { deliverd: { url: "https://old.example/api/mcp" } },
    });
    const after = JSON.parse(mergeMcpConfig(before, "deliverd", entry));
    expect(after.mcpServers.deliverd.url).toBe("https://deliverd.dev/api/mcp");
  });

  it("refuses a file it cannot parse instead of overwriting it", () => {
    // Two objects pasted one after another — the exact shape of a hand-edited
    // config that has gone wrong, and the reason this command exists.
    const broken = '{"mcpServers":{}}{"mcpServers":{"other":{}}}';
    expect(() => mergeMcpConfig(broken, "deliverd", entry)).toThrow(
      ConfigUnreadable
    );
  });

  it("refuses valid JSON that is not a config object", () => {
    expect(() => mergeMcpConfig("[1,2,3]", "deliverd", entry)).toThrow(
      ConfigUnreadable
    );
    expect(() => mergeMcpConfig('"hello"', "deliverd", entry)).toThrow(
      ConfigUnreadable
    );
  });

  it("survives mcpServers being the wrong type", () => {
    // Rather than throwing on someone's odd file, start a fresh servers map.
    const after = JSON.parse(
      mergeMcpConfig('{"mcpServers": "nonsense"}', "deliverd", entry)
    );
    expect(after.mcpServers.deliverd).toEqual(entry);
  });

  it("writes no credential", () => {
    // Authentication is OAuth. A token in a plaintext file in someone's home
    // directory is a long-lived credential that nobody remembers to rotate.
    const text = mergeMcpConfig(null, "deliverd", entry);
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("dlv_");
  });
});

describe("agentPaths", () => {
  it("uses APPDATA on Windows", () => {
    const paths = agentPaths("win32", "C:\\Users\\dave", "C:\\Users\\dave\\AppData\\Roaming");
    expect(paths["claude-desktop"]).toContain("AppData");
    expect(paths["claude-desktop"]).toContain("claude_desktop_config.json");
  });

  it("falls back to the usual Windows location when APPDATA is unset", () => {
    const paths = agentPaths("win32", "C:\\Users\\dave", undefined);
    expect(paths["claude-desktop"]).toContain("Roaming");
  });

  it("uses Application Support on macOS", () => {
    const paths = agentPaths("darwin", "/Users/dave", undefined);
    expect(paths["claude-desktop"]).toBe(
      "/Users/dave/Library/Application Support/Claude/claude_desktop_config.json"
    );
  });

  it("uses XDG config on Linux", () => {
    const paths = agentPaths("linux", "/home/dave", undefined);
    expect(paths["claude-desktop"]).toBe(
      "/home/dave/.config/Claude/claude_desktop_config.json"
    );
  });

  it("leaves Claude Code to its own command", () => {
    // `claude mcp add` maintains that file; writing it underneath would fight
    // the tool that owns it.
    expect(agentPaths("darwin", "/Users/dave", undefined)["claude-code"]).toBeNull();
  });

  it("leaves Codex to its own command, on every platform", () => {
    /*
     * Codex keeps TOML, not JSON. `writeAgentConfig` merges JSON, so a
     * non-null path here would send `~/.codex/config.toml` through a merger
     * that cannot parse it — and the failure mode of this whole feature is
     * destroying the other MCP servers someone had configured.
     */
    for (const os of ["darwin", "linux", "win32"] as const) {
      expect(agentPaths(os, "/Users/dave", undefined).codex).toBeNull();
    }
  });

  it("covers every agent it claims to support", () => {
    // `--agent` validates against AGENT_NAMES and `setup` reads FINISH_HINTS,
    // so an id added to one and not the others crashes on the tool it was
    // added for.
    const ids = allAgents("darwin", "/Users/dave", undefined).map((a) => a.id);
    expect(ids.sort()).toEqual([
      "claude-code",
      "claude-desktop",
      "codex",
      "cursor",
      "muse-code",
    ]);
    for (const agent of allAgents("darwin", "/Users/dave", undefined)) {
      expect(agent.name, `${agent.id} has no display name`).toBeTruthy();
      expect(agent.finishHint, `${agent.id} has no finish hint`).toBeTruthy();
    }
  });

  it("tells Codex users about the second step", () => {
    /*
     * Codex is the only client that does not begin the OAuth flow on first
     * use. Without `codex mcp login`, the connection reports "authorization
     * required" forever and looks like our bug.
     */
    const codex = allAgents("darwin", "/Users/dave", undefined).find(
      (a) => a.id === "codex"
    );
    expect(codex?.finishHint).toContain("codex mcp login");
  });
});

/**
 * Muse Code's settings file is a different shape from every other client's,
 * and each difference breaks Muse in its own way if it is got wrong.
 */
describe("mergeMuseSettings", () => {
  const url = "https://deliverd.dev/api/mcp";

  it("creates a settings file Muse will open", () => {
    // Without schema_version every `muse` command fails "malformed settings file".
    const result = JSON.parse(mergeMuseSettings(null, "deliverd", url));
    expect(result.schema_version).toBe(1);
    expect(result.mcp_servers.deliverd).toEqual({ transport: "streamable_http", url, mode: "optional" });
    expect(result.mcpServers).toBeUndefined();
  });

  it("keeps the person's other servers and settings", () => {
    const before = JSON.stringify({
      schema_version: 1,
      model: "muse-spark-1.2",
      mcp_servers: { tools: { transport: "stdio", command: "my-mcp-server", args: [] } },
    });
    const after = JSON.parse(mergeMuseSettings(before, "deliverd", url));
    expect(after.model).toBe("muse-spark-1.2");
    expect(Object.keys(after.mcp_servers).sort()).toEqual(["deliverd", "tools"]);
    expect(after.mcp_servers.tools.command).toBe("my-mcp-server");
  });

  it("writes under mcpServers when that is the key the file already uses, and never adds the other", () => {
    // A file with both keys has every server switched off.
    const before = JSON.stringify({ schema_version: 1, mcpServers: { other: { url: "https://x.test" } } });
    const after = JSON.parse(mergeMuseSettings(before, "deliverd", url));
    expect(after.mcp_servers).toBeUndefined();
    expect(Object.keys(after.mcpServers).sort()).toEqual(["deliverd", "other"]);
  });

  it("refuses a file that already has both keys, rather than choosing for them", () => {
    const both = JSON.stringify({ schema_version: 1, mcp_servers: {}, mcpServers: {} });
    expect(() => mergeMuseSettings(both, "deliverd", url)).toThrow(/both mcp_servers and mcpServers/);
  });

  it("refuses a settings schema it does not know", () => {
    expect(() => mergeMuseSettings('{"schema_version": 2}', "deliverd", url)).toThrow(ConfigUnreadable);
    expect(() => mergeMuseSettings("{oops", "deliverd", url)).toThrow(ConfigUnreadable);
  });

  it("writes no credential", () => {
    const text = mergeMuseSettings(null, "deliverd", url);
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text).not.toContain("dlv_");
  });
});

describe("Muse Code", () => {
  it("is configured in its XDG settings file, on every platform", () => {
    for (const os of ["darwin", "linux", "win32"] as const) {
      expect(agentPaths(os, "/home/dave", undefined)["muse-code"]).toBe(join("/home/dave", ".config", "muse", "settings.json"));
    }
    expect(agentPaths("linux", "/home/dave", undefined, "/xdg")["muse-code"]).toBe(join("/xdg", "muse", "settings.json"));
  });

  it("is told to sign in, which it needs for a remote server", () => {
    const muse = allAgents("darwin", "/Users/dave", undefined).find((a) => a.id === "muse-code");
    expect(muse?.finishHint).toContain("muse mcp login deliverd");
  });

  it("gets a Muse settings file from writeAgentConfig, with the path in any refusal", () => {
    const path = join(mkdtempSync(join(tmpdir(), "deliverd-muse-")), "muse", "settings.json");
    writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp", "muse");
    expect(JSON.parse(readFileSync(path, "utf8")).mcp_servers.deliverd.transport).toBe("streamable_http");
    writeFileSync(path, '{"schema_version": 3}');
    expect(() => writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp", "muse")).toThrow(path);
  });
});

describe("writeAgentConfig", () => {
  function tmp(): string {
    return join(mkdtempSync(join(tmpdir(), "deliverd-agents-")), "mcp.json");
  }

  it("writes a new config", () => {
    const path = tmp();
    const result = writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp");
    expect(result.backedUpTo).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.deliverd.url).toBe(
      "https://deliverd.dev/api/mcp"
    );
  });

  it("backs up what was there before touching it", () => {
    const path = tmp();
    const before = JSON.stringify({ mcpServers: { github: { url: "x" } } });
    writeFileSync(path, before);

    const result = writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp");
    expect(result.backedUpTo).not.toBeNull();
    expect(readFileSync(result.backedUpTo!, "utf8")).toBe(before);
    // And the original server survived the edit.
    expect(
      JSON.parse(readFileSync(path, "utf8")).mcpServers.github.url
    ).toBe("x");
  });

  it("leaves an unparseable file exactly as it was", () => {
    const path = tmp();
    const broken = "{not json at all";
    writeFileSync(path, broken);

    expect(() =>
      writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp")
    ).toThrow(ConfigUnreadable);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  it("names the real path in the refusal, not a placeholder", () => {
    const path = tmp();
    writeFileSync(path, "{oops");
    try {
      writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ConfigUnreadable).message).toContain(path);
    }
  });

  it("creates the directory when the tool has never written one", () => {
    const dir = mkdtempSync(join(tmpdir(), "deliverd-agents-"));
    const path = join(dir, "nested", "deeper", "mcp.json");
    writeAgentConfig(path, "deliverd", "https://deliverd.dev/api/mcp");
    expect(existsSync(path)).toBe(true);
  });
});
