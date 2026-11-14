import { describe, expect, it } from "vitest";
import {
  answerManagedAgentConfirmations,
  followManagedAgentSession,
  watchManagedAgentSessions,
  type Approver,
  type ManagedAgentsClient,
  type ManagedAgentsEvent,
  type ManagedAgentsStreamEvent,
  type ManagedAgentsToolConfirmation,
} from "./adapters/index.js";
import { DeliverdTimeoutError } from "./errors.js";
import type { Decision } from "./types.js";

/**
 * Claude Managed Agents, hosted or self-hosted: a session paused on
 * `requires_action` gets a person's answer as `user.tool_confirmation`.
 *
 * What matters: only calls the server holds for confirmation are answered,
 * a no never runs and the model reads why, a correction is not run as
 * proposed, a slow decision leaves the session waiting rather than refusing,
 * and a second pass never asks twice. The client's shape was checked by
 * compiling `new Anthropic()` from `@anthropic-ai/sdk` 1.8 against
 * `ManagedAgentsClient`.
 */

function decision(status: Decision["status"], extra: Partial<Decision> = {}): Decision {
  return {
    approved: status === "approved",
    status,
    note: null,
    decidedBy: "Dana",
    decidedById: "u1",
    decidedAt: "2026-11-14T09:00:00Z",
    id: "apr_1",
    url: "https://app.example.test/approve/apr_1",
    input: null,
    changes: [],
    approval: {},
    ...extra,
  };
}

function approver(answer: (externalId: string) => Decision | Error) {
  const asked: Parameters<Approver["approve"]>[0][] = [];
  const deliverd: Approver = {
    async approve(options) {
      asked.push(options);
      const a = answer(options.externalId ?? "");
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { deliverd, asked };
}

const IDLE: ManagedAgentsEvent = {
  id: "sevt_idle",
  type: "session.status_idle",
  stop_reason: { type: "requires_action", event_ids: ["sevt_bash", "sevt_mcp", "sevt_worker"] },
};
const BASH: ManagedAgentsEvent = {
  id: "sevt_bash",
  type: "agent.tool_use",
  name: "bash",
  input: { command: "rm -rf /workspace/reports" },
  evaluated_permission: "ask",
};
const MCP: ManagedAgentsEvent = {
  id: "sevt_mcp",
  type: "agent.mcp_tool_use",
  name: "create_issue",
  mcp_server_name: "github",
  input: { repo: "acme/api", title: "Rotate keys" },
  evaluated_permission: "ask",
};
// A worker-run tool on a self-hosted environment: blocking, but not ours to answer.
const WORKER: ManagedAgentsEvent = {
  id: "sevt_worker",
  type: "agent.tool_use",
  name: "read",
  input: { path: "README.md" },
  evaluated_permission: "allow",
};

function fakeClient(events: ManagedAgentsEvent[], options: { sessions?: string[]; stream?: ManagedAgentsStreamEvent[] } = {}) {
  const sent: Array<{ sessionId: string; events: ManagedAgentsToolConfirmation[] }> = [];
  const listed: Array<{ sessionId: string; types?: string[] }> = [];
  async function* iterate<T>(items: T[]) {
    for (const item of items) yield item;
  }
  const client: ManagedAgentsClient = {
    beta: {
      sessions: {
        list: () => iterate((options.sessions ?? []).map((id) => ({ id }))),
        events: {
          list(sessionId, params) {
            listed.push({ sessionId, types: params?.types });
            const wanted = params?.types as string[] | undefined;
            const picked = events.filter((e) => !wanted || wanted.includes(e.type));
            return iterate(params?.order === "desc" ? [...picked].reverse() : picked);
          },
          async send(sessionId, params) {
            sent.push({ sessionId, events: params.events });
          },
          async stream() {
            return iterate(options.stream ?? []);
          },
        },
      },
    },
  };
  return { client, sent, listed };
}

describe("Claude Managed Agents' tool confirmations", () => {
  it("answers only the calls held for confirmation, once each, and sends a yes", async () => {
    const { client, sent } = fakeClient([BASH, MCP, WORKER, IDLE]);
    const { deliverd, asked } = approver(() => decision("approved"));
    const resolution = await answerManagedAgentConfirmations(client, "sesn_1", { deliverd, approvers: ["platform-team"] });
    expect(asked.map((a) => a.externalId)).toEqual(["managed-agents:sevt_bash", "managed-agents:sevt_mcp"]);
    expect(asked[0]!.approvers).toEqual(["platform-team"]);
    expect(asked[0]!.input).toEqual({ command: "rm -rf /workspace/reports" });
    expect(asked[1]!.title).toBe("Allow the agent to run create_issue on github");
    expect(asked[1]!.metadata).toMatchObject({ tool: "create_issue", session: "sesn_1", mcp_server: "github" });
    expect(sent).toEqual([
      {
        sessionId: "sesn_1",
        events: [
          { type: "user.tool_confirmation", tool_use_id: "sevt_bash", result: "allow" },
          { type: "user.tool_confirmation", tool_use_id: "sevt_mcp", result: "allow" },
        ],
      },
    ]);
    expect(resolution.pending).toEqual([]);
  });

  it("denies with the person's reason as the deny_message", async () => {
    const { client, sent } = fakeClient([BASH, IDLE]);
    const { deliverd } = approver(() => decision("rejected", { note: "Those reports are the audit trail." }));
    const resolution = await answerManagedAgentConfirmations(client, "sesn_1", { deliverd });
    const [answer] = sent[0]!.events;
    expect(answer!.result).toBe("deny");
    expect(answer!.deny_message).toMatch(/declined running bash by Dana\. Their reason: Those reports are the audit trail\. Do not retry/);
    expect(resolution.reasons.sevt_bash).toBe(answer!.deny_message);
  });

  it("does not run a call approved only with changes, and names the approved values", async () => {
    const { client, sent } = fakeClient([MCP, IDLE]);
    const { deliverd } = approver(() =>
      decision("approved", { changes: [{ field: "repo", from: "acme/api", to: "acme/staging" }] })
    );
    await answerManagedAgentConfirmations(client, "sesn_1", { deliverd });
    const [answer] = sent[0]!.events;
    expect(answer!.result).toBe("deny");
    expect(answer!.deny_message).toContain('repo from "acme/api" to "acme/staging"');
  });

  it("leaves an undecided call waiting, sending nothing for it", async () => {
    const { client, sent } = fakeClient([BASH, MCP, IDLE]);
    const { deliverd } = approver((id) => (id.endsWith("sevt_bash") ? new DeliverdTimeoutError("apr_1", 10) : decision("approved")));
    const resolution = await answerManagedAgentConfirmations(client, "sesn_1", { deliverd, timeout: "10s" });
    expect(resolution.pending).toEqual(["sevt_bash"]);
    expect(sent[0]!.events.map((e) => e.tool_use_id)).toEqual(["sevt_mcp"]);
  });

  it("lets a call through untouched when `when` says nobody needs to see it", async () => {
    const { client, sent } = fakeClient([BASH, MCP, IDLE]);
    const { deliverd, asked } = approver(() => decision("approved"));
    await answerManagedAgentConfirmations(client, "sesn_1", { deliverd, when: (tool) => tool === "bash" });
    expect(asked).toHaveLength(1);
    expect(sent[0]!.events.map((e) => e.result)).toEqual(["allow", "allow"]);
  });

  it("does nothing for a session that is not waiting on a confirmation", async () => {
    const { client, sent } = fakeClient([BASH, { id: "sevt_done", type: "session.status_idle", stop_reason: { type: "end_turn" } }]);
    const { deliverd, asked } = approver(() => decision("approved"));
    const resolution = await answerManagedAgentConfirmations(client, "sesn_1", { deliverd });
    expect(asked).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(resolution.sent).toEqual([]);
  });

  it("follows a stream, answers each pause, and stops when the turn ends", async () => {
    const { client, sent } = fakeClient([BASH, MCP, WORKER], {
      stream: [
        { type: "event_start" },
        BASH,
        IDLE,
        { id: "sevt_run", type: "session.status_running" },
        { id: "sevt_end", type: "session.status_idle", stop_reason: { type: "end_turn" } },
        { id: "sevt_never", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["x"] } },
      ],
    });
    const { deliverd, asked } = approver(() => decision("approved"));
    const seen: string[] = [];
    await followManagedAgentSession(client, "sesn_1", { deliverd, onEvent: (e) => seen.push(e.type) });
    expect(asked).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(seen.at(-1)).toBe("session.status_idle");
    expect(seen).toHaveLength(5);
  });

  it("watches every idle session until stopped, carrying on past one that fails", async () => {
    const { client, sent } = fakeClient([BASH, IDLE], { sessions: ["sesn_1", "sesn_2"] });
    const controller = new AbortController();
    const failed: string[] = [];
    const { deliverd } = approver(() => {
      controller.abort();
      return decision("approved");
    });
    const flaky: ManagedAgentsClient = {
      beta: {
        sessions: {
          ...client.beta.sessions,
          events: {
            ...client.beta.sessions.events,
            list: (sessionId, params) => {
              if (sessionId === "sesn_2") throw new Error("gone");
              return client.beta.sessions.events.list(sessionId, params);
            },
          },
        },
      },
    };
    await watchManagedAgentSessions(flaky, {
      deliverd,
      signal: controller.signal,
      interval: 10,
      onError: (_err, id) => failed.push(id),
    });
    expect(sent.map((s) => s.sessionId)).toEqual(["sesn_1"]);
    expect(failed).toEqual(["sesn_2"]);
  });
});
