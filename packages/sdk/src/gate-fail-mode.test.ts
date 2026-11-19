import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/**
 * `onUnavailable`: what `gate()` does when Deliverd cannot be reached. A
 * network failure or a 5xx is an outage the caller chose how to ride out; a
 * 4xx is a bug or an answer, and is never hidden.
 */

const ask = { action: "finance.refund", externalId: "refund:1", input: { amount: 10 } };
const client = (respond: () => Promise<Response>) =>
  new Deliverd({ apiKey: "dlv_test", maxRetries: 0, fetch: (async () => respond()) as typeof fetch });
const down = () => client(async () => { throw new TypeError("fetch failed"); });
const status = (code: number) => client(async () => new Response(JSON.stringify({ error: { code: code === 404 ? "not_found" : "server_error", message: "x" } }), { status: code, headers: { "content-type": "application/json" } }));

describe("gate() when Deliverd cannot be reached", () => {
  it("throws by default, as it always did", async () => {
    await expect(down().gate(ask)).rejects.toMatchObject({ status: 0 });
  });

  it("refuses with deny, and says the answer did not come from Deliverd", async () => {
    const d = await down().gate({ ...ask, onUnavailable: "deny" });
    expect(d).toMatchObject({ allowed: false, status: "denied", unavailable: true, id: "", decisionToken: null });
    expect(d.reason).toContain("onUnavailable");
  });

  it("allows with allow, with the caller's input and no token to spend", async () => {
    const d = await status(503).gate({ ...ask, onUnavailable: "allow" });
    expect(d).toMatchObject({ allowed: true, unavailable: true, input: ask.input, decisionToken: null });
  });

  it("never turns a 4xx into an answer", async () => {
    await expect(status(404).gate({ ...ask, onUnavailable: "allow" })).rejects.toMatchObject({ status: 404 });
  });

  it("never answers for a person who is still deciding", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async gate(options: GateOptions)"), src.indexOf("async confirm("));
    const caught = body.slice(body.indexOf("try {"), body.indexOf("} catch"));
    expect(caught).toContain("this.gates.create(");
    expect(caught).not.toContain(".wait(");
  });
});
