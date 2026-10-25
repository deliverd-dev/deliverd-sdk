import { describe, expect, it } from "vitest";
import { entraAppToken, purviewCheck } from "./purview.js";

const APP = { name: "Claims assistant", entraAppId: "11111111-2222-4333-8444-555555555555" };
const USER = "5def8f26-aff8-4db6-a08c-0fcf8f1aa2ba";

function fakeFetch(responses: { status: number; body?: unknown; etag?: string }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
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

  it("sends the last ETag on the next call", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, etag: '"e1"', body: { policyActions: [] } }]);
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
