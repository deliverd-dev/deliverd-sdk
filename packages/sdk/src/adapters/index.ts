/**
 * Deliverd inside the agent frameworks people already use: a person approves
 * a tool call from their inbox, Slack or Teams, and the agent carries on.
 *
 * `@deliverd/sdk/adapters`, separate from the main entry so none of it is
 * loaded unless it is used. No dependencies: each adapter matches its
 * framework's hook by shape.
 */
export { deliverdCanUseTool } from "./claude-agent-sdk.js";
export type {
  ClaudeCanUseTool,
  ClaudeCanUseToolContext,
  ClaudePermissionResult,
  ClaudeToolApprovalOptions,
} from "./claude-agent-sdk.js";
export {
  answerManagedAgentConfirmations,
  followManagedAgentSession,
  watchManagedAgentSessions,
} from "./claude-managed-agents.js";
export type {
  ManagedAgentsApprovalOptions,
  ManagedAgentsClient,
  ManagedAgentsEvent,
  ManagedAgentsResolution,
  ManagedAgentsStreamEvent,
  ManagedAgentsToolConfirmation,
} from "./claude-managed-agents.js";
export { deliverdToolApproval } from "./ai-sdk.js";
export type { AiSdkApprovalCall, AiSdkApprovalStatus } from "./ai-sdk.js";
export { resolveInterruptions, runWithDeliverdApprovals } from "./openai-agents.js";
export type { OpenAiApprovalItem, OpenAiInterruptedResult } from "./openai-agents.js";
export { approveInGraph, resumeFromCallback } from "./langgraph.js";
export type { DeliverdInterruptValue, GraphApprovalRecord, GraphApprover, GraphDecision } from "./langgraph.js";
export { generateWithDeliverdApprovals, pendingMastraApproval, resolveMastraApproval } from "./mastra.js";
export type { MastraApprovingAgent, MastraOutput } from "./mastra.js";
export { runMuseFunctionCalls, runMuseToolCalls } from "./muse-spark.js";
export type {
  MuseFunctionCall,
  MuseFunctionCallOutput,
  MuseToolApprovalOptions,
  MuseToolCall,
  MuseToolMessage,
  MuseToolRunner,
} from "./muse-spark.js";
export { deliverdAllow, describeStep, uiSdkApprovalRoute, UI_SDK_DEFAULT_TIMEOUT } from "./ui-sdk.js";
export type { DeliverdAllowOptions, UiSdkApprovalAnswer, UiSdkApprovalRouteOptions, UiSdkStep } from "./ui-sdk.js";
export { defaultDescription, DEFAULT_TOOL_EXPIRY } from "./shared.js";
export type { Approver, CallDescription, CallOutcome, ToolApprovalOptions } from "./shared.js";
