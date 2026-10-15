/**
 * The behaviour this SDK shares with the Python one, read from one table.
 *
 * Everything else that compares the two packages compares *shapes* — exported
 * names, namespaces, every field of every type. Both SDKs then drifted in
 * behaviour anyway, in opposite directions, and neither was caught by any
 * check: Python's development mode could not start a flow, TypeScript's would
 * not publish and Python's faked it. Both were found by installing a package
 * and running its own README.
 *
 * So the cases live in `packages/conformance/cases.json` and both suites read
 * it. A case added there fails in whichever language has not implemented it,
 * which is the property that was missing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { durationMs, type Duration } from "./duration.js";
import { HttpClient } from "./http.js";
import { DeliverdError } from "./errors.js";
import { verifySignature, TOLERANCE_SECONDS } from "./webhooks.js";
import { Deliverd } from "./index.js";
import { Gate } from "./gates.js";

const CASES = JSON.parse(
  readFileSync(new URL("../../conformance/cases.json", import.meta.url), "utf8")
) as {
  durations: {
    shared: { input: string; seconds: number }[];
    divergent: { input: number; ts_milliseconds: number; why: string }[];
    rejected: string[];
  };
  retries: { _maxAttempts: number; cases: { status: number; attempts: number; why: string }[] };
  retryAfter: { header: string; ts_milliseconds: number; honoured: boolean };
  idempotency: {
    retryStatus: number;
    expectedAttempts: number;
    sameKeyOnEveryAttempt: boolean;
    header: string;
  };
  signatures: {
    secret: string;
    body: string;
    toleranceSeconds: number;
    cases: { name: string; header: string | null; now: number; verifies: boolean }[];
  };
};

/** A transport that always answers the same way, and counts how often it was asked. */
function answering(status: number, body: unknown = { error: { code: "x", message: "x" } }) {
  /*
   * `retry-after: 0` so the suite does not spend real seconds asleep proving
   * an attempt count. It is the same retry path either way — `isRetryable`
   * reads the status and nothing else — and the header's own conversion is
   * pinned separately below, where the number matters.
   */
  const seen: { idempotencyKey: string | null }[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ idempotencyKey: headers.get("idempotency-key") });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after": "0" },
    });
  }) as typeof globalThis.fetch;
  return { seen, fetchImpl };
}

describe("durations mean the same thing in both SDKs", () => {
  it("reads every shared string the same way", () => {
    expect(CASES.durations.shared.length).toBeGreaterThan(5);
    for (const { input, seconds } of CASES.durations.shared) {
      expect(durationMs(input as Duration), `durationMs(${JSON.stringify(input)})`).toBe(
        seconds * 1000
      );
    }
  });

  it("takes a bare number as milliseconds, which is this language's own unit", () => {
    /*
     * The one deliberate divergence, and the table has to say why in its own
     * `why` field rather than leaving the next reader to guess whether it is
     * a bug. `setTimeout` counts milliseconds and `time.sleep` counts seconds;
     * reading either as the other is wrong by a thousand in code that looks
     * right.
     */
    for (const { input, ts_milliseconds, why } of CASES.durations.divergent) {
      expect(why.length, "A divergence needs a reason, not a note.").toBeGreaterThan(40);
      expect(durationMs(input as Duration)).toBe(ts_milliseconds);
    }
  });

  it("refuses everything the table says is not a duration", () => {
    for (const input of CASES.durations.rejected) {
      expect(
        () => durationMs(input as Duration),
        `durationMs(${JSON.stringify(input)}) should have thrown.`
      ).toThrow();
    }
  });
});

describe("the same answers are worth asking again in both SDKs", () => {
  for (const { status, attempts, why } of CASES.retries.cases) {
    it(`asks ${attempts}× on ${status} — ${why}`, async () => {
      const { seen, fetchImpl } = answering(status);
      const http = new HttpClient({
        apiKey: "dlv_conformance",
        fetch: fetchImpl,
        maxRetries: CASES.retries._maxAttempts,
      });
      await expect(http.request({ method: "GET", path: "/reports" })).rejects.toBeInstanceOf(
        DeliverdError
      );
      expect(seen.length, `${status} was asked ${seen.length}× and the table says ${attempts}.`).toBe(
        attempts
      );
    });
  }
});

describe("Retry-After is read into the unit this language sleeps in", () => {
  it("turns the header's seconds into milliseconds", async () => {
    let waited = -1;
    const started = Date.now();
    const fetchImpl = (async () => {
      waited = Date.now() - started;
      return new Response(JSON.stringify({ error: { code: "x", message: "x" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": CASES.retryAfter.header },
      });
    }) as typeof globalThis.fetch;

    const http = new HttpClient({ apiKey: "dlv_conformance", fetch: fetchImpl, maxRetries: 2 });
    await expect(http.request({ method: "GET", path: "/reports" })).rejects.toBeInstanceOf(
      DeliverdError
    );
    /*
     * The second attempt happens after the header's own delay. Asserted as a
     * floor rather than an equality — a machine under load sleeps longer, and
     * what a unit slip does is make this fire a thousand times too early.
     */
    expect(CASES.retryAfter.honoured).toBe(true);
    expect(
      waited,
      `The retry came after ${waited}ms and Retry-After said ${CASES.retryAfter.ts_milliseconds}ms. Reading the header's seconds as milliseconds is the slip this pins.`
    ).toBeGreaterThanOrEqual(CASES.retryAfter.ts_milliseconds * 0.9);
  });
});

describe("a retried POST carries one idempotency key", () => {
  it("holds the same key across every attempt", async () => {
    /*
     * The key exists so a retry cannot create a second thing. A client that
     * mints a fresh one per attempt has the bug the header was added to
     * prevent, and it only appears under a retry — which is exactly when
     * nobody is watching.
     */
    const { seen, fetchImpl } = answering(CASES.idempotency.retryStatus);
    const http = new HttpClient({
      apiKey: "dlv_conformance",
      fetch: fetchImpl,
      maxRetries: CASES.retries._maxAttempts,
    });
    await expect(
      http.request({ method: "POST", path: "/approvals", body: { title: "x" } })
    ).rejects.toBeInstanceOf(DeliverdError);

    expect(seen.length).toBe(CASES.idempotency.expectedAttempts);
    const keys = new Set(seen.map((s) => s.idempotencyKey));
    expect(keys.has(null), "A POST went out with no idempotency key.").toBe(false);
    expect(
      keys.size,
      `${keys.size} different idempotency keys across ${seen.length} attempts. A retry that mints a new key is a second create.`
    ).toBe(1);
  });
});

describe("a webhook signature verifies the same in both SDKs", () => {
  it("agrees with the table's fixed vectors", () => {
    /*
     * Fixed vectors rather than sign-then-verify: a round trip passes even
     * when both ends are wrong in the same way, and the thing at stake is a
     * receiver somebody wrote against the other SDK.
     */
    expect(CASES.signatures.toleranceSeconds).toBe(TOLERANCE_SECONDS);
    for (const { name, header, now, verifies } of CASES.signatures.cases) {
      expect(
        verifySignature(CASES.signatures.secret, CASES.signatures.body, header, {
          now,
          toleranceSeconds: CASES.signatures.toleranceSeconds,
        }),
        `${name}: expected ${verifies}.`
      ).toBe(verifies);
    }
  });
});

describe("the gate answers the same in both SDKs", () => {
  /*
   * Run against a real `Gate` rather than asserted as a table of its own.
   * `allowed` is a derived boolean and the one an agent branches on: a
   * language that got it wrong would make a refund the other would not, with
   * nothing raised either way.
   */
  const handleFor = (status: string, allowed: boolean) =>
    new Gate(null as never, {
      id: "gat_1",
      status,
      allowed,
      input: {},
      basis: "policy",
      reason: null,
      rule: null,
      policyVersionId: null,
      approvalId: null,
      approvalUrl: null,
      outcome: null,
      settledAt: null,
      reused: false,
    } as never);

  it("agrees on what counts as permission", () => {
    for (const { status, allowed, why } of CASES.gate.allowed) {
      const gate = handleFor(status, allowed);
      expect(gate.allowed, `${status}: ${why}`).toBe(allowed);
      expect(gate.pending, `${status} pending`).toBe(status === "pending");
      expect(gate.denied, `${status} denied`).toBe(status === "denied");
      /* The flattened answer must agree with the handle, or `gate()` and
       * `gates.create()` disagree about the same decision. */
      expect(gate.toDecision().allowed).toBe(allowed);
      expect(gate.toDecision().status).toBe(status);
    }
  });

  it("requires the caller's own id and sends it as the idempotency key", async () => {
    expect(CASES.gate.externalId.required).toBe(true);
    expect(CASES.gate.externalId.sentAsIdempotencyKey).toBe(true);

    let sent: string | null = null;
    const client = new Deliverd({
      apiKey: "dlv_test",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = new Headers(init.headers).get("idempotency-key");
        return new Response(
          JSON.stringify({ ...handleFor("allowed", true).toJSON(), reused: false }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }) as unknown as typeof fetch,
    });

    await client.gates.create({ actionId: "finance.refund", input: {}, externalId: "refund:1" });
    expect(
      sent,
      "The gate sent a random idempotency key instead of the caller's id, so a retry would ask a second person about the same money."
    ).toBe("refund:1");
  });

  it("offers the same development outcomes", () => {
    const dev = readFileSync(join(__dirname, "dev.ts"), "utf8");
    for (const outcome of CASES.gate.developmentOutcomes.outcomes) {
      expect(dev, `dev mode does not know "${outcome}"`).toContain(`"${outcome}"`);
    }
  });
});
