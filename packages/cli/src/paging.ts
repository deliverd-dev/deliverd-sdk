import { api } from "./api.js";
import type { CliConfig } from "./config.js";

/**
 * One convention for the lists, the same one the SDK settled on.
 *
 * **No `--limit` means all of them; `--limit N` means one page of N.** The
 * API caps a page and returns `nextCursor`, and a CLI that printed the first
 * page and stopped would be telling somebody they have fifty reports when
 * they have four hundred — the exact misreading the cursor exists to
 * prevent. `deliverd list` did precisely that until now.
 *
 * `DRAIN_CEILING` is a stop, not a limit: something is wrong if a cursor
 * walk has not ended after this many rows, and looping forever against a
 * server that keeps handing back a cursor is worse than stopping.
 */
const DRAIN_CEILING = 10_000;

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const q = search.toString();
  return q ? `?${q}` : "";
}

/**
 * One page, with the cursor to continue from.
 *
 * `key` is the array's name in the response body — `reports`, `threads`,
 * `approvals` — because each endpoint names its own rather than sharing an
 * `items`.
 */
export async function page<T>(
  config: CliConfig,
  path: string,
  key: string,
  options: PageOptions & Record<string, string | number | undefined> = {}
): Promise<{ items: T[]; nextCursor: string | null }> {
  const body = await api<Record<string, unknown>>(
    config,
    "GET",
    `${path}${query(options)}`
  );
  return {
    items: (body[key] as T[] | undefined) ?? [],
    nextCursor: (body.nextCursor as string | null | undefined) ?? null,
  };
}

/** Follow the cursor to the end, so the array really is all of them. */
export async function collect<T>(
  config: CliConfig,
  path: string,
  key: string,
  options: Record<string, string | number | undefined> = {}
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  while (items.length < DRAIN_CEILING) {
    const result = await page<T>(config, path, key, { ...options, cursor });
    items.push(...result.items);
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  console.warn(
    `  ⚠ Stopped after ${items.length} rows; there may be more. Narrow the query, or use --limit and --cursor.`
  );
  return items;
}

/**
 * The rule above, applied: paged when asked, drained when not.
 *
 * Returns the cursor only in the paged case — there is nothing to continue
 * from when the walk already reached the end.
 */
export async function listing<T>(
  config: CliConfig,
  path: string,
  key: string,
  options: PageOptions & Record<string, string | number | undefined> = {}
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (options.limit === undefined && options.cursor === undefined) {
    return { items: await collect<T>(config, path, key, options), nextCursor: null };
  }
  return page<T>(config, path, key, options);
}
