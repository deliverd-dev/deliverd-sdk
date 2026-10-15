import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";
import { DeliverdError } from "./errors.js";
import type { CreatedWebhookEndpoint, WebhookEndpoint } from "./types.js";

/**
 * `deliverd.webhookEndpoints`, driven through a fake transport.
 *
 * Behavioural for the same reason the rest of this package is: what matters
 * is what reaches the wire — the path, the method, the body, the cursor — and
 * that a refusal arrives as the code the API sent rather than as a result.
 */

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function transport(script: (call: Call, n: number) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    const { status = 200, json } = script(call, calls.length);
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(json ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const client = (fetchImpl: typeof globalThis.fetch) =>
  new Deliverd({ apiKey: "dlv_test", fetch: fetchImpl, maxRetries: 1 });

function endpoint(over: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: "8f0c6c9e-0000-4000-8000-000000000001",
    url: "https://hooks.example.com/deliverd",
    description: null,
    events: [],
    format: "json",
    enabled: true,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    createdAt: "2026-10-09T09:00:00.000Z",
    ...over,
  };
}

describe("deliverd.webhookEndpoints", () => {
  it("adds one and hands back the secret the API returned", async () => {
    const created: CreatedWebhookEndpoint = { ...endpoint(), secret: "dlvw_abc" };
    const { calls, fetchImpl } = transport(() => ({ status: 201, json: created }));
    const result = await client(fetchImpl).webhookEndpoints.create({
      url: "https://hooks.example.com/deliverd",
      events: ["approval.approved"],
      format: "slack",
    });
    expect(result.secret).toBe("dlvw_abc");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/webhook-endpoints",
      body: { url: "https://hooks.example.com/deliverd", events: ["approval.approved"], format: "slack" },
    });
    // A create is a POST, so it carries a key and a retry cannot add a second endpoint.
    expect(calls[0]!.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("reads one and changes one by id", async () => {
    const { calls, fetchImpl } = transport(() => ({ json: endpoint({ enabled: false }) }));
    const endpoints = client(fetchImpl).webhookEndpoints;
    await endpoints.get("ep/1");
    await endpoints.update("ep/1", { enabled: false });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/webhook-endpoints/ep%2F1",
      "PATCH /api/v1/webhook-endpoints/ep%2F1",
    ]);
    expect(calls[1]!.body).toEqual({ enabled: false });
  });

  it("removes one", async () => {
    const { calls, fetchImpl } = transport(() => ({ status: 204 }));
    await client(fetchImpl).webhookEndpoints.delete("ep_1");
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/v1/webhook-endpoints/ep_1" });
  });

  it("sends a test and returns what the endpoint said, delivered or not", async () => {
    const { calls, fetchImpl } = transport(() => ({
      json: { delivered: false, responseStatus: 500, error: "Endpoint answered 500." },
    }));
    const result = await client(fetchImpl).webhookEndpoints.test("ep_1", { event: "approval.approved" });
    expect(result).toEqual({ delivered: false, responseStatus: 500, error: "Endpoint answered 500." });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/webhook-endpoints/ep_1/test",
      body: { event: "approval.approved" },
    });
  });

  it("follows the cursor to the end when no limit is asked for", async () => {
    const { calls, fetchImpl } = transport((_call, n) =>
      n === 1
        ? { json: { webhookEndpoints: [endpoint({ id: "a" })], nextCursor: "c1" } }
        : { json: { webhookEndpoints: [endpoint({ id: "b" })], nextCursor: null } }
    );
    const all = await client(fetchImpl).webhookEndpoints.list();
    expect(all.map((e) => e.id)).toEqual(["a", "b"]);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/webhook-endpoints",
      "/api/v1/webhook-endpoints?cursor=c1",
    ]);
  });

  it("returns one page, and its cursor, when asked for one", async () => {
    const { calls, fetchImpl } = transport(() => ({
      json: { webhookEndpoints: [endpoint()], nextCursor: "next" },
    }));
    const page = await client(fetchImpl).webhookEndpoints.listPage({ limit: 1 });
    expect(page.nextCursor).toBe("next");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/webhook-endpoints?limit=1");
  });

  it("is not simulated in development mode, and says so rather than inventing an endpoint", async () => {
    // The CHANGELOG says so; a plausible fake secret would be worse than a refusal.
    const deliverd = new Deliverd({ mode: "development", development: { log: false } });
    const failure = await deliverd.webhookEndpoints
      .create({ url: "https://hooks.example.com/x" })
      .catch((err: unknown) => err);
    expect((failure as DeliverdError).code).toBe("not_in_development_mode");
  });

  it("surfaces the refusal an agent key gets as the API's code", async () => {
    const { fetchImpl } = transport(() => ({
      status: 403,
      json: { error: { code: "agent_not_permitted", message: "An agent cannot manage webhook endpoints." } },
    }));
    const failure = await client(fetchImpl)
      .webhookEndpoints.create({ url: "https://hooks.example.com/x" })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DeliverdError);
    expect((failure as DeliverdError).code).toBe("agent_not_permitted");
    expect((failure as DeliverdError).status).toBe(403);
  });
});
