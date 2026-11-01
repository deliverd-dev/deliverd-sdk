import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markdownReport, parsePolicyText, readPolicies, replayHeadline, type Replay } from "./policy-files";

const YAML = `name: Refunds
rules:
  - name: Small refunds go through
    priority: 10
    effect: allow
    match:
      actions: [finance.refund]
      input:
        amount: { lte: 50 }
tests:
  - name: a small refund
    action: finance.refund
    input: { amount: 20 }
    expect: { effect: allow, rule: Small refunds go through }
`;

describe("policy files", () => {
  it("reads YAML and JSON alike", () => {
    const y = parsePolicyText("refunds.yaml", YAML);
    expect(y.name).toBe("Refunds");
    expect(y.rules[0]).toMatchObject({ effect: "allow", match: { input: { amount: { lte: 50 } } } });
    expect(y.tests[0]?.expect).toEqual({ effect: "allow", rule: "Small refunds go through" });
    const j = parsePolicyText("p.json", JSON.stringify({ name: "X", rules: [] }));
    expect(j.tests).toEqual([]);
  });

  it("names the file when it is wrong", () => {
    expect(() => parsePolicyText("bad.json", "{")).toThrow(/bad.json is not valid JSON/);
    expect(() => parsePolicyText("p.yml", "name: X")).toThrow(/p.yml needs a `name` and a `rules` list/);
  });

  it("reads a directory, one policy per file", () => {
    const dir = mkdtempSync(join(tmpdir(), "policies-"));
    writeFileSync(join(dir, "b.yaml"), YAML);
    writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "Mail", rules: [] }));
    writeFileSync(join(dir, "README.md"), "ignored");
    expect(readPolicies(dir).map((f) => f.name)).toEqual(["Mail", "Refunds"]);
    writeFileSync(join(dir, "c.yml"), YAML);
    expect(() => readPolicies(dir)).toThrow(/both describe "Refunds"/);
  });
});

describe("reports", () => {
  const replay: Replay = {
    policyName: "Refunds",
    days: 30,
    replayed: 120,
    changed: 3,
    loosened: 2,
    tightened: 1,
    rejectedNowAllowed: 1,
    ruleChanged: 0,
    transitions: [{ from: "require_human", to: "allow", count: 2 }],
    examples: [{ id: "x", createdAt: "2026-10-20T10:00:00Z", actionId: "finance.refund", from: "require_human", to: "allow", toRule: "Small", outcome: "rejected" }],
    notes: [],
    fail: true,
    failReason: "1 request a person rejected would now be allowed without asking.",
  };

  it("says what changes in one line", () => {
    expect(replayHeadline(replay)).toBe("3 of 120 requests from the last 30 days would be decided differently: 2 would ask less, 1 would ask more.");
    expect(replayHeadline({ ...replay, replayed: 0 })).toBe("No gated requests in the last 30 days to replay.");
  });

  it("writes a pull request summary", () => {
    const md = markdownReport([
      {
        file: parsePolicyText("refunds.yaml", YAML),
        test: { policyName: "Refunds", passed: 0, failed: 1, results: [{ name: "a small refund", passed: false, effect: "require_human", rule: null, problem: "Expected allow, got require_human (no rule matched)." }], notes: [] },
        replay,
      },
    ]);
    expect(md).toContain("**Tests:** 0 passed, 1 failed.");
    expect(md).toContain("- ❌ a small refund: Expected allow");
    expect(md).toContain("| a person | allowed | 2 |");
    expect(md).toContain("**Failing:** 1 request a person rejected");
  });
});
