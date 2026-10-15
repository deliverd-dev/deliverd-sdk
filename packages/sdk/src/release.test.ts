import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLISHED_TO_NPM } from "./released.js";

const PKG_DIR = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files: string[];
  scripts: Record<string, string>;
  main: string;
};

/**
 * What a `npm publish` will actually hand somebody.
 *
 * Written after a republish was attempted and refused: `403 — You cannot
 * publish over the previously published versions: 0.5.0`. npm is right, and
 * the refusal was the first thing to notice that the package had drifted four
 * commits ahead of what anyone could install. Among them the idempotency
 * work, so `deliverd.approve()` was retry-safe in the repository and not on
 * npm, while the readiness report said it had shipped.
 *
 * Nothing here can know what npm currently holds — the registry is not
 * reachable from a test. What it can do is make the tarball's contents
 * provable, so the only unknown left is the version number.
 */

describe("the published package carries the code, not just the source", () => {
  it("ships a build, and rebuilds before publishing", () => {
    // `files` includes dist, so a stale dist is what customers get. The
    // prepublish hook is the only thing standing between an edit and a
    // tarball built from last week.
    expect(pkg.files).toContain("dist");
    expect(pkg.main.startsWith("./dist/")).toBe(true);
    expect(
      pkg.scripts.prepublishOnly,
      "nothing rebuilds before publish, so the tarball is whatever dist happened to hold"
    ).toContain("build");
  });

  it("does not ship its own tests", () => {
    expect(pkg.files).toContain("!src/**/*.test.ts");
  });
});

describe("the built output has the behaviour the docs claim", () => {
  /*
   * Read from dist rather than src. Every other guard in this repo reads
   * source, which is right for intent — but the question here is what is in
   * the box, and those are different files.
   */
  const dist = (file: string) => readFileSync(join(PKG_DIR, "dist", file), "utf8");

  it("sends an idempotency key, in the build", () => {
    const http = dist("http.js");
    expect(
      http,
      "the built client does not send Idempotency-Key — the repository is retry-safe and the package is not"
    ).toContain("Idempotency-Key");
    // Only on POST. A key on a GET would be noise the server has to ignore.
    expect(http).toContain('"POST"');
  });

  it("exposes the approval fields added after 0.5.0", () => {
    /*
     * On `ApprovalData`, not `Decision` — worth naming, because I got it
     * wrong first and a whole-file check could not tell me. `requiredApprovals`
     * appears four times across these types, so asserting it merely exists
     * passes with it removed from the one type that should carry it.
     */
    const types = dist("types.d.ts");
    const at = types.indexOf("interface ApprovalData");
    expect(at, "ApprovalData is no longer exported from the built types").toBeGreaterThan(-1);
    const shape = types.slice(at, types.indexOf("\n}", at));
    for (const field of ["requiredApprovals", "approvalsSoFar"]) {
      /*
       * The declaration, not the word. `requiredApprovals` is also named in
       * the doc comment on the line below it, so matching the bare name kept
       * this green with the field itself deleted — which is exactly what its
       * own regression did.
       */
      expect(
        shape,
        `${field} is missing from ApprovalData in the built types — an older install reads it as undefined without erroring`
      ).toMatch(new RegExp(`\\b${field}\\s*:\\s*number`));
    }
  });

  it("is built from the current source, not a stale dist", () => {
    /*
     * The trap this whole file exists for. `prepublishOnly` covers a real
     * publish, but a dist committed behind its source is misleading to
     * everything that reads it in between — this test included.
     */
    const src = readFileSync(join(PKG_DIR, "src", "http.ts"), "utf8");
    const built = dist("http.js");
    expect(
      src.includes("idempotencyKey") && built.includes("idempotencyKey"),
      "dist is behind src; run `pnpm --filter @deliverd/sdk build`"
    ).toBe(true);
  });
});

/**
 * The newest version known to be on npm. Raise it after each publish.
 *
 * 0.5.0 sat here first and was the reason this file exists: it predated the
 * idempotency key, so a `npm publish` was refused with 403 and the refusal
 * was the first thing to notice the package had drifted four commits behind
 * the repository.
 *
 * 0.6.1 raised it again, for a smaller reason with the same shape: development
 * mode could not list approvals, so `externalId` — the retry safety every
 * example uses — threw a 501 for anyone without an account. The examples ask
 * for ^0.6.1 and cannot run below it.
 *
 * Be honest about what this can and cannot do. A test cannot reach the
 * registry, so it cannot know whether the working version has already been
 * published — it will not stop a second `npm publish` of the same number.
 * What it stops is the version moving *below* what is already out there,
 * which is the one mistake that guarantees a 403 and is invisible in review.
 */


/** -1, 0 or 1, comparing dotted numeric versions. */
function compare(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/*
 * Derived, not typed. This was `"0.6.1"` while npm served 0.7.0 — not false,
 * but three releases low, so the floor had quietly stopped refusing 0.6.5,
 * which is the 403 it exists to prevent. `PUBLISHED_TO_NPM` is the one place
 * that fact lives now, and the newest entry is the floor by construction.
 */
const PUBLISHED = [...PUBLISHED_TO_NPM].sort(compare).at(-1)!;

/*
 * Removed with the 0.6.0 raise: a check that the idempotency option had not
 * arrived in a 0.5.x patch. It was true when written and is settled history
 * now — it could only fail by someone setting the version back to 0.5.x,
 * which the floor above already catches, and a check hard-coded to the string
 * "5" would read as live guidance long after it stopped being about anything.
 */

describe("the version says something about what changed", () => {
  it("takes its floor from the newest version actually published", () => {
    /*
     * Deriving `PUBLISHED` is only a convention until something fails when it
     * stops being derived. Replacing it with a literal is how it went wrong
     * the first time: `"0.6.1"` while npm served 0.7.0 — not false, and
     * silently three releases too low, so it had stopped refusing 0.6.5. A
     * floor below the newest release refuses nothing worth refusing.
     */
    const newest = [...PUBLISHED_TO_NPM].sort(compare).at(-1)!;
    expect(
      PUBLISHED,
      `the floor is ${PUBLISHED} and the newest published version is ${newest}. A hard-coded floor goes stale on the next release and stops catching the 403 it exists for.`
    ).toBe(newest);
  });

  it("compares versions by number, not by string", () => {
    /*
     * The arithmetic this replaces read `major > 0 || minor > 5`, which is
     * fine until it is not — and a string compare would put 0.10.0 below
     * 0.9.0 and 0.6.0 below 0.60.0. Worth eight lines and a test, because
     * the failure is silent and arrives only once the numbers get big.
     */
    expect(compare("0.6.0", "0.5.0")).toBe(1);
    expect(compare("0.10.0", "0.9.0")).toBe(1);
    expect(compare("1.0.0", "0.60.0")).toBe(1);
    expect(compare("0.6.0", "0.6.0")).toBe(0);
    expect(compare("0.5.9", "0.6.0")).toBe(-1);
  });

  it("is not below what npm already holds", () => {
    expect(
      compare(pkg.version, PUBLISHED),
      `${pkg.version} is below ${PUBLISHED}, which npm already holds. Publishing it would be refused with 403.`
    ).toBeGreaterThanOrEqual(0);
  });
});
