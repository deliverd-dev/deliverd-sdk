import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync, type Zippable } from "fflate";

const SKIP = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX"]);

/** Read a report path (file or directory) into a publishable payload. */
export function readBundle(path: string): {
  kind: "html" | "zip";
  data: Uint8Array;
} {
  const stat = statSync(path);

  if (stat.isFile()) {
    // A video on its own: zipped under its name, and given a page to play
    // in when it is published.
    if (/\.(mp4|webm)$/i.test(path)) {
      const name = path.split(/[\\/]/).pop()!;
      return { kind: "zip", data: zipSync({ [name]: [new Uint8Array(readFileSync(path)), { level: 0 }] }) };
    }
    if (/\.(html?|zip)$/i.test(path)) {
      return {
        kind: path.toLowerCase().endsWith(".zip") ? "zip" : "html",
        data: new Uint8Array(readFileSync(path)),
      };
    }
    throw new Error("Only .html, .htm, .zip, .mp4 or .webm files can be published directly.");
  }

  // Directory → zip it.
  const entries: Zippable = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else {
        const bytes = new Uint8Array(readFileSync(full));
        // Video is already compressed: store it rather than spend minutes
        // deflating a couple of hundred megabytes for nothing.
        entries[relative(path, full)] = /\.(mp4|webm)$/i.test(name) ? [bytes, { level: 0 }] : bytes;
      }
    }
  };
  walk(path);
  if (Object.keys(entries).length === 0) {
    throw new Error("The folder is empty.");
  }
  return { kind: "zip", data: zipSync(entries) };
}
