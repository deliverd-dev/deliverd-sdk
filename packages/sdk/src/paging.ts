import type { HttpClient } from "./http.js";

/**
 * What the SDK does about a list that does not fit in one answer.
 *
 * The API says where it stopped: a response carries `nextCursor`, null when
 * the page is the end of the list and a string to pass back when it is not.
 * That leaves the client one decision, and it is worth stating rather than
 * leaving to whoever reads the call:
 *
 * **`limit` set means one page of that size. `limit` unset means all of
 * them.** `list()` with no limit follows the cursor until the API stops
 * offering one, so `.length` is the real count rather than a page size that
 * happens to look like one. A caller who wants to page by hand asks for a
 * `limit`, or uses `listPage` and drives the cursor themselves.
 *
 * The alternative — return a page and let the caller notice — reads fine and
 * fails quietly, because a full page and a complete list are indistinguishable
 * until somebody counts.
 */
export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Follow the cursor to the end, collecting as we go.
 *
 * `fetchPage` is whatever single request the caller's endpoint makes; this
 * only decides when to ask again. A page that comes back empty while still
 * offering a cursor ends the loop as well — a server that did that would
 * otherwise spin here for ever.
 */
export async function collect<T>(
  fetchPage: (cursor: string | null) => Promise<PageOf<T>>
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: PageOf<T> = await fetchPage(cursor);
    all.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) return all;
    cursor = page.nextCursor;
  }
}

/** One page, or every page, depending on whether a limit was asked for. */
export async function listOrCollect<T>(
  input: PageInput,
  fetchPage: (query: { limit?: number; cursor?: string }) => Promise<PageOf<T>>
): Promise<T[]> {
  if (input.limit !== undefined) {
    const page = await fetchPage({ limit: input.limit, cursor: input.cursor });
    return page.items;
  }
  return collect((cursor) => fetchPage({ cursor: cursor ?? undefined }));
}

export type { HttpClient };
