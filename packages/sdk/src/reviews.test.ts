import { beforeEach, describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";
import { DeliverdTimeoutError } from "./errors.js";

/**
 * The fourth primitive, driven the way the front page writes it.
 *
 * In development mode, which means these also prove development mode for
 * reviews: it is the same code path a real key takes, with the network
 * swapped out.
 */

const quiet = { log: false } as const;

beforeEach(() => {
  delete process.env.DELIVERD_API_KEY;
  delete process.env.DELIVERD_MODE;
  delete process.env.DELIVERD_DEV_OUTCOME;
});

describe("deliverd.review()", () => {
  it("asks, waits, and comes back approved", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const outcome = await deliverd.review({
      title: "Q3 board pack",
      instructions: "Check the figures against the ledger.",
      reviewers: ["partner@firm.example"],
    });
    expect(outcome.approved).toBe(true);
    expect(outcome.status).toBe("approved");
    expect(outcome.url).toContain("/reviews/");
  });

  it("resolves on changes requested rather than throwing", async () => {
    /*
     * The whole point. A refusal on a piece of work is an answer, and the
     * most useful one — it comes with what to change. Throwing would make the
     * ordinary path an exception handler.
     */
    const deliverd = new Deliverd({
      mode: "development",
      development: { ...quiet, outcome: "rejected" },
    });
    const outcome = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
    });
    expect(outcome.approved).toBe(false);
    expect(outcome.status).toBe("changes_requested");
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0]!.verdict).toBe("changes_requested");
    expect(outcome.verdicts[0]!.note, "A refusal with no reason is useless.").toBeTruthy();
  });

  it("names who gave each verdict, not their id", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const outcome = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
    });
    expect(outcome.verdicts[0]!.by).toBe("partner@firm.example");
  });

  it("gives up when nobody reviews it, naming where it is still open", async () => {
    const deliverd = new Deliverd({
      mode: "development",
      development: { ...quiet, outcome: "timeout" },
    });
    await expect(
      deliverd.review({
        title: "Q3 board pack",
        reviewers: ["partner@firm.example"],
        timeout: 300,
      })
    ).rejects.toBeInstanceOf(DeliverdTimeoutError);
  });

  it("reuses an existing request rather than asking the same people twice", async () => {
    // A crash between "asked" and "recorded that I asked" must not produce
    // two notifications for one piece of work.
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const first = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
      externalId: "pack_2026q3",
    });
    const second = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
      externalId: "pack_2026q3",
    });
    expect(second.id).toBe(first.id);
  });

  it("carries the thread count, so the agent knows there is feedback to read", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const outcome = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
    });
    expect(typeof outcome.threadCount).toBe("number");
  });

  it("expires by default, so a wait always ends", async () => {
    /*
     * The default belongs to the primitive, not to `reviews.create()`: the
     * resource call is the API as it is, and the API does not invent a
     * deadline. `review()` is the convenience, and a convenience that can
     * wait forever is not one.
     */
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const outcome = await deliverd.review({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
    });
    expect(
      outcome.review.expiresAt,
      "review() no longer sets an expiry, so a wait on it need never end."
    ).toBeTruthy();

    const raw = await deliverd.reviews.create({
      title: "Q3 board pack",
      reviewers: ["partner@firm.example"],
    });
    expect(
      raw.toJSON().expiresAt,
      "reviews.create() invented a deadline the caller did not ask for."
    ).toBeNull();
  });
});
