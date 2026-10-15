import { describe, expect, it } from "vitest";
import { HttpClient } from "./http.js";

/**
 * The retry that used to create a second approval.
 *
 * This is the one test in the SDK that reproduces a real defect rather than
 * describing an intention. The client retries a dropped connection and it
 * retries every method, so a `POST /approvals` that reached the server and
 * lost its response on the way back was replayed as a new create: two people
 * asked to authorise one act, and an orphan left pending after the real one
 * settled.
 *
 * Retrying was never the wrong behaviour. What was missing was a way for the
 * server to tell the retry from a new request — so what these assert is that
 * every attempt of one logical call carries the *same* key, which is the
 * thing that makes it recognisable.
 */

interface Attempt {
  method: string;
  idempotencyKey: string | null;
  correlationId: string | null;
}

/** A fetch that answers a scripted sequence and records what it was sent. */
function scripted(responses: Array<Response | Error>) {
  const attempts: Attempt[] = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    attempts.push({
      method: init?.method ?? "GET",
      idempotencyKey: headers.get("idempotency-key"),
      correlationId: headers.get("deliverd-correlation-id"),
    });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, attempts };
}

const ok = () =>
  new Response(JSON.stringify({ id: "a1" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

function client(fetchImpl: typeof globalThis.fetch) {
  return new HttpClient({
    apiKey: "dlv_test",
    baseUrl: "https://example.test",
    fetch: fetchImpl,
    // No waiting around in a test; the backoff itself is not what is
    // under examination here.
    maxRetries: 3,
    timeout: 5_000,
  });
}

describe("a retried create is recognisable as the same request", () => {
  it("carries one key across a dropped connection", async () => {
    const { fetchImpl, attempts } = scripted([
      new Error("socket hang up"),
      ok(),
    ]);
    await client(fetchImpl).request({ method: "POST", path: "/approvals", body: { title: "Deploy" } });

    expect(attempts.length, "the dropped connection was not retried").toBe(2);
    expect(attempts[0]!.idempotencyKey, "no key on the first attempt").toBeTruthy();
    expect(
      attempts[1]!.idempotencyKey,
      "the retry sent a different key, so the server sees a second create — this is the duplicate-approval bug."
    ).toBe(attempts[0]!.idempotencyKey);
  });

  it("carries one key across a 500", async () => {
    const { fetchImpl, attempts } = scripted([
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
      ok(),
    ]);
    await client(fetchImpl).request({ method: "POST", path: "/approvals", body: { title: "Deploy" } });

    expect(attempts.length).toBe(2);
    expect(attempts[1]!.idempotencyKey).toBe(attempts[0]!.idempotencyKey);
  });

  it("gives two separate calls two separate keys", async () => {
    // The other half of the property: holding the key across retries must not
    // become holding it across everything, or a second genuine approval would
    // be answered with the first one's response.
    const { fetchImpl, attempts } = scripted([ok()]);
    const c = client(fetchImpl);
    await c.request({ method: "POST", path: "/approvals", body: { title: "One" } });
    await c.request({ method: "POST", path: "/approvals", body: { title: "Two" } });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.idempotencyKey).not.toBe(attempts[1]!.idempotencyKey);
  });

  it("lets a caller supply the key, for their own retries", async () => {
    // A job that reruns from the start after a crash wants the key its first
    // run used, and only the caller can derive that.
    const { fetchImpl, attempts } = scripted([ok()]);
    await client(fetchImpl).request({
      method: "POST",
      path: "/approvals",
      body: { title: "Deploy" },
      idempotencyKey: "nightly-2026-09-14",
    });
    expect(attempts[0]!.idempotencyKey).toBe("nightly-2026-09-14");
  });

  it("does not put a key on reads", async () => {
    const { fetchImpl, attempts } = scripted([ok()]);
    await client(fetchImpl).request({ method: "GET", path: "/approvals/a1" });
    expect(
      attempts[0]!.idempotencyKey,
      "a GET creates nothing, so a key on it is noise in the server's table."
    ).toBeNull();
  });

  it("keeps the correlation id and the key as separate ideas", async () => {
    // They travel together and are both stable across retries, but one is for
    // a human reading logs and the other changes what the server does.
    const { fetchImpl, attempts } = scripted([new Error("socket hang up"), ok()]);
    await client(fetchImpl).request({ method: "POST", path: "/approvals", body: {} });

    expect(attempts[0]!.correlationId).toBe(attempts[1]!.correlationId);
    expect(attempts[0]!.idempotencyKey).not.toBe(attempts[0]!.correlationId);
  });
});
