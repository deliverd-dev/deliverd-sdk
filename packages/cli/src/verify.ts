import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Checking an evidence pack with nothing but this file.
 *
 * The same procedure as `apps/web/src/lib/evidence/signature.ts`, written
 * again on purpose: this package is published on its own, from a public
 * repository, and the person running `deliverd verify` is often an auditor
 * who should not have to trust the server that made the pack to tell them
 * whether it is genuine. `signature.test.ts` in the web app signs a pack
 * there and checks it here, so the two cannot drift apart.
 *
 * Two questions, answered separately because they mean different things:
 *
 * - **Does the digest recompute?** sha256 over the pack with
 *   `integrity.digest` and `integrity.signature` removed. Says the file
 *   matches itself, which anybody who edits a pack can arrange.
 * - **Is the digest signed by the key?** Ed25519 over
 *   `deliverd-evidence-pack:v1:<digest>`. Says it came from the deployment
 *   holding the private half, unaltered.
 */

export const SIGNING_CONTEXT = "deliverd-evidence-pack:v1:";
export const EVIDENCE_KEY_PATH = "/.well-known/deliverd-evidence-key";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A public key as a PEM, base64 DER, or the bare 32 bytes in base64, base64url or hex. */
export function parsePublicKey(raw: string): KeyObject {
  const text = raw.trim().replace(/\\n/g, "\n");
  let key: KeyObject;
  if (text.includes("-----BEGIN")) {
    key = createPublicKey(text);
  } else {
    const bytes = /^[0-9a-f]{64}$/i.test(text)
      ? Buffer.from(text, "hex")
      : /^[A-Za-z0-9+/_-]+={0,2}$/.test(text)
        ? Buffer.from(text, "base64")
        : null;
    if (!bytes) throw new Error("The key is not a PEM, base64 or hex Ed25519 public key.");
    const der = bytes.length === 32 ? Buffer.concat([SPKI_ED25519_PREFIX, bytes]) : bytes;
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The key is not an Ed25519 key.");
  return key;
}

/** First 16 hex characters of sha256 over the SPKI DER. */
export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function packDigest(pack: Record<string, unknown>): string {
  const integrity = { ...((pack.integrity ?? {}) as Record<string, unknown>) };
  delete integrity.digest;
  delete integrity.signature;
  return createHash("sha256")
    .update(JSON.stringify({ ...pack, integrity }))
    .digest("hex");
}

export interface Verdict {
  digestValid: boolean;
  /** `valid`, `invalid`, `unsigned` (the pack carries none) or `no_key` (signed, nothing to check it with). */
  signature: "valid" | "invalid" | "unsigned" | "no_key";
  keyId: string | null;
  /** Where the pack says its key is published, when it is signed. */
  keyUrl: string | null;
  /** Why an unsigned pack is unsigned, in its own words. */
  unsignedReason: string | null;
}

export function verifyPack(pack: Record<string, unknown>, publicKey: KeyObject | null): Verdict {
  const integrity = (pack.integrity ?? {}) as Record<string, unknown>;
  const digest = typeof integrity.digest === "string" ? integrity.digest : "";
  const digestValid = digest !== "" && packDigest(pack) === digest;
  const block = (integrity.signature ?? null) as Record<string, unknown> | null;

  if (!block || block.status !== "signed" || typeof block.value !== "string") {
    return {
      digestValid,
      signature: "unsigned",
      keyId: null,
      keyUrl: null,
      unsignedReason: block && typeof block.reason === "string" ? block.reason : null,
    };
  }
  const keyId = typeof block.keyId === "string" ? block.keyId : null;
  const keyUrl = typeof block.keyUrl === "string" ? block.keyUrl : null;
  const base = { digestValid, keyId, keyUrl, unsignedReason: null };
  if (!publicKey) return { ...base, signature: "no_key" };
  // A different key is a failed check, not a pass against some other key.
  if (keyId !== keyIdOf(publicKey)) return { ...base, signature: "invalid" };
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(SIGNING_CONTEXT + digest, "utf8"),
      publicKey,
      Buffer.from(block.value, "base64")
    );
  } catch {
    ok = false;
  }
  return { ...base, signature: ok ? "valid" : "invalid" };
}

/** Both checks passed. An unsigned pack never counts as verified. */
export function verified(v: Verdict): boolean {
  return v.digestValid && v.signature === "valid";
}
