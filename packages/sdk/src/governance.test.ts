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

describe("governance across the organisation", () => {
  it("keeps the register of AI systems", async () => {
    const { seen, deliverd } = recording({ aiSystems: [] });
    await deliverd.governance.aiSystems.list({ status: "active" });
    await deliverd.governance.aiSystems.get("s 1");
    await deliverd.governance.aiSystems.register({ name: "Claims triage", provider: "Anthropic", model: "claude", promptHash: "sha256:ab" });
    await deliverd.governance.aiSystems.update("s1", { risk: "high" });
    await deliverd.governance.aiSystems.recordModelChange("s1", { modelVersion: "2026-10", note: "New version" });
    expect(seen.map((s) => [s.method, s.url.replace("https://deliverd.example/api/v1", ""), s.body])).toEqual([
      ["GET", "/ai-systems?status=active", undefined],
      ["GET", "/ai-systems/s%201", undefined],
      ["POST", "/ai-systems", { name: "Claims triage", provider: "Anthropic", model: "claude", promptHash: "sha256:ab" }],
      ["PATCH", "/ai-systems/s1", { risk: "high" }],
      ["POST", "/ai-systems/s1/model-change", { modelVersion: "2026-10", note: "New version" }],
    ]);
  });

  it("returns the register's list, not its envelope", async () => {
    const { deliverd } = recording({ aiSystems: [{ id: "s1", name: "Claims triage" }] });
    expect(await deliverd.governance.aiSystems.list()).toEqual([{ id: "s1", name: "Claims triage" }]);
  });

  it("asks what an agent may do", async () => {
    const { seen, deliverd } = recording({ action: "send", mode: "approval" });
    const answer = await deliverd.governance.checkAuthority({ action: "send" });
    expect(answer.mode).toBe("approval");
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://deliverd.example/api/v1/governance/authority/evaluate", body: { action: "send" } });
  });

  it("reports incidents, reads them and drafts their DORA reports", async () => {
    const { seen, deliverd } = recording({ items: [], nextCursor: null });
    await deliverd.governance.incidents.report({ taskId: "t1", title: "Wrong payout", severity: "high" });
    await deliverd.governance.incidents.get("i1");
    await deliverd.governance.incidents.list({ status: "open", aiSystemId: "s1" });
    await deliverd.governance.incidents.listPage({ limit: 10, cursor: "c" });
    await deliverd.governance.incidents.draftReport("i1", { kind: "initial", content: "What happened", approvers: ["cro@example.com"] });
    expect(seen.map((s) => `${s.method} ${s.url.replace("https://deliverd.example/api/v1", "")}`)).toEqual([
      "POST /governance/incidents",
      "GET /governance/incidents/i1",
      "GET /governance/incidents?status=open&aiSystemId=s1",
      "GET /governance/incidents?limit=10&cursor=c",
      "POST /governance/incidents/i1/reports",
    ]);
    expect(seen[0]!.body).toEqual({ taskId: "t1", title: "Wrong payout", severity: "high" });
    expect(seen[4]!.body).toEqual({ kind: "initial", content: "What happened", approvers: ["cro@example.com"] });
  });

  it("follows the incident cursor to the end with no limit", async () => {
    const pages = [
      { items: [{ id: "i1" }], nextCursor: "c2" },
      { items: [{ id: "i2" }], nextCursor: null },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(pages.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const deliverd = new Deliverd({ apiKey: "dlv_test", baseUrl: "https://deliverd.example", fetch: fetchImpl });
    expect((await deliverd.governance.incidents.list()).map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(urls[1]).toContain("cursor=c2");
  });

  it("reads the frameworks, their mapping, the ICT register and the summary", async () => {
    const { seen, deliverd } = recording();
    await deliverd.governance.frameworks();
    await deliverd.governance.frameworkMapping({ taskId: "t1", framework: "eu_ai_act" });
    await deliverd.governance.createCustomFramework({
      key: "custom_underwriting",
      version: "1.0",
      name: "Underwriting AI standard",
      requirements: [{ ref: "UW-1", title: "A person signs off every decline", controls: ["human_oversight"] }],
    });
    await deliverd.governance.ictRegister();
    await deliverd.governance.summary({ risk: "high", provider: "Anthropic" });
    expect(seen.map((s) => `${s.method} ${s.url.replace("https://deliverd.example/api/v1", "")}`)).toEqual([
      "GET /governance/frameworks",
      "GET /governance/frameworks/mapping?taskId=t1&framework=eu_ai_act",
      "POST /governance/frameworks",
      "GET /governance/ict-register",
      "GET /governance/summary?risk=high&provider=Anthropic",
    ]);
  });

  it("governs a task, changes its profile, asks for control approval and reassessment, and exports the pack", async () => {
    const { seen, deliverd } = recording({ id: "t1", kind: "objective", status: "active" });
    await deliverd.tasks.govern("t1", { aiSystemId: "s1", risk: "high" });
    await deliverd.tasks.updateGovernanceProfile("t1", { personalData: true, expectedVersion: 3 });
    await deliverd.tasks.requestControlApproval("t1", "deployment_approval", { approvers: ["cto@example.com"] });
    await deliverd.tasks.triggerReassessment("t1", "The data source changed");
    await deliverd.tasks.evidencePack("t1");
    const task = await deliverd.tasks.get("t1");
    await task.govern();
    await task.updateGovernanceProfile({ customerFacing: true });
    await task.requestControlApproval("compliance_approval");
    await task.triggerReassessment("New jurisdiction");
    await task.evidencePack();
    expect(seen.map((s) => [s.method, new URL(s.url).pathname.replace("/api/v1", ""), s.body])).toEqual([
      ["POST", "/tasks/t1/governance", { aiSystemId: "s1", risk: "high" }],
      ["PATCH", "/tasks/t1/governance", { personalData: true, expectedVersion: 3 }],
      ["POST", "/tasks/t1/governance/controls/deployment_approval/approval", { approvers: ["cto@example.com"] }],
      ["POST", "/tasks/t1/governance/reassessments", { reason: "The data source changed" }],
      ["GET", "/tasks/t1/governance/pack", undefined],
      ["GET", "/tasks/t1", undefined],
      ["POST", "/tasks/t1/governance", {}],
      ["PATCH", "/tasks/t1/governance", { customerFacing: true }],
      ["POST", "/tasks/t1/governance/controls/compliance_approval/approval", {}],
      ["POST", "/tasks/t1/governance/reassessments", { reason: "New jurisdiction" }],
      ["GET", "/tasks/t1/governance/pack", undefined],
    ]);
  });

  it("is refused in development mode too", async () => {
    const deliverd = new Deliverd({ mode: "development", development: { log: false } });
    await expect(deliverd.governance.checkAuthority({ action: "send" })).rejects.toMatchObject({ code: "not_in_development_mode" });
  });
});
