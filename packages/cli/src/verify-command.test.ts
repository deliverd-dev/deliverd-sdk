import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSecureKeyUrl, keyAddress, VERIFY_EXIT, verifyOutcome } from "./commands/audit.js";
import { keyIdOf, packDigest, SIGNING_CONTEXT, verifyPack } from "./verify.js";

/**
 * `deliverd verify` says "Verified." only when the key came from somewhere
 * the pack did not choose. A forger who edits a pack signs it again with a
 * key of their own and names that key's address in the pack, so a check
 * against the pack's own key proves only that the file agrees with itself.
 */

function signedPack(keyUrl = "https://forger.example/.well-known/deliverd-evidence-key") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pack: Record<string, unknown> = { subject: { type: "report", id: "r1" }, entries: [], integrity: {} };
  const digest = packDigest(pack);
  const value = sign(null, Buffer.from(SIGNING_CONTEXT + digest, "utf8"), privateKey).toString("base64");
  pack.integrity = { digest, signature: { status: "signed", value, keyId: keyIdOf(publicKey), keyUrl } };
  return { pack, publicKey };
}

describe("what counts as verified", () => {
  const { pack, publicKey } = signedPack();
  const verdict = verifyPack(pack, publicKey);

  it("a good signature against a key you supplied is verified, exit 0", () => {
    expect(verdict.signature).toBe("valid");
    expect(verifyOutcome(verdict, { fromPack: false })).toEqual({
      verified: true,
      exitCode: VERIFY_EXIT.verified,
      keyTrusted: true,
    });
  });

  it("the same signature against the key the pack names is not, with its own exit code", () => {
    const outcome = verifyOutcome(verdict, { fromPack: true });
    expect(outcome.verified).toBe(false);
    expect(outcome.exitCode).toBe(VERIFY_EXIT.untrustedKey);
    expect(outcome.exitCode).not.toBe(VERIFY_EXIT.verified);
    expect(outcome.exitCode).not.toBe(VERIFY_EXIT.notVerified);
  });

  it("unless the caller passes --trust-pack-key", () => {
    expect(verifyOutcome(verdict, { fromPack: true }, true).verified).toBe(true);
  });

  it("a changed pack is not verified whichever key", () => {
    const tampered = { ...pack, entries: [{ forged: true }] };
    const bad = verifyPack(tampered, publicKey);
    expect(verifyOutcome(bad, { fromPack: false }).exitCode).toBe(VERIFY_EXIT.notVerified);
    expect(verifyOutcome(bad, { fromPack: true }, true).exitCode).toBe(VERIFY_EXIT.notVerified);
  });

  it("an unsigned pack is not verified", () => {
    expect(verifyOutcome(verifyPack({ integrity: {} }, null), null).verified).toBe(false);
  });
});

describe("where a key may be fetched from", () => {
  it("https, anywhere", () => {
    expect(() => assertSecureKeyUrl("https://deliverd.dev/.well-known/deliverd-evidence-key")).not.toThrow();
  });

  it("never plain http from an address the pack names, not even this machine", () => {
    expect(() => assertSecureKeyUrl("http://deliverd.dev/.well-known/deliverd-evidence-key")).toThrow(/https/);
    expect(() => assertSecureKeyUrl("http://localhost:3000/k")).toThrow(/https/);
    expect(() => keyAddress({}, undefined, { keyUrl: "http://deliverd.dev/k" })).toThrow(/https/);
    expect(() => keyAddress({}, undefined, { keyUrl: "http://127.0.0.1:3000/k" })).toThrow(/https/);
    expect(() => assertSecureKeyUrl("ftp://deliverd.dev/k")).toThrow();
    expect(() => assertSecureKeyUrl("not a url")).toThrow();
  });

  it("plain http only to this machine, and only when you named it", () => {
    expect(keyAddress({ url: "http://localhost:3000/" }, undefined, { keyUrl: null })).toEqual({
      url: "http://localhost:3000/.well-known/deliverd-evidence-key",
      fromPack: false,
    });
    expect(() => keyAddress({ url: "http://deliverd.dev" }, undefined, { keyUrl: null })).toThrow(/https/);
    expect(() => keyAddress({}, "http://deliverd.dev", { keyUrl: null })).toThrow(/https/);
  });

  it("prefers your address to the pack's, and says which it used", () => {
    const pack = { keyUrl: "https://forger.example/.well-known/deliverd-evidence-key" };
    expect(keyAddress({ url: "https://deliverd.dev" }, undefined, pack)?.fromPack).toBe(false);
    expect(keyAddress({}, "https://acme.deliverd.dev", pack)?.fromPack).toBe(false);
    expect(keyAddress({}, undefined, pack)).toEqual({ url: pack.keyUrl, fromPack: true });
    expect(keyAddress({}, undefined, { keyUrl: null })).toBeNull();
  });

  it("is checked before every fetch the command makes", () => {
    const source = readFileSync(join(__dirname, "commands", "audit.ts"), "utf8");
    const resolve = source.slice(source.indexOf("async function resolveKey"));
    const body = resolve.slice(0, resolve.indexOf("\n}\n"));
    expect(body.indexOf("keyAddress(")).toBeGreaterThan(0);
    expect(body.indexOf("keyAddress(")).toBeLessThan(body.indexOf("fetch("));
    // And it fetches the address that was checked, nothing else.
    expect(body).toContain("const { url, fromPack } = address;");
    expect(body).toContain("await fetch(url);");
    expect(source.match(/\bfetch\(/g)?.length).toBe(1);
  });
});
