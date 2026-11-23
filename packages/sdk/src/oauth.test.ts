import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";
import { clientAssertion, oauthFromEnv, oauthMode } from "./oauth.js";

function recorder(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function parts(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(p!, "base64url").toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, "base64url"),
  };
}

describe("OAuth for agents", () => {
  it("gets a token with the client credentials grant, sends it, and reuses it", async () => {
    let issued = 0;
    const { calls, fetch } = recorder((url) => {
      if (url.endsWith("/api/oauth/token")) {
        issued++;
        return { status: 200, body: { access_token: `dlvat_${issued}`, token_type: "Bearer", expires_in: 900 } };
      }
      return { status: 200, body: { data: [] } };
    });
    const d = new Deliverd({ apiKey: undefined, oauth: { clientId: "dlvac_abc", clientSecret: "dlvacs_secret" }, fetch, baseUrl: "https://example.test" });
    await d.http.request({ method: "GET", path: "/approvals" });
    await d.http.request({ method: "GET", path: "/approvals" });

    const tokenCalls = calls.filter((c) => c.url.endsWith("/api/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(String(tokenCalls[0]!.init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("dlvac_abc");
    expect(form.get("client_secret")).toBe("dlvacs_secret");
    expect(form.get("resource")).toBe("https://example.test/api/v1");
    const api = calls.filter((c) => c.url.includes("/api/v1/"));
    expect(api.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(["Bearer dlvat_1", "Bearer dlvat_1"]);
  });

  it("renews the token once when the API refuses it", async () => {
    let issued = 0;
    let apiCalls = 0;
    const { calls, fetch } = recorder((url) => {
      if (url.endsWith("/api/oauth/token")) return { status: 200, body: { access_token: `dlvat_${++issued}`, expires_in: 900 } };
      apiCalls++;
      return apiCalls === 1 ? { status: 401, body: { error: { code: "auth_error", message: "expired" } } } : { status: 200, body: {} };
    });
    const d = new Deliverd({ oauth: { clientId: "dlvac_abc", clientSecret: "s" }, fetch, baseUrl: "https://example.test" });
    await d.http.request({ method: "GET", path: "/approvals" });
    expect(issued).toBe(2);
    const auth = calls.filter((c) => c.url.includes("/api/v1/")).map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auth).toEqual(["Bearer dlvat_1", "Bearer dlvat_2"]);
  });

  it("keeps using a key when one is given, whatever else is set", async () => {
    const { calls, fetch } = recorder(() => ({ status: 200, body: {} }));
    const d = new Deliverd({ apiKey: "dlv_key", oauth: { clientId: "dlvac_abc", clientSecret: "s" }, fetch });
    await d.http.request({ method: "GET", path: "/approvals" });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer dlv_key");
  });

  it("explains a refusal from the token endpoint", async () => {
    const { fetch } = recorder(() => ({ status: 401, body: { error: "invalid_client", error_description: "Client authentication failed" } }));
    const d = new Deliverd({ oauth: { clientId: "dlvac_abc", clientSecret: "wrong" }, fetch, maxRetries: 1 });
    await expect(d.http.request({ method: "GET", path: "/approvals" })).rejects.toThrow(/invalid_client: Client authentication failed/);
  });

  it("exchanges a platform token", async () => {
    const { calls, fetch } = recorder((url) =>
      url.endsWith("/api/oauth/token") ? { status: 200, body: { access_token: "dlvat_x", expires_in: 900 } } : { status: 200, body: {} }
    );
    const d = new Deliverd({ oauth: { subjectToken: async () => "eyJplatform" }, fetch });
    await d.http.request({ method: "GET", path: "/approvals" });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token")).toBe("eyJplatform");
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
  });

  for (const [type, opts, alg] of [
    ["ec", { namedCurve: "P-256" }, "ES256"],
    ["rsa", { modulusLength: 2048 }, "RS256"],
    ["ed25519", {}, "EdDSA"],
  ] as const) {
    it(`signs a client assertion with ${alg} that verifies against the public key`, () => {
      const { privateKey, publicKey } = generateKeyPairSync(type as "ec", opts as { namedCurve: string });
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const jwt = clientAssertion({ clientId: "dlvac_abc", audience: "https://example.test/api/oauth/token", privateKey: pem, keyId: "k1" });
      const { header, claims, signingInput, signature } = parts(jwt);
      expect(header).toMatchObject({ alg, kid: "k1" });
      expect(claims).toMatchObject({ iss: "dlvac_abc", sub: "dlvac_abc", aud: "https://example.test/api/oauth/token" });
      expect(claims.exp - claims.iat).toBe(60);
      expect(typeof claims.jti).toBe("string");
      const digest = alg === "EdDSA" ? null : "sha256";
      const key = alg === "ES256" ? { key: publicKey, dsaEncoding: "ieee-p1363" as const } : publicKey;
      expect(verify(digest, Buffer.from(signingInput), key, signature)).toBe(true);
    });
  }

  it("reads a client from the environment, and needs a secret or key", () => {
    expect(oauthFromEnv({})).toBeNull();
    const fromEnv = oauthFromEnv({ DELIVERD_CLIENT_ID: "dlvac_abc", DELIVERD_PRIVATE_KEY: "-----BEGIN\\nX" });
    expect(fromEnv?.privateKey).toBe("-----BEGIN\nX");
    expect(oauthMode(fromEnv!)).toBe("private_key_jwt");
    expect(() => oauthMode({ clientId: "dlvac_abc" })).toThrow(/clientSecret or a privateKey/);
  });
});
