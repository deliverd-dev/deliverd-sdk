import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main } from "./cli-main.js";
import { fileInZip, readExport } from "./history-file.js";
import { formatHistoryReport, parseExport, scanHistory } from "./history.js";

const chatgpt = [
  {
    title: "Refund email",
    create_time: 1_730_000_000,
    mapping: {
      a: { message: { create_time: 2, author: { role: "assistant" }, content: { parts: ["Write to bob@example.com"] } } },
      b: { message: { create_time: 1, author: { role: "user" }, content: { parts: ["Draft a refund to mary@example.ie for card 4111 1111 1111 1111"] } } },
      root: { message: null },
    },
  },
  { title: "Holiday", create_time: 1_730_100_000, mapping: { c: { message: { author: { role: "user" }, content: { parts: ["Ideas for Lisbon"] } } } } },
];

const claude = [
  {
    name: "Debug the deploy",
    created_at: "2026-11-01T10:00:00Z",
    chat_messages: [
      { sender: "human", text: "", content: [{ type: "text", text: "It fails with postgres://admin:hunter2@db/prod" }] },
      { sender: "assistant", text: "Rotate that password." },
    ],
  },
];

/** A zip holding one stored and one deflated file, made by hand: no zip library needed. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe("history: what was already pasted into an assistant", () => {
  it("reads ChatGPT and Claude exports, in message order", () => {
    const [refund] = parseExport(chatgpt);
    expect(refund!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [debug] = parseExport(claude);
    expect(debug!.title).toBe("Debug the deploy");
    expect(debug!.messages[0]!.text).toContain("postgres://");
  });

  it("counts what you sent, not what the assistant said, unless asked", () => {
    const r = scanHistory(parseExport([...chatgpt, ...claude]));
    expect(r.counts).toEqual({ email: 1, payment_card: 1, secret: 1 });
    expect(r.withFindings).toBe(2);
    expect(r.top[0]!.title).toBe("Refund email");
    expect(scanHistory(parseExport(chatgpt), { assistant: true }).counts.email).toBe(2);
  });

  it("never prints a value it found", () => {
    const text = formatHistoryReport(scanHistory(parseExport([...chatgpt, ...claude])));
    expect(text).toMatch(/Found 1 email address, 1 payment card number and 1 secret or credential, in 2 conversations/);
    for (const v of ["mary@example.ie", "4111", "hunter2"]) expect(text).not.toContain(v);
  });

  it("opens the zip as downloaded, at any depth, with nothing to install", () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-history-"));
    const zip = join(dir, "export.zip");
    writeFileSync(zip, zipOf({ "chat.html": "<html/>", "export/conversations.json": JSON.stringify(chatgpt) }));
    expect(fileInZip(Buffer.from(zipOf({ "a.txt": "hello" })), "a.txt")!.toString()).toBe("hello");
    expect(readExport(zip)).toHaveLength(2);
  });

  it("runs from the command line, and fails clearly on a file that is not an export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-history-"));
    writeFileSync(join(dir, "conversations.json"), JSON.stringify(claude));
    writeFileSync(join(dir, "other.json"), "{}");
    const out = new PassThrough();
    const err = new PassThrough();
    let printed = "";
    out.on("data", (c) => (printed += c));
    expect(await main(["history", dir, "--json"], { stdin: process.stdin, stdout: out as never, stderr: err as never })).toBe(0);
    expect(JSON.parse(printed).counts).toEqual({ secret: 1 });
    let said = "";
    err.on("data", (c) => (said += c));
    expect(await main(["history", join(dir, "other.json")], { stdin: process.stdin, stdout: out as never, stderr: err as never })).toBe(2);
    expect(said).toMatch(/No ChatGPT or Claude conversations/);
  });
});
