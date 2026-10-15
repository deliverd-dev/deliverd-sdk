import { durationMs, type Duration } from "../duration.js";
import type { ApprovalFactor, ApprovalRisk, CallbackEnvelope, FieldChange } from "../types.js";

/**
 * LangGraph: pause a graph on a person's decision, and wake it with a
 * callback instead of a process waiting on it.
 *
 * Inside a node, instead of blocking on `deliverd.approve()`:
 *
 * ```ts
 * import { interrupt } from "@langchain/langgraph";
 * import { approveInGraph } from "@deliverd/sdk/adapters";
 *
 * async function refund(state, config) {
 *   const decision = await approveInGraph(deliverd, {
 *     interrupt,
 *     threadId: config.configurable.thread_id,
 *     step: "refund",
 *     title: `Refund £${state.amount} to ${state.customer}`,
 *     approvers: ["finance"],
 *     callbackUrl: "https://agent.example.com/hooks/deliverd",
 *   });
 *   if (!decision.approved) return { refunded: false, reason: decision.note };
 *   …
 * }
 * ```
 *
 * And where the callback lands:
 *
 * ```ts
 * import { Command } from "@langchain/langgraph";
 * import { resumeFromCallback } from "@deliverd/sdk/adapters";
 *
 * const envelope = deliverd.webhooks.constructCallback(secret, rawBody, signature);
 * const resume = resumeFromCallback(envelope);
 * if (resume) await graph.invoke(new Command({ resume: resume.value }), { configurable: { thread_id: resume.threadId } });
 * ```
 *
 * **Why it is safe to re-run.** LangGraph resumes a node from its first line.
 * The request is keyed by `externalId` (`langgraph:<thread>:<step>`), so the
 * second run finds the request the first one made rather than filing another,
 * sees it settled, and returns without interrupting again. A resume that
 * arrives early — before anyone decided — re-reads the request, finds it
 * still pending and returns `approved: false, status: "pending"`: the
 * decision is always Deliverd's record, never the resume value, so a stray
 * resume can never approve anything.
 *
 * `interrupt` is passed in rather than imported, so this package keeps no
 * dependency on LangGraph. Its signature follows `interrupt` in
 * `@langchain/langgraph`'s type definitions.
 */

/** The parts of the Deliverd client this adapter uses. */
export interface GraphApprover {
  approvals: {
    findByExternalId(externalId: string): Promise<GraphApprovalRecord | null>;
    create(input: {
      title: string;
      description?: string;
      risk?: ApprovalRisk;
      factors?: ApprovalFactor[];
      approvers?: string[];
      externalId: string;
      expiresAt?: string;
      callbackUrl?: string;
      metadata?: Record<string, unknown>;
      flowId?: string;
      input?: Record<string, unknown>;
      editableFields?: string[];
    }): Promise<GraphApprovalRecord & { callbackSecret: string | null }>;
  };
}

/** The request as this adapter reads it back. */
export interface GraphApprovalRecord {
  id: string;
  status: string;
  url: string;
  note: string | null;
  decidedBy: string | null;
  approvedInput?: Record<string, unknown> | null;
  changes?: FieldChange[];
}

export interface GraphDecision {
  approved: boolean;
  status: string;
  note: string | null;
  decidedBy: string | null;
  approvalId: string;
  url: string;
  /**
   * What to run with, when an `input` was sent and approved: with the
   * approver's corrections. Null otherwise.
   */
  input: Record<string, unknown> | null;
  changes: FieldChange[];
}

/** What the graph is paused on, as `interrupt` receives it. */
export interface DeliverdInterruptValue {
  deliverd: { approvalId: string; url: string };
}

/**
 * Every graph request's `externalId` starts with this; the thread and step
 * follow, and are what a callback is matched back to (callbacks carry the
 * `externalId`, which is set by this adapter and nothing else).
 */
const PREFIX = "langgraph:";

export async function approveInGraph(
  deliverd: GraphApprover,
  options: {
    /** `interrupt` from `@langchain/langgraph`. */
    interrupt: (value: DeliverdInterruptValue) => unknown;
    /** The graph's thread: `config.configurable.thread_id`. */
    threadId: string;
    /** A name for this point in the graph, unique within the thread. No colons. */
    step: string;
    title: string;
    description?: string;
    risk?: ApprovalRisk;
    factors?: ApprovalFactor[];
    approvers?: string[];
    /** Where Deliverd POSTs the decision; pair with `resumeFromCallback`. */
    callbackUrl?: string;
    /** How long the request stays open. Default a day. */
    expiresIn?: Duration;
    flowId?: string;
    /** The arguments the node will run with, shown to the approver. */
    input?: Record<string, unknown>;
    /** Fields of `input` the approver may correct; the decision's `input` has them. */
    editableFields?: string[];
    /** Called once, when the request is first made, with the secret its callback is signed with. */
    onCreated?: (created: { approvalId: string; url: string; callbackSecret: string | null }) => void | Promise<void>;
  }
): Promise<GraphDecision> {
  if (options.step.includes(":")) {
    throw new Error(`step must not contain ":" (got "${options.step}"): it is how the thread is found again.`);
  }
  const externalId = `${PREFIX}${options.threadId}:${options.step}`;
  let approval = await deliverd.approvals.findByExternalId(externalId);
  if (!approval) {
    const created = await deliverd.approvals.create({
      title: options.title,
      description: options.description,
      risk: options.risk,
      factors: options.factors,
      approvers: options.approvers,
      externalId,
      expiresAt: new Date(Date.now() + durationMs(options.expiresIn ?? "24h")).toISOString(),
      callbackUrl: options.callbackUrl,
      metadata: { langgraph: { threadId: options.threadId, step: options.step } },
      flowId: options.flowId,
      input: options.input,
      editableFields: options.editableFields,
    });
    await options.onCreated?.({ approvalId: created.id, url: created.url, callbackSecret: created.callbackSecret });
    approval = created;
  }

  if (approval.status === "pending") {
    // Pauses the graph on the first run. It returns only when the graph is
    // resumed, and what it returns is not trusted: the request is re-read.
    options.interrupt({ deliverd: { approvalId: approval.id, url: approval.url } });
    approval = (await deliverd.approvals.findByExternalId(externalId)) ?? approval;
  }

  return {
    approved: approval.status === "approved",
    status: approval.status,
    note: approval.note,
    decidedBy: approval.decidedBy,
    approvalId: approval.id,
    url: approval.url,
    input: approval.status === "approved" ? (approval.approvedInput ?? options.input ?? null) : null,
    changes: approval.changes ?? [],
  };
}

/**
 * The thread to resume and the value to resume it with, from a verified
 * callback. Null for a callback that is not about a graph's approval, and
 * for a question — the graph stays paused until the request settles.
 */
export function resumeFromCallback(
  envelope: CallbackEnvelope
): { threadId: string; step: string; value: { approvalId: string; status: string } } | null {
  if (envelope.requestType !== "approval" || envelope.event === "approval.question") return null;
  const externalId = envelope.data.externalId;
  if (typeof externalId !== "string" || !externalId.startsWith(PREFIX)) return null;
  const rest = externalId.slice(PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return {
    threadId: rest.slice(0, cut),
    step: rest.slice(cut + 1),
    value: { approvalId: envelope.requestId, status: String(envelope.data.status ?? envelope.event.split(".")[1]) },
  };
}

