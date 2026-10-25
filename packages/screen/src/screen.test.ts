import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { presidio, tokenClassifier } from "./adapters.js";
import { restoringStream, ScreenBlockedError, screenMiddleware } from "./ai-sdk.js";
import { main } from "./cli-main.js";
import { assessCounts, describeCounts, redact, screenText, type DetectedSpan, type ScreenTarget } from "./data-screen.js";
import { purviewCheck, screen } from "./index.js";
import { purviewFromEnv } from "./purview-env.js";
import { handle } from "./mcp.js";
import { VERSION } from "./version.js";

interface Vectors {
  texts: { text: string; terms?: { term: string; label?: string }[]; spans?: DetectedSpan[]; findings: { kind: string; value: string }[]; redacted: string }[];
  decisions: {
    counts: Record<string, number>;
    target: ScreenTarget | null;
    termClassification?: "confidential" | "restricted";
    verdict: string;
    classification: string;
    personalData: boolean;
    offending: string[];
  }[];
  descriptions: { counts: Record<string, number>; text: string }[];
}

const VECTORS: Vectors = JSON.parse(readFileSync(new URL("../../conformance/screening.json", import.meta.url), "utf8"));

describe("the shared screening vectors", () => {
  it.each(VECTORS.texts.map((t) => [t.text, t] as const))("finds and redacts %s", (_, t) => {
    const found = screenText(t.text, t.terms ?? [], t.spans ?? []);
    expect(found.map((f) => ({ kind: f.kind, value: t.text.slice(f.start, f.end) }))).toEqual(t.findings);
    expect(redact(t.text, found).text).toBe(t.redacted);
  });

  it.each(VECTORS.decisions.map((d, i) => [i, d] as const))("decides case %i", (_, d) => {
    const a = assessCounts(d.counts, d.target, undefined, d.termClassification ?? "confidential");
    expect({ verdict: a.verdict, classification: a.classification, personalData: a.personalData, offending: a.offending }).toEqual({
      verdict: d.verdict,
      classification: d.classification,
      personalData: d.personalData,
      offending: d.offending,
    });
  });

  it.each(VECTORS.descriptions.map((d) => [d.text, d] as const))("describes counts as %s", (_, d) => {
    expect(describeCounts(d.counts)).toBe(d.text);
  });
});

describe("screen()", () => {
  it("allows text with nothing in it, as it is", async () => {
    const s = await screen("Summarise the quarterly plan");
    expect(s).toMatchObject({ verdict: "allow", allowed: true, text: "Summarise the quarterly plan", reasons: [] });
  });

  it("redacts personal data by default and puts it back in the answer", async () => {
    const s = await screen("Reply to mary@example.ie about the renewal");
    expect(s.verdict).toBe("redact");
    expect(s.text).toBe("Reply to [EMAIL_1] about the renewal");
    expect(s.counts).toEqual({ email: 1 });
    expect(s.restore("Sent to [EMAIL_1].")).toBe("Sent to mary@example.ie.");
  });

  it("sends personal data to a model allowed it", async () => {
    const s = await screen("Reply to mary@example.ie", { allow: { personalData: true, classification: "confidential" } });
    expect(s).toMatchObject({ verdict: "allow", text: "Reply to mary@example.ie" });
  });

  it("denies secrets, whatever the model may receive", async () => {
    const s = await screen("key sk-ant-abcdefghijklmnopqrstuvwxyz0123", { allow: { personalData: true, classification: "restricted" } });
    expect(s).toMatchObject({ verdict: "deny", allowed: false, text: null, redacted: null });
  });

  it("cannot say yes to an ask, and says who can", async () => {
    const s = await screen("Her diagnosis came back on Friday");
    expect(s).toMatchObject({ verdict: "ask", allowed: false, text: null });
    expect(s.reasons.at(-1)).toMatch(/Data Gate/);
  });

  it("uses a plugged-in detector for names", async () => {
    const names = (text: string) => [...text.matchAll(/Mary Byrne/g)].map((m) => ({ kind: "person_name" as const, start: m.index!, end: m.index! + 10 }));
    const s = await screen("Mary Byrne called; ring Mary Byrne back", { detectors: [names] });
    expect(s.text).toBe("[NAME_1] called; ring [NAME_1] back");
  });
});

describe("adapters", () => {
  it("joins a token classifier's pieces into one name, with or without offsets", async () => {
    const text = "Ring Mary Byrne today";
    const withOffsets = tokenClassifier(() => [
      { entity: "B-PER", start: 5, end: 9, score: 0.99 },
      { entity: "I-PER", start: 10, end: 15, score: 0.98 },
      { entity: "B-MISC", start: 16, end: 21, score: 0.9 },
    ]);
    const wordsOnly = tokenClassifier(() => [
      { entity: "B-PER", word: "Mary", score: 0.99 },
      { entity: "I-PER", word: "Byrne", score: 0.99 },
    ]);
    const unsure = tokenClassifier(() => [{ entity_group: "PER", start: 5, end: 15, score: 0.2 }]);
    expect(await withOffsets(text)).toEqual([{ kind: "person_name", start: 5, end: 15 }]);
    expect(await wordsOnly(text)).toEqual([{ kind: "person_name", start: 5, end: 15 }]);
    expect(await unsure(text)).toEqual([]);
  });

  it("reads a Presidio analyzer", async () => {
    const bodies: unknown[] = [];
    const detect = presidio({
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify([
          { entity_type: "PERSON", start: 0, end: 4, score: 0.85 },
          { entity_type: "LOCATION", start: 8, end: 14, score: 0.9 },
        ]));
      }) as typeof globalThis.fetch,
    });
    expect(await detect("Mary in Dublin")).toEqual([{ kind: "person_name", start: 0, end: 4 }]);
    expect(bodies[0]).toMatchObject({ text: "Mary in Dublin", language: "en" });
  });
});

describe("the AI SDK middleware", () => {
  const params = (texts: string[]) => ({
    prompt: [
      { role: "system", content: "You draft replies." },
      ...texts.map((t) => ({ role: "user", content: [{ type: "text", text: t }] })),
    ],
  });

  it("screens the conversation as one, so a value has one placeholder throughout", async () => {
    const mw = screenMiddleware();
    const out = await mw.transformParams({ type: "generate", params: params(["From mary@example.ie", "and cc mary@example.ie, joe@example.ie"]) });
    const texts = out.prompt.slice(1).map((m) => (m.content as { text: string }[])[0]!.text);
    expect(texts).toEqual(["From [EMAIL_1]", "and cc [EMAIL_1], [EMAIL_2]"]);
    const result = await mw.wrapGenerate({ doGenerate: async () => ({ content: [{ type: "text", text: "Done: [EMAIL_2]" }] }), params: out });
    expect(result.content[0]!.text).toBe("Done: joe@example.ie");
  });

  it("passes clean text through untouched", async () => {
    const p = params(["Plan the offsite"]);
    expect(await screenMiddleware().transformParams({ type: "generate", params: p })).toBe(p);
  });

  it("does not call the model on a deny", async () => {
    await expect(screenMiddleware().transformParams({ type: "stream", params: params(["ghp_" + "a".repeat(36)]) })).rejects.toBeInstanceOf(ScreenBlockedError);
  });

  it("restores a placeholder split across streamed deltas", async () => {
    const parts = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Sent to [EMA" },
      { type: "text-delta", id: "t", delta: "IL_1] and [" },
      { type: "text-delta", id: "t", delta: "x]" },
      { type: "text-end", id: "t" },
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    }).pipeThrough(restoringStream({ "[EMAIL_1]": "mary@example.ie" }));
    let text = "";
    for await (const p of stream as unknown as AsyncIterable<{ type: string; delta?: string }>) if (p.type === "text-delta") text += p.delta;
    expect(text).toBe("Sent to mary@example.ie and [x]");
  });
});

describe("the CLI", () => {
  const run = async (args: string[], input = "") => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (d) => (out += d));
    stderr.on("data", (d) => (err += d));
    stdin.end(input);
    const code = await main(args, { stdin: stdin as unknown as typeof process.stdin, stdout: stdout as unknown as typeof process.stdout, stderr: stderr as unknown as typeof process.stderr });
    return { code, out, err };
  };

  it("redacts standard input", async () => {
    expect(await run(["--redact"], "Ring +353 87 123 4567")).toMatchObject({ code: 0, out: "Ring [PHONE_1]" });
  });

  it("fails a hook when something is found, and never prints a value", async () => {
    const r = await run(["--fail", "--json"], "mary@example.ie");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("mary");
    expect(JSON.parse(r.out)).toMatchObject({ counts: { email: 1 } });
  });

  it("passes when nothing is found", async () => {
    expect((await run(["--fail"], "nothing here")).code).toBe(0);
  });
});

describe("the MCP server", () => {
  it("lists and runs screen_text, without the values it replaced", async () => {
    const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["screen_text"]);
    const call = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "screen_text", arguments: { text: "Email mary@example.ie" } } })) as {
      result: { structuredContent: { verdict: string; text: string } };
    };
    expect(call.result.structuredContent).toMatchObject({ verdict: "redact", text: "Email [EMAIL_1]" });
    expect(JSON.stringify(call)).not.toContain("mary");
  });

  it("answers no notification", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});

it("reports the version in package.json", () => {
  expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

describe("Microsoft Purview", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const APP = { name: "Test", entraAppId: "11111111-2222-3333-4444-555555555555" };
  const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("denies what Purview blocks, even a text it would otherwise allow", async () => {
    const purview = purviewCheck({ token: "t", userId: USER, app: APP, fetch: async () => ok({ policyActions: [{ restrictionAction: "block" }] }) });
    const checked = await screen("Summarise the board pack.", { purview });
    expect(checked.verdict).toBe("deny");
    expect(checked.allowed).toBe(false);
    expect(checked.text).toBeNull();
    expect(checked.purview?.restriction).toBe("block");
    expect(checked.reasons.join(" ")).toMatch(/Purview policy blocks/);
  });

  it("treats a warn as an ask, which nobody here can answer", async () => {
    const purview = purviewCheck({ token: "t", app: APP, fetch: async () => ok({ policyActions: [{ restrictionAction: "warn" }] }) });
    const checked = await screen("Summarise the board pack.", { purview });
    expect(checked.verdict).toBe("ask");
    expect(checked.allowed).toBe(false);
    expect(checked.redacted).toBe("Summarise the board pack.");
  });

  it("changes nothing when Purview has nothing to say", async () => {
    const purview = purviewCheck({ token: "t", app: APP, fetch: async () => ok({ policyActions: [] }) });
    const checked = await screen("Summarise the board pack.", { purview });
    expect(checked.verdict).toBe("allow");
    expect(checked.text).toBe("Summarise the board pack.");
  });

  it("is off, and sends nothing, unless every variable is set", async () => {
    expect(purviewFromEnv({})).toBeNull();
    expect(() => purviewFromEnv({ DELIVERD_PURVIEW_TENANT_ID: "x" })).toThrow(/missing/);
  });

  it("takes a token as the app itself, once, and asks for the configured person", async () => {
    const calls: string[] = [];
    const doFetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("login.microsoftonline.com")) return ok({ access_token: "app-token", expires_in: 3600 });
      return ok({ policyActions: [{ restrictionAction: "audit" }] });
    }) as unknown as typeof fetch;
    const purview = purviewFromEnv(
      {
        DELIVERD_PURVIEW_TENANT_ID: "99999999-8888-7777-6666-555555555555",
        DELIVERD_PURVIEW_CLIENT_ID: APP.entraAppId,
        DELIVERD_PURVIEW_CLIENT_SECRET: "s",
        DELIVERD_PURVIEW_USER_ID: USER,
      },
      doFetch
    )!;
    expect((await purview("a")).restriction).toBe("audit");
    await purview("b");
    expect(calls.filter((u) => u.includes("login.microsoftonline.com"))).toHaveLength(1);
    expect(calls[1]).toContain(`/users/${USER}/dataSecurityAndGovernance/processContent`);
  });
});
