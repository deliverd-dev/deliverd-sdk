import { DeliverdTimeoutError } from "../errors.js";
import type { Duration } from "../duration.js";
import type { ApprovalFactor, ApprovalRisk, Decision, FieldChange } from "../types.js";

/**
 * What the framework adapters share: how a tool call becomes a request, and
 * what the answer becomes.
 *
 * The adapters are written against each framework's own hook — the Claude
 * Agent SDK's `canUseTool`, the AI SDK's `toolApproval`, the OpenAI Agents
 * SDK's interruptions, LangGraph's `interrupt`, Mastra's suspended tool
 * approvals — by shape rather than by
 * import, so `@deliverd/sdk` keeps its promise of no dependencies. Each
 * shape was taken from that framework's published type definitions and is
 * checked against them in this package's tests.
 */

/** Anything with Deliverd's `approve()`: the client, or a test double. */
export interface Approver {
  approve(options: {
    title: string;
    description?: string;
    risk?: ApprovalRisk;
    factors?: ApprovalFactor[];
    approvers?: string[];
    externalId?: string;
    flowId?: string;
    metadata?: Record<string, unknown>;
    callbackUrl?: string;
    input?: Record<string, unknown>;
    editableFields?: string[];
    expiresIn?: Duration;
    timeout?: Duration;
    signal?: AbortSignal;
  }): Promise<Decision>;
}

/** What a person is shown about one tool call. */
export interface CallDescription {
  title: string;
  description?: string;
  risk?: ApprovalRisk;
  factors?: ApprovalFactor[];
}

export interface ToolApprovalOptions {
  /** The client: `new Deliverd()`. */
  deliverd: Approver;
  /**
   * Which calls need a person. Every call when omitted — so name the few
   * that matter: `when: (tool) => ["send_email", "refund"].includes(tool)`.
   */
  when?: (toolName: string, input: unknown) => boolean | Promise<boolean>;
  /** Who may decide: people, teams, groups. The organisation's admins when omitted. */
  approvers?: string[];
  /** What the approver reads. A readable default is built from the tool and its input. */
  describe?: (toolName: string, input: unknown) => CallDescription;
  /** How long the request stays open. Default one hour: an agent is waiting. */
  expiresIn?: Duration;
  /** Give up waiting after this and refuse the call. Defaults to the request's own expiry. */
  timeout?: Duration;
  /** The flow this run belongs to, so every call it asked about is on one timeline. */
  flowId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The tool input as the approver sees it: its arguments, shown field by field
 * on the approval page, when it is a plain object of a sensible size. Larger
 * or odd-shaped input is still in the description, just not structured.
 */
const INPUT_MAX = 8000;
export function structuredInput(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  try {
    return JSON.stringify(input).length <= INPUT_MAX ? (input as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_TOOL_EXPIRY: Duration = "1h";
const INPUT_PREVIEW_MAX = 3000;

/** A plain account of a call, for when the caller did not write one. */
export function defaultDescription(toolName: string, input: unknown): CallDescription {
  let rendered: string;
  try {
    rendered = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    rendered = String(input);
  }
  if (rendered && rendered.length > INPUT_PREVIEW_MAX) rendered = `${rendered.slice(0, INPUT_PREVIEW_MAX - 1)}…`;
  return {
    title: `Allow the agent to run ${toolName}`,
    description: rendered ? `With this input:\n\n${rendered}` : undefined,
    risk: "medium",
  };
}

/** The answer an adapter hands back to its framework. */
export type CallOutcome =
  | {
      allowed: true;
      decidedBy: string | null;
      note: string | null;
      /** What to run with: the approver's correction, when they made one. */
      input: Record<string, unknown> | null;
      changes: FieldChange[];
    }
  | { allowed: false; reason: string };

/**
 * Ask about one call and wait.
 *
 * `externalId` makes the ask idempotent: a framework that retries a step, or
 * a process that restarts mid-wait, finds the request it already made instead
 * of filing a second one (`approve()` reuses by `externalId`).
 *
 * A refusal, an expiry and a wait that ran out are all "not allowed", each
 * with a sentence the model can read and act on — never a thrown error, which
 * most frameworks would turn into a crashed run rather than a declined call.
 */
export async function askAboutCall(
  toolName: string,
  input: unknown,
  externalId: string,
  options: ToolApprovalOptions,
  signal?: AbortSignal,
  /** Fields a person may correct. Only for a framework that can run a corrected call. */
  editableFields?: string[]
): Promise<CallOutcome> {
  const described = (options.describe ?? defaultDescription)(toolName, input);
  const structured = structuredInput(input);
  let decision: Decision;
  try {
    decision = await options.deliverd.approve({
      ...described,
      approvers: options.approvers,
      externalId,
      flowId: options.flowId,
      metadata: { ...options.metadata, tool: toolName },
      ...(structured ? { input: structured } : {}),
      ...(structured && editableFields?.length
        ? { editableFields: editableFields.filter((field) => field in structured) }
        : {}),
      expiresIn: options.expiresIn ?? DEFAULT_TOOL_EXPIRY,
      timeout: options.timeout,
      signal,
    });
  } catch (err) {
    if (err instanceof DeliverdTimeoutError) {
      return { allowed: false, reason: `Nobody decided whether to run ${toolName} in time, so it was not run.` };
    }
    throw err;
  }
  if (decision.approved) {
    return {
      allowed: true,
      decidedBy: decision.decidedBy,
      note: decision.note,
      input: decision.input ?? null,
      changes: decision.changes ?? [],
    };
  }
  return { allowed: false, reason: refusalReason(toolName, decision) };
}

export function refusalReason(toolName: string, decision: Pick<Decision, "status" | "note" | "decidedBy">): string {
  const who = decision.decidedBy ? ` by ${decision.decidedBy}` : "";
  const why = decision.note ? ` Their reason: ${decision.note}` : "";
  switch (decision.status) {
    case "rejected":
      return `A person declined running ${toolName}${who}.${why} Do not retry it; change course or ask how to proceed.`;
    case "expired":
      return `Nobody decided whether to run ${toolName} before the request expired, so it was not run.`;
    default:
      return `The request to run ${toolName} was withdrawn, so it was not run.`;
  }
}
