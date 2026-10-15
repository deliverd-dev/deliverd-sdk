import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/**
 * Approve with changes, through `approve()`, in development mode — which
 * applies the imaginary approver's `edits` the way production does: only to
 * fields you offered, and only on an approval.
 */

const proposal = {
  title: "Refund order 1042",
  input: { orderId: "1042", amount: 420 },
  editableFields: ["amount"],
};

function client(development: Record<string, unknown>) {
  return new Deliverd({ mode: "development", development: { log: false, ...development } });
}

describe("approve() with an input", () => {
  it("returns what to run with, corrected, and what changed", async () => {
    const decision = await client({ edits: { amount: 300, orderId: "9999" } }).approve(proposal);
    expect(decision.approved).toBe(true);
    // orderId was not offered, so it stands.
    expect(decision.input).toEqual({ orderId: "1042", amount: 300 });
    expect(decision.changes).toEqual([{ field: "amount", from: 420, to: 300 }]);
  });

  it("returns the proposal when it was approved as it stood", async () => {
    const decision = await client({}).approve(proposal);
    expect(decision.input).toEqual(proposal.input);
    expect(decision.changes).toEqual([]);
  });

  it("returns nothing to run on a no", async () => {
    const decision = await client({ outcome: "rejected", edits: { amount: 300 } }).approve(proposal);
    expect(decision.approved).toBe(false);
    expect(decision.input).toBeNull();
  });

  it("returns null input when none was sent, so a caller cannot mistake {} for approval to run", async () => {
    const decision = await client({}).approve({ title: "Deploy" });
    expect(decision.input).toBeNull();
  });
});
