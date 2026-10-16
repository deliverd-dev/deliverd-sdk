import { askAboutCall, type ToolApprovalOptions } from "./shared.js";

/**
 * Mastra: a person approves an agent's tool calls, through Deliverd.
 *
 * Mark the tools that need a person as Mastra already has you do —
 * `createTool({ requireApproval: true })`, or `requireToolApproval` on the
 * call — and a run that reaches one stops with `finishReason: "suspended"`.
 * Instead of building your own prompt:
 *
 * ```ts
 * import { Deliverd } from "@deliverd/sdk";
 * import { generateWithDeliverdApprovals } from "@deliverd/sdk/adapters";
 *
 * const output = await generateWithDeliverdApprovals(
 *   agent,
 *   agent.generate("Refund order 1042", { requireToolApproval: true }),
 *   { deliverd: new Deliverd(), approvers: ["finance"] }
 * );
 * console.log(output.text);
 * ```
 *
 * Each suspended call becomes a request in Deliverd. Approved, it is
 * `agent.approveToolCallGenerate({ runId, toolCallId })` and the tool runs;
 * declined, it is `agent.declineToolCallGenerate({ runId, toolCallId, reason })`
 * and Mastra hands the person's reason to the model in place of its default
 * "not approved". The run resumes until nothing is waiting on a person.
 * `resolveMastraApproval` does one round, for a loop you own.
 *
 * A run suspended by a tool's own `suspend()` — waiting on data, not on a
 * yes or no — is returned as it is, for you to resume.
 *
 * Shapes follow `@mastra/core` 1.78.0's type definitions:
 * `Agent.approveToolCallGenerate` and `Agent.declineToolCallGenerate` in
 * `dist/agent/agent.d.ts`; `FullOutput`'s `finishReason`, `runId` and
 * `suspendPayload` in `dist/stream/base/output.d.ts`; and the payload of a
 * `tool-call-approval` chunk, `ToolCallApprovalPayload` (`toolCallId`,
 * `toolName`, `args`), against `ToolCallSuspendedPayload`, which also carries
 * the tool's own `suspendPayload`, in `dist/stream/types.d.ts`.
 */

/** The part of a Mastra generate output this adapter reads. */
export interface MastraOutput {
  finishReason?: string;
  runId?: string;
  /** For an approval: `{ toolCallId, toolName, args }`. */
  suspendPayload?: unknown;
}

/** The part of a Mastra `Agent` this adapter calls. */
export interface MastraApprovingAgent<Output extends MastraOutput = MastraOutput> {
  approveToolCallGenerate(options: { runId: string; toolCallId?: string }): Promise<Output>;
  declineToolCallGenerate(options: { runId: string; toolCallId?: string; reason?: string }): Promise<Output>;
}

/** The tool call a suspended output is waiting on a person for, or null when it is not. */
export function pendingMastraApproval(
  output: MastraOutput
): { runId: string; toolCallId: string; toolName: string; args: unknown } | null {
  if (output.finishReason !== "suspended" || !output.runId) return null;
  const payload = output.suspendPayload;
  if (typeof payload !== "object" || payload === null) return null;
  const { toolCallId, toolName, args } = payload as Record<string, unknown>;
  // A tool that called suspend() is waiting on data, not on a decision.
  if ("suspendPayload" in payload || typeof toolCallId !== "string") return null;
  return {
    runId: output.runId,
    toolCallId,
    toolName: typeof toolName === "string" ? toolName : "a tool",
    args: args ?? {},
  };
}

/**
 * Decide the call a suspended output is waiting on, and resume the run.
 * Returns the resumed run's output, or null when nothing was waiting on a
 * person.
 */
export async function resolveMastraApproval<Output extends MastraOutput>(
  agent: MastraApprovingAgent<Output>,
  output: MastraOutput,
  options: ToolApprovalOptions
): Promise<Output | null> {
  const pending = pendingMastraApproval(output);
  if (!pending) return null;
  const { runId, toolCallId, toolName, args } = pending;
  if (options.when && !(await options.when(toolName, args))) {
    return agent.approveToolCallGenerate({ runId, toolCallId });
  }
  const outcome = await askAboutCall(toolName, args, `mastra:${runId}:${toolCallId}`, options);
  return outcome.allowed
    ? agent.approveToolCallGenerate({ runId, toolCallId })
    : agent.declineToolCallGenerate({ runId, toolCallId, reason: outcome.reason });
}

/**
 * Resume a Mastra run until nothing is waiting on a person.
 *
 * `first` is the output of `agent.generate(…)`, or the promise of it. A cap
 * on rounds stops an agent that keeps asking from waiting forever.
 */
export async function generateWithDeliverdApprovals<Output extends MastraOutput>(
  agent: MastraApprovingAgent<Output>,
  first: Output | Promise<Output>,
  options: ToolApprovalOptions & { maxRounds?: number }
): Promise<Output> {
  const maxRounds = options.maxRounds ?? 10;
  let output = await first;
  for (let round = 0; pendingMastraApproval(output); round++) {
    if (round >= maxRounds) {
      throw new Error(
        `The run was still waiting for approval after ${maxRounds} rounds; stopping rather than asking forever.`
      );
    }
    output = (await resolveMastraApproval(agent, output, options))!;
  }
  return output;
}
