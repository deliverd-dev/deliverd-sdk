import { describe, expect, it } from "vitest";
import { collect, listOrCollect } from "./paging.js";

/**
 * The SDK's half of the rule.
 *
 * The API says where a page stopped; this decides what to do about it. The
 * decision worth testing is the one a caller inherits without reading any of
 * this: **a `limit` means one page of that size, no `limit` means all of
 * them.** Returning one page from a method called `list` and leaving the
 * caller to notice is how a full page comes to be mistaken for a whole list.
 */

const pageOf = (items: number[], nextCursor: string | null) => ({ items, nextCursor });

describe("collect", () => {
  it("follows the cursor to the end", async () => {
    const asked: (string | null)[] = [];
    const all = await collect<number>(async (cursor) => {
      asked.push(cursor);
      if (cursor === null) return pageOf([1, 2], "c1");
      if (cursor === "c1") return pageOf([3, 4], "c2");
      return pageOf([5], null);
    });
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(asked, "each page resumes from the one before").toEqual([null, "c1", "c2"]);
  });

  it("asks once when the first page is the whole list", async () => {
    let calls = 0;
    const all = await collect<number>(async () => {
      calls += 1;
      return pageOf([1, 2, 3], null);
    });
    expect(all).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });

  it("stops on an empty page even if a cursor is still offered", async () => {
    /*
     * A server that keeps handing back a cursor with no rows would spin here
     * for ever, and "the SDK hung" is a worse failure than a short list. This
     * is the loop's own floor, not a claim about the server.
     */
    let calls = 0;
    const all = await collect<number>(async () => {
      calls += 1;
      return pageOf([], "always-more");
    });
    expect(all).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("what a limit means", () => {
  it("one page, when they asked for a size", async () => {
    let calls = 0;
    const items = await listOrCollect<number>({ limit: 2 }, async (q) => {
      calls += 1;
      expect(q.limit, "the size is passed through").toBe(2);
      return pageOf([1, 2], "more");
    });
    // A cursor came back and it was not followed: they asked for two.
    expect(items).toEqual([1, 2]);
    expect(calls).toBe(1);
  });

  it("all of them, when they did not", async () => {
    const items = await listOrCollect<number>({}, async (q) =>
      q.cursor ? pageOf([3], null) : pageOf([1, 2], "more")
    );
    expect(items).toEqual([1, 2, 3]);
  });

  it("carries a cursor the caller supplied with a limit", async () => {
    // Paging by hand: the caller drives, so both halves go through untouched.
    const seen: { limit?: number; cursor?: string }[] = [];
    await listOrCollect<number>({ limit: 5, cursor: "c9" }, async (q) => {
      seen.push(q);
      return pageOf([], null);
    });
    expect(seen).toEqual([{ limit: 5, cursor: "c9" }]);
  });
});
