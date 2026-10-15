import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * A release's fingerprint, worked out from the files it is built from: the
 * prompt files and the guardrail configuration. Only the digest leaves the
 * machine, never the text.
 *
 * The digest is one a pipeline can reproduce without this CLI:
 *
 * - **One file:** the sha256 of its bytes — what `sha256sum file` prints.
 * - **Several, or a directory:** the sha256 of `sha256sum`'s own output over
 *   them, one `<hex>  <path>` line each in path order, the paths relative to
 *   the working directory with forward slashes. That is
 *   `find prompts -type f -not -path '*\/.*' | LC_ALL=C sort | xargs sha256sum | sha256sum`
 *   run from the same directory.
 *
 * A directory is read whole, its dot-files and dot-directories (`.git`,
 * `.DS_Store`) left out. Either way the result is `sha256:<64 hex>`.
 */

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

/** The files the paths name, relative to `cwd`, with forward slashes, in path order. */
export function releaseFiles(paths: string[], cwd = process.cwd()): string[] {
  const files = paths.flatMap((p) => {
    const full = resolve(cwd, p);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      throw new Error(`${p} does not exist.`);
    }
    return isDir ? walk(full) : [full];
  });
  const named = [...new Set(files.map((f) => relative(cwd, f).split(sep).join("/")))];
  if (named.length === 0) throw new Error(`${paths.join(", ")} holds no files to fingerprint.`);
  // By code unit, as `LC_ALL=C sort` orders them.
  return named.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The fingerprint of the files the paths name: `sha256:<hex>`. */
export function releaseDigest(paths: string[], cwd = process.cwd()): string {
  const files = releaseFiles(paths, cwd);
  if (files.length === 1) return `sha256:${sha256(readFileSync(resolve(cwd, files[0]!)))}`;
  const listing = files.map((f) => `${sha256(readFileSync(resolve(cwd, f)))}  ${f}\n`).join("");
  return `sha256:${sha256(listing)}`;
}

export interface ReleaseOptions {
  prompt?: string[];
  guardrails?: string[];
  provider?: string;
  model?: string;
  modelVersion?: string;
}

/** The release the options name — digests of the files, and the model as given — or null when they name none. */
export function releaseOf(options: ReleaseOptions, cwd = process.cwd()): Record<string, string> | null {
  const release: Record<string, string> = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelVersion ? { modelVersion: options.modelVersion } : {}),
    ...(options.prompt?.length ? { promptHash: releaseDigest(options.prompt, cwd) } : {}),
    ...(options.guardrails?.length ? { guardrailsHash: releaseDigest(options.guardrails, cwd) } : {}),
  };
  return Object.keys(release).length ? release : null;
}
