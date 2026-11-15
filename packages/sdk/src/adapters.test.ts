import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adapters from "./adapters/index.js";
import {
  approveInGraph,
  changeOpenRouterGuardrail,
  deliverdAllow,
  deliverdWebMcpAllow,
  deliverdCanUseTool,
  deliverdPermissionRequest,
  deliverdToolApproval,
  generateWithDeliverdApprovals,
  openRouterGuardrailForData,
  openRouterModelsInUse,
  pendingMastraApproval,
  raiseOpenRouterKeyLimit,
  registerOpenRouterModels,
  resolveInterruptions,
  resolveMastraApproval,
  resolveOpenRouterApprovals,
  resumeFromCallback,
  runMuseFunctionCalls,
  runMuseToolCalls,
  runWithDeliverdApprovals,
  uiSdkApprovalRoute,
  type Approver,
  type RegisterClient,
} from "./adapters/index.js";
import { Deliverd } from "./index.js";
import { DeliverdTimeoutError } from "./errors.js";
import type { CallbackEnvelope, Decision } from "./types.js";

/**
 * The framework adapters, driven the way each framework drives its hook.
 *
 * What they must get right is the same everywhere: a call nobody needs to see
 * runs untouched; one that needs a person waits and runs only on a yes; a no
 * reaches the model as a sentence it can act on rather than as a crash; and a
 * retried call never asks twice. That each adapter's shape matches its
 * framework's real types was checked by compiling them against the published
 * packages; these check what they do.
 */

function decision(status: Decision["status"], extra: Partial<Decision> = {}): Decision {
  return {
    approved: status === "approved",
    status,
    note: null,
    decidedBy: "Dana",
    decidedById: "u1",
    decidedAt: "2026-09-23T09:00:00Z",
    id: "apr_1",
    url: "https://app.example.test/approve/apr_1",
    input: null,
    changes: [],
    approval: {},
    ...extra,
  };
}

function approver(answer: Decision | Error) {
  const asked: Parameters<Approver["approve"]>[0][] = [];
  const deliverd: Approver = {
    async approve(options) {
      asked.push(options);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deliverd, asked };
}

const signal = new AbortController().signal;

describe("the Claude Agent SDK's canUseTool", () => {
  it("lets a call nobody needs to see through untouched", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const canUseTool = deliverdCanUseTool({ deliverd, when: (tool) => tool === "Bash" });
    expect(await canUseTool("Read", { path: "a" }, { signal, toolUseID: "t1" })).toEqual({
      behavior: "allow",
      updatedInput: { path: "a" },
    });
    expect(asked).toHaveLength(0);
  });

  it("asks once per tool call, and runs it on a yes", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const result = await deliverdCanUseTool({ deliverd, approvers: ["ops"] })("Bash", { command: "rm -rf dist" }, { signal, toolUseID: "toolu_1" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf dist" } });
    expect(asked[0]!.externalId).toBe("claude-agent-sdk:toolu_1");
    expect(asked[0]!.approvers).toEqual(["ops"]);
    expect(asked[0]!.title).toBe("Allow the agent to run Bash");
    expect(asked[0]!.description).toContain("rm -rf dist");
    expect(asked[0]!.signal).toBe(signal);
  });

  it("denies with the person's reason, and says not to retry", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Not on a Friday." }));
    const result = await deliverdCanUseTool({ deliverd })("Bash", {}, { signal, toolUseID: "t" });
    expect(result.behavior).toBe("deny");
    expect(result.behavior === "deny" && result.message).toMatch(/declined running Bash by Dana\. Their reason: Not on a Friday\. Do not retry/);
  });

  it("denies, rather than crashing the run, when nobody decides in time", async () => {
    const { deliverd } = approver(new DeliverdTimeoutError("apr_1", 5));
    const result = await deliverdCanUseTool({ deliverd, timeout: "5m" })("Bash", {}, { signal, toolUseID: "t" });
    expect(result).toEqual({ behavior: "deny", message: "Nobody decided whether to run Bash in time, so it was not run." });
  });
});

describe("approving with changes", () => {
  it("runs the Claude call with what the person approved, not what the model proposed", async () => {
    const corrected = { orderId: "1042", amount: 300 };
    const { deliverd, asked } = approver(
      decision("approved", { input: corrected, changes: [{ field: "amount", from: 420, to: 300 }] })
    );
    const canUseTool = deliverdCanUseTool({ deliverd, editable: (tool) => (tool === "refund" ? ["amount", "nope"] : []) });
    const result = await canUseTool("refund", { orderId: "1042", amount: 420 }, { signal, toolUseID: "t" });
    expect(result).toEqual({ behavior: "allow", updatedInput: corrected });
    // The input goes as fields, and only fields that exist are offered.
    expect(asked[0]!.input).toEqual({ orderId: "1042", amount: 420 });
    expect(asked[0]!.editableFields).toEqual(["amount"]);
  });

  it("offers nothing for correction unless asked to", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    await deliverdCanUseTool({ deliverd })("refund", { amount: 420 }, { signal, toolUseID: "t" });
    expect(asked[0]!.editableFields).toBeUndefined();
  });

  it("does not send input too large to show as fields", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    await deliverdCanUseTool({ deliverd })("write", { body: "x".repeat(9000) }, { signal, toolUseID: "t" });
    expect(asked[0]!.input).toBeUndefined();
  });

  it("hands a graph node the corrected input, and nothing to run on a no", async () => {
    const approved = { id: "a", status: "approved", url: "u", note: null, decidedBy: "Dana", approvedInput: { amount: 300 }, changes: [{ field: "amount", from: 420, to: 300 }] };
    const client = {
      approvals: {
        findByExternalId: async () => approved,
        create: async () => ({ ...approved, callbackSecret: null }),
      },
    };
    const d = await approveInGraph(client, { interrupt: () => undefined, threadId: "t", step: "s", title: "x", input: { amount: 420 }, editableFields: ["amount"] });
    expect(d).toMatchObject({ approved: true, input: { amount: 300 }, changes: [{ field: "amount", to: 300 }] });

    const rejected = { ...approved, status: "rejected", approvedInput: null, changes: [] };
    client.approvals.findByExternalId = async () => rejected;
    expect((await approveInGraph(client, { interrupt: () => undefined, threadId: "t", step: "s", title: "x", input: { amount: 420 } })).input).toBeNull();
  });
});

describe("the AI SDK's toolApproval", () => {
  const call = { toolCall: { toolName: "refund", toolCallId: "call_9", input: { orderId: "1042" } } };

  it("is not-applicable for a call outside `when`", async () => {
    const { deliverd } = approver(decision("approved"));
    expect(await deliverdToolApproval({ deliverd, when: () => false })(call)).toEqual({ type: "not-applicable" });
  });

  it("approves, naming who", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    expect(await deliverdToolApproval({ deliverd })(call)).toEqual({ type: "approved", reason: "Approved by Dana" });
    expect(asked[0]!.externalId).toBe("ai-sdk:call_9");
  });

  it("denies with a reason the model reads", async () => {
    const { deliverd } = approver(decision("expired"));
    const status = await deliverdToolApproval({ deliverd })(call);
    expect(status.type).toBe("denied");
    expect(status.type === "denied" && status.reason).toMatch(/before the request expired/);
  });
});

describe("the OpenAI Agents SDK's interruptions", () => {
  function interrupted(names: string[]) {
    const approved: string[] = [];
    const rejected: { name: string; message?: string }[] = [];
    const items = names.map((name, i) => ({ name, arguments: JSON.stringify({ n: i }), rawItem: { callId: `call_${i}` } }));
    return {
      approved,
      rejected,
      result: {
        interruptions: items,
        state: {
          approve: (item: (typeof items)[number]) => void approved.push(item.name),
          reject: (item: (typeof items)[number], options?: { message?: string }) =>
            void rejected.push({ name: item.name, message: options?.message }),
        },
      },
    };
  }

  it("records each answer on the run's state", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { result, approved } = interrupted(["refund", "email"]);
    expect(await resolveInterruptions(result, { deliverd })).toEqual({ approved: 2, rejected: 0 });
    expect(approved).toEqual(["refund", "email"]);
    expect(asked.map((a) => a.externalId)).toEqual(["openai-agents:call_0", "openai-agents:call_1"]);
    expect(asked[0]!.description).toContain('"n": 0');
  });

  it("rejects with the person's reason", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Wrong customer." }));
    const { result, rejected } = interrupted(["refund"]);
    await resolveInterruptions(result, { deliverd });
    expect(rejected[0]!.message).toMatch(/Their reason: Wrong customer\./);
  });

  it("runs until nothing is waiting, resuming from the state", async () => {
    const { deliverd } = approver(decision("approved"));
    const first = interrupted(["refund"]).result;
    const done = { interruptions: [], state: first.state, finalOutput: "refunded" };
    const inputs: unknown[] = [];
    const final = await runWithDeliverdApprovals(
      async (input) => {
        inputs.push(input);
        return (inputs.length === 1 ? first : done) as typeof first & { finalOutput?: string };
      },
      "refund order 1042",
      { deliverd }
    );
    expect(inputs).toEqual(["refund order 1042", first.state]);
    expect((final as { finalOutput?: string }).finalOutput).toBe("refunded");
  });

  it("stops rather than asking forever", async () => {
    const { deliverd } = approver(decision("approved"));
    const again = interrupted(["refund"]).result;
    await expect(runWithDeliverdApprovals(async () => again, "x", { deliverd, maxRounds: 2 })).rejects.toThrow(/after 2 rounds/);
  });
});

describe("Mastra's suspended tool approvals", () => {
  /*
   * A double of `Agent` as `@mastra/core` 1.78.0 behaves: `generate()` with a
   * tool that requires approval finishes "suspended", its `suspendPayload` the
   * `tool-call-approval` chunk's payload; `approveToolCallGenerate` and
   * `declineToolCallGenerate` resume the run by `runId` and `toolCallId`.
   */
  type Output = { text: string; finishReason: string; runId: string; suspendPayload?: unknown };
  const suspended = (toolCallId: string, toolName: string, args: unknown): Output => ({
    text: "",
    finishReason: "suspended",
    runId: "run_1",
    suspendPayload: { toolCallId, toolName, args, resumeSchema: "{}" },
  });
  const finished = (text: string): Output => ({ text, finishReason: "stop", runId: "run_1" });

  function mastraAgent(next: Output[]) {
    const approved: { runId: string; toolCallId?: string }[] = [];
    const declined: { runId: string; toolCallId?: string; reason?: string }[] = [];
    return {
      approved,
      declined,
      agent: {
        async approveToolCallGenerate(options: { runId: string; toolCallId?: string }) {
          approved.push(options);
          return next.shift() ?? finished("done");
        },
        async declineToolCallGenerate(options: { runId: string; toolCallId?: string; reason?: string }) {
          declined.push(options);
          return next.shift() ?? finished("declined");
        },
      },
    };
  }

  it("asks once per suspended call, approves it, and returns the finished run", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { agent, approved } = mastraAgent([finished("Refunded order 1042.")]);
    const output = await generateWithDeliverdApprovals(agent, Promise.resolve(suspended("call_7", "refund", { orderId: "1042" })), {
      deliverd,
      approvers: ["finance"],
    });
    expect(output.text).toBe("Refunded order 1042.");
    expect(approved).toEqual([{ runId: "run_1", toolCallId: "call_7" }]);
    expect(asked[0]!.externalId).toBe("mastra:run_1:call_7");
    expect(asked[0]!.approvers).toEqual(["finance"]);
    expect(asked[0]!.title).toBe("Allow the agent to run refund");
    expect(asked[0]!.input).toEqual({ orderId: "1042" });
  });

  it("declines with the person's reason, which Mastra hands the model", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Wrong customer." }));
    const { agent, approved, declined } = mastraAgent([]);
    await resolveMastraApproval(agent, suspended("call_7", "refund", {}), { deliverd });
    expect(approved).toHaveLength(0);
    expect(declined[0]).toMatchObject({ runId: "run_1", toolCallId: "call_7" });
    expect(declined[0]!.reason).toMatch(/declined running refund by Dana\. Their reason: Wrong customer\. Do not retry/);
  });

  it("declines, rather than crashing the run, when nobody decides in time", async () => {
    const { deliverd } = approver(new DeliverdTimeoutError("apr_1", 5));
    const { agent, declined } = mastraAgent([]);
    await resolveMastraApproval(agent, suspended("call_7", "refund", {}), { deliverd, timeout: "5m" });
    expect(declined[0]!.reason).toBe("Nobody decided whether to run refund in time, so it was not run.");
  });

  it("approves a call outside `when` without asking anyone", async () => {
    const { deliverd, asked } = approver(decision("rejected"));
    const { agent, approved } = mastraAgent([]);
    await resolveMastraApproval(agent, suspended("call_1", "lookupOrder", {}), { deliverd, when: (tool) => tool === "refund" });
    expect(approved).toEqual([{ runId: "run_1", toolCallId: "call_1" }]);
    expect(asked).toHaveLength(0);
  });

  it("keeps going while the resumed run suspends for the next call", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { agent, approved } = mastraAgent([suspended("call_8", "sendEmail", { to: "a@b.c" }), finished("All done.")]);
    const output = await generateWithDeliverdApprovals(agent, suspended("call_7", "refund", {}), { deliverd });
    expect(output.text).toBe("All done.");
    expect(approved.map((a) => a.toolCallId)).toEqual(["call_7", "call_8"]);
    expect(asked.map((a) => a.externalId)).toEqual(["mastra:run_1:call_7", "mastra:run_1:call_8"]);
  });

  it("leaves a finished run, and a tool's own suspend(), alone", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { agent, approved } = mastraAgent([]);
    const done = finished("hi");
    expect(await generateWithDeliverdApprovals(agent, done, { deliverd })).toBe(done);
    // `tool-call-suspended`: waiting on data from the caller, not on a yes or no.
    const waiting = { ...done, finishReason: "suspended", suspendPayload: { toolCallId: "c", toolName: "t", args: {}, suspendPayload: { ask: "which?" } } };
    expect(pendingMastraApproval(waiting)).toBeNull();
    expect(await generateWithDeliverdApprovals(agent, waiting, { deliverd })).toBe(waiting);
    expect(approved).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("stops rather than asking forever", async () => {
    const { deliverd } = approver(decision("approved"));
    const again = suspended("call_7", "refund", {});
    const agent = { approveToolCallGenerate: async () => again, declineToolCallGenerate: async () => again };
    await expect(generateWithDeliverdApprovals(agent, again, { deliverd, maxRounds: 2 })).rejects.toThrow(/after 2 rounds/);
  });
});

describe("LangGraph", () => {
  type Row = { id: string; status: string; url: string; note: string | null; decidedBy: string | null };

  function graphClient(rows: Row[]) {
    const created: Record<string, unknown>[] = [];
    let reads = 0;
    return {
      created,
      client: {
        approvals: {
          async findByExternalId() {
            return rows[Math.min(reads++, rows.length - 1)] ?? null;
          },
          async create(input: Record<string, unknown>) {
            created.push(input);
            return { id: "apr_1", status: "pending", url: "u", note: null, decidedBy: null, callbackSecret: "dlvcb_x" };
          },
        },
      },
    };
  }

  class GraphInterrupt extends Error {}
  const pausing = () => {
    throw new GraphInterrupt("paused");
  };

  it("asks once, keyed to the thread and step, then pauses the graph", async () => {
    const { client, created } = graphClient([]);
    const secrets: (string | null)[] = [];
    await expect(
      approveInGraph(client, {
        interrupt: pausing,
        threadId: "th_1",
        step: "refund",
        title: "Refund",
        callbackUrl: "https://agent.example.com/cb",
        onCreated: ({ callbackSecret }) => void secrets.push(callbackSecret),
      })
    ).rejects.toBeInstanceOf(GraphInterrupt);
    expect(created[0]!.externalId).toBe("langgraph:th_1:refund");
    expect(created[0]!.callbackUrl).toBe("https://agent.example.com/cb");
    expect(secrets).toEqual(["dlvcb_x"]);
  });

  it("on the re-run after the decision, returns it without asking or pausing again", async () => {
    const { client, created } = graphClient([{ id: "apr_1", status: "approved", url: "u", note: null, decidedBy: "Dana" }]);
    let paused = 0;
    const d = await approveInGraph(client, { interrupt: () => paused++, threadId: "th_1", step: "refund", title: "Refund" });
    expect(d).toMatchObject({ approved: true, decidedBy: "Dana" });
    expect(created).toHaveLength(0);
    expect(paused).toBe(0);
  });

  it("never treats a resume as a decision: an early one reads pending, not approved", async () => {
    const pending = { id: "apr_1", status: "pending", url: "u", note: null, decidedBy: null };
    const { client } = graphClient([pending, pending]);
    const d = await approveInGraph(client, { interrupt: () => ({ status: "approved" }), threadId: "th_1", step: "refund", title: "Refund" });
    expect(d).toMatchObject({ approved: false, status: "pending" });
  });

  it("refuses a step name that would make the thread ambiguous", async () => {
    const { client } = graphClient([]);
    await expect(approveInGraph(client, { interrupt: pausing, threadId: "t", step: "a:b", title: "x" })).rejects.toThrow(/must not contain/);
  });

  const envelope = (event: CallbackEnvelope["event"], externalId: unknown): CallbackEnvelope => ({
    event,
    sentAt: "2026-09-23T09:00:00Z",
    requestType: "approval",
    requestId: "apr_1",
    data: { externalId, status: event.split(".")[1] },
  });

  it("finds the thread to resume from a callback, even one with colons in it", () => {
    expect(resumeFromCallback(envelope("approval.approved", "langgraph:org:th_1:refund"))).toEqual({
      threadId: "org:th_1",
      step: "refund",
      value: { approvalId: "apr_1", status: "approved" },
    });
  });

  it("resumes nothing for a question, or for a request that is not a graph's", () => {
    expect(resumeFromCallback(envelope("approval.question", "langgraph:th_1:refund"))).toBeNull();
    expect(resumeFromCallback(envelope("approval.approved", "order:1042"))).toBeNull();
    expect(resumeFromCallback(envelope("approval.approved", undefined))).toBeNull();
  });
});

describe("Muse Spark's function calls", () => {
  const output = [
    { type: "reasoning", id: "rs_1" },
    { type: "function_call", call_id: "call_1", name: "refund", arguments: '{"order":"1042","amount":420}' },
    { type: "function_call", call_id: "call_2", name: "lookup", arguments: '{"order":"1042"}' },
  ];

  it("runs a call nobody needs to see, and asks about the one that does", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const ran: [string, unknown][] = [];
    const results = await runMuseFunctionCalls(
      output,
      (tool, input) => {
        ran.push([tool, input]);
        return tool === "refund" ? { refunded: true } : "found it";
      },
      { deliverd, when: (tool) => tool === "refund", approvers: ["finance"] }
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.externalId).toBe("muse-spark:call_1");
    expect(asked[0]!.approvers).toEqual(["finance"]);
    expect(asked[0]!.input).toEqual({ order: "1042", amount: 420 });
    expect(ran).toEqual([
      ["refund", { order: "1042", amount: 420 }],
      ["lookup", { order: "1042" }],
    ]);
    // One output per call, in the Responses API's shape, ready to send back.
    expect(results).toEqual([
      { type: "function_call_output", call_id: "call_1", output: '{"refunded":true}' },
      { type: "function_call_output", call_id: "call_2", output: "found it" },
    ]);
  });

  it("never runs a declined call, and tells the model why", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Over the limit" }));
    let ran = false;
    const [result] = await runMuseFunctionCalls(output.slice(0, 2), () => (ran = true), { deliverd });
    expect(ran).toBe(false);
    expect(result!.output).toContain("A person declined running refund by Dana");
    expect(result!.output).toContain("Over the limit");
  });

  it("runs what the approver corrected, not what the model asked", async () => {
    const { deliverd, asked } = approver(decision("approved", { input: { order: "1042", amount: 200 } }));
    let got: unknown;
    await runMuseFunctionCalls(output.slice(1, 2), (_tool, input) => (got = input), {
      deliverd,
      editable: (tool) => (tool === "refund" ? ["amount"] : []),
    });
    expect(asked[0]!.editableFields).toEqual(["amount"]);
    expect(got).toEqual({ order: "1042", amount: 200 });
  });

  it("refuses rather than crashes when nobody decides in time", async () => {
    const { deliverd } = approver(new DeliverdTimeoutError("waited too long"));
    const [result] = await runMuseFunctionCalls(output.slice(1, 2), () => "ran", { deliverd });
    expect(result!.output).toContain("Nobody decided whether to run refund in time");
  });

  it("answers Chat Completions tool calls with tool messages", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const results = await runMuseToolCalls(
      { tool_calls: [{ id: "call_9", type: "function", function: { name: "send_email", arguments: '{"to":"a@b.test"}' } }] },
      () => ({ sent: true }),
      { deliverd }
    );
    expect(asked[0]!.externalId).toBe("muse-spark:call_9");
    expect(results).toEqual([{ role: "tool", tool_call_id: "call_9", content: '{"sent":true}' }]);
    expect(await runMuseToolCalls({ tool_calls: null }, () => "x", { deliverd })).toEqual([]);
  });
});

describe("OpenRouter's Agent SDK", () => {
  /*
   * Driven the way `@openrouter/agent` 1.2.1 drives them: the PermissionRequest
   * hook gets `{ toolName, toolInput, riskLevel }` and the hook context
   * `{ signal, hookName, sessionId }` (sessionId is "" unless the run names
   * one); a paused ModelResult offers `getPendingToolCalls()` and `getState()`.
   * The real package was also run end to end against a stand-in Responses API
   * (examples/openrouter-agent): approved, declined, paused and resumed.
   */
  const payload = (toolName: string, toolInput: Record<string, unknown>) => ({ toolName, toolInput, riskLevel: "medium" as const });
  const context = (sessionId = "") => ({ signal: new AbortController().signal, hookName: "PermissionRequest", sessionId });

  it("allows the call once a person says yes, and passes the input and approvers", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const hook = deliverdPermissionRequest({ deliverd, approvers: ["finance"] });
    expect(await hook.handler(payload("refund", { order: "1042" }), context("sess_1"))).toEqual({ decision: "allow" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.approvers).toEqual(["finance"]);
    expect(asked[0]!.input).toEqual({ order: "1042" });
    expect(asked[0]!.risk).toBe("medium");
    expect(asked[0]!.externalId).toMatch(/^openrouter:sess_1:refund:[0-9a-f]{8}$/);
  });

  it("denies with the person's reason, which OpenRouter hands the model", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Over the limit" }));
    const result = await deliverdPermissionRequest({ deliverd }).handler(payload("refund", {}), context());
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/declined running refund by Dana\. Their reason: Over the limit/);
  });

  it("denies, rather than throws, when nobody answers in time", async () => {
    const { deliverd } = approver(new DeliverdTimeoutError("apr_1", 5));
    const result = await deliverdPermissionRequest({ deliverd, timeout: "5m" }).handler(payload("refund", {}), context());
    expect(result).toMatchObject({ decision: "deny" });
  });

  it("allows a call `when` does not select without asking", async () => {
    const { deliverd, asked } = approver(decision("rejected"));
    const hook = deliverdPermissionRequest({ deliverd, when: (tool) => tool === "refund" });
    expect(await hook.handler(payload("lookupOrder", {}), context())).toEqual({ decision: "allow" });
    expect(asked).toHaveLength(0);
  });

  it("keys the same input the same way regardless of key order, and asks again for a repeat", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const hook = deliverdPermissionRequest({ deliverd });
    await hook.handler(payload("refund", { a: 1, b: 2 }), context("s"));
    await hook.handler(payload("refund", { b: 2, a: 1 }), context("s"));
    expect(asked[1]!.externalId).toBe(`${asked[0]!.externalId}:2`);
  });

  it("never shares a key between two hooks when the run names no session", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    await deliverdPermissionRequest({ deliverd }).handler(payload("refund", { order: "1" }), context(""));
    await deliverdPermissionRequest({ deliverd }).handler(payload("refund", { order: "1" }), context(""));
    expect(asked[0]!.externalId).not.toBe(asked[1]!.externalId);
  });

  it("resolves a paused run into the ids to resume with, keyed by conversation and call", async () => {
    let n = 0;
    const deliverd: Approver = {
      async approve(options) {
        n += 1;
        return n === 1 ? decision("approved") : decision("rejected", { note: "No" });
      },
    };
    const asked: string[] = [];
    const spy: Approver = { approve: async (o) => (asked.push(o.externalId!), deliverd.approve(o)) };
    const paused = {
      getPendingToolCalls: async () => [
        { id: "call_1", name: "refund", arguments: { order: "1" } },
        { id: "call_2", name: "sendEmail", arguments: '{"to":"a@b.c"}' },
        { id: "call_3", name: "lookupOrder", arguments: {} },
      ],
      getState: async () => ({ id: "conv_9", status: "awaiting_approval" }),
    };
    const resume = await resolveOpenRouterApprovals(paused, { deliverd: spy, when: (tool) => tool !== "lookupOrder" });
    expect(asked).toEqual(["openrouter:conv_9:call_1", "openrouter:conv_9:call_2"]);
    expect(resume.approveToolCalls).toEqual(["call_1", "call_3"]);
    expect(resume.rejectToolCalls).toEqual(["call_2"]);
    expect(resume.reasons.call_2).toMatch(/Their reason: No/);
  });

  it("returns nothing to do when the run is not paused", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const idle = { getPendingToolCalls: async () => [], getState: async () => ({ id: "c" }) };
    expect(await resolveOpenRouterApprovals(idle, { deliverd })).toEqual({ approveToolCalls: [], rejectToolCalls: [], reasons: {} });
    expect(asked).toHaveLength(0);
  });
});

describe("OpenRouter's own controls", () => {
  /*
   * A double of OpenRouter's management API as `@openrouter/sdk` 1.5.103
   * describes it: answers wrapped in `{ data }`, snake_case fields. The PATCH
   * bodies these helpers send were also compared with what @openrouter/sdk
   * itself sends for the same change, and matched.
   */
  function openrouter(state: { guardrail?: Record<string, unknown>; key?: Record<string, unknown>; activity?: Record<string, unknown>[] }) {
    const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
      if (url.endsWith("/activity")) return Response.json({ data: state.activity ?? [] });
      if (url.includes("/guardrails/")) return state.guardrail ? Response.json({ data: state.guardrail }) : Response.json({ error: { message: "Not found" } }, { status: 404 });
      if (url.includes("/keys/")) return Response.json({ data: state.key });
      return Response.json({ data: {} });
    }) as unknown as typeof globalThis.fetch;
    return { calls, admin: { managementKey: "sk-or-mgmt", fetch } };
  }
  const guardrail = { id: "g1", name: "Production", limit_usd: 100, enforce_zdr: true, allowed_providers: ["OpenAI", "Anthropic"], created_at: "2026-11-01", updated_at: "2026-11-02" };

  it("shows each setting that would change, applies it on a yes, and keeps the key on your side", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { calls, admin } = openrouter({ guardrail });
    const result = await changeOpenRouterGuardrail("g1", { limitUsd: 50, allowedDataRegions: ["europe"], enforceZdr: true }, { deliverd, openrouter: admin, approvers: ["platform"] });
    expect(result).toMatchObject({ applied: true, decidedBy: "Dana", approvalId: "apr_1" });
    expect(asked[0]!.title).toBe("Change the OpenRouter guardrail “Production”");
    expect(asked[0]!.description).toContain("Spend limit (USD): 100 → 50");
    expect(asked[0]!.description).toContain("Data regions: none → europe");
    expect(asked[0]!.description).not.toContain("Zero data retention"); // unchanged
    expect(asked[0]!.risk).toBe("medium");
    expect(JSON.stringify(asked[0])).not.toContain("sk-or-mgmt");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toBe("https://openrouter.ai/api/v1/guardrails/g1");
    expect(calls[1]!.body).toEqual({ limit_usd: 50, allowed_data_regions: ["europe"] });
    expect(calls[1]!.auth).toBe("Bearer sk-or-mgmt");
  });

  it("asks as high risk when a change loosens anything", async () => {
    for (const change of [{ limitUsd: 500 }, { limitUsd: null }, { enforceZdr: false }, { allowedProviders: ["OpenAI", "Anthropic", "DeepInfra"] }, { allowedProviders: null }, { enablePaidModelTraining: true }]) {
      const { deliverd, asked } = approver(decision("approved"));
      await changeOpenRouterGuardrail("g1", change, { deliverd, openrouter: openrouter({ guardrail }).admin });
      expect(asked[0]!.risk, JSON.stringify(change)).toBe("high");
    }
  });

  it("changes nothing on a no, and says why", async () => {
    const { deliverd } = approver(decision("rejected", { note: "Not before the audit" }));
    const { calls, admin } = openrouter({ guardrail });
    const result = await changeOpenRouterGuardrail("g1", { limitUsd: 500 }, { deliverd, openrouter: admin });
    expect(result.applied).toBe(false);
    expect(result).toMatchObject({ reason: "A person declined the change by Dana, so nothing was changed. Their reason: Not before the audit" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("asks nothing when nothing would change", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const result = await changeOpenRouterGuardrail("g1", { limitUsd: 100, allowedProviders: ["Anthropic", "OpenAI"] }, { deliverd, openrouter: openrouter({ guardrail }).admin });
    expect(result.applied).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it("keys the same change the same way until the guardrail changes", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    await changeOpenRouterGuardrail("g1", { limitUsd: 50 }, { deliverd, openrouter: openrouter({ guardrail }).admin });
    await changeOpenRouterGuardrail("g1", { limitUsd: 50 }, { deliverd, openrouter: openrouter({ guardrail }).admin });
    await changeOpenRouterGuardrail("g1", { limitUsd: 50 }, { deliverd, openrouter: openrouter({ guardrail: { ...guardrail, updated_at: "2026-11-15" } }).admin });
    expect(asked[0]!.externalId).toBe(asked[1]!.externalId);
    expect(asked[2]!.externalId).not.toBe(asked[0]!.externalId);
  });

  it("surfaces OpenRouter's own error", async () => {
    const { deliverd } = approver(decision("approved"));
    await expect(changeOpenRouterGuardrail("nope", { limitUsd: 1 }, { deliverd, openrouter: openrouter({}).admin })).rejects.toThrow(/\(404\): Not found/);
  });

  it("raises a key's limit on a yes, showing what it has spent", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const { calls, admin } = openrouter({ key: { hash: "h1", name: "support-agent", limit: 50, usage: 12.5, usage_monthly: 4, created_at: "x" } });
    const result = await raiseOpenRouterKeyLimit("h1", { limit: 80 }, { deliverd, openrouter: admin });
    expect(result.applied).toBe(true);
    expect(asked[0]!.title).toBe("Set OpenRouter key “support-agent” to a $80 limit");
    expect(asked[0]!.description).toContain("It has spent $12.50 so far, $4.00 this month.");
    expect(asked[0]!.risk).toBe("medium");
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://openrouter.ai/api/v1/keys/h1", body: { limit: 80 } });
    const { deliverd: d2, asked: a2 } = approver(decision("approved"));
    await raiseOpenRouterKeyLimit("h1", { limit: null }, { deliverd: d2, openrouter: admin });
    expect(a2[0]!.risk).toBe("high");
  });

  describe("the AI use policy, read for OpenRouter", () => {
    const cell = (rule: "yes" | "no" | "conditional", condition = "") => ({ rule, condition, satisfiedBy: "ask" as const });
    const row = (consumer: ReturnType<typeof cell>, enterprise: ReturnType<typeof cell>, priv: ReturnType<typeof cell>) => ({ consumer, enterprise, private: priv });
    const policy = {
      enforce: true,
      automatedDecisionLine: "",
      outOfBounds: "",
      grid: {
        public: row(cell("yes"), cell("yes"), cell("yes")),
        internal: row(cell("no"), cell("yes"), cell("yes")),
        confidential: row(cell("no"), cell("conditional", "Only with a client's consent"), cell("yes")),
        restricted: row(cell("no"), cell("no"), cell("yes")),
        personal: row(cell("no"), cell("yes"), cell("yes")),
        special: row(cell("no"), cell("no"), cell("no")),
      },
    };

    it("public data needs nothing", () => {
      expect(openRouterGuardrailForData(policy, ["public"])).toMatchObject({ allowed: true, deploymentClass: "consumer", guardrail: {} });
    });

    it("data the policy keeps to enterprise tools needs zero data retention and no training", () => {
      const reading = openRouterGuardrailForData(policy, ["public", "personal", "confidential"], { region: "europe" });
      expect(reading).toMatchObject({
        allowed: true,
        deploymentClass: "enterprise",
        guardrail: { enforceZdr: true, enablePaidModelTraining: false, enableFreeModelTraining: false, enableFreeModelPublication: false, allowedDataRegions: ["europe"] },
      });
      expect(reading.conditions).toEqual(["confidential data: Only with a client's consent"]);
    });

    it("never lets OpenRouter carry what the policy keeps to a private deployment, or out of AI altogether", () => {
      expect(openRouterGuardrailForData(policy, ["restricted"])).toMatchObject({ allowed: false, deploymentClass: "private" });
      expect(openRouterGuardrailForData(policy, ["special"])).toMatchObject({ allowed: false, deploymentClass: null });
    });
  });

  it("reads activity by model and registers only the models nobody registered", async () => {
    const { admin } = openrouter({
      activity: [
        { date: "2026-11-10 00:00:00", model: "openai/gpt-4o-mini", provider_name: "OpenAI", requests: 10, usage: 0.1 },
        { date: "2026-11-12 00:00:00", model: "openai/gpt-4o-mini", provider_name: "Azure", requests: 5, usage: 0.05 },
        { date: "2026-11-11 00:00:00", model: "anthropic/claude-sonnet-4.5", provider_name: "Anthropic", requests: 3, usage: 0.3 },
        { date: "2026-11-11 00:00:00", model: "meta/llama", provider_name: "Groq", requests: 1, usage: 0 },
      ],
    });
    const uses = await openRouterModelsInUse(admin);
    expect(uses[0]).toMatchObject({ model: "openai/gpt-4o-mini", providers: ["OpenAI", "Azure"], requests: 15, firstSeen: "2026-11-10 00:00:00", lastSeen: "2026-11-12 00:00:00" });
    const registered: unknown[] = [];
    const client = {
      governance: {
        aiSystems: {
          list: async () => [{ id: "s1", name: "Support bot", model: "anthropic/claude-sonnet-4.5" }],
          register: async (input: unknown) => (registered.push(input), { id: `s${registered.length + 1}`, name: "x" }),
        },
      },
    };
    const result = await registerOpenRouterModels({ deliverd: client, openrouter: admin, minRequests: 2 });
    expect(result.registered).toEqual([{ id: "s2", model: "openai/gpt-4o-mini" }]);
    expect(result.skipped.sort()).toEqual(["anthropic/claude-sonnet-4.5", "meta/llama"]);
    expect(registered[0]).toMatchObject({
      name: "openai/gpt-4o-mini via OpenRouter",
      provider: "OpenAI, Azure",
      supplier: "OpenRouter",
      entryType: "discovered",
      buildOrBuy: "buy",
    });
  });

  it("takes the Deliverd client as it is", () => {
    // Compile-time: the real client satisfies what registerOpenRouterModels asks for.
    const client: RegisterClient = new Deliverd({ apiKey: "dlv_test" });
    expect(client.governance.aiSystems).toBeDefined();
  });
});

describe("the README", () => {
  it("imports from @deliverd/sdk/adapters only what it exports", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    const imported = [...readme.matchAll(/import \{([^}]+)\} from "@deliverd\/sdk\/adapters"/g)].flatMap(([, names]) =>
      names!.split(",").map((name) => name.trim())
    );
    // Every framework, so a sweep that stopped matching cannot pass by checking nothing.
    expect(new Set(imported)).toEqual(
      new Set([
        "deliverdCanUseTool",
        "deliverdToolApproval",
        "runWithDeliverdApprovals",
        "approveInGraph",
        "resumeFromCallback",
        "generateWithDeliverdApprovals",
        "runMuseFunctionCalls",
        "deliverdAllow",
        "deliverdWebMcpAllow",
        "uiSdkApprovalRoute",
        "watchManagedAgentSessions",
        "deliverdPermissionRequest",
        "resolveOpenRouterApprovals",
      ])
    );
    for (const name of imported) expect(adapters, `README imports ${name}`).toHaveProperty(name);
  });
});

describe("Vercel's UI SDK agent bridge", () => {
  const confirmStep = {
    ref: "c4",
    component: "button",
    label: "Delete project",
    action: "press",
    args: ["Delete forever"],
    confirm: "Deletes the project and all its files",
  };

  /** The browser half wired straight to the server half, as a real route would be. */
  function wired(answer: Decision | Error, route: Partial<Parameters<typeof uiSdkApprovalRoute>[0]> = {}) {
    const { deliverd, asked } = approver(answer);
    const handler = uiSdkApprovalRoute({ deliverd, ...route });
    const sent: Request[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const request = new Request(new URL(url, "https://app.example.test"), init);
      sent.push(request.clone());
      return handler(request);
    }) as typeof globalThis.fetch;
    return { deliverd, asked, fetch, sent };
  }

  it("allows a step with no confirm mark without asking anyone", async () => {
    const { asked, fetch } = wired(decision("approved"));
    const allow = deliverdAllow({ endpoint: "/api/ui-approval", fetch });
    expect(await allow({ ref: "c1", component: "select", label: "Region", action: "setValue", args: ["eu"] })).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("asks a person about a marked step, in the app's own words, and runs it on a yes", async () => {
    const { asked, fetch } = wired(decision("approved"), { approvers: ["ops"] });
    const answers: unknown[] = [];
    const allow = deliverdAllow({ endpoint: "/api/ui-approval", fetch, onAnswer: (a) => answers.push(a) });
    expect(await allow(confirmStep)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.title).toBe("Deletes the project and all its files");
    expect(asked[0]!.description).toMatch(/press "Delete project" \(Delete forever\)/);
    expect(asked[0]!.approvers).toEqual(["ops"]);
    expect(asked[0]!.risk).toBe("high");
    expect(asked[0]!.externalId).toMatch(/^ui-sdk:[0-9a-f]{64}$/);
    expect(asked[0]!.timeout).toBe("4m");
    expect(asked[0]!.expiresIn).toBe("4m");
    expect(asked[0]!.metadata).toMatchObject({ source: "ui-sdk" });
    expect(answers).toEqual([{ allowed: true, decidedBy: "Dana" }]);
  });

  it("refuses on a no and hands the page the person's reason", async () => {
    const { fetch } = wired(decision("rejected", { note: "Not on a Friday" }));
    const answers: { allowed: boolean; reason?: string }[] = [];
    const allow = deliverdAllow({ endpoint: "/api/ui-approval", fetch, onAnswer: (a) => answers.push(a) });
    expect(await allow(confirmStep)).toBe(false);
    expect(answers[0]!.reason).toMatch(/Not on a Friday/);
  });

  it("treats a wait that ran out as a no", async () => {
    const { fetch } = wired(new DeliverdTimeoutError("waited"));
    expect(await deliverdAllow({ endpoint: "/api/ui-approval", fetch })(confirmStep)).toBe(false);
  });

  it("never asks twice under one id: each ask is its own request", async () => {
    const { asked, fetch } = wired(decision("approved"));
    const allow = deliverdAllow({ endpoint: "/api/ui-approval", fetch });
    await allow(confirmStep);
    await allow(confirmStep);
    expect(asked[0]!.externalId).not.toBe(asked[1]!.externalId);
  });

  it("refuses when the route fails or cannot be reached", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const broken = (async () => new Response("oops", { status: 500 })) as typeof globalThis.fetch;
    expect(await deliverdAllow({ endpoint: "/x", fetch: down })(confirmStep)).toBe(false);
    expect(await deliverdAllow({ endpoint: "/x", fetch: broken })(confirmStep)).toBe(false);
  });

  it("sends only the step's documented fields", async () => {
    const { fetch, sent } = wired(decision("approved"));
    await deliverdAllow({ endpoint: "/x", fetch })({ ...confirmStep, secretThing: "no" } as typeof confirmStep);
    const body = (await sent[0]!.json()) as { step: Record<string, unknown> };
    expect(Object.keys(body.step).sort()).toEqual(["action", "args", "component", "confirm", "label", "ref"]);
  });

  it("the route refuses unmarked steps, unreadable bodies and other methods", async () => {
    const { deliverd, asked } = approver(decision("approved"));
    const route = uiSdkApprovalRoute({ deliverd });
    const post = (body: string) => route(new Request("https://app.example.test/x", { method: "POST", body }));
    const unmarked = await post(JSON.stringify({ step: { ref: "c1", component: "button", action: "press" }, nonce: "n" }));
    expect(unmarked.status).toBe(403);
    expect(await unmarked.json()).toMatchObject({ allowed: false });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ step: { ref: 1 }, nonce: "n" }))).status).toBe(400);
    expect((await post("x".repeat(20_000))).status).toBe(413);
    expect((await route(new Request("https://app.example.test/x"))).status).toBe(405);
    expect(asked).toHaveLength(0);
  });

  it("the route's `when` can send unmarked steps to a person too", async () => {
    const { asked, fetch } = wired(decision("approved"), { when: (step) => step.label === "Plan" });
    const allow = deliverdAllow({ endpoint: "/x", fetch, when: (step) => step.label === "Plan" });
    expect(await allow({ ref: "c2", component: "select", label: "Plan", action: "setValue", args: ["Enterprise"] })).toBe(true);
    expect(asked[0]!.title).toBe('Let the agent set "Plan"');
  });

  describe("WebMCP: the browser's own agent", () => {
    it("asks about a marked step and tells the approver the browser's agent asked", async () => {
      const { asked, fetch, sent } = wired(decision("approved"));
      const allow = deliverdWebMcpAllow({ endpoint: "/x", fetch });
      expect(await allow({ ...confirmStep })).toBe(true);
      expect(((await sent[0]!.json()) as { via?: string }).via).toBe("webmcp");
      expect(asked).toHaveLength(1);
      expect(asked[0]!.description).toMatch(/browser's own agent, using the page through WebMCP/);
      expect(asked[0]!.metadata).toMatchObject({ source: "ui-sdk", via: "webmcp" });
    });

    it("lets an unmarked step through without asking, as the bridge's allow does", async () => {
      const { asked, fetch } = wired(decision("approved"));
      expect(await deliverdWebMcpAllow({ endpoint: "/x", fetch })({ ref: "c1", component: "input", action: "setValue", args: ["Atlas"] })).toBe(true);
      expect(asked).toHaveLength(0);
    });

    it("does not ask twice when the bridge's deliverdAllow already asked about the same step", async () => {
      // UI SDK hands one step object to the bridge's allow, then to registerTools' allow.
      const { asked, fetch } = wired(decision("approved"));
      const bridge = deliverdAllow({ endpoint: "/x", fetch });
      const webmcp = deliverdWebMcpAllow({ endpoint: "/x", fetch });
      const step = { ...confirmStep };
      expect(await bridge(step)).toBe(true);
      expect(await webmcp(step)).toBe(true);
      expect(asked).toHaveLength(1);
      // Once only: the same object asked about again goes to a person again.
      expect(await webmcp(step)).toBe(true);
      expect(asked).toHaveLength(2);
    });

    it("asks for itself when an allow other than Deliverd's said yes first", async () => {
      const { asked, fetch } = wired(decision("approved"));
      const step = { ...confirmStep };
      // A bridge allow that is not Deliverd's said yes: the person was not asked, so ask.
      expect(await deliverdWebMcpAllow({ endpoint: "/x", fetch })(step)).toBe(true);
      expect(asked).toHaveLength(1);
    });

    it("the route's `when` sees who asked, so it can send the browser's presses to a person too", async () => {
      const { asked, fetch } = wired(decision("approved"), {
        when: (step, _request, { via }) => Boolean(step.confirm) || (via === "webmcp" && step.action === "press"),
      });
      const press = { ref: "c6", component: "button", label: "Save changes", action: "press", args: [] };
      const webmcp = deliverdWebMcpAllow({ endpoint: "/x", fetch, when: (step) => Boolean(step.confirm) || step.action === "press" });
      expect(await webmcp(press)).toBe(true);
      expect(asked).toHaveLength(1);
      // The same press, sent without via, is refused: only the browser's agent widened.
      const bridge = deliverdAllow({ endpoint: "/x", fetch, when: () => true });
      expect(await bridge(press)).toBe(false);
      expect(asked).toHaveLength(1);
    });

    it("the route refuses a via that is not a short name", async () => {
      const { deliverd, asked } = approver(decision("approved"));
      const route = uiSdkApprovalRoute({ deliverd });
      const response = await route(
        new Request("https://app.example.test/x", { method: "POST", body: JSON.stringify({ step: confirmStep, nonce: "n", via: "<script>" }) })
      );
      expect(response.status).toBe(400);
      expect(asked).toHaveLength(0);
    });
  });
});
