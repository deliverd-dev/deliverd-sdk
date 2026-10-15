import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { api, apiText } from "../api.js";
import { requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { day, emit, plural, run } from "../ui.js";

/**
 * Agent governance, read from a terminal: which agents the organisation has,
 * and what became of a gate somebody is investigating.
 *
 * Reading only. Raising a gate is an agent's call (see "There is no
 * `deliverd gate`" in docs/cli.md), and cancelling one, reporting what was
 * done with it or releasing through it are accepted only from the agent that
 * asked — a person's key would be refused by the server, so offering the
 * command would only teach people to expect it to work.
 */
interface Agent {
  id: string;
  name: string;
  platform: string;
  providerAgentId: string | null;
  environment: string | null;
  status: string;
  registeredVia: string;
  createdAt: string;
}

interface Gate {
  id: string;
  actionId: string;
  status: string;
  decision: string;
  canExecute: boolean;
  blockedBecause: string | null;
  reason: string | null;
  requestedBy: string;
  createdAt: string | null;
  approvalUrl: string | null;
  scope: {
    destination: { type: string; id: string; label?: string } | null;
    recipientScope: string | null;
    classification: string | null;
    artifact: { name: string | null; versionNumber: number | null; sha256: string | null } | null;
  };
  authorisation: { validUntil: string | null; maxUses: number; usesRemaining: number };
  executions?: { phase: string; verification: string; executedAt: string | null; reportedBy: string }[];
}

export function governanceCommands(program: Command): void {
  const agents = program.command("agents").description("The organisation's agents and what they run on");

  agents
    .command("list", { isDefault: true })
    .description("Every agent, newest first")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Agent>(config, "/agents", "agents", {
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { agents: items, nextCursor }, () => {
          console.log(`\n${plural(items.length, "agent")}`);
          for (const a of items) {
            const where = [a.platform, a.environment].filter(Boolean).join(", ");
            console.log(`  ${a.name} — ${where}${a.status === "active" ? "" : ` (${a.status})`}  ${a.id}`);
          }
          if (nextCursor) console.log(`\n  More: --cursor ${nextCursor}`);
          console.log("");
        });
      })
    );

  agents
    .command("get")
    .description("One agent and the gates it asked most recently")
    .argument("<id>", "Agent id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const agent = await api<
          Agent & { recentGates: { id: string; action: string; decision: string; outcome: string | null; createdAt: string }[] }
        >(config, "GET", `/agents/${encodeURIComponent(id)}`);
        emit(options.json, agent, () => {
          console.log(`\n${agent.name} — ${agent.platform}${agent.environment ? `, ${agent.environment}` : ""}`);
          console.log(`  Registered by ${agent.registeredVia === "connector" ? "its connector" : "an administrator"} ${day(agent.createdAt)}`);
          if (agent.recentGates.length) {
            console.log(`\n  Recent gates:`);
            for (const g of agent.recentGates) {
              console.log(`    ${day(g.createdAt)} ${g.action} — ${g.outcome ?? g.decision}  ${g.id}`);
            }
          }
          console.log("");
        });
      })
    );

  const gates = program.command("gates").description("Read what became of a gate an agent raised");

  gates
    .command("show")
    .description("A gate: what was asked, what it covers, and what was done with it")
    .argument("<id>", "Gate id, as it appears on the gate's page or in a gate.* webhook")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const gate = await api<Gate>(config, "GET", `/gates/${encodeURIComponent(id)}`);
        emit(options.json, gate, () => {
          console.log(`\n${gate.actionId} — ${gate.status} (${gate.decision})`);
          console.log(`  Asked by ${gate.requestedBy}${gate.createdAt ? ` ${day(gate.createdAt)}` : ""}`);
          const { destination, recipientScope, classification, artifact } = gate.scope;
          if (destination) console.log(`  To ${destination.label ?? destination.id} (${destination.type}, ${recipientScope ?? "unknown"})`);
          if (classification) console.log(`  Classification: ${classification}`);
          if (artifact) {
            const version = artifact.versionNumber ? ` v${artifact.versionNumber}` : "";
            console.log(`  Artifact: ${artifact.name ?? "unnamed"}${version}${artifact.sha256 ? ` sha256 ${artifact.sha256.slice(0, 12)}…` : ""}`);
          }
          // The organisation's authorisation, and only that: the platform the
          // agent runs on may still ask its own user, whatever this says.
          console.log(
            gate.canExecute
              ? `  May act: yes, ${plural(gate.authorisation.usesRemaining, "use")} left${gate.authorisation.validUntil ? ` until ${day(gate.authorisation.validUntil)}` : ""}`
              : `  May act: no — ${gate.blockedBecause ?? gate.reason ?? "not authorised"}`
          );
          for (const e of gate.executions ?? []) {
            console.log(`  ${e.phase} ${e.executedAt ? day(e.executedAt) : ""} by ${e.reportedBy} — ${e.verification}`);
          }
          if (gate.approvalUrl) console.log(`  ${gate.approvalUrl}`);
          console.log("");
        });
      })
    );

  gates
    .command("evidence")
    .description("The full record behind a gate, for an auditor")
    .argument("<id>", "Gate id")
    .option("--format <format>", "json or csv", "json")
    .option("-o, --out <file>", "Write to a file instead of standard output")
    .action(
      run(async (id: string, options: { format?: string; out?: string }) => {
        const format = options.format === "csv" ? "csv" : "json";
        const config = requireConfig();
        const body = await apiText(config, "GET", `/gates/${encodeURIComponent(id)}/evidence?format=${format}`);
        if (options.out) {
          writeFileSync(options.out, body);
          console.log(`Written to ${options.out}`);
          return;
        }
        console.log(body);
      })
    );
}
