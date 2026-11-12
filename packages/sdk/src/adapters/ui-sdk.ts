import type { Duration } from "../duration.js";
import { askAboutCall, type CallDescription, type ToolApprovalOptions } from "./shared.js";

/**
 * Vercel's UI SDK (`@ui-sdk/*`): a person approves what an agent does in your
 * interface, through Deliverd.
 *
 * UI SDK's agent bridge lets an agent press buttons and fill fields in an app
 * built with its components. Controls marked `data-agent-confirm="…"` wait for
 * the bridge's `allow` hook. These two functions make that hook a Deliverd
 * approval: the browser half asks your server, and your server, which holds the
 * agent key, asks Deliverd and waits for the person.
 *
 * In the browser, where the bridge is created:
 *
 * ```ts
 * import { createAgent } from "@ui-sdk/react/agent";
 * import { deliverdAllow } from "@deliverd/sdk/adapters";
 *
 * const agent = createAgent({
 *   allow: deliverdAllow({ endpoint: "/api/deliverd/ui-approval" }),
 *   timeout: 15 * 60_000,
 * });
 * ```
 *
 * On the server, as a fetch-style route (Next.js `app/api/deliverd/ui-approval/route.ts`):
 *
 * ```ts
 * import { Deliverd } from "@deliverd/sdk";
 * import { uiSdkApprovalRoute } from "@deliverd/sdk/adapters";
 *
 * export const maxDuration = 800;
 * export const POST = uiSdkApprovalRoute({ deliverd: new Deliverd(), approvers: ["ops"], timeout: "13m" });
 * ```
 *
 * The browser never sees the agent key, and the agent never sees the answer
 * until a person gives it. Each ask is its own request: an approval is for
 * that one step, then, and is never reused for a later one. A wait that runs
 * out is a no, and the request expires with it, so nobody approves a step the
 * agent has stopped waiting for.
 *
 * Shapes follow `AgentAction` and `createAgent`'s `allow` option in
 * `@ui-sdk/core`'s agent docs (0.1.0-beta.1).
 */

/** The step UI SDK hands to `allow`: its `AgentAction`. */
export interface UiSdkStep {
  ref: string;
  component: string;
  label?: string;
  action: string;
  args?: unknown[];
  /** The sentence from a `data-agent-confirm` mark on the target, when it has one. */
  confirm?: string;
}

/** What the server route answers. */
export type UiSdkApprovalAnswer = { allowed: true; decidedBy: string | null } | { allowed: false; reason: string };

export interface DeliverdAllowOptions {
  /** Your server route that calls `uiSdkApprovalRoute`. */
  endpoint: string;
  /**
   * Which steps go to a person. Default: those on a `data-agent-confirm`
   * mark. Steps outside it are allowed without asking.
   */
  when?: (step: UiSdkStep) => boolean;
  /** Headers for the call to your route, such as a CSRF token. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Told each answer, so the page can show a person's reason. */
  onAnswer?: (answer: UiSdkApprovalAnswer, step: UiSdkStep) => void;
  fetch?: typeof globalThis.fetch;
}

/**
 * UI SDK's `allow` hook, answered by a person through Deliverd.
 *
 * Anything other than a clear yes from your route is a no: a network failure,
 * an error status, an answer it cannot read. UI SDK then tells the agent the
 * person said no, and the control is not touched.
 */
export function deliverdAllow(
  options: DeliverdAllowOptions
): (step: UiSdkStep, context?: { signal?: AbortSignal }) => Promise<boolean> {
  const needsPerson = options.when ?? ((step: UiSdkStep) => Boolean(step.confirm));
  return async (step, context) => {
    if (!needsPerson(step)) return true;
    const doFetch = options.fetch ?? globalThis.fetch;
    const headers = typeof options.headers === "function" ? options.headers() : options.headers;
    let answer: UiSdkApprovalAnswer;
    try {
      const response = await doFetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ step: pickStep(step), nonce: nonce() }),
        signal: context?.signal,
      });
      const body = (await response.json().catch(() => null)) as Partial<UiSdkApprovalAnswer> | null;
      answer =
        response.ok && body?.allowed === true
          ? { allowed: true, decidedBy: typeof body.decidedBy === "string" ? body.decidedBy : null }
          : {
              allowed: false,
              reason:
                body && body.allowed === false && typeof body.reason === "string"
                  ? body.reason
                  : `The approval route answered ${response.status}, so the step was not run.`,
            };
    } catch {
      if (context?.signal?.aborted) return false;
      answer = { allowed: false, reason: "The approval route could not be reached, so the step was not run." };
    }
    options.onAnswer?.(answer, step);
    return answer.allowed;
  };
}

export interface UiSdkApprovalRouteOptions extends Omit<ToolApprovalOptions, "when" | "describe"> {
  /**
   * Which steps go to a person, decided on the server. Default: those on a
   * `data-agent-confirm` mark. A step outside it is refused, not allowed:
   * the browser only sends steps it wants a person for, so anything else
   * arriving here was not sent by `deliverdAllow`.
   */
  when?: (step: UiSdkStep, request: Request) => boolean | Promise<boolean>;
  /** What the approver reads. Built from the mark's sentence, the control and its values when omitted. */
  describe?: (step: UiSdkStep) => CallDescription;
  /**
   * How long to wait for the person. Default four minutes, inside UI SDK's
   * own five-minute wait and a typical function limit. Raise all three together.
   */
  timeout?: Duration;
  /** How long the request stays open. Default: the same as `timeout`. */
  expiresIn?: Duration;
}

export const UI_SDK_DEFAULT_TIMEOUT: Duration = "4m";

/**
 * The server half: a fetch-style `POST` handler (Next.js route handlers, Hono,
 * Remix, Workers) that asks Deliverd about one UI SDK step and waits.
 *
 * Set `timeout` below both your platform's function limit and the bridge's
 * own `timeout`, or the function is cut off before it can answer. The
 * request's abort signal cancels the wait when the page stops asking.
 */
export function uiSdkApprovalRoute(options: UiSdkApprovalRouteOptions): (request: Request) => Promise<Response> {
  const needsPerson = options.when ?? ((step: UiSdkStep) => Boolean(step.confirm));
  const describe = options.describe ?? describeStep;
  const timeout = options.timeout ?? UI_SDK_DEFAULT_TIMEOUT;
  return async (request) => {
    if (request.method !== "POST") return json({ allowed: false, reason: "Use POST." }, 405);
    let raw: unknown;
    try {
      const text = await request.text();
      if (text.length > BODY_MAX) return json({ allowed: false, reason: "The step is too large to ask about." }, 413);
      raw = JSON.parse(text);
    } catch {
      return json({ allowed: false, reason: "The step could not be read." }, 400);
    }
    const parsed = readBody(raw);
    if (!parsed) return json({ allowed: false, reason: "The step could not be read." }, 400);
    const { step, nonce: id } = parsed;
    if (!(await needsPerson(step, request))) {
      return json({ allowed: false, reason: "This step is not one this route asks a person about." }, 403);
    }
    const name = stepName(step);
    const outcome = await askAboutCall(
      name,
      { component: step.component, ref: step.ref, action: step.action, args: step.args ?? [] },
      `ui-sdk:${await sha256(canonical({ step, id }))}`,
      {
        ...options,
        when: undefined,
        describe: () => describe(step),
        timeout,
        expiresIn: options.expiresIn ?? timeout,
        metadata: { ...options.metadata, source: "ui-sdk" },
      },
      request.signal
    );
    return json(
      outcome.allowed ? { allowed: true, decidedBy: outcome.decidedBy } : { allowed: false, reason: outcome.reason },
      200
    );
  };
}

/** What an approver reads about a step, when the app did not write it. */
export function describeStep(step: UiSdkStep): CallDescription {
  const target = step.label ? `"${step.label}"` : `the ${step.component}`;
  const verb = step.action === "press" ? "press" : step.action === "setValue" ? "set" : step.action;
  const values = (step.args ?? []).map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(", ");
  const lines = [
    step.confirm ? `The app says this: ${step.confirm}` : undefined,
    `An agent wants to ${verb} ${target}${values ? ` (${truncate(values, 500)})` : ""} in the app.`,
  ].filter(Boolean);
  return {
    title: truncate(step.confirm ?? `Let the agent ${verb} ${target}`, 200),
    description: lines.join("\n\n"),
    risk: step.confirm ? "high" : "medium",
  };
}

const BODY_MAX = 16_000;

function stepName(step: UiSdkStep): string {
  return step.label ? `${step.action} "${step.label}"` : `${step.action} ${step.component}`;
}

/** Only the fields `AgentAction` documents, so nothing else on the object leaves the page. */
function pickStep(step: UiSdkStep): UiSdkStep {
  return {
    ref: step.ref,
    component: step.component,
    ...(step.label !== undefined ? { label: step.label } : {}),
    action: step.action,
    args: step.args ?? [],
    ...(step.confirm !== undefined ? { confirm: step.confirm } : {}),
  };
}

function readBody(raw: unknown): { step: UiSdkStep; nonce: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { step, nonce: id } = raw as { step?: unknown; nonce?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
  if (typeof step !== "object" || step === null) return null;
  const s = step as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length <= 1000;
  if (!str(s.ref) || !str(s.component) || !str(s.action)) return null;
  if (s.label !== undefined && !str(s.label)) return null;
  if (s.confirm !== undefined && !str(s.confirm)) return null;
  if (s.args !== undefined && !Array.isArray(s.args)) return null;
  return { step: pickStep(s as unknown as UiSdkStep), nonce: id };
}

function json(body: UiSdkApprovalAnswer | { allowed: false; reason: string }, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nonce(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
