import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseDigest, releaseFiles, releaseOf } from "./release";

/**
 * A release's fingerprint from its files: what `governance release` records
 * and `governance evidence --prompt` names, which must agree for evidence to
 * count — and which a pipeline without the CLI can reproduce with sha256sum.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  mkdirSync(join(dir, "prompts", "system"), { recursive: true });
  mkdirSync(join(dir, "prompts", ".git"));
  writeFileSync(join(dir, "prompts", "memo.md"), "Draft a credit memo.\n");
  writeFileSync(join(dir, "prompts", "system", "role.md"), "You are a careful credit analyst.\n");
  writeFileSync(join(dir, "prompts", ".DS_Store"), "noise");
  writeFileSync(join(dir, "prompts", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "guardrails.yaml"), "pii: block\n");
  return dir;
}

const hasSha256sum = (() => {
  try {
    execSync("sha256sum --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("a release's fingerprint", () => {
  it("of one file is its sha256, as sha256sum prints it", () => {
    const dir = repo();
    expect(releaseDigest(["guardrails.yaml"], dir)).toBe(`sha256:${sha("pii: block\n")}`);
  });

  it("of a directory is the sha256 of sha256sum's listing of its files in path order, dot-files left out", () => {
    const dir = repo();
    expect(releaseFiles(["prompts"], dir)).toEqual(["prompts/memo.md", "prompts/system/role.md"]);
    const listing = `${sha("Draft a credit memo.\n")}  prompts/memo.md\n${sha("You are a careful credit analyst.\n")}  prompts/system/role.md\n`;
    expect(releaseDigest(["prompts"], dir)).toBe(`sha256:${sha(listing)}`);
    // The same files named one by one, in any order, are the same release.
    expect(releaseDigest(["prompts/system/role.md", "prompts/memo.md"], dir)).toBe(releaseDigest(["prompts"], dir));
  });

  it.skipIf(!hasSha256sum)("is what the documented pipeline computes without the CLI", () => {
    const dir = repo();
    const shell = execSync("find prompts -type f -not -path '*/.*' | LC_ALL=C sort | xargs sha256sum | sha256sum", { cwd: dir, encoding: "utf8" });
    expect(releaseDigest(["prompts"], dir)).toBe(`sha256:${shell.split(" ")[0]}`);
    const single = execSync("sha256sum guardrails.yaml", { cwd: dir, encoding: "utf8" });
    expect(releaseDigest(["guardrails.yaml"], dir)).toBe(`sha256:${single.split(" ")[0]}`);
  });

  it("changes when a prompt changes, and never carries the text", () => {
    const dir = repo();
    const before = releaseDigest(["prompts"], dir);
    writeFileSync(join(dir, "prompts", "memo.md"), "Draft a short credit memo.\n");
    const after = releaseDigest(["prompts"], dir);
    expect(after).not.toBe(before);
    expect(after).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("says when a path is not there or holds nothing", () => {
    const dir = repo();
    mkdirSync(join(dir, "empty"));
    expect(() => releaseDigest(["missing.md"], dir)).toThrow(/missing\.md does not exist/);
    expect(() => releaseDigest(["empty"], dir)).toThrow(/holds no files/);
  });

  it("names the parts given, and nothing when none are", () => {
    const dir = repo();
    expect(releaseOf({ guardrails: ["guardrails.yaml"], model: "claude", modelVersion: "2026-10" }, dir)).toEqual({
      model: "claude",
      modelVersion: "2026-10",
      guardrailsHash: `sha256:${sha("pii: block\n")}`,
    });
    expect(releaseOf({}, dir)).toBeNull();
  });
});
