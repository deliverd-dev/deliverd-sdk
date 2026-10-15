import { describe, expect, it } from "vitest";
import { evidenceBody } from "./commands/compliance.js";

describe("governance evidence", () => {
  const base = { control: ["model_evaluation"], format: "deliverd" };

  it("pulls a Langfuse experiment by name, with no keys of its own", () => {
    expect(evidenceBody({ ...base, langfuse: "credit-memo-v12" }, undefined, undefined)).toEqual({
      type: "model_evaluation",
      title: "Langfuse: credit-memo-v12",
      controls: ["model_evaluation"],
      pull: { source: "langfuse", experiment: "credit-memo-v12" },
    });
  });

  it("looks from --since, sent as a time", () => {
    const body = evidenceBody({ ...base, langfuse: "credit-memo-v12" }, undefined, new Date("2026-09-01"));
    expect(body.pull).toEqual({ source: "langfuse", experiment: "credit-memo-v12", since: "2026-09-01T00:00:00.000Z" });
  });

  it("names the run's tool as Langfuse when the run is described by hand", () => {
    expect(evidenceBody({ ...base, langfuse: "x", runUrl: "https://ci.example/run/9" }, undefined, undefined).run).toEqual({ tool: "langfuse", url: "https://ci.example/run/9" });
  });

  it("pulls a LangSmith experiment by name or prefix the same way", () => {
    expect(evidenceBody({ ...base, langsmith: "credit-memo-v12" }, undefined, new Date("2026-09-01"))).toEqual({
      type: "model_evaluation",
      title: "LangSmith: credit-memo-v12",
      controls: ["model_evaluation"],
      pull: { source: "langsmith", experiment: "credit-memo-v12", since: "2026-09-01T00:00:00.000Z" },
    });
    expect(evidenceBody({ ...base, langsmith: "x", runName: "nightly" }, undefined, undefined).run).toEqual({ tool: "langsmith", name: "nightly" });
  });

  it("pulls a Braintrust experiment the same way", () => {
    expect(evidenceBody({ ...base, braintrust: "credit-memo-v12" }, undefined, undefined)).toEqual({
      type: "model_evaluation",
      title: "Braintrust: credit-memo-v12",
      controls: ["model_evaluation"],
      pull: { source: "braintrust", experiment: "credit-memo-v12" },
    });
  });

  it("pulls a Weave evaluation the same way", () => {
    expect(evidenceBody({ ...base, weave: "credit-memo-v12" }, undefined, undefined)).toEqual({
      type: "model_evaluation",
      title: "Weave: credit-memo-v12",
      controls: ["model_evaluation"],
      pull: { source: "weave", experiment: "credit-memo-v12" },
    });
  });

  it("names the release the run tested, with a report or a pull", () => {
    const release = { promptHash: "sha256:abc", modelVersion: "2026-10" };
    expect(evidenceBody({ ...base, report: "out.json", format: "promptfoo" }, "{}", undefined, release)).toMatchObject({ report: { format: "promptfoo" }, release });
    expect(evidenceBody({ ...base, weave: "credit-memo-v12" }, undefined, undefined, release)).toMatchObject({ pull: { source: "weave" }, release });
    expect(evidenceBody(base, undefined, undefined)).not.toHaveProperty("release");
  });

  it("pulls from one tool at a time", () => {
    expect(() => evidenceBody({ ...base, langfuse: "a", langsmith: "b" }, undefined, undefined)).toThrow(/not both --langfuse and --langsmith/);
    expect(() => evidenceBody({ ...base, langsmith: "a", braintrust: "b" }, undefined, undefined)).toThrow(/not both --langsmith and --braintrust/);
    expect(() => evidenceBody({ ...base, braintrust: "a", weave: "b" }, undefined, undefined)).toThrow(/not both --braintrust and --weave/);
  });

  it("sends a report as before, and never a pull with it", () => {
    const body = evidenceBody({ ...base, report: "out.json", format: "promptfoo" }, "{}", undefined);
    expect(body).toMatchObject({ title: "promptfoo run", report: { format: "promptfoo", content: "{}" } });
    expect(body).not.toHaveProperty("pull");
  });
});
