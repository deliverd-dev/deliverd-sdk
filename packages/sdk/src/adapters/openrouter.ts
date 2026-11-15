import { DeliverdTimeoutError } from "../errors.js";
import type { Duration } from "../duration.js";
import type { ApprovalRisk, Decision, RegisterAiSystemInput, UsePolicy, UsePolicyData, UsePolicyDeploymentClass } from "../types.js";
import { askAboutCall, type Approver, type ToolApprovalOptions } from "./shared.js";

/**
 * OpenRouter's Agent SDK (`@openrouter/agent`): a person approves the tool
 * calls you mark `requireApproval`, through Deliverd.
 *
 * OpenRouter pauses a run when a tool marked `requireApproval` is called and
 * leaves who decides, and where, to you. Two ways to hand that to Deliverd:
 *
 * In the run, with the `PermissionRequest` hook, which fires just before the
 * SDK would pause. The run waits for the person and goes on by itself; a no
 * reaches the model with the person's reason.
 *
 * ```ts
 * import { OpenRouter } from "@openrouter/agent";
 * import { Deliverd } from "@deliverd/sdk";
 * import { deliverdPermissionRequest } from "@deliverd/sdk/adapters";
 *
 * const result = openrouter.callModel({
 *   model: "anthropic/claude-sonnet-4.5",
 *   input: "Refund order 1042",
 *   tools: [refundTool], // tool({ ..., requireApproval: true })
 *   hooks: { PermissionRequest: [deliverdPermissionRequest({ deliverd: new Deliverd(), approvers: ["finance"] })] },
 * });
 * console.log(await result.getText());
 * ```
 *
 * Or across a pause, for a wait longer than a process should hold open: let
 * the run pause as OpenRouter does (with a `state` accessor), then
 * `resolveOpenRouterApprovals(result, options)` asks about each pending call
 * and returns the `approveToolCalls` and `rejectToolCalls` to resume with.
 * Each call is keyed by the conversation and call id, so asking again after a
 * restart finds the same request rather than filing a second one. OpenRouter
 * tells the model only "Rejected by user" on this path; the hook passes the
 * person's own reason.
 *
 * Shapes follow `@openrouter/agent` 1.2.1's type definitions: the
 * `PermissionRequest` entry of `BuiltInHookDefinitions` (`HookEntry`,
 * `PermissionRequestPayload` `{ toolName, toolInput, riskLevel }`,
 * `PermissionRequestResult` `{ decision: "allow" | "deny" | "ask_user",
 * reason }`, `LifecycleHookContext` `{ signal, hookName, sessionId }`) in
 * `esm/lib/hooks-types.d.ts` and `hooks-schemas.d.ts`; `ModelResult`'s
 * `getPendingToolCalls()` and `getState()` in `esm/lib/model-result.d.ts`;
 * and `ParsedToolCall` `{ id, name, arguments }` and `ConversationState`'s
 * `id` and `status` in `esm/lib/tool-types.d.ts`.
 */

/** The `PermissionRequest` hook payload. */
export interface OpenRouterPermissionPayload {
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
}

/** What a `PermissionRequest` handler returns. */
export interface OpenRouterPermissionResult {
  decision: "allow" | "deny" | "ask_user";
  reason?: string;
}

/** The hook context OpenRouter passes every handler. */
export interface OpenRouterHookContext {
  signal?: AbortSignal;
  sessionId?: string;
}

/** A `HookEntry` for `hooks.PermissionRequest`. */
export interface OpenRouterPermissionHook {
  handler: (payload: OpenRouterPermissionPayload, context: OpenRouterHookContext) => Promise<OpenRouterPermissionResult>;
}

/**
 * A `PermissionRequest` hook entry: each call OpenRouter would pause for is
 * decided by a person in Deliverd, and the run carries on.
 *
 * A call `when` does not select is allowed, as with the other adapters.
 * OpenRouter's payload carries no call id, so a call is keyed by the session
 * (or, when the run names none, this hook), the tool, its input and how many
 * times that same call has come up: the same call asked again in one run gets
 * a request of its own, and another run never reuses this one's yes.
 */
export function deliverdPermissionRequest(options: ToolApprovalOptions): OpenRouterPermissionHook {
  const seen = new Map<string, number>();
  // OpenRouter leaves the session id empty unless the run names one; a key
  // without it would let one run reuse another's yes for the same input.
  const instance = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return {
    async handler(payload, context) {
      const toolName = payload.toolName || "a tool";
      const input = payload.toolInput ?? {};
      if (options.when && !(await options.when(toolName, input))) return { decision: "allow" };
      const base = `openrouter:${context?.sessionId || instance}:${toolName}:${fingerprint(input)}`;
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      const outcome = await askAboutCall(
        toolName,
        input,
        occurrence === 1 ? base : `${base}:${occurrence}`,
        withRisk(options, payload.riskLevel),
        context?.signal
      );
      return outcome.allowed ? { decision: "allow" } : { decision: "deny", reason: outcome.reason };
    },
  };
}

/** The part of a `ParsedToolCall` this adapter reads. */
export interface OpenRouterPendingCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** The part of a `ModelResult` this adapter reads. */
export interface OpenRouterPausedResult {
  getPendingToolCalls(): Promise<OpenRouterPendingCall[]>;
  getState(): Promise<{ id: string; status?: string }>;
}

/** What to resume a paused conversation with: pass both to `callModel` with the same `state`. */
export interface OpenRouterResume {
  approveToolCalls: string[];
  rejectToolCalls: string[];
  /** Each refused call's reason, by call id, for your own log. OpenRouter does not pass it on. */
  reasons: Record<string, string>;
}

/**
 * Ask about every call a paused run is waiting on, and return the decisions
 * to resume it with. Calls `when` does not select are approved.
 */
export async function resolveOpenRouterApprovals(
  result: OpenRouterPausedResult,
  options: ToolApprovalOptions
): Promise<OpenRouterResume> {
  const resume: OpenRouterResume = { approveToolCalls: [], rejectToolCalls: [], reasons: {} };
  const pending = await result.getPendingToolCalls();
  if (pending.length === 0) return resume;
  const { id: conversationId } = await result.getState();
  for (const call of pending) {
    const toolName = String(call.name || "a tool");
    const input = parseArguments(call.arguments);
    if (options.when && !(await options.when(toolName, input))) {
      resume.approveToolCalls.push(call.id);
      continue;
    }
    const outcome = await askAboutCall(toolName, input, `openrouter:${conversationId}:${call.id}`, options);
    if (outcome.allowed) {
      resume.approveToolCalls.push(call.id);
    } else {
      resume.rejectToolCalls.push(call.id);
      resume.reasons[call.id] = outcome.reason;
    }
  }
  return resume;
}

/** OpenRouter's own reading of the risk, when the caller did not describe the call. */
function withRisk(options: ToolApprovalOptions, risk: OpenRouterPermissionPayload["riskLevel"]): ToolApprovalOptions {
  if (options.describe || !risk) return options;
  return {
    ...options,
    describe: (toolName, input) => {
      const rendered = safeJson(input);
      return {
        title: `Allow the agent to run ${toolName}`,
        description: rendered ? `With this input:\n\n${rendered}` : undefined,
        risk,
      };
    },
  };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safeJson(input: unknown): string {
  try {
    const text = JSON.stringify(input, null, 2) ?? "";
    return text.length > 3000 ? `${text.slice(0, 2999)}…` : text;
  } catch {
    return String(input);
  }
}

/** A short, stable key for an input: FNV-1a over its JSON with sorted keys. */
function fingerprint(input: unknown): string {
  const text = canonical(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/* ── OpenRouter's own controls and activity ─────────────────────────────── */

/**
 * OpenRouter's own controls, with a person's yes on every change, and the
 * AI register kept to what OpenRouter actually routes.
 *
 * OpenRouter guardrails set what a key may spend, which models and providers
 * it may reach, zero data retention and data regions. Anyone holding a
 * management key can change them, and nothing records who agreed. These
 * helpers run on your side, with your management key, which never reaches
 * Deliverd:
 *
 * - `changeOpenRouterGuardrail` reads the guardrail, shows a person what would
 *   change, and applies it only on their yes.
 * - `raiseOpenRouterKeyLimit` does the same for one key's credit limit.
 * - `openRouterGuardrailForData` reads your AI use policy for the data a key
 *   will carry and says whether OpenRouter may carry it at all, and with which
 *   guardrail settings.
 * - `openRouterModelsInUse` reads OpenRouter's activity (the last 30 days, by
 *   model) and `registerOpenRouterModels` adds the models nobody registered to
 *   the AI register, as found in use, for a person to triage.
 *
 * Shapes follow `@openrouter/sdk` 1.5.103's generated models: `Guardrail` and
 * `UpdateGuardrailRequest` (snake_case on the wire, `GET`/`PATCH
 * /guardrails/{id}`, answered as `{ data }`), `UpdateKeysRequestBody`
 * (`limit`, `limit_reset`; `GET`/`PATCH /keys/{hash}`) and `ActivityItem`
 * (`GET /activity`: `date`, `model`, `provider_name`, `requests`, `usage`).
 */

export interface OpenRouterAdmin {
  /** A management key (OpenRouter → Settings → Management keys). It stays in your process. */
  managementKey: string;
  /** Default `https://openrouter.ai/api/v1`; `https://eu.openrouter.ai/api/v1` for EU in-region routing. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** The guardrail settings these helpers read and change, as OpenRouter names them in its SDK. */
export interface OpenRouterGuardrailSettings {
  name?: string;
  description?: string | null;
  /** Spend limit in US dollars; null removes it. */
  limitUsd?: number | null;
  resetInterval?: "daily" | "weekly" | "monthly" | null;
  allowedModels?: string[] | null;
  ignoredModels?: string[] | null;
  allowedProviders?: string[] | null;
  ignoredProviders?: string[] | null;
  /** Zero data retention, for every provider. */
  enforceZdr?: boolean | null;
  allowedDataRegions?: ("global" | "europe" | "us")[] | null;
  enablePaidModelTraining?: boolean | null;
  enableFreeModelTraining?: boolean | null;
  enableFreeModelPublication?: boolean | null;
}

export interface OpenRouterChangeOptions {
  /** The client: `new Deliverd()`. */
  deliverd: Approver;
  openrouter: OpenRouterAdmin;
  /** Who may decide. The organisation's admins when omitted. */
  approvers?: string[];
  /** Why the change is wanted, in a sentence the approver reads first. */
  reason?: string;
  /** How long the request stays open. Default one day: nobody is waiting on a run. */
  expiresIn?: Duration;
  timeout?: Duration;
  flowId?: string;
  metadata?: Record<string, unknown>;
}

/** What happened to a change. */
export type OpenRouterChangeResult =
  | { applied: true; decidedBy: string | null; approvalId: string; changes: string[] }
  | { applied: false; reason: string; approvalId: string | null; changes: string[] };

const FIELDS: { key: keyof OpenRouterGuardrailSettings; wire: string; label: string }[] = [
  { key: "name", wire: "name", label: "Name" },
  { key: "description", wire: "description", label: "Description" },
  { key: "limitUsd", wire: "limit_usd", label: "Spend limit (USD)" },
  { key: "resetInterval", wire: "reset_interval", label: "Limit resets" },
  { key: "allowedModels", wire: "allowed_models", label: "Allowed models" },
  { key: "ignoredModels", wire: "ignored_models", label: "Blocked models" },
  { key: "allowedProviders", wire: "allowed_providers", label: "Allowed providers" },
  { key: "ignoredProviders", wire: "ignored_providers", label: "Blocked providers" },
  { key: "enforceZdr", wire: "enforce_zdr", label: "Zero data retention" },
  { key: "allowedDataRegions", wire: "allowed_data_regions", label: "Data regions" },
  { key: "enablePaidModelTraining", wire: "enable_paid_model_training", label: "Paid models may train on prompts" },
  { key: "enableFreeModelTraining", wire: "enable_free_model_training", label: "Free models may train on prompts" },
  { key: "enableFreeModelPublication", wire: "enable_free_model_publication", label: "Free models may publish prompts" },
];

/**
 * Change an OpenRouter guardrail only once a person says yes.
 *
 * The approver sees each setting that would change, before and after. A
 * change that loosens anything (a higher or removed spend limit, zero data
 * retention off, training on, more regions, models or providers) is asked as
 * high risk. The same change to the same guardrail, asked again before it was
 * applied, finds the same request; once the guardrail has changed, a new ask
 * is a new request.
 */
export async function changeOpenRouterGuardrail(
  guardrailId: string,
  change: OpenRouterGuardrailSettings,
  options: OpenRouterChangeOptions
): Promise<OpenRouterChangeResult> {
  const path = `/guardrails/${encodeURIComponent(guardrailId)}`;
  const current = await openRouterRequest<Record<string, unknown>>(options.openrouter, "GET", path);
  const body: Record<string, unknown> = {};
  const lines: string[] = [];
  let loosens = false;
  for (const { key, wire, label } of FIELDS) {
    if (!(key in change)) continue;
    const next = change[key] ?? null;
    const before = current[wire] ?? null;
    if (same(before, next)) continue;
    body[wire] = next;
    lines.push(`${label}: ${show(before)} → ${show(next)}`);
    if (loosening(key, before, next)) loosens = true;
  }
  if (lines.length === 0) {
    return { applied: false, reason: "The guardrail already has these settings, so nothing was asked or changed.", approvalId: null, changes: [] };
  }
  const name = typeof current.name === "string" ? current.name : guardrailId;
  const outcome = await ask(options, {
    title: `Change the OpenRouter guardrail “${name}”`,
    description: [options.reason, lines.map((line) => `- ${line}`).join("\n")].filter(Boolean).join("\n\n"),
    risk: loosens ? "high" : "medium",
    externalId: `openrouter-guardrail:${guardrailId}:${String(current.updated_at ?? current.created_at ?? "")}:${digestOf(body)}`,
    input: body,
    metadata: { openrouterGuardrailId: guardrailId },
  });
  if (!outcome.allowed) return { applied: false, reason: outcome.reason, approvalId: outcome.approvalId, changes: lines };
  await openRouterRequest(options.openrouter, "PATCH", path, body);
  return { applied: true, decidedBy: outcome.decidedBy, approvalId: outcome.approvalId, changes: lines };
}

/**
 * Raise (or change, or remove) one OpenRouter key's credit limit only once a
 * person says yes. The approver sees what the key has spent against its
 * current limit. Removing a limit, or more than doubling it, is high risk.
 */
export async function raiseOpenRouterKeyLimit(
  keyHash: string,
  next: { limit: number | null; limitReset?: "daily" | "weekly" | "monthly" | null },
  options: OpenRouterChangeOptions
): Promise<OpenRouterChangeResult> {
  const path = `/keys/${encodeURIComponent(keyHash)}`;
  const key = await openRouterRequest<Record<string, unknown>>(options.openrouter, "GET", path);
  const before = typeof key.limit === "number" ? key.limit : null;
  const body: Record<string, unknown> = { limit: next.limit };
  if ("limitReset" in next) body.limit_reset = next.limitReset ?? null;
  const lines = [`Credit limit (USD): ${show(before)} → ${show(next.limit)}`];
  if ("limitReset" in next && !same(key.limit_reset ?? null, next.limitReset ?? null)) {
    lines.push(`Limit resets: ${show(key.limit_reset ?? null)} → ${show(next.limitReset ?? null)}`);
  }
  if (same(before, next.limit) && lines.length === 1) {
    return { applied: false, reason: "The key already has this limit, so nothing was asked or changed.", approvalId: null, changes: [] };
  }
  const spent = typeof key.usage === "number" ? `It has spent $${key.usage.toFixed(2)} so far` : null;
  const monthly = typeof key.usage_monthly === "number" ? `, $${key.usage_monthly.toFixed(2)} this month` : "";
  const label = typeof key.name === "string" && key.name ? key.name : String(key.label ?? keyHash);
  const outcome = await ask(options, {
    title: next.limit === null ? `Remove the spend limit on OpenRouter key “${label}”` : `Set OpenRouter key “${label}” to a $${next.limit} limit`,
    description: [options.reason, spent ? `${spent}${monthly}.` : null, lines.map((line) => `- ${line}`).join("\n")].filter(Boolean).join("\n\n"),
    risk: next.limit === null || (before !== null && next.limit > before * 2) ? "high" : "medium",
    externalId: `openrouter-key:${keyHash}:${String(key.updated_at ?? key.created_at ?? "")}:${digestOf(body)}`,
    input: body,
    metadata: { openrouterKeyHash: keyHash },
  });
  if (!outcome.allowed) return { applied: false, reason: outcome.reason, approvalId: outcome.approvalId, changes: lines };
  await openRouterRequest(options.openrouter, "PATCH", path, body);
  return { applied: true, decidedBy: outcome.decidedBy, approvalId: outcome.approvalId, changes: lines };
}

/** What the AI use policy says about sending this data through OpenRouter. */
export interface OpenRouterPolicyReading {
  /** False when the policy keeps some of the data to a private deployment, or out of AI tools altogether. */
  allowed: boolean;
  /** The least-controlled kind of tool the policy accepts for all of the data. */
  deploymentClass: UsePolicyDeploymentClass | null;
  /** Guardrail settings that make OpenRouter that kind of tool, as far as settings can. Empty when nothing is needed. */
  guardrail: OpenRouterGuardrailSettings;
  /** Conditions the policy attaches, which still apply per use: a person asked, or a current DPIA. */
  conditions: string[];
  /** In a sentence or two, for a log or the approver. */
  explanation: string;
}

const CLASS_ORDER: UsePolicyDeploymentClass[] = ["consumer", "enterprise", "private"];

/**
 * Read the AI use policy for the data a key will carry.
 *
 * OpenRouter on its defaults is treated as a consumer tool. With zero data
 * retention enforced and training and publication off, under your own
 * agreement with OpenRouter, it is treated as an enterprise tenant. It is
 * never a private deployment. Pass the policy from
 * `deliverd.governance.aiUsePolicy()`.
 */
export function openRouterGuardrailForData(
  policy: UsePolicy,
  data: UsePolicyData[],
  options: { region?: "europe" | "us" } = {}
): OpenRouterPolicyReading {
  let needed = 0;
  const conditions: string[] = [];
  for (const kind of data.length ? data : (["internal"] as UsePolicyData[])) {
    const row = policy.grid[kind];
    const first = CLASS_ORDER.findIndex((cls) => row?.[cls] && row[cls].rule !== "no");
    if (first === -1) {
      return {
        allowed: false,
        deploymentClass: null,
        guardrail: {},
        conditions: [],
        explanation: `The AI use policy says ${labelOf(kind)} goes into no AI tool, so it may not go through OpenRouter.`,
      };
    }
    needed = Math.max(needed, first);
  }
  const cls = CLASS_ORDER[needed]!;
  for (const kind of data) {
    const cell = policy.grid[kind]?.[cls];
    if (cell?.rule === "conditional" && cell.condition) conditions.push(`${labelOf(kind)}: ${cell.condition}`);
  }
  if (cls === "private") {
    return {
      allowed: false,
      deploymentClass: cls,
      guardrail: {},
      conditions,
      explanation: "The AI use policy keeps this data to a private deployment (your own cloud and region). OpenRouter is a hosted router, so it may not carry it.",
    };
  }
  const guardrail: OpenRouterGuardrailSettings =
    cls === "enterprise"
      ? { enforceZdr: true, enablePaidModelTraining: false, enableFreeModelTraining: false, enableFreeModelPublication: false }
      : {};
  if (options.region) guardrail.allowedDataRegions = [options.region];
  return {
    allowed: true,
    deploymentClass: cls,
    guardrail,
    conditions,
    explanation:
      cls === "enterprise"
        ? "The AI use policy needs an enterprise tenant for this data. Enforce zero data retention and turn training and publication off, and make sure your agreement with OpenRouter covers it."
        : "The AI use policy lets this data go into consumer tools, so no guardrail setting is needed for it.",
  };
}

/** One model OpenRouter routed to, from its activity. */
export interface OpenRouterModelUse {
  model: string;
  providers: string[];
  requests: number;
  /** US dollars. */
  usage: number;
  firstSeen: string;
  lastSeen: string;
}

/** The models a management key's organisation used through OpenRouter, from its activity (the last 30 days), most requests first. */
export async function openRouterModelsInUse(openrouter: OpenRouterAdmin): Promise<OpenRouterModelUse[]> {
  const { data } = await openRouterRequest<{ data?: Record<string, unknown>[] }>(openrouter, "GET", "/activity", undefined, true);
  const byModel = new Map<string, OpenRouterModelUse>();
  for (const row of data ?? []) {
    const model = typeof row.model === "string" ? row.model : null;
    if (!model) continue;
    const date = typeof row.date === "string" ? row.date : "";
    const entry = byModel.get(model) ?? { model, providers: [], requests: 0, usage: 0, firstSeen: date, lastSeen: date };
    const provider = typeof row.provider_name === "string" ? row.provider_name : null;
    if (provider && !entry.providers.includes(provider)) entry.providers.push(provider);
    entry.requests += typeof row.requests === "number" ? row.requests : 0;
    entry.usage += typeof row.usage === "number" ? row.usage : 0;
    if (date && (!entry.firstSeen || date < entry.firstSeen)) entry.firstSeen = date;
    if (date && date > entry.lastSeen) entry.lastSeen = date;
    byModel.set(model, entry);
  }
  return [...byModel.values()].sort((a, b) => b.requests - a.requests);
}

/** The part of the Deliverd client this needs: `deliverd.governance.aiSystems`. */
export interface RegisterClient {
  governance: {
    aiSystems: {
      list(input?: { status?: "active" | "retired" }): Promise<{ id: string; model: string | null; name: string }[]>;
      register(input: RegisterAiSystemInput): Promise<{ id: string; name: string }>;
    };
  };
}

/**
 * Add each model OpenRouter routed to, and nobody registered, to the AI
 * register as found in use (`entryType: "discovered"`, supplier OpenRouter),
 * for a person to triage. A model already on a record, active or retired, is
 * left alone. Returns what it added and what it skipped.
 */
export async function registerOpenRouterModels(options: {
  deliverd: RegisterClient;
  openrouter: OpenRouterAdmin;
  /** Only models with at least this many requests. Default 1. */
  minRequests?: number;
  /** What to put on each new record, on top of what is found. */
  defaults?: Partial<RegisterAiSystemInput>;
}): Promise<{ registered: { id: string; model: string }[]; skipped: string[] }> {
  const [models, records] = await Promise.all([openRouterModelsInUse(options.openrouter), options.deliverd.governance.aiSystems.list()]);
  const known = new Set(records.map((record) => record.model).filter((model): model is string => Boolean(model)));
  const registered: { id: string; model: string }[] = [];
  const skipped: string[] = [];
  for (const use of models) {
    if (known.has(use.model) || use.requests < (options.minRequests ?? 1)) {
      skipped.push(use.model);
      continue;
    }
    const record = await options.deliverd.governance.aiSystems.register({
      name: `${use.model} via OpenRouter`,
      provider: use.providers.join(", ") || null,
      model: use.model,
      supplier: "OpenRouter",
      buildOrBuy: "buy",
      entryType: "discovered",
      purpose: `Found in OpenRouter activity: ${use.requests} request${use.requests === 1 ? "" : "s"} between ${use.firstSeen.slice(0, 10)} and ${use.lastSeen.slice(0, 10)}. Who uses it, and for what, is for a person to fill in.`,
      ...options.defaults,
    });
    known.add(use.model);
    registered.push({ id: record.id, model: use.model });
  }
  return { registered, skipped };
}

/* ── Plumbing ─────────────────────────────────────────────────────────── */

async function openRouterRequest<T>(
  admin: OpenRouterAdmin,
  method: "GET" | "PATCH",
  path: string,
  body?: unknown,
  whole = false
): Promise<T> {
  const doFetch = admin.fetch ?? fetch;
  const base = (admin.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const response = await doFetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin.managementKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* keep the text */
    }
    throw new Error(`OpenRouter ${method} ${path} failed (${response.status}): ${message}`);
  }
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return (whole ? json : (json.data ?? json)) as T;
}

type Asked = { allowed: true; decidedBy: string | null; approvalId: string } | { allowed: false; reason: string; approvalId: string | null };

async function ask(
  options: OpenRouterChangeOptions,
  request: { title: string; description: string; risk: ApprovalRisk; externalId: string; input: Record<string, unknown>; metadata: Record<string, unknown> }
): Promise<Asked> {
  let decision: Decision;
  try {
    decision = await options.deliverd.approve({
      title: request.title,
      description: request.description,
      risk: request.risk,
      approvers: options.approvers,
      externalId: request.externalId,
      flowId: options.flowId,
      input: request.input,
      metadata: { ...options.metadata, ...request.metadata, source: "openrouter" },
      expiresIn: options.expiresIn ?? "1d",
      timeout: options.timeout,
    });
  } catch (err) {
    if (err instanceof DeliverdTimeoutError) {
      return { allowed: false, reason: "Nobody decided in time, so nothing was changed.", approvalId: null };
    }
    throw err;
  }
  if (decision.approved) return { allowed: true, decidedBy: decision.decidedBy, approvalId: decision.id };
  const who = decision.decidedBy ? ` by ${decision.decidedBy}` : "";
  const why = decision.note ? ` Their reason: ${decision.note}` : "";
  const reason =
    decision.status === "rejected"
      ? `A person declined the change${who}, so nothing was changed.${why}`
      : decision.status === "expired"
        ? "Nobody decided before the request expired, so nothing was changed."
        : "The request was withdrawn, so nothing was changed.";
  return { allowed: false, reason, approvalId: decision.id };
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : JSON.stringify(v ?? null));
  return norm(a) === norm(b);
}

/** Whether moving from `before` to `after` gives the key more room than it had. */
function loosening(key: keyof OpenRouterGuardrailSettings, before: unknown, after: unknown): boolean {
  switch (key) {
    case "limitUsd":
      return after === null || (typeof before === "number" && typeof after === "number" && after > before);
    case "enforceZdr":
      return before === true && after !== true;
    case "enablePaidModelTraining":
    case "enableFreeModelTraining":
    case "enableFreeModelPublication":
      return after === true;
    case "allowedModels":
    case "allowedProviders":
    case "allowedDataRegions": {
      // null or empty means "anything": widening from a list to anything, or adding to the list.
      const was = Array.isArray(before) ? before.map(String) : null;
      const now = Array.isArray(after) ? after.map(String) : null;
      if (!now || now.length === 0) return Boolean(was && was.length);
      if (!was || was.length === 0) return false;
      return now.some((item) => !was.includes(item));
    }
    case "ignoredModels":
    case "ignoredProviders": {
      const was = Array.isArray(before) ? before.map(String) : [];
      const now = Array.isArray(after) ? after.map(String) : [];
      return was.some((item) => !now.includes(item));
    }
    default:
      return false;
  }
}

function labelOf(kind: UsePolicyData): string {
  return (
    { public: "public data", internal: "internal data", confidential: "confidential data", restricted: "restricted data", personal: "personal data", special: "special-category data" } as const
  )[kind];
}

function digestOf(value: unknown): string {
  const text = JSON.stringify(value, Object.keys((value ?? {}) as object).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
