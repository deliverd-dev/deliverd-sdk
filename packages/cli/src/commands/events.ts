import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { emit, run } from "../ui.js";

/**
 * MCP Events (io.modelcontextprotocol/events) from a terminal.
 *
 * `deliverd events watch gate.denied` prints every denied gate as it happens,
 * reading the same cursor an MCP client reads on /api/mcp/v2. It polls
 * /api/v1/events/poll and waits as long as the server says to (never under a
 * second), so it is safe to leave running. Ctrl-C stops it; --from resumes
 * from a cursor a previous run printed.
 */

interface EventDefinition {
  name: string;
  title: string;
  description: string;
  delivery: string[];
}

interface Occurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface Page {
  events: Occurrence[];
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One line a person can read: when, what, and the fields that say which. */
export function describeEvent(event: Occurrence): string {
  const d = event.data ?? {};
  const pick = ["status", "title", "actionId", "agentName", "summary", "key"]
    .map((k) => (d[k] !== undefined && d[k] !== null ? `${k}=${String(d[k])}` : null))
    .filter(Boolean);
  const id = d.id ?? d.approvalId ?? d.gateId ?? d.agentId;
  return [event.timestamp, event.name, id ? String(id) : null, ...pick].filter(Boolean).join("  ");
}

export function eventCommands(program: Command): void {
  const events = program
    .command("events")
    .description("Be told when an approval, gate or review settles (MCP Events)");

  events
    .command("list", { isDefault: true })
    .description("The events this key can hear")
    .option("--json", "Print as JSON, for scripting")
    .action(
      run(async (options: { json?: boolean }) => {
        const config = requireConfig();
        const answer = await api<{ events: EventDefinition[] }>(config, "GET", "/events");
        emit(options.json, answer.events, () => {
          for (const e of answer.events) console.log(`${e.name.padEnd(26)} ${e.title}`);
        });
      })
    );

  events
    .command("watch")
    .description("Print each matching event as it happens, until Ctrl-C")
    .argument("<event>", "An event name from `deliverd events list`, such as gate.decided")
    .option("--id <id>", "Only this approval, gate, review, collection, task or agent")
    .option("--external-id <id>", "Only requests carrying this external id")
    .option("--agent <id>", "Only this agent")
    .option("--from <cursor>", "Resume from a cursor a previous run printed, instead of now")
    .option("--once", "Stop after the first matching event")
    .option("--json", "Print one JSON object per line")
    .action(
      run(
        async (
          name: string,
          options: { id?: string; externalId?: string; agent?: string; from?: string; once?: boolean; json?: boolean }
        ) => {
          const config = requireConfig();
          const args: Record<string, string> = {};
          if (options.id) args.id = options.id;
          if (options.externalId) args.externalId = options.externalId;
          if (options.agent) args.agentId = options.agent;
          let cursor: string | null = options.from ?? null;
          let stopping = false;
          process.once("SIGINT", () => {
            stopping = true;
            if (!options.json && cursor) console.error(`\nStopped. Resume with --from ${cursor}`);
            process.exit(0);
          });
          if (!options.json) console.error(`Watching ${name}${options.id ? ` for ${options.id}` : ""}. Ctrl-C to stop.`);
          while (!stopping) {
            const page = await api<Page>(config, "POST", "/events/poll", { name, arguments: args, cursor });
            cursor = page.cursor;
            if (page.truncated && !options.json) console.error("Some events were older than the seven days kept and were missed.");
            for (const event of page.events) {
              if (options.json) console.log(JSON.stringify({ ...event, cursor }));
              else console.log(describeEvent(event));
              if (options.once) return;
            }
            if (!page.hasMore) await sleep(Math.max(1000, page.nextPollMs));
          }
        }
      )
    );
}
