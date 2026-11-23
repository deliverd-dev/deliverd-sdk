import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { DeliverdError } from "./errors.js";

/**
 * OAuth for agents: short-lived access tokens instead of a key on every
 * request.
 *
 * An agent with an OAuth client (Agents → Agents → an agent → OAuth in
 * Deliverd) asks the token endpoint for an access token with the client
 * credentials grant, proving itself with a client secret or with a JWT it
 * signs with its own private key (private_key_jwt). An agent that already has
 * a token from its platform (a Microsoft Entra Agent ID, an Azure managed
 * identity, AWS, Google Cloud, GitHub Actions, Kubernetes) exchanges that
 * instead (token exchange, RFC 8693).
 *
 * The token is cached and renewed a minute before it runs out, and once more
 * if the API says it is no longer valid. No dependencies: node:crypto signs.
 */

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export interface AgentOAuthOptions {
  /** The client ID from the agent's page (`dlvac_…`). Not needed for token exchange. */
  clientId?: string;
  /** For a client that proves itself with a secret (`dlvacs_…`). */
  clientSecret?: string;
  /**
   * For a client that signs: the agent's private key, as a PEM string, a JWK
   * object or a KeyObject. RSA (RS256), EC P-256 (ES256) or Ed25519 (EdDSA).
   */
  privateKey?: string | KeyObject | Record<string, unknown>;
  /** The `kid` of that key, when its public key set holds more than one. */
  keyId?: string;
  /**
   * Token exchange instead of a client: the platform's own token for this
   * agent, or a function that returns a fresh one each time it is needed
   * (they are short-lived too).
   */
  subjectToken?: string | (() => string | Promise<string>);
  /** Space-separated scopes, to ask for fewer than the client holds. */
  scope?: string;
}

export interface TokenSource {
  /** A valid bearer token, from the cache when it has a minute left. */
  token(): Promise<string>;
  /** Forget the cached token, so the next call fetches a new one. */
  invalidate(): void;
}

function algFor(key: KeyObject): { alg: string; digest: string | null; dsaEncoding?: "ieee-p1363" } {
  const type = key.asymmetricKeyType;
  if (type === "rsa") return { alg: "RS256", digest: "sha256" };
  if (type === "rsa-pss") return { alg: "PS256", digest: "sha256" };
  if (type === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve && curve !== "prime256v1" && curve !== "P-256") {
      throw new DeliverdError(0, "invalid_private_key", "An EC key must be on P-256 (ES256).");
    }
    return { alg: "ES256", digest: "sha256", dsaEncoding: "ieee-p1363" };
  }
  if (type === "ed25519") return { alg: "EdDSA", digest: null };
  throw new DeliverdError(0, "invalid_private_key", `Keys of type ${type ?? "unknown"} cannot sign a client assertion: use RSA, EC P-256 or Ed25519.`);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function toKeyObject(key: AgentOAuthOptions["privateKey"]): KeyObject {
  if (!key) throw new DeliverdError(0, "invalid_private_key", "No private key.");
  if (typeof key === "object" && "asymmetricKeyType" in key && typeof (key as KeyObject).export === "function") return key as KeyObject;
  try {
    if (typeof key === "string") return createPrivateKey(key);
    return createPrivateKey({ key: key as never, format: "jwk" });
  } catch (cause) {
    throw new DeliverdError(0, "invalid_private_key", "The private key could not be read: give a PEM string or a private JWK.", undefined, { cause });
  }
}

/** A signed client assertion (RFC 7523): one minute long, single use. */
export function clientAssertion(input: { clientId: string; audience: string; privateKey: AgentOAuthOptions["privateKey"]; keyId?: string; now?: number }): string {
  const key = toKeyObject(input.privateKey);
  const { alg, digest, dsaEncoding } = algFor(key);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const header = { alg, typ: "JWT", ...(input.keyId ? { kid: input.keyId } : {}) };
  const claims = { iss: input.clientId, sub: input.clientId, aud: input.audience, iat: now, exp: now + 60, jti: randomUUID() };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign(digest, Buffer.from(signingInput), dsaEncoding ? { key, dsaEncoding } : key);
  return `${signingInput}.${b64url(signature)}`;
}

/** Which of the three ways the options describe, or why none. */
export function oauthMode(options: AgentOAuthOptions): "secret" | "private_key_jwt" | "token_exchange" {
  if (options.subjectToken) return "token_exchange";
  if (!options.clientId) throw new DeliverdError(0, "no_client_id", "OAuth needs a clientId (dlvac_…), or a subjectToken to exchange.");
  if (options.privateKey) return "private_key_jwt";
  if (options.clientSecret) return "secret";
  throw new DeliverdError(0, "no_client_credentials", "OAuth needs a clientSecret or a privateKey for the client.");
}

/**
 * OAuth options from the environment, when they are there: DELIVERD_CLIENT_ID
 * with DELIVERD_CLIENT_SECRET or DELIVERD_PRIVATE_KEY (a PEM; DELIVERD_KEY_ID
 * for its kid). Null when there is no client ID.
 */
export function oauthFromEnv(env: Record<string, string | undefined> = process.env): AgentOAuthOptions | null {
  const clientId = env.DELIVERD_CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: env.DELIVERD_CLIENT_SECRET || undefined,
    privateKey: env.DELIVERD_PRIVATE_KEY ? env.DELIVERD_PRIVATE_KEY.replace(/\\n/g, "\n") : undefined,
    keyId: env.DELIVERD_KEY_ID || undefined,
    scope: env.DELIVERD_SCOPE || undefined,
  };
}

/**
 * A cached access token from the token endpoint. Concurrent callers share
 * one request, so a burst of calls at start-up asks once.
 */
export function agentTokenSource(
  options: AgentOAuthOptions,
  context: { baseUrl: string; fetch?: typeof globalThis.fetch; userAgent?: string }
): TokenSource {
  const mode = oauthMode(options);
  const doFetch = context.fetch ?? globalThis.fetch;
  const base = context.baseUrl.replace(/\/+$/, "");
  const tokenEndpoint = `${base}/api/oauth/token`;
  const resource = `${base}/api/v1`;
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const form = new URLSearchParams();
    form.set("resource", resource);
    if (options.scope) form.set("scope", options.scope);
    if (mode === "token_exchange") {
      const subject = typeof options.subjectToken === "function" ? await options.subjectToken() : options.subjectToken!;
      form.set("grant_type", TOKEN_EXCHANGE_GRANT);
      form.set("subject_token", subject);
      form.set("subject_token_type", JWT_TOKEN_TYPE);
    } else {
      form.set("grant_type", "client_credentials");
      form.set("client_id", options.clientId!);
      if (mode === "secret") form.set("client_secret", options.clientSecret!);
      else {
        form.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
        form.set("client_assertion", clientAssertion({ clientId: options.clientId!, audience: tokenEndpoint, privateKey: options.privateKey, keyId: options.keyId }));
      }
    }
    let response: Response;
    try {
      response = await doFetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": context.userAgent ?? "deliverd-sdk" },
        body: form.toString(),
      });
    } catch (cause) {
      throw new DeliverdError(0, "network_error", `Could not reach ${tokenEndpoint}.`, undefined, { cause });
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new DeliverdError(
        response.status || 401,
        // Its own code, so the token endpoint's reason is kept rather than replaced by the API key advice.
        "oauth_token_refused",
        `The token endpoint refused: ${body.error ?? "error"}${body.error_description ? `: ${body.error_description}` : ""}. Check the client on the agent's page in Deliverd (Agents → Agents → the agent → OAuth).`,
        { oauthError: body.error }
      );
    }
    const lifetime = Math.max(30, Number(body.expires_in ?? 900));
    // Renewed a minute early, or at half-life for a token shorter than two minutes.
    cached = { token: body.access_token, until: Date.now() + Math.max(lifetime / 2, lifetime - 60) * 1000 };
    return body.access_token;
  }

  return {
    async token() {
      if (cached && Date.now() < cached.until) return cached.token;
      inflight ??= fetchToken().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}
