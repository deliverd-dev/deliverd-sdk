import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOSTED, signUpLine } from "./links.js";

export interface CliConfig {
  baseUrl: string;
  token: string;
}

const CONFIG_DIR = join(homedir(), ".config", "deliverd");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Credentials, from the environment first.
 *
 * `deliverd login` is browser-assisted — it opens a page and listens on
 * localhost — which is exactly right at a desk and impossible in CI, where
 * there is no browser and nothing to keep a config file between steps. So a
 * token in the environment takes precedence, and is the only way a build
 * server can publish at all.
 *
 * Environment wins over the file deliberately: a workflow that sets
 * DELIVERD_TOKEN means it, and silently preferring a stale config left in a
 * cached home directory would publish to the wrong place.
 */
export function loadConfig(): CliConfig | null {
  const token = process.env.DELIVERD_TOKEN;
  const baseUrl = process.env.DELIVERD_URL;
  if (token && baseUrl) {
    return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
  }
  if (token && !baseUrl) {
    console.error(
      "DELIVERD_TOKEN is set but DELIVERD_URL is not. Set both, e.g. DELIVERD_URL=https://app.example.com"
    );
    process.exit(1);
  }

  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof raw.baseUrl === "string" && typeof raw.token === "string") {
      return raw as CliConfig;
    }
  } catch {
    // fallthrough
  }
  return null;
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  chmodSync(CONFIG_PATH, 0o600);
}

export function requireConfig(): CliConfig {
  const config = loadConfig();
  if (!config) {
    // No config says which server; the environment might, and otherwise it is ours.
    const signUp = signUpLine(process.env.DELIVERD_URL ?? HOSTED, "not-logged-in");
    console.error(
      "Not logged in. Run: deliverd login (with --url for a self-hosted server).\n" +
        "In CI, set DELIVERD_URL and DELIVERD_TOKEN instead." +
        (signUp ? `\n${signUp}` : "")
    );
    process.exit(1);
  }
  return config;
}
