import { describe, expect, it } from "vitest";
import { changeLines, checkEditable, parseInput } from "./input";

describe("--input", () => {
  it("takes inline JSON, a file with @path, and standard input with @-", () => {
    expect(parseInput('{"amount": 1240}')).toEqual({ amount: 1240 });
    const files: Record<string, string> = { "refund.json": '{"to":"acme"}', "-": '{"from":"stdin"}' };
    expect(parseInput("@refund.json", (p) => files[p]!)).toEqual({ to: "acme" });
    expect(parseInput("@-", (p) => files[p]!)).toEqual({ from: "stdin" });
  });

  it("refuses anything that is not a JSON object, saying how to fix it", () => {
    expect(() => parseInput("amount=1240")).toThrow(/Quote it for the shell/);
    expect(() => parseInput("[1,2]")).toThrow(/JSON object/);
    expect(() => parseInput("null")).toThrow(/JSON object/);
    expect(() => parseInput("@bad.json", () => "{not json")).toThrow(/that file is not JSON/);
  });
});

describe("--editable", () => {
  it("needs --input, and only names fields the input has", () => {
    expect(() => checkEditable(["amount"], undefined)).toThrow(/needs --input/);
    expect(() => checkEditable(["amount", "memo"], { amount: 1 })).toThrow(/names memo/);
    expect(() => checkEditable(["amount"], { amount: 1 })).not.toThrow();
    expect(() => checkEditable(undefined, undefined)).not.toThrow();
  });
});

describe("what an approver changed", () => {
  it("reads as one line per field", () => {
    expect(changeLines([{ field: "amount", from: 1240, to: 1000 }])).toEqual(["amount: 1240 → 1000"]);
    expect(changeLines(undefined)).toEqual([]);
  });
});
