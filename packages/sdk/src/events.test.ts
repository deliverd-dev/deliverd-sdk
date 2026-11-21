import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/** A fake API: an events log and one approval, answered the way the server does. */
function fakeApi(options: { events?: boolean; decideAfterPolls?: number; status?: string } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const approval = { id: "a1", status: "pending" };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/v1/events/poll") {
      if (options.events === false) return json({ error: { code: "not_found", message: "Not found" } }, 404);
      const body = JSON.parse(String(init?.body)) as { cursor: string | null };
      if (body.cursor === null) return json({ events: [], cursor: "c0", truncated: false, hasMore: false, nextPollMs: 1 });
      polls++;
      if (polls >= (options.decideAfterPolls ?? 1)) {
        approval.status = options.status ?? "approved";
        return json({
          events: [{ eventId: "evt_9", name: "approval.decided", timestamp: "2026-11-21T12:00:00Z", data: { approvalId: "a1", status: approval.status }, cursor: null }],
          cursor: "c1",
          truncated: false,
          hasMore: false,
          nextPollMs: 1,
        });
      }
      return json({ events: [], cursor: `c${polls}`, truncated: false, hasMore: false, nextPollMs: 1 });
    }
    if (url.pathname === "/api/v1/approvals/a1") {
      if (options.events === false && ++polls >= (options.decideAfterPolls ?? 1)) approval.status = options.status ?? "approved";
      return json(approval);
    }
    if (url.pathname === "/api/v1/events") return json({ events: [{ name: "approval.decided", delivery: ["poll", "webhook"] }] });
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  };
  return { fetch, calls };
}

describe("deliverd.events", () => {
  it("waits for a decision on the event, not by reading the approval again and again", async () => {
    const api = fakeApi({ decideAfterPolls: 3 });
    const deliverd = new Deliverd({ apiKey: "dlv_test", fetch: api.fetch, maxRetries: 1 });
    const decided = await deliverd.events.waitForDecision({ approvalId: "a1" }, { minPollMs: 0 });
    expect(decided).toMatchObject({ status: "approved", via: "event" });
    // One read of the approval, to catch a decision made before the cursor started; the rest are polls.
    expect(api.calls.filter((c) => c === "GET /api/v1/approvals/a1")).toHaveLength(1);
    expect(api.calls.filter((c) => c === "POST /api/v1/events/poll").length).toBeGreaterThanOrEqual(4);
  });

  it("falls back to reading the approval on a server without events", async () => {
    const api = fakeApi({ events: false, decideAfterPolls: 2, status: "rejected" });
    const deliverd = new Deliverd({ apiKey: "dlv_test", fetch: api.fetch, maxRetries: 1 });
    const decided = await deliverd.events.waitForDecision({ approvalId: "a1" }, { minPollMs: 0 });
    expect(decided).toMatchObject({ status: "rejected", via: "read" });
  }, 20_000);

  it("lists what the key can hear and polls from now with a null cursor", async () => {
    const api = fakeApi();
    const deliverd = new Deliverd({ apiKey: "dlv_test", fetch: api.fetch, maxRetries: 1 });
    expect((await deliverd.events.list()).map((e) => e.name)).toEqual(["approval.decided"]);
    const first = await deliverd.events.poll({ name: "approval.decided", arguments: { id: "a1" } });
    expect(first).toMatchObject({ events: [], cursor: "c0" });
  });

  it("times out instead of waiting for ever", async () => {
    const api = fakeApi({ decideAfterPolls: 1_000_000 });
    const deliverd = new Deliverd({ apiKey: "dlv_test", fetch: api.fetch, maxRetries: 1 });
    await expect(deliverd.events.waitForDecision({ approvalId: "a1" }, { timeout: 50, minPollMs: 5 })).rejects.toMatchObject({ code: "timeout" });
  });
});
