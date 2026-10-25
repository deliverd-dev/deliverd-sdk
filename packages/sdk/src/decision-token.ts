import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { DeliverdError } from "./errors.js";

/**
 * Checking a decision token where the action happens.
 *
 * A gate that may be acted on carries `decisionToken`: the yes, signed with
 * the deployment's Ed25519 evidence key. Hand it to the service that performs
 * the action — the one that issues the refund or merges the change — and that
 * service checks it against what it is about to do before it does it:
 *
 * ```ts
 * const check = await deliverd.decisionTokens.verify(req.headers["deliverd-decision"], {
 *   action: "finance.refund",
 *   input: { customer_id, amount, currency },
 * });
 * if (!check.ok) return res.status(403).send(check.reason);
 * ```
 *
 * It fails when the token was not signed by your Deliverd, has expired, is for
 * another action, or was agreed for a different input: a refund of £1240
 * against a yes for £1200 is refused. It needs no API key and makes no call
 * beyond fetching the public key once.
 *
 * What it does not check is how many times the yes has been used. Record the
 * execution against the gate (`gate.recordExecution`) to spend the use; the
 * server refuses a second.
 *
 * Kept byte-for-byte with the server's `lib/governance/decision-token.ts`;
 * `decision-token.test.ts` on the server signs there and verifies here.
 */

export const DECISION_TOKEN_PREFIX = "dlv_dt1";
export const DECISION_TOKEN_CONTEXT = "deliverd-decision-token:v1:";
/** Where a deployment publishes the key that signs its tokens and evidence packs. */
export const EVIDENCE_KEY_PATH = "/.well-known/deliverd-evidence-key";

export interface DecisionTokenClaims {
  v: 1;
  kid: string;
  iss: string;
  org: string;
  gate: string;
  action: string;
  /** Hex SHA-256 of the approved input in canonical JSON. */
  input: string;
  dest: { type: string; id: string } | null;
  artifact: string | null;
  iat: number;
  exp: number;
}

export interface DecisionTokenExpectation {
  /** The action you are about to perform. */
  action: string;
  /** The input you are about to perform it with. */
  input: unknown;
  /** Where it lands, when the gate named a destination. */
  destination?: { type: string; id: string } | null;
  /** The SHA-256 of what you are sending, when the gate named an artifact. */
  artifactSha256?: string | null;
}

export type DecisionTokenFailure =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "wrong_issuer"
  | "expired"
  | "wrong_action"
  | "input_mismatch"
  | "destination_mismatch"
  | "artifact_mismatch";

export type DecisionTokenResult =
  | { ok: true; claims: DecisionTokenClaims }
  | { ok: false; reason: DecisionTokenFailure };

/** Keys sorted at every depth, undefined dropped: the server's `canonicalJson`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function decisionInputHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input ?? {}), "utf8").digest("hex");
}

/** The server's `sameDestination`: addresses and domains ignore case, ids do not. */
function sameDestination(a: { type: string; id: string }, b: { type: string; id: string }): boolean {
  if (a.type !== b.type) return false;
  const fold = a.type === "email" || a.type === "domain";
  return fold ? a.id.trim().toLowerCase() === b.id.trim().toLowerCase() : a.id.trim() === b.id.trim();
}

/**
 * Verify with a key you already hold: a PEM string or a `KeyObject`. `issuer`
 * is the origin of the deployment you trust, such as `https://deliverd.dev`.
 */
export function verifyDecisionToken(
  token: string | null | undefined,
  expected: DecisionTokenExpectation,
  key: { publicKey: string | KeyObject; issuer: string; now?: Date; skewSeconds?: number }
): DecisionTokenResult {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== DECISION_TOKEN_PREFIX) return { ok: false, reason: "malformed" };
  let claims: DecisionTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as DecisionTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims?.v !== 1) return { ok: false, reason: "malformed" };
  let good = false;
  try {
    const publicKey = typeof key.publicKey === "string" ? createPublicKey(key.publicKey) : key.publicKey;
    good = verify(
      null,
      Buffer.from(DECISION_TOKEN_CONTEXT + parts[1], "utf8"),
      publicKey,
      Buffer.from(parts[2]!, "base64url")
    );
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad_signature" };
  if (claims.iss !== key.issuer.replace(/\/+$/, "")) return { ok: false, reason: "wrong_issuer" };
  const now = Math.floor((key.now ?? new Date()).getTime() / 1000);
  if (claims.exp + (key.skewSeconds ?? 30) <= now) return { ok: false, reason: "expired" };
  if (claims.action !== expected.action) return { ok: false, reason: "wrong_action" };
  if (claims.input !== decisionInputHash(expected.input)) return { ok: false, reason: "input_mismatch" };
  if (claims.dest) {
    const d = expected.destination;
    if (!d || !sameDestination(d, claims.dest)) return { ok: false, reason: "destination_mismatch" };
  }
  if (claims.artifact && expected.artifactSha256 !== claims.artifact) return { ok: false, reason: "artifact_mismatch" };
  return { ok: true, claims };
}

/**
 * `deliverd.decisionTokens`: verification against the deployment this client
 * talks to. The key comes from that deployment's own well-known address and
 * the issuer must be that deployment, never whatever the token names, so a
 * token signed by somebody else's Deliverd does not pass.
 */
export class DecisionTokens {
  private key: Promise<KeyObject> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async verify(
    token: string | null | undefined,
    expected: DecisionTokenExpectation,
    options: { now?: Date; skewSeconds?: number } = {}
  ): Promise<DecisionTokenResult> {
    if (!token) return { ok: false, reason: "missing" };
    const publicKey = await this.publicKey();
    return verifyDecisionToken(token, expected, { publicKey, issuer: new URL(this.baseUrl).origin, ...options });
  }

  private publicKey(): Promise<KeyObject> {
    this.key ??= (async () => {
      const res = await this.doFetch(`${this.baseUrl.replace(/\/+$/, "")}${EVIDENCE_KEY_PATH}`);
      if (!res.ok) {
        throw new DeliverdError(res.status, "no_signing_key", "This deployment does not publish a signing key.");
      }
      const body = (await res.json()) as { publicKey?: string };
      if (!body.publicKey) throw new DeliverdError(0, "no_signing_key", "The signing key response had no public key.");
      return createPublicKey(body.publicKey);
    })().catch((err) => {
      this.key = null;
      throw err;
    });
    return this.key;
  }
}
