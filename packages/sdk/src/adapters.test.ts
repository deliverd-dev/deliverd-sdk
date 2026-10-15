import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adapters from "./adapters/index.js";
import {
  approveInGraph,
  deliverdCanUseTool,
  deliverdToolApproval,
  resolveInterruptions,
  resumeFromCallback,
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

describe("the README", () => {
  it("imports from @deliverd/sdk/adapters only what it exports", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
    const imported = [...readme.matchAll(/import \{([^}]+)\} from "@deliverd\/sdk\/adapters"/g)].flatMap(([, names]) =>
      names!.split(",").map((name) => name.trim())
    );
    // All four frameworks, so a sweep that stopped matching cannot pass by checking nothing.
    expect(new Set(imported)).toEqual(
      new Set(["deliverdCanUseTool", "deliverdToolApproval", "runWithDeliverdApprovals", "approveInGraph", "resumeFromCallback"])
    );
    for (const name of imported) expect(adapters, `README imports ${name}`).toHaveProperty(name);
  });
});
