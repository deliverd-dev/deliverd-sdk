import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXPLANATIONS } from "./messages";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FROZEN, PUBLISHED_TO_NPM, RELEASED } from "./released.js";

/**
 * The half `release.test.ts` says it cannot do.
 *
 * That file proves what a tarball contains and states plainly that "the only
 * unknown left is the version number", because the registry is not reachable
 * from a test. It could not be — but the *source* can be held to a ledger of
 * what each version was published with, and that catches the same bug one step
 * earlier: a public surface that has grown since the last recorded release,
 * under a version number npm has already served.
 *
 * Which is exactly what happened. The package sat thirteen commits and
 * fifty-four surface items ahead of npm's 0.6.2 — `decidedById`, the
 * `Schedules` namespace, the analytics and paging types — while `docs/api.md`
 * and the site described all of it as shipped.
 */

const DIR = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8")) as { version: string };
const types = readFileSync(join(__dirname, "types.ts"), "utf8");
const index = readFileSync(join(__dirname, "index.ts"), "utf8");
const adapters = readFileSync(join(__dirname, "adapters", "index.ts"), "utf8");

/**
 * Everything a caller can reach, computed rather than listed.
 *
 * Three kinds of item, because a release can add any of them and each is
 * something somebody has to install the package to get:
 *
 * - an export from the entry point — a class, a function, a type;
 * - a field of an exported object type, which is where `decidedById` lived
 *   and where a list-only-the-exports version of this guard would have missed
 *   it entirely;
 * - a webhook event name, which a receiver branches on;
 * - an export from `@deliverd/sdk/adapters`, prefixed `adapters:` because it
 *   is imported from a different path and a name can mean something else
 *   there.
 */
function surface(): string[] {
  const items = new Set<string>();

  for (const [, group] of index.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const part of group!.split(",")) {
      const name = part.trim().replace(/^type /, "");
      // `x as y` re-exports are one name to a caller, not two; skipping the
      // pair rather than guessing which half is the public one.
      if (name && !name.includes(" as ")) items.add(name);
    }
  }
  for (const [, name] of index.matchAll(/^export (?:class|const|interface|type) (\w+)/gm)) {
    items.add(name!);
  }

  for (const match of types.matchAll(/^export (?:interface|type) (\w+)(?: \{| = \{)/gm)) {
    const body = types.slice(match.index! + match[0]!.length);
    const end = body.indexOf("\n}");
    for (const [, field] of body.slice(0, end).matchAll(/^ {2}(\w+)\??:/gm)) {
      items.add(`${match[1]}.${field}`);
    }
  }

  for (const [, group] of adapters.matchAll(/^export (?:type )?\{([^}]+)\}/gm)) {
    for (const part of group!.split(",")) {
      const name = part.trim();
      if (name && !name.includes(" as ")) items.add(`adapters:${name}`);
    }
  }
  expect([...items].some((item) => item.startsWith("adapters:")), "The adapters entry exports nothing the guard can see.").toBe(true);

  const from = types.indexOf("export type WebhookEventName");
  const to = types.indexOf("export interface WebhookEvent");
  expect(from, "WebhookEventName is gone from the SDK.").toBeGreaterThan(-1);
  for (const [, event] of types.slice(from, to).matchAll(/\| "([\w.]+)"/g)) {
    items.add(`event:${event}`);
  }

  return [...items].sort();
}

/** -1, 0 or 1, comparing dotted numeric versions. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

describe("what the source offers is what a released version carries", () => {
  it("records the version in package.json", () => {
    expect(
      RELEASED[pkg.version],
      `package.json is at ${pkg.version} and released.ts has no entry for it. ` +
        `Bump the version and record its surface — publishing over a version npm ` +
        `has already served is refused, and shipping new code under one is worse: ` +
        `it succeeds everywhere except npm.`
    ).toBeTruthy();
  });

  it("offers exactly what this version recorded", () => {
    const recorded = [...(RELEASED[pkg.version] ?? [])].sort();
    const current = surface();

    const added = current.filter((i) => !recorded.includes(i));
    const removed = recorded.filter((i) => !current.includes(i));

    expect(
      added,
      `The SDK's public surface has grown since ${pkg.version} was recorded. ` +
        `Bump the version and record the new surface, or these are things the ` +
        `documentation can describe and nobody can install.`
    ).toEqual([]);
    expect(
      removed,
      `The SDK no longer offers something ${pkg.version} recorded. That is a ` +
        `breaking change for anyone who upgraded — a major bump and a note in ` +
        `CHANGELOG.md, not a quiet removal.`
    ).toEqual([]);
  });

  it("never rewrites a version somebody already installed", () => {
    /*
     * An entry is a claim about a tarball that exists on a registry and cannot
     * be changed. Editing one makes this file say something about 0.7.0 that
     * 0.7.0 does not do, which is worse than having no ledger — so every
     * published entry is fingerprinted in `FROZEN` and any change to one
     * fails below.
     */
    expect(Object.keys(RELEASED).length, "A recorded version disappeared.").toBeGreaterThan(0);
    for (const [version, items] of Object.entries(RELEASED)) {
      expect(new Set(items).size, `${version} records a duplicate item.`).toBe(items.length);
      expect(items.length, `${version} records an implausibly small surface.`).toBeGreaterThan(50);
    }

    /*
     * The two assertions above are plausibility, not integrity, and the
     * comment over this test used to claim otherwise — "the count is pinned
     * per version and a change to an old entry fails here". It was not
     * pinned; it was a floor of fifty. Deleting one name from 0.7.0 passed
     * all of it, and the repository would then describe a tarball that does
     * something else. `FROZEN` is the pin the comment was describing.
     */
    for (const [version, digest] of Object.entries(FROZEN)) {
      expect(
        [...PUBLISHED_TO_NPM],
        `${version} is frozen but is not recorded as published. A fingerprint is ` +
          `only meaningful for a tarball that already exists.`
      ).toContain(version);

      const items = RELEASED[version];
      expect(
        items,
        `${version} is frozen and its recorded surface is gone. Iterating the ` +
          `fingerprints rather than the entries is deliberate: a loop over ` +
          `RELEASED would skip a deleted entry and report green.`
      ).toBeTruthy();

      expect(
        createHash("sha256").update((items ?? []).join("\n")).digest("hex"),
        `${version} is published and its recorded surface no longer matches its ` +
          `fingerprint. That entry describes a tarball on npm that cannot change, ` +
          `so either the edit is wrong or it belongs to a different version.`
      ).toBe(digest);
    }

    /*
     * And the pin cannot be dodged by simply not adding one: a published
     * version that carries a ledger entry carries a fingerprint too. Only
     * 0.6.2 and earlier are exempt, because they predate the ledger and have
     * no entry to fingerprint.
     */
    for (const version of PUBLISHED_TO_NPM) {
      if (!RELEASED[version]) continue;
      expect(
        Object.keys(FROZEN),
        `${version} has a recorded surface and no fingerprint, so it can be ` +
          `edited freely — which is the hole this pair of loops closes.`
      ).toContain(version);
    }
  });

  it("agrees with the changelog about what has shipped", () => {
    /*
     * The list above cannot be verified from here — no test reaches a
     * registry — so it is held against the one thing a release *always*
     * updates: the changelog. Every published version needs an entry, and
     * every entry below the working version is a version that went out.
     *
     * This is what makes staleness fail rather than rot. The list stopped at
     * 0.6.2 while npm served 0.7.0, and nothing noticed because nothing else
     * in the repository knew the fact twice.
     */
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const entries = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]!);
    expect(entries.length, "CHANGELOG.md has no version headings.").toBeGreaterThan(1);

    /*
     * Only from the changelog's own beginning. CHANGELOG.md starts at 0.7.0 —
     * everything before it shipped without one, the same carve-out `RELEASED`
     * makes for the same reason: reconstructing entries for versions nobody
     * wrote them for would be asserting a history that was never recorded.
     */
    const earliest = [...entries].sort(compareVersions)[0]!;
    for (const version of PUBLISHED_TO_NPM) {
      if (compareVersions(version, earliest) < 0) continue;
      expect(
        entries,
        `${version} is recorded as published to npm and has no CHANGELOG.md entry. One of the two is wrong.`
      ).toContain(version);
    }
    for (const entry of entries) {
      if (entry === pkg.version) continue;
      expect(
        [...PUBLISHED_TO_NPM],
        `CHANGELOG.md describes ${entry}, which is neither the working version nor recorded as published. If it shipped, add it to PUBLISHED_TO_NPM; if it did not, it should not have an entry yet.`
      ).toContain(entry);
    }
  });

  it("is ahead of the version that is actually on npm", () => {
    /*
     * The one thing still unprovable from here, written down rather than
     * assumed: a test cannot reach the registry. What it can do is refuse the
     * version that is known to be taken, so the specific mistake that caused
     * this file cannot be made twice.
     */
    expect(
      [...PUBLISHED_TO_NPM],
      `${pkg.version} is already on npm. npm refuses a republish, so this has to ` +
        `be a new version — and the code under the old number is what nobody can install.`
    ).not.toContain(pkg.version);
  });

  it("numbers an addition as a minor, not a patch", () => {
    /*
     * The working version steps forward as soon as a release lands, and the
     * number it steps to is a guess about what comes next. 0.7.2 was chosen
     * with an unchanged surface, which makes it right today and wrong the
     * moment somebody adds an export and leaves the number alone — a patch
     * that carries new API, so a caller pinned to ~0.7.1 gets it without
     * asking and a caller reading the changelog never learns it arrived.
     *
     * The other guards here cannot see this. `RELEASED[pkg.version]` is
     * satisfied by recording the addition under 0.7.2, and the floor only
     * refuses going backwards. This is the one that makes the guess honest:
     * grow the surface and the minor has to move.
     *
     * Stated as a single unconditional expectation rather than an early
     * return, because a guard that skips itself when the interesting case is
     * absent is a guard that reports green for the wrong reason.
     */
    const newest = [...PUBLISHED_TO_NPM].sort(compareVersions).at(-1)!;
    const shipped = RELEASED[newest];
    expect(shipped, `${newest} is published and has no recorded surface.`).toBeTruthy();

    const added = surface().filter((item) => !(shipped ?? []).includes(item));
    const [publishedMajor, publishedMinor] = newest.split(".").map(Number);
    const [workingMajor, workingMinor] = pkg.version.split(".").map(Number);
    const samePatchLine =
      publishedMajor === workingMajor && publishedMinor === workingMinor;

    expect(
      added.length > 0 && samePatchLine,
      `${pkg.version} is a patch on ${newest} and offers ${added.length} thing(s) ` +
        `${newest} does not: ${added.join(", ")}. Additions are a minor — rename ` +
        `this version and its entry in released.ts, or the new API ships to ` +
        `everyone pinned to a patch range without a line in the changelog.`
    ).toBe(false);
  });

  it("names codes that exist, and as many as it says", () => {
    /*
     * The 0.8.2 entry is a list of error codes, and a changelog naming one
     * that does not exist sends a reader grepping for a string the package
     * never emits — the same failure as a hint under a code nobody receives,
     * one file over.
     *
     * Sliced to the two bullets that do the listing, because the prose around
     * them names `upload_id`, `deliverd.http` and a handful of predicates,
     * none of which is a code. Inside those bullets every backticked token is
     * one.
     */
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const entry = changelog.slice(
      changelog.indexOf("## 0.8.2"),
      changelog.indexOf("## 0.8.1")
    );
    expect(entry.length, "CHANGELOG.md has no 0.8.2 entry to check.").toBeGreaterThan(400);

    const bullets = [...entry.matchAll(/^- \*\*(?:The gate|Five 404s)[\s\S]*?(?=\n\n)/gm)];
    expect(bullets.length, "The two listing bullets were not found; the check below would pass on nothing.").toBe(2);

    const named = bullets.flatMap((b) => [...b[0].matchAll(/`([a-z][a-z_]+)`/g)].map((m) => m[1]!));
    for (const code of named) {
      expect(
        Object.keys(EXPLANATIONS),
        `CHANGELOG.md's 0.8.2 entry names ${code}, which the package does not explain.`
      ).toContain(code);
    }

    const claimed = /\bten codes\b/.test(entry);
    expect(claimed, "The 0.8.2 entry no longer says how many codes it changed.").toBe(true);
    expect(
      new Set(named).size,
      `The entry says ten codes and lists ${new Set(named).size}.`
    ).toBe(10);
  });
});
