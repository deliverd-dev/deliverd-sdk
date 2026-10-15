import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the published tarball contains.
 *
 * Nothing in the build fails when this is wrong, and nothing in a consumer's
 * install fails either — the package resolves, the types resolve, and the one
 * thing that breaks is the one thing this SDK is built around: a developer
 * pressing go-to-definition on `deliverd.approve` and reading why it does what
 * it does. The compiler emits a `.d.ts.map` beside every declaration pointing
 * at `../src/*.ts`; ship the declarations without the source and every one of
 * those pointers lands on a file that is not there.
 *
 * Found by extracting a real `npm pack` and resolving each map, so these
 * assertions describe a defect that existed rather than one imagined.
 */

const DIR = join(__dirname, "..");

const manifest = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8")) as {
  files: string[];
  publishConfig?: { access?: string };
};
const tsconfig = readFileSync(join(DIR, "tsconfig.json"), "utf8");
const readmeText = readFileSync(join(DIR, "README.md"), "utf8");

describe("the published package", () => {
  it("ships the source the declaration maps point at", () => {
    // The two travel together. Either emit the maps and ship what they name,
    // or emit neither.
    if (/"declarationMap"\s*:\s*true/.test(tsconfig)) {
      expect(
        manifest.files,
        'tsconfig emits declaration maps naming ../src/*.ts, and package.json does not ship "src". Every go-to-definition in a consumer\'s editor lands on a missing file.'
      ).toContain("src");
    }
  });

  it("keeps the tests out of it", () => {
    /*
     * `files: ["src"]` takes the whole directory, tests included — and those
     * import vitest, which is a devDependency. A consumer's bundler that walks
     * the package then resolves an import nobody installed.
     */
    expect(
      manifest.files,
      "package.json ships src without excluding the tests, so the tarball carries imports of vitest."
    ).toContain("!src/**/*.test.ts");
  });

  it("goes out public without anyone remembering a flag", () => {
    /*
     * npm defaults a scoped package to restricted. Forget `--access public` on
     * the first publish and it lands private — installable by nobody, and the
     * developer page links straight at it. Stating it in the manifest means the
     * flag cannot be the thing that was forgotten, here or in CI.
     */
    expect(
      manifest.publishConfig?.access,
      "package.json no longer declares public access, so a publish without --access public goes out restricted."
    ).toBe("public");
  });

  it("does not tell the reader a primitive is missing when it is there", () => {
    /*
     * The readme said `review()` was "not in this package yet" for exactly as
     * long as it took to ship it. Nothing failed: the sentence was true when
     * written and became a lie without being touched, which is the shape of
     * documentation drift that only a reader ever finds.
     *
     * So the claim is read against the code. A method the client defines must
     * not be listed as absent, and a method it does not define must not be
     * shown as something to call.
     */
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    const index = readFileSync(join(DIR, "src/index.ts"), "utf8");
    for (const method of ["approve", "review", "confirm", "collect"]) {
      const defined = new RegExp(`async ${method}\\(|\\s${method}\\(`).test(index);
      const calledInReadme = readme.includes(`deliverd.${method}(`);
      const saidAbsent = new RegExp(`\`${method}\\(\\)\`[^.]{0,200}not in this package`).test(readme);
      if (defined) {
        expect(
          saidAbsent,
          `The readme says ${method}() is not in this package, and the client defines it.`
        ).toBe(false);
      } else {
        expect(
          calledInReadme,
          `The readme shows deliverd.${method}(), and the client does not define it.`
        ).toBe(false);
      }
    }
  });

  /*
   * The same rule for the namespaces. `flows` is not a `deliverd.x()` verb —
   * it is a collection with a handle hanging off it — so the check above
   * cannot see it, and a namespace nobody documents is one nobody finds.
   */
  it("documents every namespace it exposes", () => {
    const index = readFileSync(join(DIR, "src/index.ts"), "utf8");
    const declared = [...index.matchAll(/^  readonly (\w+):/gm)]
      .map((m) => m[1]!)
      .filter((name) => name !== "http" && name !== "development");
    expect(declared.length, "No namespaces found; this guard is reading the wrong thing.").toBeGreaterThan(3);
    for (const name of declared) {
      /*
       * Either spelling counts. `webhooks` is taught through the standalone
       * `constructEvent` export under its own heading rather than as
       * `deliverd.webhooks.…`, and demanding one particular phrasing would
       * mean documenting a second way to do the same thing to satisfy a test.
       * The requirement is that the namespace is written about at all.
       */
      const heading = `\n## ${name[0]!.toUpperCase()}${name.slice(1)}\n`;
      expect(
        readmeText.includes(`deliverd.${name}.`) || readmeText.includes(heading),
        `The client exposes deliverd.${name} and the readme neither calls it nor has a section for it.`
      ).toBe(true);
    }
  });

  it("exposes every namespace it documents", () => {
    /*
     * The other direction, and the one that goes quiet rather than red: the
     * check above asks whether what is exposed is written about, so deleting
     * the assignment leaves a readme teaching `deliverd.schedules` against a
     * client that has no such property. A reader following the front page
     * gets `undefined is not an object`, and nothing here disagreed.
     */
    const index = readFileSync(join(DIR, "src/index.ts"), "utf8");
    const taught = new Set(
      [...readmeText.matchAll(/deliverd\.(\w+)\./g)].map((m) => m[1]!)
    );
    expect(taught.size, "No namespace calls found in the readme.").toBeGreaterThan(3);
    for (const name of taught) {
      expect(
        index,
        `The readme teaches deliverd.${name} and the client never assigns it.`
      ).toContain(`this.${name} = new `);
    }
  });

  /*
   * A section that appears twice is a stray from an edit, and the readme is
   * the package's front page on npm — the one file nobody runs and everybody
   * reads.
   */
  it("says each thing once", () => {
    const headings = readmeText.split("\n").filter((line) => line.startsWith("## "));
    const seen = new Set<string>();
    for (const heading of headings) {
      expect(seen.has(heading), `"${heading}" appears twice in the readme.`).toBe(false);
      seen.add(heading);
    }
  });

  it("still ships the built output, the readme and the licence", () => {
    for (const entry of ["dist", "README.md", "LICENSE"]) {
      expect(manifest.files, `package.json no longer ships ${entry}.`).toContain(entry);
    }
  });
});
