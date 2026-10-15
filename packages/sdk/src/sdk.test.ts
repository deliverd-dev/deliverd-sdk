import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Deliverd } from "./index.js";
import { DeliverdError, DeliverdTimeoutError } from "./errors.js";
import { constructEvent, verifySignature } from "./webhooks.js";
import type { ApprovalData } from "./types.js";

/**
 * The SDK is the one piece of this product that runs on somebody else's
 * machine, inside their agent, where a bug is a support ticket rather than a
 * deploy. So these are behavioural: a fake transport stands in for the API and
 * every test drives the real client through it.
 */

function approval(over: Partial<ApprovalData> = {}): ApprovalData {
  return {
    id: "apr_1",
    status: "pending",
    url: "https://deliverd.dev/approve/apr_1",
    title: "Deploy release 8.2",
    description: null,
    risk: "high",
    factors: [],
    links: [],
    reportId: null,
    externalId: null,
    metadata: {},
    requestedBy: "Deployment agent",
    approvers: ["u1"],
    decidedBy: null,
    decidedAt: null,
    note: null,
    expiresAt: null,
    questions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A transport that answers from a script and records what it was asked. */
function transport(script: (call: Call, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
      ),
    };
    calls.push(call);
    const { status = 200, json = {}, headers = {} } = script(call, calls.length);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new Deliverd({ apiKey: "dlv_test", fetch: fetchImpl, ...over });
}

describe("the client", () => {
  it("refuses to be built without a key, rather than 401ing later", () => {
    // The message is the human one: what happened, then what to do about it.
    expect(() => new Deliverd({ apiKey: "", mode: "live" })).toThrow(/No API key/);
  });

  it("sends the key as a bearer token against the documented host", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: approval() }));
    await client(fetchImpl).approvals.get("apr_1");
    expect(calls[0]!.path).toBe("/api/v1/approvals/apr_1");
    expect(calls[0]!.headers.Authorization).toBe("Bearer dlv_test");
  });

  it("turns the API's error envelope into a typed error", async () => {
    const { fetchImpl } = transport(() => ({
      status: 403,
      json: { error: { code: "self_approval", message: "You cannot approve your own request.", details: { who: "u1" } } },
    }));
    const err = await client(fetchImpl).approvals.get("apr_1").catch((e) => e);
    expect(err).toBeInstanceOf(DeliverdError);
    expect(err.code).toBe("self_approval");
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ who: "u1" });
    expect(err.isAuth).toBe(true);
  });

  it("retries a 429 and honours Retry-After", async () => {
    const { calls, fetchImpl } = transport((_call, n) =>
      n === 1
        ? { status: 429, json: { error: { code: "rate_limited", message: "Slow down." } }, headers: { "retry-after": "0" } }
        : { json: approval() }
    );
    const result = await client(fetchImpl).approvals.get("apr_1");
    expect(calls).toHaveLength(2);
    expect(result.id).toBe("apr_1");
  });

  it("does not retry a 4xx that will be just as wrong next time", async () => {
    const { calls, fetchImpl } = transport(() => ({
      status: 400,
      json: { error: { code: "unknown_approver", message: "Not a member." } },
    }));
    await expect(
      client(fetchImpl).approvals.create({ title: "x", approvers: ["nobody@example.invalid"] })
    ).rejects.toThrow(/No approver could be found/);
    expect(calls).toHaveLength(1);
  });
});

describe("asking a person", () => {
  it("creates the request and hands back the page the approver decides on", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: approval() }));
    const a = await client(fetchImpl).approvals.create({
      title: "Deploy release 8.2",
      risk: "high",
      approvers: ["dave@example.com"],
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({ title: "Deploy release 8.2", risk: "high" });
    expect(a.url).toBe("https://deliverd.dev/approve/apr_1");
    expect(a.pending).toBe(true);
  });

  it("waits until a person decides, then reads as approved", async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = transport((_c, n) => ({
        json: n < 3 ? approval() : approval({ status: "approved", decidedBy: "u1", note: "Ship it." }),
      }));
      const a = await client(fetchImpl).approvals.create({ title: "Deploy" });
      const waiting = a.wait();
      await vi.advanceTimersByTimeAsync(60_000);
      await waiting;
      expect(a.approved).toBe(true);
      expect(a.note).toBe("Ship it.");
      // One create, then a poll per refresh — not a tight loop.
      expect(calls.length).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves rather than throwing on a no, because a refusal is an answer", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = transport(() => ({ json: approval({ status: "rejected", note: "Wait for Q4." }) }));
      const a = await client(fetchImpl).approvals.create({ title: "Deploy" });
      const waiting = a.wait();
      await vi.advanceTimersByTimeAsync(10_000);
      await waiting;
      expect(a.approved).toBe(false);
      expect(a.rejected).toBe(true);
      expect(a.note).toBe("Wait for Q4.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers the approver's question without leaving the wait", async () => {
    vi.useFakeTimers();
    try {
      const question = {
        id: "q1",
        question: "Is this supplier approved?",
        answer: null,
        askedAt: "2026-01-01T00:00:10.000Z",
        answeredAt: null,
      };
      const { calls, fetchImpl } = transport((call) => {
        if (call.method === "POST" && call.path.endsWith("/answers")) {
          return { json: approval({ questions: [{ ...question, answer: String((call.body as { answer: string }).answer) }] }) };
        }
        // Pending with an open question until it is answered, then approved.
        const answered = calls.some((c) => c.path.endsWith("/answers"));
        return {
          json: answered
            ? approval({ status: "approved", questions: [{ ...question, answer: "Yes." }] })
            : approval({ questions: [question] }),
        };
      });
      const a = await client(fetchImpl).approvals.create({ title: "Raise PO" });
      const asked: string[] = [];
      const waiting = a.wait({
        onQuestion: (q) => {
          asked.push(q.question);
          return "Yes — approved since 2024.";
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await waiting;
      expect(asked).toEqual(["Is this supplier approved?"]);
      const answer = calls.find((c) => c.path.endsWith("/answers"));
      expect(answer?.body).toMatchObject({ questionId: "q1", answer: "Yes — approved since 2024." });
      expect(a.approved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a question for a person when the handler declines it", async () => {
    vi.useFakeTimers();
    try {
      const question = { id: "q1", question: "Why?", answer: null, askedAt: "t", answeredAt: null };
      const { calls, fetchImpl } = transport((_c, n) => ({
        json: n > 3 ? approval({ status: "approved" }) : approval({ questions: [question] }),
      }));
      const a = await client(fetchImpl).approvals.create({ title: "x" });
      const waiting = a.wait({ onQuestion: () => null });
      await vi.advanceTimersByTimeAsync(60_000);
      await waiting;
      expect(calls.some((c) => c.path.endsWith("/answers"))).toBe(false);
      expect(a.approved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a timeout with the page in the message", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = transport(() => ({ json: approval() }));
      const a = await client(fetchImpl).approvals.create({ title: "Deploy release 8.2" });
      const waiting = a.wait({ timeout: 5_000 }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await waiting;
      expect(err).toBeInstanceOf(DeliverdTimeoutError);
      expect(err.message).toContain("https://deliverd.dev/approve/apr_1");
      expect(a.pending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the caller aborts", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = transport(() => ({ json: approval() }));
      const a = await client(fetchImpl).approvals.create({ title: "x" });
      const controller = new AbortController();
      const waiting = a.wait({ signal: controller.signal }).catch((e) => e);
      controller.abort();
      const err = await waiting;
      expect(err.code).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once when the request already settled", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: approval({ status: "expired" }) }));
    const a = await client(fetchImpl).approvals.get("apr_1");
    await a.wait();
    expect(a.expired).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("publishing", () => {
  it("publishes and says when a policy held it instead", async () => {
    const { calls, fetchImpl } = transport(() => ({
      status: 202,
      json: { status: "pending_approval", report: { id: "r1" }, approval: { id: "apr_9", status: "pending" } },
    }));
    const result = await client(fetchImpl).reports.publish({ title: "Q3", content: "<h1>Q3</h1>" });
    expect(calls[0]!.path).toBe("/api/v1/reports");
    expect(result.status).toBe("pending_approval");
    expect(result.approval?.id).toBe("apr_9");
  });

  it("sends the task a report is for, and the flow, on a publish and on a new version", async () => {
    const { calls, fetchImpl } = transport(() => ({ status: 201, json: { status: "published", report: { id: "r1", taskId: "t1" } } }));
    const deliverd = client(fetchImpl);
    const first = await deliverd.reports.publish({ title: "Q3 status", content: "<h1>Q3</h1>", taskId: "t1", flowId: "f1" });
    await deliverd.reports.update("q3-status", { content: "<h1>Q3, revised</h1>", taskId: "t2" });
    expect(calls[0]!.body).toMatchObject({ taskId: "t1", flowId: "f1" });
    expect(calls[1]!.path).toBe("/api/v1/reports/q3-status/versions");
    expect(calls[1]!.body).toMatchObject({ taskId: "t2" });
    expect(first.report.taskId).toBe("t1");
  });

  it("escapes a slug with a slash in it, which the product allows", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: { id: "r1" } }));
    await client(fetchImpl).reports.get("finance/weekly");
    expect(calls[0]!.path).toBe("/api/v1/reports/finance%2Fweekly");
  });
});

describe("sharing at a level", () => {
  it("sends the capability it is given", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: { granted: [] } }));
    await client(fetchImpl).reports.share("finance/weekly", ["sarah@acme.com"], { capability: "comment" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/reports/finance%2Fweekly/share" });
    expect(calls[0]!.body).toEqual({ audience: ["sarah@acme.com"], capability: "comment" });
  });

  it("sends no capability when none is given, so the body is the old one", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: { granted: [] } }));
    await client(fetchImpl).reports.share("finance/weekly", ["sarah@acme.com"]);
    expect(calls[0]!.body).toEqual({ audience: ["sarah@acme.com"] });
  });

  it("still takes a signal in third place, where it went before options existed", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = transport(() => ({ json: { granted: [] } }));
    const aborting = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return fetchImpl(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      client(aborting).reports.share("finance/weekly", ["sarah@acme.com"], controller.signal)
    ).rejects.toThrow(/abort/i);
  });
});

describe("verifying a webhook", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "approval.approved", sentAt: "t", data: { approvalId: "apr_1" } });
  const sign = (t: number, b = body, s = secret) =>
    `t=${t},v1=${createHmac("sha256", s).update(`${t}.${b}`).digest("hex")}`;

  it("accepts what the server signs", () => {
    const now = 1_700_000_000;
    expect(verifySignature(secret, body, sign(now), { now })).toBe(true);
  });

  it("refuses another secret, a changed body, an old timestamp and a missing header", () => {
    const now = 1_700_000_000;
    expect(verifySignature("wrong", body, sign(now), { now })).toBe(false);
    expect(verifySignature(secret, `${body} `, sign(now), { now })).toBe(false);
    expect(verifySignature(secret, body, sign(now - 3600), { now })).toBe(false);
    expect(verifySignature(secret, body, null, { now })).toBe(false);
    expect(verifySignature(secret, body, "garbage", { now })).toBe(false);
  });

  it("parses a verified body and throws on one that does not verify", () => {
    const now = 1_700_000_000;
    const event = constructEvent(secret, body, sign(now), { now });
    expect(event.event).toBe("approval.approved");
    expect(() => constructEvent(secret, body, sign(now, body, "wrong"), { now })).toThrow(/signature did not verify/);
  });
});
