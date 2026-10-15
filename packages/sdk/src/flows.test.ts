import { beforeEach, describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/**
 * The flow handle, driven the way the readme writes it.
 *
 * Behavioural rather than source-level because the whole claim is about what
 * the handle *does* to a call passing through it: a `flowId` a caller never
 * types cannot be checked by reading, only by watching one arrive.
 */

const quiet = { log: false } as const;

beforeEach(() => {
  delete process.env.DELIVERD_API_KEY;
  delete process.env.DELIVERD_MODE;
  delete process.env.DELIVERD_DEV_OUTCOME;
});

describe("deliverd.flows", () => {
  it("starts open, empty, and not settled", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Q3 close" });
    expect(flow.open).toBe(true);
    expect(flow.title).toBe("Q3 close");
    expect(flow.url).toContain(flow.id);
    /*
     * An empty flow has nothing outstanding, which is true and would be read
     * as "finished" by anything branching on it. It is never settled.
     */
    expect(flow.allSettled).toBe(false);
  });

  it("carries its id into everything started through it", async () => {
    const seen: (string | undefined)[] = [];
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Q3 close" });

    // Watch the wire: the caller never types a flowId, so only the request body
    // can prove the handle put one there.
    const original = deliverd.http.request.bind(deliverd.http);
    deliverd.http.request = async (options: Parameters<typeof original>[0]) => {
      const body = options.body as { flowId?: string } | undefined;
      if (options.method === "POST" && body) seen.push(body.flowId);
      return original(options);
    };

    await flow.approve({ title: "Send the pack", risk: "low" });
    await flow.collect({
      title: "One figure first",
      respondents: ["finance@firm.example"],
      questions: [{ prompt: "Headcount", kind: "number" }],
    });
    await flow.review({
      title: "Read it",
      reportId: "00000000-0000-0000-0000-000000000000",
      reviewers: ["partner@firm.example"],
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(
      seen.every((id) => id === flow.id),
      "Something started through the flow went out without its flowId, so that step is missing from the history."
    ).toBe(true);
  });

  it("closes, and refuses to close twice", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Q3 close" });
    await flow.close();
    expect(flow.complete).toBe(true);
    expect(flow.open).toBe(false);
    /*
     * A second ending is refused rather than emitted. A subscriber cannot tell
     * a duplicate `flow.completed` from a real second one.
     */
    await expect(flow.close()).rejects.toThrow(/already complete/i);
  });

  it("cancels without cancelling what is inside it", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Abandoned" });
    await flow.cancel();
    expect(flow.cancelled).toBe(true);
    expect(flow.complete).toBe(false);
  });

  it("resumes the flow for a reference instead of starting a second", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const first = await deliverd.flows.resume({ title: "Q3 close", externalId: "q3_2026" });
    const again = await deliverd.flows.resume({ title: "Q3 close", externalId: "q3_2026" });
    expect(again.id, "A restarted agent started a second flow for the same job.").toBe(first.id);
  });

  it("starts a new one when the last flow for that reference is closed", async () => {
    // Otherwise next quarter's work lands on last quarter's timeline.
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const first = await deliverd.flows.resume({ title: "Q3 close", externalId: "close" });
    await first.close();
    const next = await deliverd.flows.resume({ title: "Q4 close", externalId: "close" });
    expect(next.id).not.toBe(first.id);
    expect(next.open).toBe(true);
  });

  it("finds nothing for a reference that was never used", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    expect(await deliverd.flows.findByExternalId("never")).toBeNull();
  });
});

describe("evidence", () => {
  it("comes back from the flow you are holding", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Q3 close" });
    const pack = await flow.evidence();
    expect(pack.subject.kind).toBe("flow");
    expect(pack.subject.id).toBe(flow.id);
    expect(pack.subject.title).toBe("Q3 close");
  });

  it("is reachable for a report as well as a flow", async () => {
    // The subject an auditor names, and the one that works for work done
    // before flows existed.
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const pack = await deliverd.reports.evidence("rep_1");
    expect(pack.subject.kind).toBe("report");
  });

  it("says what its digest does not cover, not only what it does", async () => {
    /*
     * The sentence is the feature. A pack carrying a hash and no qualification
     * is a pack that reads as proof the records cannot have been changed,
     * which is not what it is.
     */
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const flow = await deliverd.flows.create({ title: "Q3 close" });
    const { integrity } = await flow.evidence();
    expect(integrity.covers.length, "The pack no longer says what the digest covers.").toBeGreaterThan(20);
    expect(
      integrity.doesNotCover.length,
      "The pack no longer says what the digest does not cover."
    ).toBeGreaterThan(20);
  });
});
