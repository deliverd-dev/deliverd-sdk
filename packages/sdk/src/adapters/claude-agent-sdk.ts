import { askAboutCall, type ToolApprovalOptions } from "./shared.js";

/**
 * The Claude Agent SDK: a person approves tool calls, through Deliverd.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { Deliverd } from "@deliverd/sdk";
 * import { deliverdCanUseTool } from "@deliverd/sdk/adapters";
 *
 * const deliverd = new Deliverd();
 * for await (const message of query({
 *   prompt: "Tidy the release notes and publish them",
 *   options: {
 *     canUseTool: deliverdCanUseTool({
 *       deliverd,
 *       approvers: ["release-managers"],
 *       when: (tool) => tool === "Bash" || tool.startsWith("mcp__"),
 *     }),
 *   },
 * })) { … }
 * ```
 *
 * A call that needs no person is allowed with its input unchanged. One that
 * does waits for the decision, from the page, the email link, Slack or Teams:
 * allowed, it runs; declined, the model is told why and told not to retry.
 * The run's abort signal cancels the wait.
 *
 * Shapes follow `CanUseTool` and `PermissionResult` in
 * `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`.
 */

/** The options `canUseTool` receives that this adapter reads. */
export interface ClaudeCanUseToolContext {
  signal: AbortSignal;
  /** The tool call's id, which keeps a retried call from asking twice. */
  toolUseID?: string;
}

export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: ClaudeCanUseToolContext
) => Promise<ClaudePermissionResult>;

export interface ClaudeToolApprovalOptions extends ToolApprovalOptions {
  /**
   * Fields of a tool's input the approver may correct before approving, per
   * tool: `editable: (tool) => tool === "refund" ? ["amount"] : []`. The call
   * then runs with what they approved — the Agent SDK's `updatedInput` —
   * rather than with what the model proposed.
   */
  editable?: (toolName: string, input: Record<string, unknown>) => string[];
}

export function deliverdCanUseTool(options: ClaudeToolApprovalOptions): ClaudeCanUseTool {
  return async (toolName, input, context) => {
    if (options.when && !(await options.when(toolName, input))) {
      return { behavior: "allow", updatedInput: input };
    }
    const id = context.toolUseID ?? `${toolName}:${stableHash(input)}`;
    const outcome = await askAboutCall(
      toolName,
      input,
      `claude-agent-sdk:${id}`,
      options,
      context.signal,
      options.editable?.(toolName, input)
    );
    // What was approved runs, which is the proposal unless a person corrected it.
    return outcome.allowed
      ? { behavior: "allow", updatedInput: outcome.input ?? input }
      : { behavior: "deny", message: outcome.reason };
  };
}

/** A short, stable fingerprint of an input, for when no call id is given. */
function stableHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
