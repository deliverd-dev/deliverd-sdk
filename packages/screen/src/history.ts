/**
 * What you have already pasted into an AI assistant: a report on a ChatGPT or
 * Claude data export, made on this machine.
 *
 *   npx @deliverd/screen history ~/Downloads/chatgpt-export.zip
 *
 * Both assistants let you download everything you have said to them
 * (ChatGPT: Settings → Data controls → Export data; Claude: Settings →
 * Privacy → Export data). The export holds a `conversations.json`. This reads
 * it, screens your own messages with the same detectors as `screen()`, and
 * reports how many email addresses, card numbers, keys and the rest went in,
 * and in which conversations. It never prints a value it found.
 *
 * Pure: no file system and no network here, so the same code can run in a
 * browser on a file dropped into the page. `readExport` in `history-file.ts`
 * opens the file in Node.
 */

import { describeCounts, screenText, summarise, type DataKind, type ScreenCounts, type ScreenTerm } from "./data-screen.js";

export interface HistoryMessage {
  role: "user" | "assistant" | "other";
  text: string;
}

export interface HistoryConversation {
  title: string;
  /** ISO date, when the export says. */
  created: string | null;
  messages: HistoryMessage[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const isoFrom = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

const roleOf = (r: unknown): HistoryMessage["role"] => (r === "user" || r === "human" ? "user" : r === "assistant" ? "assistant" : "other");

/** One ChatGPT conversation: messages live in a tree under `mapping`, in creation order. */
function fromChatGpt(c: Record<string, unknown>): HistoryConversation {
  const nodes = Object.values((c.mapping ?? {}) as Record<string, { message?: Record<string, unknown> | null }>);
  const messages = nodes
    .map((n) => n.message)
    .filter((m): m is Record<string, unknown> => !!m)
    .map((m) => {
      const content = (m.content ?? {}) as { parts?: unknown[]; text?: unknown };
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const text = [...parts.map((p) => (typeof p === "string" ? p : str((p as { text?: unknown })?.text))), str(content.text)].filter(Boolean).join("\n");
      return { at: typeof m.create_time === "number" ? m.create_time : 0, role: roleOf((m.author as { role?: unknown })?.role), text };
    })
    .filter((m) => m.text)
    .sort((a, b) => a.at - b.at)
    .map(({ role, text }) => ({ role, text }));
  return { title: str(c.title) || "Untitled", created: isoFrom(c.create_time), messages };
}

/** One Claude conversation: `chat_messages`, each with `text` or `content` blocks. */
function fromClaude(c: Record<string, unknown>): HistoryConversation {
  const raw = Array.isArray(c.chat_messages) ? (c.chat_messages as Record<string, unknown>[]) : [];
  const messages = raw
    .map((m) => {
      const blocks = Array.isArray(m.content) ? (m.content as { type?: unknown; text?: unknown }[]) : [];
      const fromBlocks = blocks.filter((b) => b?.type === "text").map((b) => str(b.text)).filter(Boolean).join("\n");
      const files = Array.isArray(m.attachments) ? (m.attachments as { extracted_content?: unknown }[]).map((a) => str(a?.extracted_content)).filter(Boolean) : [];
      return { role: roleOf(m.sender), text: [fromBlocks || str(m.text), ...files].filter(Boolean).join("\n") };
    })
    .filter((m) => m.text);
  return { title: str(c.name) || "Untitled", created: isoFrom(c.created_at), messages };
}

/** The conversations in a parsed `conversations.json` from ChatGPT or Claude. */
export function parseExport(json: unknown): HistoryConversation[] {
  const list = Array.isArray(json) ? json : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ("mapping" in c ? fromChatGpt(c) : "chat_messages" in c ? fromClaude(c) : null))
    .filter((c): c is HistoryConversation => c !== null);
}

export interface HistoryFinding {
  title: string;
  created: string | null;
  counts: ScreenCounts;
}

export interface HistoryReport {
  conversations: number;
  /** Messages read: yours, unless `assistant` was asked for too. */
  messages: number;
  /** Conversations with anything found. */
  withFindings: number;
  /** Totals across everything read. */
  counts: ScreenCounts;
  /** The conversations with the most found, most first. */
  top: HistoryFinding[];
  /** "12 email addresses, 3 payment card numbers and 1 secret or credential". */
  summary: string;
}

export interface HistoryOptions {
  /** Read the assistant's answers too. Default false: what you sent is the question. */
  assistant?: boolean;
  terms?: readonly ScreenTerm[];
  /** How many conversations to list. Default 10. */
  top?: number;
}

/** Screen an export's conversations and count what was found. Values are never kept. */
export function scanHistory(conversations: readonly HistoryConversation[], options: HistoryOptions = {}): HistoryReport {
  const totals: Partial<Record<DataKind, number>> = {};
  const found: HistoryFinding[] = [];
  let messages = 0;
  for (const c of conversations) {
    const counts: Partial<Record<DataKind, number>> = {};
    for (const m of c.messages) {
      if (m.role !== "user" && !(options.assistant && m.role === "assistant")) continue;
      messages++;
      for (const [k, n] of Object.entries(summarise(screenText(m.text, options.terms ?? []))) as [DataKind, number][]) {
        counts[k] = (counts[k] ?? 0) + n;
        totals[k] = (totals[k] ?? 0) + n;
      }
    }
    if (Object.keys(counts).length > 0) found.push({ title: c.title, created: c.created, counts });
  }
  const size = (f: HistoryFinding) => Object.values(f.counts).reduce((a, n) => a + (n ?? 0), 0);
  found.sort((a, b) => size(b) - size(a) || (b.created ?? "").localeCompare(a.created ?? ""));
  return {
    conversations: conversations.length,
    messages,
    withFindings: found.length,
    counts: totals,
    top: found.slice(0, options.top ?? 10),
    summary: describeCounts(totals),
  };
}

/** The report as text for a terminal. Titles and counts, never values. */
export function formatHistoryReport(r: HistoryReport): string {
  const lines = [
    `Read ${r.messages} of your messages in ${r.conversations} conversations.`,
    r.withFindings === 0
      ? "Nothing found. (A net, not a guarantee: names are not found unless you add --names.)"
      : `Found ${r.summary}, in ${r.withFindings} conversation${r.withFindings === 1 ? "" : "s"}.`,
  ];
  if (r.top.length > 0) {
    lines.push("", "Where most of it was:");
    for (const f of r.top) lines.push(`  ${f.created ? f.created.slice(0, 10) + "  " : ""}${f.title}: ${describeCounts(f.counts)}`);
    lines.push(
      "",
      "Nothing was sent anywhere, and no value was printed. Before the next one, screen the prompt first:",
      "https://deliverd.dev/screen"
    );
  }
  return lines.join("\n");
}
