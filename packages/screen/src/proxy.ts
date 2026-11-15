/**
 * A local screening proxy: point any tool's model address at it, and every
 * request is screened before it leaves the machine.
 *
 *   npx @deliverd/screen proxy --upstream https://api.openai.com
 *   OPENAI_BASE_URL=http://localhost:8787/v1 your-tool
 *
 * It speaks whatever the upstream speaks (OpenAI's chat completions and
 * responses, Anthropic's messages, OpenRouter, a local model server): it finds
 * the text in a JSON request (`content`, `text`, `input`, `system`,
 * `instructions`, `prompt`), screens all of it as one, and then
 *
 * - `allow`: forwards the request unchanged;
 * - `redact`: forwards it with placeholders such as `[EMAIL_1]`, and puts the
 *   values back in the answer, streamed answers included;
 * - `ask` or `deny`: forwards nothing and answers 403 with the reasons, in the
 *   error shape OpenAI and Anthropic clients both print.
 *
 * Headers, keys and everything else pass through untouched. Nothing is sent
 * anywhere but the upstream you name, and Microsoft Purview when you set the
 * `DELIVERD_PURVIEW_*` variables.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { screen, type ScreenOptions } from "./index.js";

/** Keys whose string values are text a model reads. */
const TEXT_KEYS = new Set(["content", "text", "input", "system", "instructions", "prompt"]);

/** Between texts screened as one: no detector matches across it. */
const SEPARATOR = "\n\u0000\n";

interface Slot {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Every string a model reads in a request body, where it is, in order. */
export function textSlots(body: unknown): Slot[] {
  const slots: Slot[] = [];
  const walk = (node: unknown, inText: boolean) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === "string" && inText) slots.push({ holder: node, key: i });
        else walk(v, inText);
      });
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const isText = TEXT_KEYS.has(k);
        if (typeof v === "string" && isText) slots.push({ holder: node as Record<string, unknown>, key: k });
        else walk(v, isText);
      }
    }
  };
  walk(body, false);
  return slots;
}

const read = (slot: Slot) => (slot.holder as Record<string | number, unknown>)[slot.key] as string;
const write = (slot: Slot, value: string) => {
  (slot.holder as Record<string | number, unknown>)[slot.key] = value;
};

export interface ScreenedRequest {
  verdict: "allow" | "redact" | "ask" | "deny";
  /** The body to forward, or null when nothing may be sent. */
  body: string | null;
  reasons: string[];
  replacements: Readonly<Record<string, string>>;
}

/** Screen a request body: the texts in it, as one. A body that is not JSON goes through as it is. */
export async function screenRequestBody(raw: string, options: ScreenOptions = {}): Promise<ScreenedRequest> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { verdict: "allow", body: raw, reasons: [], replacements: {} };
  }
  const slots = textSlots(body);
  if (slots.length === 0) return { verdict: "allow", body: raw, reasons: [], replacements: {} };
  const joined = slots.map(read).join(SEPARATOR);
  const checked = await screen(joined, options);
  if (!checked.allowed || checked.text === null) return { verdict: checked.verdict, body: null, reasons: checked.reasons, replacements: {} };
  if (checked.verdict === "allow") return { verdict: "allow", body: raw, reasons: [], replacements: {} };
  const parts = checked.text.split(SEPARATOR);
  if (parts.length !== slots.length) {
    // A placeholder can't swallow the separator, but never forward a body that might be wrong.
    return { verdict: "deny", body: null, reasons: ["The request could not be redacted safely, so nothing was sent."], replacements: {} };
  }
  slots.forEach((s, i) => write(s, parts[i]!));
  return { verdict: checked.verdict, body: JSON.stringify(body), reasons: checked.reasons, replacements: checked.replacements };
}

/** A value as it appears inside a JSON string. */
const jsonEscaped = (v: string) => JSON.stringify(v).slice(1, -1);

/**
 * Puts the values back in an answer, as it streams: JSON or server-sent
 * events, whose strings are JSON-escaped. A placeholder split across two
 * chunks is held until it is whole.
 */
export function restorer(replacements: Readonly<Record<string, string>>) {
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const escaped = new Map(keys.map((k) => [k, jsonEscaped(replacements[k]!)]));
  const longest = keys.reduce((n, k) => Math.max(n, k.length), 0);
  let held = "";
  const apply = (s: string) => (keys.length ? keys.reduce((out, k) => out.split(k).join(escaped.get(k)!), s) : s);
  return {
    push(chunk: string): string {
      if (keys.length === 0) return chunk;
      const text = held + chunk;
      // Hold back a tail that could be the start of a placeholder.
      const open = text.lastIndexOf("[");
      const cut = open >= 0 && text.length - open < longest && !text.slice(open).includes("]") ? open : text.length;
      held = text.slice(cut);
      return apply(text.slice(0, cut));
    },
    end(): string {
      const rest = apply(held);
      held = "";
      return rest;
    },
  };
}

export interface ProxyOptions extends ScreenOptions {
  /** Where requests go after screening, such as https://api.openai.com. */
  upstream: string;
  /** Told about each request: its path and verdict, never its text. */
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "accept-encoding"]);

async function readBody(req: IncomingMessage): Promise<string> {
  let out = "";
  for await (const chunk of req) out += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return out;
}

function refuse(res: ServerResponse, verdict: string, reasons: string[]) {
  const message = `Deliverd Screen held this request (${verdict}): ${reasons.join(" ")}`;
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "deliverd_screen_" + verdict, code: "deliverd_screen_" + verdict, message } }));
}

/** The proxy as a request handler, for a server of your own. */
export function proxyHandler(options: ProxyOptions) {
  const upstream = options.upstream.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const raw = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
      const checked = raw ? await screenRequestBody(raw, options) : { verdict: "allow" as const, body: raw, reasons: [], replacements: {} };
      options.log?.(`${req.method} ${req.url} ${checked.verdict}`);
      if (checked.body === null) return refuse(res, checked.verdict, checked.reasons);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const answer = await doFetch(upstream + (req.url ?? "/"), {
        method: req.method,
        headers,
        ...(checked.body ? { body: checked.body } : {}),
      });
      const out: Record<string, string> = {};
      answer.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k) && k !== "content-encoding") out[k] = v;
      });
      res.writeHead(answer.status, out);
      if (!answer.body) return res.end();
      const restore = restorer(checked.replacements);
      const decoder = new TextDecoder();
      const reader = answer.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(restore.push(decoder.decode(value, { stream: true })));
      }
      res.end(restore.push(decoder.decode()) + restore.end());
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "deliverd_screen_upstream", message: `Deliverd Screen could not reach ${upstream}: ${(e as Error).message}` } }));
    }
  };
}

/** Start the proxy on localhost. */
export function startProxy(options: ProxyOptions & { port?: number; host?: string }): Promise<Server> {
  const server = createServer(proxyHandler(options));
  return new Promise((resolve) => server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => resolve(server)));
}
