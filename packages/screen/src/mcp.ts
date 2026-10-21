/**
 * A local MCP server with one tool, `screen_text`, so an agent in Claude
 * Code, Cursor or Codex can check text before it pastes it anywhere.
 *
 *   npx @deliverd/screen mcp
 *
 * It speaks MCP over stdio, one JSON-RPC message per line, and nothing else:
 * no network, no account. The tool returns the verdict, the counts and the
 * redacted text, never the values it replaced, so the originals do not enter
 * the agent's context through it.
 */

import { createInterface } from "node:readline";
import { describeCounts, SCREEN_CLASSIFICATIONS, type ScreenClassification } from "./data-screen.js";
import { screen } from "./index.js";
import { VERSION } from "./version.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const SCREEN_TOOL = {
  name: "screen_text",
  description:
    "Check text for personal data, secrets and confidential terms before sending it to a model, a tool or anyone else, and get back what may be sent. Runs locally; nothing leaves this machine. Use the returned text in place of the original. A net, not a guarantee: names are not reliably found.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to check." },
      terms: { type: "array", items: { type: "string" }, description: "Your own words not to send: clients, code names." },
      personalData: { type: "boolean", description: "Whether the destination may receive personal data. Default false." },
      classification: { type: "string", enum: [...SCREEN_CLASSIFICATIONS], description: "The highest classification the destination may receive. Default internal." },
    },
    required: ["text"],
  },
} as const;

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function handle(req: Request): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  if (req.id === undefined) return null; // A notification: nothing to answer.
  switch (req.method) {
    case "initialize": {
      const asked = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "";
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "deliverd-screen", version: VERSION },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [SCREEN_TOOL] });
    case "tools/call": {
      if (req.params?.name !== SCREEN_TOOL.name) return fail(-32602, `Unknown tool: ${String(req.params?.name)}`);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args.text !== "string") return fail(-32602, "text is required.");
      const terms = Array.isArray(args.terms) ? args.terms.filter((t): t is string => typeof t === "string").map((term) => ({ term })) : [];
      const classification = SCREEN_CLASSIFICATIONS.includes(args.classification as ScreenClassification)
        ? (args.classification as ScreenClassification)
        : undefined;
      const checked = await screen(args.text, {
        model: "the destination",
        terms,
        allow: { personalData: args.personalData === true, classification },
      });
      const summary = {
        verdict: checked.verdict,
        allowed: checked.allowed,
        found: describeCounts(checked.counts),
        counts: checked.counts,
        reasons: checked.reasons,
        text: checked.text,
      };
      return reply({ content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary, isError: false });
    }
    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

export function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    pending.push(
      handle(req).then((res) => {
        if (res) output.write(JSON.stringify(res) + "\n");
      })
    );
  });
  return new Promise((resolve) => lines.on("close", () => void Promise.all(pending).then(() => resolve())));
}
