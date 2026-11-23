// Who is calling: the agent, and the person it acts for when there is one.
//
// Two ways in, and neither is on unless you set it:
//
// - Microsoft Entra ID (ENTRA_TENANT_ID and ENTRA_AUDIENCE). The agent gets an
//   access token for the runtime from your tenant and sends it as a bearer
//   token. The agent is the token's client (`azp`, or `appid` in a v1 token).
//   A delegated token (one with `scp`) also names the person it acts for
//   (`preferred_username`, `upn`, else `oid`); an app-only token names nobody.
//   With ENTRA_BLUEPRINT_APP_IDS, only agent identities made from those
//   blueprints (the Deliverd Agent Blueprint) get in.
// - Client keys (GATEWAY_CLIENT_KEYS="claims-bot:<secret>,…"), for a trial
//   before Entra is wired up. The agent is the name before the colon.
//
// With neither set, every call is refused: a runtime that let anyone in would
// hand the application to whoever can reach it on the network.

import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_SECONDS = 300;

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  return { header: JSON.parse(b64url(parts[0]).toString("utf8")), payload: JSON.parse(b64url(parts[1]).toString("utf8")), signed: `${parts[0]}.${parts[1]}`, signature: b64url(parts[2]) };
}

/** The tenant's signing keys, fetched and cached for an hour, fetched again when a token names a key we have not seen. */
export function entraKeys(tenantId, fetchImpl = fetch, now = () => Date.now()) {
  let cache = { at: 0, keys: [] };
  const load = async () => {
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`could not fetch the tenant's signing keys (HTTP ${res.status})`);
    cache = { at: now(), keys: (await res.json()).keys ?? [] };
  };
  return async (kid) => {
    if (now() - cache.at > 3_600_000) await load();
    let key = cache.keys.find((k) => k.kid === kid);
    if (!key && now() - cache.at > 60_000) {
      await load();
      key = cache.keys.find((k) => k.kid === kid);
    }
    return key ?? null;
  };
}

/**
 * Verifies an Entra access token for this runtime. Returns the caller, or
 * throws with why. Checks, in Microsoft's order for a resource server: RS256
 * signature by a key the tenant publishes, issuer and tenant, audience, time.
 */
export async function verifyEntra(token, settings, keyFor, now = () => Date.now()) {
  const { header, payload, signed, signature } = decodeJwt(token);
  if (header.alg !== "RS256") throw new Error("the token is not RS256");
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new Error("the token is signed with a key the tenant does not publish");
  const ok = verify("RSA-SHA256", Buffer.from(signed), createPublicKey({ key: jwk, format: "jwk" }), signature);
  if (!ok) throw new Error("the token's signature does not verify");
  const tid = settings.tenantId;
  const issuers = [`https://login.microsoftonline.com/${tid}/v2.0`, `https://sts.windows.net/${tid}/`];
  if (payload.tid !== tid || !issuers.includes(payload.iss)) throw new Error("the token is from another tenant");
  const audiences = settings.audiences;
  const aud = [].concat(payload.aud ?? []);
  if (!aud.some((a) => audiences.includes(a))) throw new Error("the token is not for this runtime");
  const t = Math.floor(now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < t) throw new Error("the token has expired");
  if (typeof payload.nbf === "number" && payload.nbf - SKEW_SECONDS > t) throw new Error("the token is not valid yet");
  if (settings.requiredScope) {
    const granted = [...String(payload.scp ?? "").split(" "), ...[].concat(payload.roles ?? [])];
    if (!granted.includes(settings.requiredScope)) throw new Error(`the token does not carry ${settings.requiredScope}`);
  }
  if (settings.blueprints?.length) {
    // Deliverd Agent Blueprint: only agent identities made from these blueprints. Microsoft puts the
    // blueprint's app ID in xms_par_app_azp, and only on tokens issued to agent identities.
    const parent = String(payload.xms_par_app_azp ?? "").toLowerCase();
    if (!settings.blueprints.includes(parent)) throw new Error("the token was not issued to an agent made from an allowed blueprint");
  }
  const agent = payload.azp ?? payload.appid;
  if (typeof agent !== "string" || !GUID.test(agent)) throw new Error("the token does not name the client that holds it");
  const delegated = typeof payload.scp === "string" && payload.scp.length > 0;
  const user = delegated ? payload.preferred_username ?? payload.upn ?? payload.oid ?? null : null;
  return { agent, user, label: settings.names?.[agent] ?? agent, via: "entra" };
}

/** Client keys from `name:secret,name:secret`. */
export function parseClientKeys(text) {
  const keys = new Map();
  for (const part of String(text ?? "").split(",")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const secret = part.slice(at + 1).trim();
    if (name && secret.length >= 24) keys.set(name, secret);
  }
  return keys;
}

function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The settings from the environment, checked once at start. */
export function authSettings(env) {
  const tenantId = env.ENTRA_TENANT_ID?.trim() || null;
  if (tenantId && !GUID.test(tenantId)) throw new Error("ENTRA_TENANT_ID is your tenant's ID, a GUID.");
  const audiences = String(env.ENTRA_AUDIENCE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (tenantId && !audiences.length) throw new Error("Set ENTRA_AUDIENCE to the runtime's application ID URI or client ID.");
  const names = {};
  for (const part of String(env.ENTRA_AGENT_NAMES ?? "").split(",")) {
    const [id, ...rest] = part.split("=");
    if (id?.trim() && rest.length) names[id.trim()] = rest.join("=").trim();
  }
  const blueprints = String(env.ENTRA_BLUEPRINT_APP_IDS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (blueprints.some((b) => !GUID.test(b))) throw new Error("ENTRA_BLUEPRINT_APP_IDS is a comma-separated list of blueprint app IDs, GUIDs.");
  if (blueprints.length && !tenantId) throw new Error("ENTRA_BLUEPRINT_APP_IDS needs ENTRA_TENANT_ID and ENTRA_AUDIENCE too.");
  const clientKeys = parseClientKeys(env.GATEWAY_CLIENT_KEYS);
  return { entra: tenantId ? { tenantId, audiences, requiredScope: env.ENTRA_REQUIRED_SCOPE?.trim() || null, names, blueprints } : null, clientKeys };
}

/**
 * The caller of one request, from its Authorization header. Returns
 * `{ caller }` or `{ error }`; never throws.
 */
export async function callerOf(authorization, settings, keyFor) {
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!m) return { error: "Send a bearer token." };
  const token = m[1].trim();
  for (const [name, secret] of settings.clientKeys) {
    if (sameSecret(token, secret)) return { caller: { agent: name, user: null, label: name, via: "key" } };
  }
  if (settings.entra && token.split(".").length === 3) {
    try {
      return { caller: await verifyEntra(token, settings.entra, keyFor) };
    } catch (error) {
      return { error: `The token was not accepted: ${error.message}.` };
    }
  }
  return { error: "The token was not accepted." };
}
