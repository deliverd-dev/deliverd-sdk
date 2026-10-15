import { beforeEach, describe, expect, it } from "vitest";
import { Deliverd } from "./index.js";

/**
 * The Task Graph loop, driven the way the readme writes it: an objective, a
 * side task branched out of it, a structured result, applied back.
 *
 * Behavioural, against development mode, because what matters is what comes
 * back — the objective at the top of every context, the result reaching the
 * parent — and that can only be checked by running it.
 */

const quiet = { log: false } as const;

beforeEach(() => {
  delete process.env.DELIVERD_API_KEY;
  delete process.env.DELIVERD_MODE;
  delete process.env.DELIVERD_DEV_OUTCOME;
});

function client() {
  return new Deliverd({ mode: "development", development: quiet });
}

describe("deliverd.tasks", () => {
  it("starts an objective, open, at the root of its own tree", async () => {
    const task = await client().tasks.create({
      title: "Ship SSO",
      objective: "Customers can sign in with their identity provider.",
    });
    expect(task.kind).toBe("objective");
    expect(task.active).toBe(true);
    expect(task.isSideTask).toBe(false);
    expect(task.rootTaskId).toBe(task.id);
    expect(task.url).toContain(task.id);
    expect(task.resumed).toBe(false);
  });

  it("resumes the open objective for a reference instead of starting a second", async () => {
    const deliverd = client();
    const first = await deliverd.tasks.create({ title: "Ship SSO", objective: "x", externalId: "sso" });
    const again = await deliverd.tasks.create({ title: "Ship SSO", objective: "x", externalId: "sso" });
    expect(again.id, "A restarted agent started a second objective for the same goal.").toBe(first.id);
    expect(again.resumed).toBe(true);
  });

  it("starts a new one when the last objective for that reference is finished", async () => {
    const deliverd = client();
    const first = await deliverd.tasks.create({ title: "Ship SSO", objective: "x", externalId: "sso" });
    await first.cancel({ reason: "Replanned" });
    const next = await deliverd.tasks.create({ title: "Ship SSO again", objective: "x", externalId: "sso" });
    expect(next.id).not.toBe(first.id);
    expect(next.resumed).toBe(false);
  });

  it("says the objective first in every context, including a side task's", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "Ship SSO", objective: "Customers can sign in with SSO." });
    const side = await task.createSideTask({ title: "Token audience", goal: "Find why the token is refused." });
    const context = await side.context();
    expect(context.rootObjective).toBe("Customers can sign in with SSO.");
    expect(context.task.isSideTask).toBe(true);
    expect(context.path.map((p) => p.id)).toEqual([task.id, side.id]);
    expect(context.reanchor).toContain("Customers can sign in with SSO.");
    // The same shape as the API's: development mode publishes nothing, so the list is there and empty.
    expect(context.reports).toEqual([]);
  });

  it("carries a completed side task's result into the parent when applied", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({
      title: "Ship SSO",
      objective: "Customers can sign in with SSO.",
      state: { openQuestions: ["Why is the token refused?"] },
    });
    const side = await task.createSideTask({
      title: "Token audience",
      goal: "Find why the token is refused.",
      kind: "debug",
      resolvesQuestion: "Why is the token refused?",
    });
    expect(side.kind).toBe("debug");
    expect(side.parentTaskId).toBe(task.id);

    await side.complete({
      summary: "The access token is issued for the wrong audience.",
      findings: [{ title: "Audience mismatch", description: "aud is the SPA, not the API." }],
      suggestedNextAction: "Request the token for the API audience.",
    });
    expect(side.completed).toBe(true);

    // Waiting for somebody to choose, until applied.
    expect((await task.context()).sideTasks.awaitingOutcome.map((s) => s.id)).toEqual([side.id]);

    const applied = await side.apply();
    expect(applied.sideTask.outcome).toBe("applied");
    expect(side.outcome, "The handle did not take the side task's new state.").toBe("applied");
    expect(applied.context.nextAction).toBe("Request the token for the API audience.");
    expect(
      applied.context.openQuestions,
      "The question the side task was opened to answer is still open on the parent."
    ).not.toContain("Why is the token refused?");
    expect(applied.context.relevantFindings.map((f) => f.title)).toContain("Audience mismatch");

    await expect(side.apply(), "A result applied twice would land in the parent twice.").rejects.toThrow(
      /already been applied/i
    );
  });

  it("refuses to apply a result that does not exist yet", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "t", objective: "o" });
    const side = await task.createSideTask({ title: "s", goal: "g" });
    await expect(deliverd.tasks.apply(side.id)).rejects.toThrow(/not been completed/i);
  });

  it("keeps the earlier result when a task is reopened", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "t", objective: "o" });
    await task.complete({ summary: "First answer." });
    await task.reopen();
    expect(task.active).toBe(true);
    expect(task.result).toBeNull();
    expect(task.toJSON().previousResults.map((r) => r.summary)).toEqual(["First answer."]);
  });

  it("refuses an update somebody else got in before", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "t", objective: "o" });
    const read = task.version;
    await deliverd.tasks.update(task.id, { state: { currentState: "Halfway" } });
    await expect(
      task.update({ status: "blocked", expectedVersion: read }),
      "A stale write went through and overwrote somebody else's."
    ).rejects.toThrow(/changed since you read it/i);
  });

  it("records a decision as a suggestion, never as decided", async () => {
    const task = await client().tasks.create({ title: "t", objective: "o" });
    const decision = await task.addFinding({ kind: "decision", title: "Use the API audience" });
    expect(decision.decisionStatus).toBe("suggested");
    expect((await task.context()).decisions.suggested).toEqual(["Use the API audience"]);
  });

  it("lists objectives only, with their side tasks counted", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "Ship SSO", objective: "o" });
    await task.createSideTask({ title: "s", goal: "g" });
    const listed = await deliverd.tasks.list({ status: "active" });
    expect(listed.map((t) => t.id)).toEqual([task.id]);
    expect(listed[0]!.toJSON().sideTasks).toEqual({ open: 1, done: 0, awaiting: 0 });
  });

  it("draws the whole tree from any task in it", async () => {
    const deliverd = client();
    const task = await deliverd.tasks.create({ title: "t", objective: "o" });
    const side = await task.createSideTask({ title: "s", goal: "g" });
    const other = await deliverd.tasks.create({ title: "u", objective: "p" });
    const link = await side.link({ targetTaskId: other.id, kind: "related_to" });
    expect(link.created).toBe(true);
    expect((await side.link({ targetTaskId: other.id, kind: "related_to" })).created).toBe(false);

    const graph = await side.graph();
    expect(graph.root.id).toBe(task.id);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([task.id, side.id].sort());
    expect(graph.links).toHaveLength(1);

    const read = await deliverd.tasks.get(task.id);
    expect(read.children.map((c) => c.id)).toEqual([side.id]);
  });

  it("calls the routes the API serves, with the methods it serves them on", async () => {
    // Watch the wire: development mode answers by path, so this is what
    // proves `update()` is a PATCH and the nested routes are spelled right.
    const seen: string[] = [];
    const deliverd = client();
    const original = deliverd.http.request.bind(deliverd.http);
    deliverd.http.request = async (options: Parameters<typeof original>[0]) => {
      seen.push(`${options.method} ${options.path.replace(/tsk_dev_\d+/g, "{}").replace(/fnd_dev_\d+/g, "{}")}`);
      return original(options);
    };

    const task = await deliverd.tasks.create({ title: "t", objective: "o" });
    await task.update({ status: "in_progress" });
    const finding = await task.addFinding({ kind: "decision", title: "d" });
    await task.requestDecisionApproval(finding.id).catch(() => undefined); // not simulated offline
    await task.cancel();

    expect(seen).toEqual([
      "POST /tasks",
      "PATCH /tasks/{}",
      "POST /tasks/{}/findings",
      "POST /tasks/{}/findings/{}/approval",
      "POST /tasks/{}/cancel",
    ]);
  });
});
