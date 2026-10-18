import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * Wiring an AI tool up to this server, without anyone editing JSON by hand.
 *
 * Hand-editing is where this goes wrong, and it goes wrong quietly: a config
 * file with two objects pasted one after another is not valid JSON, the client
 * silently ignores the whole file, and every server the person had configured
 * before disappears at the same time. They then have a broken setup and no
 * error message pointing at it.
 *
 * So: read what is there, merge one entry into it, keep a backup, and refuse
 * outright rather than overwrite something we could not parse.
 *
 * No API token is written anywhere. The server implements the MCP
 * authorisation spec, so a client registers itself and asks the person to
 * approve it in a browser. A pasted token is a long-lived credential sitting
 * in a plaintext file in someone's home directory; consent is not.
 */

export type AgentId = "claude-code" | "claude-desktop" | "cursor" | "codex" | "muse-code";

export interface Agent {
  id: AgentId;
  name: string;
  /** Config file we would write, or null when the tool has its own command. */
  configPath: string | null;
  /** How the person finishes: what to restart, or what will open. */
  finishHint: string;
}

/**
 * Where each tool keeps its configuration, per platform.
 *
 * Exported and pure so the paths can be checked on every platform from any
 * platform — the one thing that cannot be verified by running the tests on a
 * single machine.
 */
export function agentPaths(
  os: NodeJS.Platform,
  home: string,
  appData: string | undefined,
  xdgConfigHome: string | undefined = undefined
): Record<AgentId, string | null> {
  const claudeDesktop =
    os === "win32"
      ? join(appData ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : os === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");

  return {
    // Claude Code owns its own config through `claude mcp add`; writing the
    // file underneath it would fight the tool that maintains it.
    "claude-code": null,
    // Codex likewise, through `codex mcp add`. Its config is TOML rather than
    // JSON, so writing it ourselves would need a second merger with a second
    // set of ways to destroy somebody's other servers.
    codex: null,
    "claude-desktop": claudeDesktop,
    cursor: join(home, ".cursor", "mcp.json"),
    // Muse Code reads `$XDG_CONFIG_HOME/muse/settings.json`, falling back to
    // `~/.config/muse/settings.json`, on every platform. It has no
    // `muse mcp add`, so the file is the supported way in.
    "muse-code": join(xdgConfigHome || join(home, ".config"), "muse", "settings.json"),
  };
}

export const AGENT_NAMES: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  "muse-code": "Muse Code",
};

const FINISH_HINTS: Record<AgentId, string> = {
  "claude-code": "Claude Code will open a browser to approve the connection.",
  // Codex is the one client that does not begin the approval flow by itself.
  // Leaving this step out is the difference between a working connection and
  // an "OAuth authorization required" that never resolves.
  codex: "Run `codex mcp login deliverd` to approve the connection.",
  "claude-desktop": "Quit Claude Desktop completely and reopen it.",
  cursor: "Reload Cursor, then approve the connection in your browser.",
  // Remote servers sign in through `muse mcp login`, like Codex's.
  "muse-code": "Run `muse mcp login deliverd` to approve the connection, then start a new session.",
};

export function allAgents(
  os: NodeJS.Platform = platform(),
  home: string = homedir(),
  appData: string | undefined = process.env.APPDATA,
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME
): Agent[] {
  const paths = agentPaths(os, home, appData, xdgConfigHome);
  return (Object.keys(AGENT_NAMES) as AgentId[]).map((id) => ({
    id,
    name: AGENT_NAMES[id],
    configPath: paths[id],
    finishHint: FINISH_HINTS[id],
  }));
}

/**
 * The tools that appear to be installed.
 *
 * The parent directory rather than the file: a freshly installed Claude
 * Desktop has the folder but no config until something writes one, and that
 * first write is exactly what we are here to do.
 */
export function detectAgents(agents: Agent[] = allAgents()): Agent[] {
  return agents.filter((agent) => {
    if (agent.id === "claude-code") {
      return existsSync(join(homedir(), ".claude")) ||
        existsSync(join(homedir(), ".claude.json"));
    }
    if (agent.id === "codex") {
      return existsSync(join(homedir(), ".codex"));
    }
    return agent.configPath !== null && existsSync(dirname(agent.configPath));
  });
}

/** The entry a JSON-configured client needs. Authentication is OAuth. */
export function mcpEntry(url: string): Record<string, string> {
  return { type: "http", url };
}

export class ConfigUnreadable extends Error {
  constructor(
    public path: string,
    public problem: string = "is not valid JSON"
  ) {
    super(
      `${path} exists but ${problem}, so it cannot be edited safely. ` +
        "Open it and fix or empty it, then run this again."
    );
    this.name = "ConfigUnreadable";
  }
}

/**
 * Add one server to an existing config, leaving everything else alone.
 *
 * Pure: text in, text out. The whole risk of this feature is here — someone's
 * other MCP servers live in this file, and losing them is worse than never
 * having run the command.
 */
export function mergeMcpConfig(
  existing: string | null,
  name: string,
  entry: Record<string, string>
): string {
  let parsed: Record<string, unknown> = {};
  const trimmed = existing?.trim() ?? "";
  if (trimmed.length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new ConfigUnreadable("config");
    }
    // A JSON array or string is valid JSON and still not a config; replacing
    // it silently would discard whatever the person meant by it.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigUnreadable("config");
    }
    parsed = value as Record<string, unknown>;
  }

  const servers =
    typeof parsed.mcpServers === "object" &&
    parsed.mcpServers !== null &&
    !Array.isArray(parsed.mcpServers)
      ? { ...(parsed.mcpServers as Record<string, unknown>) }
      : {};

  servers[name] = entry;
  return JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + "\n";
}

/**
 * Muse Code's settings file is not an `mcpServers` file, in three ways that
 * each break it if ignored.
 *
 * - It must carry `"schema_version": 1`; without it every `muse` command
 *   fails with "malformed settings file", so a new file gets one and a file
 *   on a version we do not know is left alone.
 * - Servers live under `mcp_servers`, each with a `transport`. Some Muse
 *   builds read `mcpServers` instead, and a file with both has every server
 *   switched off, so the entry goes under whichever key is already there and
 *   a second key is never added.
 * - A server is `required` by default, so one that cannot be reached stops
 *   the session from starting. Ours is `optional`: Muse warns and carries on.
 */
export function museEntry(url: string): Record<string, string> {
  return { transport: "streamable_http", url, mode: "optional" };
}

export function mergeMuseSettings(existing: string | null, name: string, url: string): string {
  let parsed: Record<string, unknown> = {};
  const trimmed = existing?.trim() ?? "";
  if (trimmed.length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new ConfigUnreadable("config");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigUnreadable("config");
    }
    parsed = value as Record<string, unknown>;
  }

  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new ConfigUnreadable("config", `is on settings schema version ${JSON.stringify(parsed.schema_version)}, not 1`);
  }
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isMap(parsed.mcp_servers) && isMap(parsed.mcpServers)) {
    // Muse already has every server off for this file; choosing which half
    // the person meant is theirs to do.
    throw new ConfigUnreadable("config", "has both mcp_servers and mcpServers, which turns every server off");
  }
  const key = isMap(parsed.mcpServers) ? "mcpServers" : "mcp_servers";
  const servers = isMap(parsed[key]) ? { ...(parsed[key] as Record<string, unknown>) } : {};
  servers[name] = museEntry(url);
  return JSON.stringify({ schema_version: 1, ...parsed, [key]: servers }, null, 2) + "\n";
}

export interface WriteResult {
  path: string;
  backedUpTo: string | null;
  replaced: boolean;
}

/**
 * Write the merged config, keeping a timestamped copy of what was there.
 *
 * The backup is not defensive habit: this edits a file the person did not ask
 * us to touch the rest of, in their home directory, and a copy is the
 * difference between "undo it" and "reconstruct it from memory".
 */
export function writeAgentConfig(
  configPath: string,
  name: string,
  url: string,
  format: "mcpServers" | "muse" = "mcpServers"
): WriteResult {
  const existed = existsSync(configPath);
  const current = existed ? readFileSync(configPath, "utf8") : null;

  let merged: string;
  try {
    merged =
      format === "muse"
        ? mergeMuseSettings(current, name, url)
        : mergeMcpConfig(current, name, mcpEntry(url));
  } catch (err) {
    if (err instanceof ConfigUnreadable) throw new ConfigUnreadable(configPath, err.problem);
    throw err;
  }

  let backedUpTo: string | null = null;
  if (existed && current !== null && current.trim().length > 0) {
    backedUpTo = `${configPath}.backup-${Date.now()}`;
    writeFileSync(backedUpTo, current);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, merged);

  const replaced =
    current !== null && current.includes(`"${name}"`);
  return { path: configPath, backedUpTo, replaced };
}
