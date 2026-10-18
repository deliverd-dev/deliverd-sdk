import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adapters from "./adapters/index.js";
import {
  approveInGraph,
  deliverdCanUseTool,
  deliverdToolApproval,
  generateWithDeliverdApprovals,
  pendingMastraApproval,
  resolveInterruptions,
  resolveMastraApproval,
  resumeFromCallback,
  runMuseFunctionCalls,
  runMuseToolCalls,
  runWithDeliverdApprovals,
  type Approver,
} from "./adapters/index.js";
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

describe("the README", () => {
  it("imports from @deliverd/sdk/adapters only what it exports", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    const imported = [...readme.matchAll(/import \{([^}]+)\} from "@deliverd\/sdk\/adapters"/g)].flatMap(([, names]) =>
      names!.split(",").map((name) => name.trim())
    );
    // All five frameworks, so a sweep that stopped matching cannot pass by checking nothing.
    expect(new Set(imported)).toEqual(
      new Set([
        "deliverdCanUseTool",
        "deliverdToolApproval",
        "runWithDeliverdApprovals",
        "approveInGraph",
        "resumeFromCallback",
        "generateWithDeliverdApprovals",
        "runMuseFunctionCalls",
      ])
    );
    for (const name of imported) expect(adapters, `README imports ${name}`).toHaveProperty(name);
  });
});
