import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLISHED_TO_NPM, RELEASED, REMOVED } from "./released";

/**
 * `--version` is the one command whose entire job is answering "which version
 * am I on", and it shipped a 0.2.0 release reporting 0.1.0 — because the
 * number lived both in `package.json` and in a string literal, and releasing
 * only touches the first.
 *
 * The fix is that there is now one copy. This is here to keep it that way.
 */
const root = join(__dirname, "..");

describe("the reported version", () => {
  it("is read from the manifest, not written down", () => {
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(source).toContain('readFileSync(new URL("../package.json"');
    expect(source).toContain(".version(version)");
  });

  it("has no version literal left to drift", () => {
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(source).not.toMatch(/\.version\(\s*["'`]\d+\.\d+\.\d+/);
  });

  it("resolves the manifest from one directory up, which holds for src and dist", () => {
    // `src/index.ts` and `dist/index.js` are each one level below the
    // manifest, so the same relative path works in development and when
    // installed from npm. A published CLI that cannot find its own
    // package.json crashes on startup, not on --version.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toContain("dist");
  });
});

/**
 * Every command token the CLI registers, from source.
 *
 * Flat and unqualified: `comments retract` contributes `retract`, and that is
 * the point — what changes when a verb is added is this set, whether the verb
 * is top-level or hangs off a group.
 */
function commandsInSource(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(full);
    }
  };
  walk(join(root, "src"));
  const names = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/\.command\("([a-z-]+)"/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe("what the published version can do", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };

  it("is recorded for the version in the manifest", () => {
    /*
     * 0.3.0 went to npm mid-slice and landed three commands short — `send`,
     * `unshare` and `comments retract` were merged and documented within hours
     * either side of the publish, so `docs/cli.md` taught three things that
     * `npm i -g deliverd` did not install. The version had not moved since
     * before any of them existed, and nothing said so.
     */
    expect(
      RELEASED[pkg.version],
      `No command set is recorded for ${pkg.version}. Add one to RELEASED — a version nobody has accounted for is a version that ships whatever happened to be on the branch.`
    ).toBeDefined();
  });

  it("matches what the source actually registers", () => {
    // The forcing function. Adding a verb fails here until the set is
    // recorded, and recording it against the current version is refused by
    // the assertion above only if that version is new — so the honest move is
    // to bump, which is exactly what did not happen before 0.3.0.
    const recorded = [...(RELEASED[pkg.version] ?? [])].sort();
    expect(
      commandsInSource(),
      `The CLI's commands have changed since ${pkg.version} was recorded. Bump the version and record the new set, or whatever is published will be missing them.`
    ).toEqual(recorded);
  });

  it("only ever grew", () => {
    /*
     * Both directions, in version order: a command that disappears between
     * releases is a breaking change somebody has to have decided on, and this
     * is where it gets noticed rather than in an issue from whoever scripted
     * against it.
     */
    // Numerically: as text, "0.10.0" sorts before "0.3.0" and every command
    // added since 0.3.0 would read as dropped.
    const numeric = (v: string) => v.split(".").map(Number);
    const versions = Object.keys(RELEASED).sort((x, y) => {
      const [a, b] = [numeric(x), numeric(y)];
      return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    });
    for (let i = 1; i < versions.length; i++) {
      const before = new Set(RELEASED[versions[i - 1]!]);
      const lost = [...before].filter((c) => !RELEASED[versions[i]!]!.includes(c));
      const decided = REMOVED[versions[i]!] ?? {};
      expect(
        lost.filter((c) => !(c in decided)),
        `${versions[i]} drops ${lost.join(", ")} — that breaks anybody scripting against ${versions[i - 1]}. ` +
          "If it was decided, record the decision in REMOVED."
      ).toEqual([]);
      // A decision for a removal that did not happen is a note nobody can check.
      expect(Object.keys(decided).filter((c) => !lost.includes(c)), `${versions[i]} records removals it does not make`).toEqual([]);
    }
    for (const v of Object.keys(REMOVED)) expect(RELEASED[v], `REMOVED names ${v}, which is not in RELEASED`).toBeDefined();
  });
});

describe("what npm has actually been sent", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };

  it("is ahead of the version that is actually on npm", () => {
    /*
     * Lifted from the SDK, which learned it the hard way. A test cannot reach
     * the registry; what it can do is refuse the version known to be taken,
     * so new commands cannot sit under a number npm has already served — the
     * state 0.3.0 shipped in, three commands short.
     */
    expect(
      [...PUBLISHED_TO_NPM],
      `${pkg.version} is already on npm. npm refuses a republish, so this has to be a new version — and the code under the old number is what nobody can install.`
    ).not.toContain(pkg.version);
  });

  it("has a recorded command set for the newest published version", () => {
    // The doc guard in the web app diffs the working surface against the
    // published one. A published version with no entry gives it nothing to
    // diff against, and a guard with nothing to compare passes.
    const newest = [...PUBLISHED_TO_NPM].at(-1)!;
    expect(
      RELEASED[newest],
      `${newest} is recorded as published and has no entry in RELEASED, so nothing can say what it lacks.`
    ).toBeDefined();
  });

  it("only ever appends, in order", () => {
    // A ledger somebody re-sorted or trimmed is a ledger somebody edited by
    // hand, and the whole point is that entries are added at publish time and
    // never revised.
    const numeric = (v: string) => v.split(".").map(Number);
    for (let i = 1; i < PUBLISHED_TO_NPM.length; i++) {
      const [a, b] = [numeric(PUBLISHED_TO_NPM[i - 1]!), numeric(PUBLISHED_TO_NPM[i]!)];
      const later = b[0]! > a[0]! || (b[0] === a[0] && (b[1]! > a[1]! || (b[1] === a[1] && b[2]! > a[2]!)));
      expect(later, `${PUBLISHED_TO_NPM[i]} follows ${PUBLISHED_TO_NPM[i - 1]} out of order.`).toBe(true);
    }
  });
});
