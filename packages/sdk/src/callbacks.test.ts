import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constructCallback, Deliverd, DeliverdError } from "./index.js";
import { signedPayload } from "./webhooks.js";

/**
 * Callbacks: being told when a person answers, instead of polling.
 *
 * What goes on the wire when a request names a `callbackUrl`, the secret that
 * comes back once on the handle `create()` returns, and verifying what later
 * arrives at that address.
 */

const SECRET = "dlvcb_test";
const sign = (body: string, at: number, secret = SECRET) =>
  `t=${at},v1=${createHmac("sha256", secret).update(signedPayload(at, body)).digest("hex")}`;

function recorder(response: Record<string, unknown>) {
  const sent: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const approval = { id: "apr_1", status: "pending", url: "https://app.example.test/approve/apr_1", title: "t", questions: [] };

describe("asking to be called back", () => {
  it("sends the address and keeps the secret on the handle", async () => {
    const { sent, fetchImpl } = recorder({ ...approval, callbackSecret: "dlvcb_once" });
    const deliverd = new Deliverd({ apiKey: "dlv_t", fetch: fetchImpl });
    const handle = await deliverd.approvals.create({ title: "t", callbackUrl: "https://agent.example.com/cb" });
    expect(sent[0]!.body!.callbackUrl).toBe("https://agent.example.com/cb");
    expect(handle.callbackSecret).toBe("dlvcb_once");
  });

  it("has no secret on a read", async () => {
    const { fetchImpl } = recorder(approval);
    const deliverd = new Deliverd({ apiKey: "dlv_t", fetch: fetchImpl });
    expect((await deliverd.approvals.get("apr_1")).callbackSecret).toBeNull();
  });
});

const BODY = JSON.stringify({
  event: "approval.approved",
  sentAt: "2026-09-23T08:00:00Z",
  requestType: "approval",
  requestId: "apr_1",
  data: { id: "apr_1", status: "approved" },
});

describe("receiving one", () => {
  const now = Math.floor(Date.now() / 1000);

  it("verifies and parses", () => {
    const envelope = constructCallback(SECRET, BODY, sign(BODY, now), { now });
    expect(envelope.event).toBe("approval.approved");
    expect(envelope.requestType).toBe("approval");
    expect(envelope.requestId).toBe("apr_1");
  });

  it("refuses another request's secret, and an altered body", () => {
    expect(() => constructCallback("dlvcb_other", BODY, sign(BODY, now), { now })).toThrow(DeliverdError);
    expect(() => constructCallback(SECRET, BODY.replace("approved", "rejected"), sign(BODY, now), { now })).toThrow(
      DeliverdError
    );
  });

  it("is on the client too", () => {
    const deliverd = new Deliverd({ apiKey: "dlv_t" });
    expect(deliverd.webhooks.constructCallback(SECRET, BODY, sign(BODY, now), { now }).requestId).toBe("apr_1");
  });
});
