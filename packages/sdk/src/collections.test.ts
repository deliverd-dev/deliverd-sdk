import { beforeEach, describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";
import { DeliverdTimeoutError } from "./errors.js";

/** The fifth primitive, driven the way the readme writes it. */

const quiet = { log: false } as const;

const QUESTIONS = [
  { prompt: "Headcount at 30 September", kind: "number" as const },
  { prompt: "Any disposals in the quarter?", kind: "boolean" as const },
  { prompt: "Which basis?", kind: "choice" as const, options: ["Accrual", "Cash"] },
];

beforeEach(() => {
  delete process.env.DELIVERD_API_KEY;
  delete process.env.DELIVERD_MODE;
  delete process.env.DELIVERD_DEV_OUTCOME;
});

describe("deliverd.collect()", () => {
  it("asks, waits, and comes back with the answers keyed by the question", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const { complete, answers } = await deliverd.collect({
      title: "Before I file the Q3 return",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
    });
    expect(complete).toBe(true);
    expect(Object.keys(answers)).toEqual(QUESTIONS.map((q) => q.prompt));
  });

  it("gives back the type the question asked for, not a string of it", async () => {
    /*
     * The whole reason the kinds exist. A caller who writes
     * `answers[prompt] + 1` should find out here that it is a number.
     */
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const { answers } = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
    });
    expect(typeof answers["Headcount at 30 September"]).toBe("number");
    expect(typeof answers["Any disposals in the quarter?"]).toBe("boolean");
    expect(["Accrual", "Cash"]).toContain(answers["Which basis?"]);
  });

  it("resolves rather than throwing when it closes unanswered", async () => {
    // There is no way to say no to a question, only to leave it. That ending
    // is the one a caller most needs to have thought about.
    const deliverd = new Deliverd({
      mode: "development",
      development: { ...quiet, outcome: "rejected" },
    });
    const result = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
    });
    expect(result.complete).toBe(false);
    expect(result.status).toBe("expired");
    expect(result.responses).toEqual([]);
  });

  it("gives up when nobody answers, naming where it is still open", async () => {
    const deliverd = new Deliverd({
      mode: "development",
      development: { ...quiet, outcome: "timeout" },
    });
    await expect(
      deliverd.collect({
        title: "Q3",
        respondents: ["finance@firm.example"],
        questions: QUESTIONS,
        timeout: 300,
      })
    ).rejects.toBeInstanceOf(DeliverdTimeoutError);
  });

  it("reuses an existing request rather than asking the same people twice", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const first = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
      externalId: "q3_close",
    });
    const second = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
      externalId: "q3_close",
    });
    expect(second.id).toBe(first.id);
  });

  it("names who answered, and only counts the ones who did", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const { responses, collection } = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example", "ops@firm.example"],
      questions: QUESTIONS,
    });
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.respondent)).toContain("ops@firm.example");
    expect(collection.submittedCount).toBe(2);
    expect(collection.askedCount).toBe(2);
  });

  it("expires by default, so a wait always ends", async () => {
    const deliverd = new Deliverd({ mode: "development", development: quiet });
    const { collection } = await deliverd.collect({
      title: "Q3",
      respondents: ["finance@firm.example"],
      questions: QUESTIONS,
    });
    expect(
      collection.expiresAt,
      "collect() no longer sets an expiry, so a wait on it need never end."
    ).toBeTruthy();
  });
});
