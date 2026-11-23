import { describe, expect, it } from "vitest";
import { entraAppToken, purviewCheck } from "./purview.js";

const APP = { name: "Claims assistant", entraAppId: "11111111-2222-4333-8444-555555555555" };
const USER = "5def8f26-aff8-4db6-a08c-0fcf8f1aa2ba";

type Answer = { status: number; body?: unknown; etag?: string };

/** processContent answers in turn; protectionScopes/compute answers `compute` (by default 200 with no ETag). */
function fakeFetch(responses: Answer[], compute: Answer | (() => Answer) = { status: 200, body: { value: [] } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const r = url.endsWith("/protectionScopes/compute")
      ? typeof compute === "function"
        ? compute()
        : compute
      : responses[Math.min(n++, responses.length - 1)]!;
    if (!url.endsWith("/protectionScopes/compute")) calls.push({ url, init });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.etag ? { ETag: r.etag } : {},
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("purviewCheck", () => {
  it("sends the text to Microsoft Graph for the user, as the app, and reads a block", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, etag: '"e1"', body: { protectionScopeState: "notModified", policyActions: [{ action: "restrictAccess", restrictionAction: "block" }] } },
    ]);
    const check = purviewCheck({ token: () => "tok", userId: USER, app: APP, agent: { id: "a1", name: "Claims agent" }, fetch: impl });
    const outcome = await check("card 4532667785213500");
    expect(outcome).toEqual({ restriction: "block", actions: 1, scopeModified: false, unavailable: false });
    expect(calls[0]!.url).toBe(`https://graph.microsoft.com/v1.0/users/${USER}/dataSecurityAndGovernance/processContent`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.contentToProcess.activityMetadata.activity).toBe("uploadText");
    expect(body.contentToProcess.contentEntries[0].content.data).toBe("card 4532667785213500");
    expect(body.contentToProcess.contentEntries[0].agents[0]).toMatchObject({ identifier: "a1", name: "Claims agent" });
    expect(body.contentToProcess.protectedAppMetadata.applicationLocation.value).toBe(APP.entraAppId);
  });

  it("computes the user's protection scopes for the app first, once an hour, and sends their ETag", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      bodies.push(String(init.body));
      if (url.endsWith("/protectionScopes/compute")) return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { ETag: '"scope"' } });
      expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('"scope"');
      return new Response(JSON.stringify({ policyActions: [{ restrictionAction: "block" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const check = purviewCheck({ token: "t", userId: USER, app: APP, fetch: impl });
    expect((await check("a")).restriction).toBe("block");
    await check("b");
    expect(urls.filter((u) => u.endsWith("/protectionScopes/compute"))).toEqual([`https://graph.microsoft.com/v1.0/users/${USER}/dataSecurityAndGovernance/protectionScopes/compute`]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ activities: "uploadText", locations: [{ value: APP.entraAppId }] });
  });

  it("still asks processContent when compute is refused", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { policyActions: [{ restrictionAction: "warn" }] } }], { status: 403 });
    expect(await purviewCheck({ token: "t", app: APP, fetch: impl })("x")).toMatchObject({ restriction: "warn", unavailable: false });
    expect((calls[0]!.init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });

  it("computes again and asks once more when Purview says its policies changed", async () => {
    let computed = 0;
    const { impl, calls } = fakeFetch(
      [{ status: 200, body: { protectionScopeState: "modified", policyActions: [] } }, { status: 200, body: { policyActions: [{ restrictionAction: "block" }] } }],
      () => ({ status: 200, body: { value: [] }, etag: `"e${++computed}"` })
    );
    expect((await purviewCheck({ token: "t", app: APP, fetch: impl })("x")).restriction).toBe("block");
    expect(computed).toBe(2);
    expect((calls[1]!.init.headers as Record<string, string>)["If-None-Match"]).toBe('"e2"');
  });

  it("sends the computed scope's ETag on every call", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { policyActions: [] } }], { status: 200, body: { value: [] }, etag: '"e1"' });
    const check = purviewCheck({ token: "tok", app: APP, fetch: impl });
    await check("one");
    await check("two");
    expect(calls[0]!.url).toContain("/me/dataSecurityAndGovernance/processContent");
    expect((calls[1]!.init.headers as Record<string, string>)["If-None-Match"]).toBe('"e1"');
    expect(JSON.parse(calls[1]!.init.body as string).contentToProcess.contentEntries[0].sequenceNumber).toBe(1);
  });

  it("treats 202 and 204 as nothing to do", async () => {
    const { impl } = fakeFetch([{ status: 204 }]);
    expect((await purviewCheck({ token: "t", app: APP, fetch: impl })("x")).restriction).toBeNull();
  });

  it("asks a person when Purview cannot be reached, unless told otherwise", async () => {
    const { impl } = fakeFetch([{ status: 503 }]);
    expect(await purviewCheck({ token: "t", app: APP, fetch: impl })("x")).toMatchObject({ restriction: "warn", unavailable: true });
    expect(await purviewCheck({ token: "t", app: APP, fetch: impl, onUnavailable: "deny" })("x")).toMatchObject({ restriction: "block", unavailable: true });
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await purviewCheck({ token: "t", app: APP, fetch: failing, onUnavailable: "allow" })("x")).toMatchObject({ restriction: null, unavailable: true });
  });

  it("refuses ids that are not GUIDs", () => {
    expect(() => purviewCheck({ token: "t", app: { name: "x", entraAppId: "nope" } })).toThrow(/GUID/);
    expect(() => purviewCheck({ token: "t", app: APP, userId: "me@example.com" })).toThrow(/GUID/);
  });
});

describe("entraAppToken", () => {
  it("asks Entra once for the app's token and reuses it", async () => {
    const bodies: string[] = [];
    const token = entraAppToken({
      tenantId: "99999999-8888-7777-6666-555555555555",
      clientId: "c",
      clientSecret: "s",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ access_token: "app", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await token()).toBe("app");
    expect(await token()).toBe("app");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("grant_type=client_credentials");
  });
});
