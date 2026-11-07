import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decisionInputHash, DECISION_TOKEN_CONTEXT } from "./decision-token.js";
import { checkDecision, memoryReplayGuard, requireDecision } from "./verify.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ISS = "https://deliverd.example";
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

function token(overrides: Record<string, unknown> = {}, input: unknown = { amount: 1200, currency: "GBP" }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: 1, kid: "k", iss: ISS, org: "o", gate: "g", action: "finance.refund", input: decisionInputHash(input), dest: null, artifact: null, iat: now, exp: now + 600, agent: "agent-1", jti: `j-${Math.random()}`, ...overrides };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = sign(null, Buffer.from(DECISION_TOKEN_CONTEXT + payload), privateKey).toString("base64url");
  return `dlv_dt1.${payload}.${sig}`;
}

const req = (t: string | null, body: Record<string, unknown> = { amount: 1200, currency: "GBP" }) =>
  new Request("https://svc.example/refunds", { method: "POST", headers: t ? { "Deliverd-Decision": t } : {}, body: JSON.stringify(body) });

const options = (extra = {}) => ({
  key: { publicKey: pem, issuer: ISS },
  action: "finance.refund",
  input: async (r: Request) => (await r.clone().json()) as unknown,
  ...extra,
});

describe("checking a decision where the action happens", () => {
  it("lets through exactly what was agreed", async () => {
    expect(await checkDecision(req(token()), options())).toBeNull();
  });

  it("refuses a missing token, a different amount, another agent and another action", async () => {
    expect((await checkDecision(req(null), options()))!.status).toBe(403);
    const changed = await checkDecision(req(token(), { amount: 1240, currency: "GBP" }), options());
    expect(await changed!.json()).toMatchObject({ reason: "input_mismatch" });
    const other = await checkDecision(req(token()), options({ agent: "agent-2" }));
    expect(await other!.json()).toMatchObject({ reason: "wrong_agent" });
    expect(await (await checkDecision(req(token({ action: "finance.payout" })), options()))!.json()).toMatchObject({ reason: "wrong_action" });
  });

  it("refuses the same token twice with a replay guard, and a token with no id", async () => {
    const replay = memoryReplayGuard();
    const t = token();
    expect(await checkDecision(req(t), options({ replay }))).toBeNull();
    expect(await (await checkDecision(req(t), options({ replay })))!.json()).toMatchObject({ reason: "replayed" });
    expect(await (await checkDecision(req(token({ jti: undefined })), options({ replay })))!.json()).toMatchObject({ reason: "replayed" });
  });

  it("works as Express middleware and reads Authorization: Deliverd", async () => {
    const mw = requireDecision<{ headers: Record<string, string>; body: unknown }>({ key: { publicKey: pem, issuer: ISS }, action: "finance.refund", input: (r) => r.body });
    let nextCalled = false;
    let status = 0;
    const res = { status(code: number) { status = code; return res; }, json() {} };
    await mw({ headers: { authorization: `Deliverd ${token()}` }, body: { amount: 1200, currency: "GBP" } }, res, () => (nextCalled = true));
    expect(nextCalled).toBe(true);
    nextCalled = false;
    await mw({ headers: {}, body: {} }, res, () => (nextCalled = true));
    expect(nextCalled).toBe(false);
    expect(status).toBe(403);
  });
});
