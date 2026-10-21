import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";
import { assessCounts, redact, screenText, type ScreenTarget } from "./data-screen.js";

/**
 * Screening, in the language the agent runs in.
 *
 * The vectors are shared with the Python SDK: the same text has to give the
 * same findings, the same redaction and the same verdict in both, or the
 * answer an organisation tested is not the one its Python agent got.
 */

interface Vectors {
  texts: { text: string; terms?: { term: string; label?: string }[]; findings: { kind: string; value: string }[]; redacted: string }[];
  decisions: {
    counts: Record<string, number>;
    target: ScreenTarget | null;
    termClassification?: "confidential" | "restricted";
    verdict: string;
    classification: string;
    personalData: boolean;
    offending: string[];
  }[];
}

const VECTORS: Vectors = JSON.parse(readFileSync(new URL("../../conformance/screening.json", import.meta.url), "utf8"));

describe("the shared screening vectors", () => {
  it.each(VECTORS.texts.map((t) => [t.text, t] as const))("finds and redacts %s", (_, t) => {
    const found = screenText(t.text, t.terms ?? []);
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
});

describe("deliverd.screen()", () => {
  const quiet = { log: false } as const;

  it("sends counts, never the text", async () => {
    const bodies: string[] = [];
    const deliverd = new Deliverd({
      apiKey: "dlv_test",
      fetch: (async (_: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({
            verdict: "redact",
            allowed: true,
            classification: "confidential",
            personalData: true,
            categories: ["personal"],
            counts: { email: 1 },
            offending: ["email"],
            reasons: ["It contains 1 email address."],
            target: null,
            findings: null,
            redactedText: null,
            approval: null,
          }),
          { headers: { "content-type": "application/json" } }
        );
      }) as typeof globalThis.fetch,
    });
    const screened = await deliverd.screen("Reply to mary@example.ie", { aiSystemId: "6f9619ff-8b86-4011-b42d-00c04fc964ff" });
    expect(bodies[0]).not.toContain("mary");
    expect(JSON.parse(bodies[0]!)).toMatchObject({ counts: { email: 1 }, aiSystemId: "6f9619ff-8b86-4011-b42d-00c04fc964ff" });
    expect(screened.allowed).toBe(true);
    expect(screened.text).toBe("Reply to [EMAIL_1]");
    expect(screened.restore("Sent to [EMAIL_1].")).toBe("Sent to mary@example.ie.");
  });

  it("allows an ordinary prompt as it is, offline", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const screened = await deliverd.screen("Summarise the board pack in three bullets.");
    expect(screened.verdict).toBe("allow");
    expect(screened.text).toBe("Summarise the board pack in three bullets.");
  });

  it("refuses a secret, offline", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const screened = await deliverd.screen("use AKIAIOSFODNN7EXAMPLE");
    expect(screened.verdict).toBe("deny");
    expect(screened.allowed).toBe(false);
    expect(screened.text).toBeNull();
  });

  it("asks a person about special-category data and sends the original once they agree, offline", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const screened = await deliverd.screen("Her diagnosis was confirmed");
    expect(screened.verdict).toBe("ask");
    expect(screened.approval?.approved).toBe(true);
    expect(screened.allowed).toBe(true);
    expect(screened.text).toBe("Her diagnosis was confirmed");
  });

  it("does not send when the person says no, offline", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "rejected" } });
    const screened = await deliverd.screen("Her diagnosis was confirmed");
    expect(screened.allowed).toBe(false);
    expect(screened.text).toBeNull();
  });
});
