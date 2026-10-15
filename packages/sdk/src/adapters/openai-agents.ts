import { askAboutCall, type ToolApprovalOptions } from "./shared.js";

/**
 * The OpenAI Agents SDK: a person resolves the run's approval interruptions,
 * through Deliverd.
 *
 * Mark the tools that need a person with `needsApproval: true` as usual; a run
 * then stops with `result.interruptions`. Instead of building your own prompt:
 *
 * ```ts
 * import { Agent, run } from "@openai/agents";
 * import { Deliverd } from "@deliverd/sdk";
 * import { runWithDeliverdApprovals } from "@deliverd/sdk/adapters";
 *
 * const result = await runWithDeliverdApprovals(
 *   (input) => run(agent, input),
 *   "Refund order 1042",
 *   { deliverd: new Deliverd(), approvers: ["finance"] }
 * );
 * ```
 *
 * Each interruption becomes a request in Deliverd; approved ones are
 * `state.approve(item)`, declined ones `state.reject(item, { message })` with
 * the person's reason, and the run resumes from its state until nothing is
 * waiting. `resolveInterruptions` does one round, for a loop you own.
 *
 * Shapes follow `RunToolApprovalItem`, `RunState.approve` / `reject` and
 * `RunResult.interruptions` in `@openai/agents-core`'s type definitions.
 */

/** The part of a `RunToolApprovalItem` this adapter reads. */
export interface OpenAiApprovalItem {
  name?: string;
  arguments?: string;
  rawItem?: { callId?: string; id?: string; name?: string };
}

/** The part of a run result this adapter reads and resolves. */
export interface OpenAiInterruptedResult<Item extends OpenAiApprovalItem = OpenAiApprovalItem, State = unknown> {
  interruptions: Item[];
  state: State & {
    approve(item: Item, options?: { alwaysApprove?: boolean }): void;
    reject(item: Item, options?: { alwaysReject?: boolean; message?: string }): void;
  };
}

/** Ask about every interruption in a result, and record each answer on its state. */
export async function resolveInterruptions<Item extends OpenAiApprovalItem>(
  result: OpenAiInterruptedResult<Item>,
  options: ToolApprovalOptions
): Promise<{ approved: number; rejected: number }> {
  let approved = 0;
  let rejected = 0;
  for (const item of result.interruptions) {
    const toolName = item.name ?? item.rawItem?.name ?? "a tool";
    const input = parseArguments(item.arguments);
    if (options.when && !(await options.when(toolName, input))) {
      result.state.approve(item);
      approved += 1;
      continue;
    }
    const callId = item.rawItem?.callId ?? item.rawItem?.id ?? `${toolName}:${item.arguments ?? ""}`;
    const outcome = await askAboutCall(toolName, input, `openai-agents:${callId}`, options);
    if (outcome.allowed) {
      result.state.approve(item);
      approved += 1;
    } else {
      result.state.reject(item, { message: outcome.reason });
      rejected += 1;
    }
  }
  return { approved, rejected };
}

/**
 * Run until nothing is waiting on a person.
 *
 * `runOnce` is your call to the SDK's `run(agent, input)`; it is called
 * first with `input`, then with the result's state after each round of
 * decisions. A cap on rounds stops an agent that keeps asking from waiting
 * forever.
 */
export async function runWithDeliverdApprovals<
  Result extends OpenAiInterruptedResult<Item>,
  Item extends OpenAiApprovalItem = OpenAiApprovalItem,
  Input = unknown,
>(
  runOnce: (input: Input | Result["state"]) => Promise<Result>,
  input: Input,
  options: ToolApprovalOptions & { maxRounds?: number }
): Promise<Result> {
  let result = await runOnce(input);
  for (let round = 0; result.interruptions.length > 0; round++) {
    if (round >= (options.maxRounds ?? 10)) {
      throw new Error(
        `The run was still waiting for approval after ${options.maxRounds ?? 10} rounds; stopping rather than asking forever.`
      );
    }
    await resolveInterruptions(result, options);
    result = await runOnce(result.state);
  }
  return result;
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
