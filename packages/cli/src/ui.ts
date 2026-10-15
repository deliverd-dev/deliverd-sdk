import { exec } from "node:child_process";
import { ApiError } from "./api.js";

/**
 * Everything the commands print, in one place.
 *
 * The rule the whole CLI follows: **every command that returns something
 * takes `--json`.** It shipped on `publish` alone, which meant a pipeline
 * could get the URL of what it had just published and then had to parse
 * human prose for anything else — and human prose is exactly what changes
 * when somebody improves the wording.
 */

/** Print the machine form, or run the human one. Never both. */
export function emit(json: boolean | undefined, data: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

export function fail(err: unknown): never {
  if (err instanceof ApiError) {
    console.error(`Error (${err.code}): ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

/**
 * Wrap a command body so a failure prints one line instead of a stack.
 *
 * Every command had the same try/catch around it and one of them will
 * eventually be written without it; this makes forgetting impossible.
 */
export function run<A extends unknown[]>(
  body: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await body(...args);
    } catch (err) {
      fail(err);
    }
  };
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

export function day(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

/** A count with the right noun, because "1 comments" reads like a bug. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
