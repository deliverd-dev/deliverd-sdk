import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { readBundle } from "./bundle.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "deliverd-cli-test-"));
}

describe("readBundle", () => {
  it("reads a single html file", () => {
    const dir = scratch();
    const file = join(dir, "report.html");
    writeFileSync(file, "<html></html>");
    const bundle = readBundle(file);
    expect(bundle.kind).toBe("html");
    expect(Buffer.from(bundle.data).toString()).toBe("<html></html>");
  });

  it("zips a folder, skipping junk", () => {
    const dir = scratch();
    writeFileSync(join(dir, "index.html"), "<html></html>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "junk.js"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");

    const bundle = readBundle(dir);
    expect(bundle.kind).toBe("zip");
    const entries = Object.keys(unzipSync(bundle.data)).sort();
    expect(entries).toEqual(["assets/app.js", "index.html"]);
  });

  it("rejects unsupported files", () => {
    const dir = scratch();
    const file = join(dir, "report.pdf");
    writeFileSync(file, "%PDF");
    expect(() => readBundle(file)).toThrow();
  });
});
