import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deliverd, DEFAULT_EXPIRY } from "./index.js";
import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import { durationMs } from "./duration.js";

/**
 * The mission's test: could a developer discover this through autocomplete
 * and use it without opening the documentation?
 *
 * These drive the five-line integration exactly as it is written on the
 * package's front page, in development mode — which means they also prove
 * development mode itself, since it is the same code path a real key takes,
 * with the network swapped out.
 */

const quiet = { log: false } as const;

beforeEach(() => {
  delete process.env.DELIVERD_API_KEY;
  delete process.env.DELIVERD_MODE;
  delete process.env.DELIVERD_DEV_OUTCOME;
});
afterEach(() => vi.restoreAllMocks());

describe("the five lines on the front page", () => {
  it("runs with no key, no network and no colleague", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const decision = await deliverd.approve({ title: "Deploy to production" });
    expect(decision.approved).toBe(true);
    expect(decision.status).toBe("approved");
    expect(decision.url).toMatch(/^https:\/\/deliverd\.dev\/approve\//);
  });

  it("takes the key from the environment with no arguments at all", async () => {
    process.env.DELIVERD_API_KEY = "dlv_from_env";
    const calls: string[] = [];
    const deliverd = new Deliverd({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(String((init?.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ approvals: [] }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    });
    await deliverd.approvals.list();
    expect(calls[0]).toBe("Bearer dlv_from_env");
  });

  it("says what to do when there is no key, rather than a code", () => {
    const err = (() => {
      try {
        new Deliverd();
      } catch (e) {
        return e as DeliverdError;
      }
    })();
    expect(err).toBeInstanceOf(DeliverdError);
    expect(err!.message).toContain("No API key.");
    expect(err!.message).toContain("DELIVERD_API_KEY");
    expect(err!.message).toContain("development");
    expect(err!.hint).toBeTruthy();
  });

  it("reaches development mode from the environment too", async () => {
    process.env.DELIVERD_MODE = "development";
    const deliverd = new Deliverd({ development: quiet });
    expect(deliverd.development).toBe(true);
    expect((await deliverd.approve({ title: "x" })).approved).toBe(true);
  });
});

describe("the four things that can happen, before you have an account", () => {
  it("approved", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "approved", note: "Ship it." } });
    const decision = await deliverd.approve({ title: "Deploy" });
    expect(decision.approved).toBe(true);
    expect(decision.note).toBe("Ship it.");
    expect(decision.decidedBy).toBeTruthy();
  });

  it("rejected — and resolves, because a no is an answer", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "rejected" } });
    const decision = await deliverd.approve({ title: "Deploy" });
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("rejected");
    expect(decision.note).toContain("Not yet");
  });

  it("nobody answered", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "timeout" } });
    const err = await deliverd.approve({ title: "Deploy", timeout: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(DeliverdTimeoutError);
    expect(err.message).toContain("Deploy");
  });

  it("they asked a question, and the handler answers it", async () => {
    const deliverd = new Deliverd({
      mode: "development",
      development: { ...quiet, outcome: "question", question: "Has this been through staging?" },
    });
    const asked: string[] = [];
    const decision = await deliverd.approve({
      title: "Deploy",
      onQuestion: (q) => {
        asked.push(q.question);
        return "Yes, staged on Tuesday.";
      },
    });
    expect(asked).toEqual(["Has this been through staging?"]);
    expect(decision.approved).toBe(true);
  });

  it("a question with no handler ends the wait rather than hanging a test", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "question" } });
    const err = await deliverd.approve({ title: "Deploy", timeout: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(DeliverdTimeoutError);
  });

  it("gives up quickly enough in development to report its own failure", async () => {
    // Five seconds is what a test runner allows a whole test; a development
    // wait that took that long would lose the race and report the runner's
    // timeout instead of the useful one.
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "timeout" } });
    const started = Date.now();
    await deliverd.approve({ title: "Deploy" }).catch(() => {});
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("is driven from the command line for a whole suite at once", async () => {
    process.env.DELIVERD_DEV_OUTCOME = "rejected";
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    expect((await deliverd.approve({ title: "x" })).approved).toBe(false);
  });

  it("shows what the approver would have seen", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deliverd = new Deliverd({ mode: "development" });
    await deliverd.approve({
      title: "Refund £1,240 to Acme",
      description: "Duplicate charge on invoice 4821.",
      risk: "high",
      factors: [{ label: "Within the refund limit", status: "ok" }],
      approvers: ["finance@example.com"],
    });
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("Refund £1,240 to Acme");
    expect(printed).toContain("Duplicate charge");
    expect(printed).toContain("✓ Within the refund limit");
    expect(printed).toContain("finance@example.com");
  });

  it("refuses the rest of the API rather than pretending to serve it", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const err = await deliverd.reports.list().catch((e) => e);
    expect(err.code).toBe("not_in_development_mode");
    expect(err.message).toContain("real API key");
  });
});

describe("defaults a developer should not have to think about", () => {
  /** Captures what the SDK sent, answering approved. */
  function capture() {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const method = init?.method ?? "GET";
      if (method === "POST") bodies.push(body);
      const url = new URL(String(input));
      if (url.pathname.endsWith("/approvals") && method === "GET") {
        return new Response(JSON.stringify({ approvals: [] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          id: "apr_1",
          status: "approved",
          url: "https://deliverd.dev/approve/apr_1",
          title: "t",
          description: null,
          risk: "medium",
          factors: [],
          links: [],
          reportId: null,
          externalId: (body as { externalId?: string }).externalId ?? null,
          metadata: {},
          requestedBy: "agent",
          approvers: [],
          decidedBy: "u1",
          decidedAt: "2026-01-01T00:00:00.000Z",
          note: null,
          expiresAt: null,
          questions: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof globalThis.fetch;
    return { bodies, fetchImpl };
  }

  it("expires a request by itself, so a wait always ends", async () => {
    const { bodies, fetchImpl } = capture();
    const deliverd = new Deliverd({ apiKey: "dlv_x", fetch: fetchImpl });
    const before = Date.now();
    await deliverd.approve({ title: "Deploy" });
    const expiresAt = Date.parse(String(bodies[0]!.expiresAt));
    expect(expiresAt - before).toBeGreaterThan(durationMs(DEFAULT_EXPIRY) - 5_000);
    expect(expiresAt - before).toBeLessThan(durationMs(DEFAULT_EXPIRY) + 5_000);
  });

  it("takes a duration a person would write", async () => {
    const { bodies, fetchImpl } = capture();
    const deliverd = new Deliverd({ apiKey: "dlv_x", fetch: fetchImpl });
    const before = Date.now();
    await deliverd.approve({ title: "Deploy", expiresIn: "4h" });
    expect(Date.parse(String(bodies[0]!.expiresAt)) - before).toBeGreaterThan(durationMs("4h") - 5_000);
    expect(() => durationMs("soon" as never)).toThrow(/Use a number of milliseconds/);
  });

  it("does not ask twice when an agent restarts, given an externalId", async () => {
    const existing = {
      id: "apr_existing",
      status: "approved",
      url: "https://deliverd.dev/approve/apr_existing",
      title: "Deploy",
      description: null,
      risk: "medium",
      factors: [],
      links: [],
      reportId: null,
      externalId: "deploy_842",
      metadata: {},
      requestedBy: "agent",
      approvers: [],
      decidedBy: "u1",
      decidedAt: "t",
      note: null,
      expiresAt: null,
      questions: [],
      createdAt: "t",
    };
    const posts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST") posts.push(url.pathname);
      if (url.searchParams.get("externalId") === "deploy_842") {
        return new Response(JSON.stringify({ approvals: [existing] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(existing), { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    const deliverd = new Deliverd({ apiKey: "dlv_x", fetch: fetchImpl });
    const decision = await deliverd.approve({ title: "Deploy", externalId: "deploy_842" });
    expect(decision.id).toBe("apr_existing");
    expect(posts, "It asked again instead of reusing the request it already made.").toHaveLength(0);
  });

  it("carries one correlation id per request, for when something goes wrong", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)["deliverd-correlation-id"]!);
      return new Response(JSON.stringify({ approvals: [] }), { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const deliverd = new Deliverd({ apiKey: "dlv_x", fetch: fetchImpl });
    await deliverd.approvals.list();
    await deliverd.approvals.list();
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("confirm", () => {
  it("is a yes or no, at low ceremony", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    expect(await deliverd.confirm({ title: "Send 240 emails?" })).toBe(true);
  });

  it("asks for less time and less weight than approve, unless told", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") bodies.push(JSON.parse(String(init!.body)));
      return new Response(
        JSON.stringify({
          id: "a", status: "approved", url: "u", title: "t", description: null, risk: "low",
          factors: [], links: [], reportId: null, externalId: null, metadata: {}, requestedBy: "x",
          approvers: [], decidedBy: null, decidedAt: null, note: null, expiresAt: null,
          questions: [], createdAt: "t",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof globalThis.fetch;
    const deliverd = new Deliverd({ apiKey: "dlv_x", fetch: fetchImpl });
    const before = Date.now();
    await deliverd.confirm({ title: "Sure?" });
    expect(bodies[0]!.risk).toBe("low");
    expect(Date.parse(String(bodies[0]!.expiresAt)) - before).toBeLessThan(durationMs("2h"));
  });
});

describe("development mode serves what the primitives actually call", () => {
  /*
   * Found by writing `examples/deployment-gate`, not by reading the code.
   *
   * `approve()` with an `externalId` calls `findByExternalId` first — that is
   * the whole retry-safety story, and it is the line the docs put in front of
   * anybody wiring this into CI. It goes through `GET /approvals`, which
   * development mode did not implement: reviews, collections and flows all had
   * their list route from the start and approvals did not. So the one feature
   * that stops a restarted agent asking a person twice was the one feature you
   * could not try before signing up, and it failed with a 501 rather than
   * anything a reader could act on.
   */
  it("finds an approval by externalId without a key", async () => {
    const deliverd = new Deliverd({
      mode: "development",
      development: { outcome: "approved", log: false },
    });

    const created = await deliverd.approvals.create({
      title: "Deploy a1b2c3d",
      externalId: "deploy-a1b2c3d",
    });

    const found = await deliverd.approvals.findByExternalId("deploy-a1b2c3d");
    expect(found, "development mode cannot list approvals").not.toBeNull();
    expect(found!.data.id).toBe(created.data.id);

    // And an id nobody used comes back empty rather than throwing, because
    // that is the branch `approve()` takes on a first run.
    expect(await deliverd.approvals.findByExternalId("never-used")).toBeNull();
  });

  it("does not ask the same person twice when a run is repeated", async () => {
    // The behaviour the route exists for, end to end through `approve()`.
    const deliverd = new Deliverd({
      mode: "development",
      development: { outcome: "approved", log: false },
    });
    const first = await deliverd.approve({ title: "Deploy", externalId: "deploy-once" });
    const second = await deliverd.approve({ title: "Deploy", externalId: "deploy-once" });
    expect(second.id, "a repeated run filed a second request").toBe(first.id);
  });

  it("still refuses what it genuinely cannot simulate", () => {
    /*
     * The fix widened development mode by one route, not into a pretend
     * server. Publishing puts bytes somewhere and there is nowhere local to
     * put them, so it must keep saying so — an example that appeared to
     * publish and then did not would be worse than the refusal.
     */
    const dev = readFileSync(new URL("./dev.ts", import.meta.url), "utf8");
    expect(dev).toContain("not_in_development_mode");
    expect(dev).not.toContain('path === "/reports"');
  });
});

/**
 * What the first five minutes actually do.
 *
 * These three came out of running the product as somebody who had never seen
 * it: a clean `npm install` from the registry, the quickstart page open, and
 * the commands it gives typed as written. Everything here is something that
 * page told a newcomer to do and that did not do what the page implied.
 */
describe("the paths the quickstart sends a newcomer down", () => {
  it("says an unanswered question is why the wait ran out", async () => {
    /*
     * `DELIVERD_DEV_OUTCOME=question` is the page's own instruction, and it
     * used to end in "Nobody decided in time" — which is wrong about what
     * happened. The approver did engage; they asked something and nothing
     * answered. The two failures need different sentences because they send
     * you to different places.
     */
    const deliverd = new Deliverd({
      mode: "development",
      development: { outcome: "question", question: "Has this been through staging?" },
    });

    await expect(
      deliverd.approve({ title: "Deploy to production", timeout: 50 })
    ).rejects.toThrow(/asked a question .* nothing answered it/s);
    await expect(
      deliverd.approve({ title: "Deploy to production", timeout: 50 })
    ).rejects.toThrow(/onQuestion/);
  });

  it("still says nobody decided when nobody did", () => {
    // The other branch has to keep its own message: an approver who never
    // opened the request is a different problem from one waiting on you.
    const deliverd = new Deliverd({ mode: "development", development: { outcome: "timeout" } });
    return expect(
      deliverd.approve({ title: "Deploy to production", timeout: 50 })
    ).rejects.toThrow(/Nobody decided/);
  });

  it("gives a review that asks for changes something to read", async () => {
    /*
     * `threadCount: 0` on a changes-requested review made the one path that
     * matters print "changes requested — 0 thread(s) to read", which tells
     * somebody running it for the first time that the feature is broken. The
     * threads are the point: they are what the next draft is written from.
     */
    const deliverd = new Deliverd({ mode: "development", development: { outcome: "rejected" } });
    const outcome = await deliverd.review({
      title: "Q3 portfolio review",
      reviewers: ["partner@firm.example"],
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.threadCount, "changes requested with nothing to read").toBeGreaterThan(0);
  });

  it("leaves an approved review with nothing outstanding", () => {
    // And the opposite, so the count is a fact about the verdict rather than
    // a constant that happens to look right in one case.
    const deliverd = new Deliverd({ mode: "development", development: { outcome: "approved" } });
    return deliverd
      .review({ title: "Q3 portfolio review", reviewers: ["partner@firm.example"] })
      .then((outcome) => {
        expect(outcome.approved).toBe(true);
        expect(outcome.threadCount).toBe(0);
      });
  });
});

describe("an approver's inbox, offline", () => {
  it("lists only the requests naming that person, as the API does", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { ...quiet, outcome: "timeout" } });
    const mine = await deliverd.approvals.create({ title: "Refund £40", approvers: ["sarah@acme.example"] });
    await deliverd.approvals.create({ title: "Refund £90", approvers: ["tom@acme.example"] });
    const inbox = await deliverd.approvals.list({ approver: "Sarah@Acme.example" });
    expect(inbox.map((a) => a.id)).toEqual([mine.id]);
    expect(await deliverd.approvals.list({ approver: "nobody@acme.example" })).toEqual([]);
  });

  it("refuses a decision session rather than faking one", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const approval = await deliverd.approvals.create({ title: "Refund £40", approvers: ["sarah@acme.example"] });
    await expect(deliverd.approvals.createSession(approval.id, { approver: "sarah@acme.example" })).rejects.toMatchObject({
      code: "not_in_development_mode",
    });
  });
});
