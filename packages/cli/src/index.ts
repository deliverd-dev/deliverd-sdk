#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { exec, execFile } from "node:child_process";
import { Command } from "commander";
import { loadConfig, saveConfig } from "./config.js";
import { fail, openBrowser } from "./ui.js";
import { reportCommands } from "./commands/reports.js";
import { commentCommands, dataCommands } from "./commands/data.js";
import { complianceCommands } from "./commands/compliance.js";
import { governanceCommands } from "./commands/governance.js";
import { lookupCommands } from "./commands/lookups.js";
import { controlCommands } from "./commands/control.js";
import { taskCommands } from "./commands/tasks.js";
import { actionCommands } from "./commands/actions.js";
import { policyCommands } from "./commands/policy.js";
import { auditCommands } from "./commands/audit.js";
import {
  AGENT_NAMES,
  ConfigUnreadable,
  allAgents,
  detectAgents,
  mcpEntry,
  mergeMuseSettings,
  writeAgentConfig,
  type Agent,
  type AgentId,
} from "./agents.js";
import { signUpLine } from "./links.js";

/*
 * Read, not written down. This said 0.1.0 in a 0.2.0 release because the
 * number lived in two places and only `package.json` got bumped — so the one
 * command whose entire job is answering "which version am I on" gave the wrong
 * answer, to whoever was debugging something.
 *
 * The path holds in both forms this runs in: `dist/index.js` and
 * `src/index.ts` are each one directory below the manifest.
 */
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

const program = new Command();
program
  .name("deliverd")
  .description("Publish AI-generated reports to a secure URL.")
  .version(version);


program
  .command("login")
  .description("Authenticate with your publishing server")
  /*
   * Optional, like `setup`'s. It was required here and defaulted there,
   * which meant the two commands a new person runs first disagreed about
   * whether they had to know the URL — and the one that insisted was the
   * one they hit first.
   */
  .option("--url <url>", "App URL; defaults to the one you last used, or deliverd.dev")
  .option("--token <token>", "Paste an API token directly (skips the browser)")
  .action(async (options: { url?: string; token?: string }) => {
    const baseUrl = (
      options.url ??
      loadConfig()?.baseUrl ??
      "https://deliverd.dev"
    ).replace(/\/+$/, "");

    if (options.token) {
      saveConfig({ baseUrl, token: options.token });
      console.log("Logged in (token saved to ~/.config/deliverd/config.json).");
      return;
    }

    // Browser-assisted flow: listen on an ephemeral localhost port; the app
    // creates a token and redirects back with it.
    const state = randomBytes(16).toString("hex");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const authorizeUrl = `${baseUrl}/cli/authorize?port=${port}&state=${state}`;
    console.log("Opening your browser to authorize the CLI…");
    console.log(`If it doesn't open, visit:\n  ${authorizeUrl}\n`);
    // The browser asks a stranger to sign in; this is where they get an account.
    const signUp = signUpLine(baseUrl, "login");
    if (signUp) console.log(`${signUp}\n`);
    openBrowser(authorizeUrl);

    const token = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for authorization (5 min).")),
        5 * 60 * 1000
      );
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const gotState = url.searchParams.get("state");
        const gotToken = url.searchParams.get("token");
        if (gotState !== state || !gotToken) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid callback. Return to your terminal and retry.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:system-ui;text-align:center;padding-top:4rem'><h2>CLI authorized</h2><p>You can close this tab and return to your terminal.</p></body></html>"
        );
        clearTimeout(timeout);
        resolve(gotToken);
      });
    }).finally(() => server.close());

    saveConfig({ baseUrl, token });
    console.log("Logged in. You can now publish:");
    console.log("  deliverd publish ./report --audience \"Finance team\"");
  });

/**
 * Wire up whichever AI tools are installed, in one command.
 *
 * The alternative we shipped first was a page of JSON to copy into a file
 * whose location differs per tool and per platform. It worked, and it produced
 * exactly the failure it was always going to: a config with two objects pasted
 * one after another, silently ignored by the client, taking every other MCP
 * server with it — and an API token typed into a plaintext file along the way.
 *
 * Nothing here writes a credential. The server implements the MCP
 * authorisation spec, so each client registers itself and the person approves
 * it in a browser.
 */
program
  .command("setup")
  .description("Connect your AI tools to this server")
  .option("--url <url>", "Server URL, e.g. https://deliverd.dev")
  .option(
    "--agent <agent>",
    "Only set up one: claude-code, codex, claude-desktop, cursor, muse-code"
  )
  .option("--print", "Show the configuration instead of writing anything")
  .action(async (options: { url?: string; agent?: string; print?: boolean }) => {
    const baseUrl = (
      options.url ??
      loadConfig()?.baseUrl ??
      "https://deliverd.dev"
    ).replace(/\/+$/, "");
    const mcpUrl = `${baseUrl}/api/mcp`;

    if (options.agent && !(options.agent in AGENT_NAMES)) {
      console.error(
        `Unknown agent "${options.agent}". Choose one of: ${Object.keys(AGENT_NAMES).join(", ")}.`
      );
      process.exit(1);
    }

    if (options.print) {
      console.log(`Server URL:\n  ${mcpUrl}\n`);
      console.log("Claude Code:");
      console.log(`  claude mcp add --transport http deliverd ${mcpUrl}\n`);
      console.log("Codex:");
      console.log(`  codex mcp add deliverd --url ${mcpUrl}`);
      console.log("  codex mcp login deliverd\n");
      console.log("Claude Desktop, Cursor and other JSON-configured clients:");
      console.log(
        JSON.stringify({ mcpServers: { deliverd: mcpEntry(mcpUrl) } }, null, 2)
      );
      console.log("\nMuse Code (~/.config/muse/settings.json), then muse mcp login deliverd:");
      console.log(mergeMuseSettings(null, "deliverd", mcpUrl).trimEnd());
      return;
    }

    const candidates = options.agent
      ? allAgents().filter((a) => a.id === options.agent)
      : detectAgents();

    if (candidates.length === 0) {
      console.log("No supported AI tools found on this machine.\n");
      console.log("Looked for: Claude Code, Codex, Claude Desktop, Cursor, Muse Code.");
      console.log("Run with --print to see the settings to add by hand.");
      return;
    }

    console.log(`Connecting to ${baseUrl}\n`);
    const done: Agent[] = [];

    for (const agent of candidates) {
      if (agent.id === "claude-code") {
        const added = await addToClaudeCode(mcpUrl);
        if (added) {
          console.log(`  ${agent.name}: added`);
          done.push(agent);
        } else {
          console.log(`  ${agent.name}: run this yourself —`);
          console.log(`      claude mcp add --transport http deliverd ${mcpUrl}`);
        }
        continue;
      }

      if (agent.id === "codex") {
        const added = await addToCodex(mcpUrl);
        if (added) {
          console.log(`  ${agent.name}: added`);
          done.push(agent);
        } else {
          console.log(`  ${agent.name}: run this yourself —`);
          console.log(`      codex mcp add deliverd --url ${mcpUrl}`);
          console.log("      codex mcp login deliverd");
        }
        continue;
      }

      try {
        const result = writeAgentConfig(
          agent.configPath!,
          "deliverd",
          mcpUrl,
          agent.id === "muse-code" ? "muse" : "mcpServers"
        );
        console.log(
          `  ${agent.name}: ${result.replaced ? "updated" : "added"} in ${result.path}`
        );
        if (result.backedUpTo) {
          console.log(`      previous file kept at ${result.backedUpTo}`);
        }
        done.push(agent);
      } catch (err) {
        if (err instanceof ConfigUnreadable) {
          // Deliberately not repaired for them: the file is theirs, it holds
          // their other servers, and guessing at what they meant is how the
          // rest of it gets lost.
          console.log(`  ${agent.name}: skipped — ${err.message}`);
        } else {
          console.log(
            `  ${agent.name}: skipped — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    if (done.length === 0) return;
    console.log("\nNo API token is needed — you will be asked to approve the");
    console.log("connection in your browser the first time it is used.\n");
    for (const agent of done) console.log(`  ${agent.name}: ${agent.finishHint}`);
  });

/**
 * Let Claude Code add the server itself.
 *
 * It maintains its own config, so `claude mcp add` is the supported way in;
 * writing the file underneath it would fight the tool that owns it. Returns
 * false rather than failing when the CLI is not installed — the person still
 * gets the command to run.
 */
function addToClaudeCode(mcpUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "claude.cmd" : "claude",
      ["mcp", "add", "--transport", "http", "deliverd", mcpUrl],
      (error) => resolve(!error)
    );
  });
}

/**
 * Let Codex add the server itself, for the same reason as Claude Code — it
 * owns `~/.codex/config.toml` and `codex mcp add` is the supported way in.
 *
 * Only the first half of the job. Codex does not start the OAuth flow on
 * first use the way the Claude clients do, so the person still has to run
 * `codex mcp login deliverd`; that is what `FINISH_HINTS` tells them.
 */
function addToCodex(mcpUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "codex.cmd" : "codex",
      ["mcp", "add", "deliverd", "--url", mcpUrl],
      (error) => resolve(!error)
    );
  });
}

/*
 * The rest of the commands live in `./commands`, grouped by what they are
 * about. They were all in this file, which was fine at seven and would not
 * have been at thirty; what stays here is the program itself and the two
 * commands about this machine rather than about the server.
 */
reportCommands(program);
dataCommands(program);
commentCommands(program);
lookupCommands(program);
controlCommands(program);
taskCommands(program);
actionCommands(program);
policyCommands(program);
governanceCommands(program);
complianceCommands(program);
auditCommands(program);

program.parseAsync().catch(fail);
