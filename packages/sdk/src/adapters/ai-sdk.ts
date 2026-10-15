import { askAboutCall, type ToolApprovalOptions } from "./shared.js";

/**
 * The Vercel AI SDK: a person approves tool calls, through Deliverd.
 *
 * ```ts
 * import { generateText } from "ai";
 * import { Deliverd } from "@deliverd/sdk";
 * import { deliverdToolApproval } from "@deliverd/sdk/adapters";
 *
 * const result = await generateText({
 *   model,
 *   tools: { refund, sendEmail, lookupOrder },
 *   toolApproval: deliverdToolApproval({
 *     deliverd: new Deliverd(),
 *     approvers: ["finance"],
 *     when: (tool) => tool === "refund" || tool === "sendEmail",
 *   }),
 *   prompt,
 * });
 * ```
 *
 * `toolApproval` is the AI SDK's own approval hook on `generateText`,
 * `streamText` and `ToolLoopAgent`; this function is one it accepts. A call
 * that needs no person is `not-applicable`. One that does waits for Deliverd:
 * `approved` runs it, `denied` hands the model the person's reason.
 *
 * Shapes follow `GenericToolApprovalFunction` and `ToolApprovalStatus` in
 * `ai`'s type definitions (v7).
 */

/** The part of the AI SDK's approval call this adapter reads. */
export interface AiSdkApprovalCall {
  toolCall: { toolName: string; toolCallId: string; input: unknown };
}

export type AiSdkApprovalStatus =
  | { type: "not-applicable" }
  | { type: "approved"; reason?: string }
  | { type: "denied"; reason?: string };

export function deliverdToolApproval(
  options: ToolApprovalOptions
): (call: AiSdkApprovalCall) => Promise<AiSdkApprovalStatus> {
  return async ({ toolCall }) => {
    if (options.when && !(await options.when(toolCall.toolName, toolCall.input))) {
      return { type: "not-applicable" };
    }
    const outcome = await askAboutCall(
      toolCall.toolName,
      toolCall.input,
      `ai-sdk:${toolCall.toolCallId}`,
      options
    );
    return outcome.allowed
      ? { type: "approved", reason: outcome.decidedBy ? `Approved by ${outcome.decidedBy}` : undefined }
      : { type: "denied", reason: outcome.reason };
  };
}
