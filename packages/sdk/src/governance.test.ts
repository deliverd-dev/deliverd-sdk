import { describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/**
 * Compliance Mode on tasks, as the wire sees it: the route, the method, and
 * the body each call sends. The API's own behaviour — thresholds, the newest
 * run deciding, an agent refused — is proved against a real database in the
 * web app (`scored-evidence.integration.test.ts`); this holds the SDK to the
 * routes that test exercises.
 */

function recording(answer: unknown = { ok: true }) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const deliverd = new Deliverd({ apiKey: "dlv_test", baseUrl: "https://deliverd.example", fetch: fetchImpl });
  return { seen, deliverd };
}

describe("governance on tasks", () => {
  it("reads a governed task's governance", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.governance("t 1");
    expect(seen[0]).toMatchObject({ method: "GET", url: "https://deliverd.example/api/v1/tasks/t%201/governance" });
  });

  it("submits results, or a tool's own report, as the body", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.submitEvidence("t1", {
      type: "red_team",
      title: "Red-team run",
      controls: ["resilience_testing"],
      run: { tool: "garak", runId: "r-1", url: "https://ci.example/r/1" },
      results: [{ metric: "attack_success_rate", value: 0.02 }, { metric: "pi", value: 1, passed: false, severity: "critical" }],
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "https://deliverd.example/api/v1/tasks/t1/governance/evidence",
      body: { type: "red_team", controls: ["resilience_testing"], run: { tool: "garak", runId: "r-1" } },
    });
    await deliverd.tasks.submitEvidence("t1", {
      type: "model_evaluation",
      title: "promptfoo run",
      controls: ["model_evaluation"],
      report: { format: "promptfoo", content: "{}" },
    });
    expect(seen[1]!.body).toMatchObject({ report: { format: "promptfoo", content: "{}" } });
  });

  it("names a Langfuse experiment to pull, with no keys of its own", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.submitEvidence("t1", {
      type: "model_evaluation",
      title: "Prompt v12 evaluation",
      controls: ["model_evaluation"],
      pull: { source: "langfuse", experiment: "credit-memo-v12", since: "2026-10-01T00:00:00Z" },
    });
    expect(seen[0]!.body).toEqual({
      type: "model_evaluation",
      title: "Prompt v12 evaluation",
      controls: ["model_evaluation"],
      pull: { source: "langfuse", experiment: "credit-memo-v12", since: "2026-10-01T00:00:00Z" },
    });
  });

  it("names a Weave evaluation the same way", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.submitEvidence("t1", { type: "model_evaluation", title: "Prompt v12", controls: ["model_evaluation"], pull: { source: "weave", experiment: "credit-memo-v12" } });
    expect(seen[0]!.body).toMatchObject({ pull: { source: "weave", experiment: "credit-memo-v12" } });
  });

  it("names a Braintrust experiment the same way", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.submitEvidence("t1", { type: "model_evaluation", title: "Prompt v12", controls: ["model_evaluation"], pull: { source: "braintrust", experiment: "credit-memo-v12" } });
    expect(seen[0]!.body).toMatchObject({ pull: { source: "braintrust", experiment: "credit-memo-v12" } });
  });

  it("names a LangSmith experiment the same way", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.submitEvidence("t1", { type: "model_evaluation", title: "Prompt v12", controls: ["model_evaluation"], pull: { source: "langsmith", experiment: "credit-memo-v12" } });
    expect(seen[0]!.body).toMatchObject({ pull: { source: "langsmith", experiment: "credit-memo-v12" } });
  });

  it("asks the gate, with an action when given", async () => {
    const { seen, deliverd } = recording();
    await deliverd.tasks.checkGovernanceGate("t1");
    await deliverd.tasks.checkGovernanceGate("t1", { action: "customer_decision" });
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", "https://deliverd.example/api/v1/tasks/t1/governance/gate"],
      ["GET", "https://deliverd.example/api/v1/tasks/t1/governance/gate?action=customer_decision"],
    ]);
  });

  it("cannot set thresholds: a person does, in the app, and no key may", () => {
    const { deliverd } = recording();
    expect("setThresholds" in deliverd.tasks).toBe(false);
  });

  it("does the same from a task handle", async () => {
    const { seen, deliverd } = recording({ id: "t1", kind: "objective", status: "active" });
    const task = await deliverd.tasks.get("t1");
    await task.governance();
    await task.submitEvidence({ type: "test_result", title: "Tests", report: { format: "junit", content: "<testsuite/>" } });
    await task.checkGovernanceGate();
    expect("setThresholds" in task).toBe(false);
    expect(seen.slice(1).map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "GET /api/v1/tasks/t1/governance",
      "POST /api/v1/tasks/t1/governance/evidence",
      "GET /api/v1/tasks/t1/governance/gate",
    ]);
  });

  it("is refused in development mode, which does not simulate governance", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { log: false } });
    await expect(deliverd.tasks.checkGovernanceGate("t1")).rejects.toMatchObject({ code: "not_in_development_mode" });
  });
});
