/**
 * Microsoft Purview's answer on a text, held beside Deliverd's own.
 *
 * An organisation that runs Microsoft Purview has already written its data
 * loss prevention (DLP) policies there. An app can ask Purview about a text
 * before it is sent to a model, through Microsoft Graph's `processContent`,
 * and Purview answers with what the app must do: nothing, or a restricted
 * access action whose `restrictionAction` is `audit`, `warn` or `block`.
 *
 * The SDKs make that call where the agent runs, with the organisation's own
 * Entra app, so the text goes to Microsoft and never to Deliverd. Deliverd is
 * sent only the outcome below, and holds it beside its own screening:
 *
 * - `block`: nothing is sent. The organisation's own policy said so, and it
 *   is honoured on every plan, report-only included.
 * - `warn`: a person decides, through an ordinary approval. Purview's "warn"
 *   is an override a user may make; here the override is recorded, with who
 *   made it.
 * - `audit`: no hold. Purview has recorded the activity itself.
 *
 * When Purview cannot be reached, the caller has already decided what that
 * means (allow, ask or deny) and says so in `restriction`, with `unavailable`
 * set, so the reason given is honest about it.
 *
 * Pure, with no imports. This file is copied verbatim into
 * `packages/sdk/src/purview-rules.ts` and `packages/screen/src/purview-rules.ts`,
 * and a test fails when they differ.
 */

export const PURVIEW_RESTRICTIONS = ["audit", "warn", "block"] as const;
export type PurviewRestriction = (typeof PURVIEW_RESTRICTIONS)[number];

export interface PurviewOutcome {
  /** The strictest restriction among Purview's policy actions; null when there were none. */
  restriction: PurviewRestriction | null;
  /** How many policy actions Purview returned. */
  actions: number;
  /** Purview said the organisation's policies changed since the caller last looked. */
  scopeModified: boolean;
  /** Purview could not be reached; `restriction` is what the caller chose for that case. */
  unavailable: boolean;
}

/** What a caller does when Purview cannot be reached. */
export type PurviewOnUnavailable = "allow" | "ask" | "deny";

const RESTRICTION_RANK: Record<PurviewRestriction, number> = { audit: 0, warn: 1, block: 2 };

/**
 * The outcome of a `processContent` response body. Anything unrecognised in
 * a policy action counts as a block: a DLP rule the code does not understand
 * is not a reason to send the text.
 */
export function purviewOutcomeFromResponse(body: unknown): PurviewOutcome {
  const b = (body ?? {}) as { policyActions?: unknown; protectionScopeState?: unknown };
  const actions = Array.isArray(b.policyActions) ? b.policyActions : [];
  let restriction: PurviewRestriction | null = null;
  for (const raw of actions) {
    const a = (raw ?? {}) as { action?: unknown; restrictionAction?: unknown };
    const given = typeof a.restrictionAction === "string" ? a.restrictionAction : null;
    const r: PurviewRestriction = given === "audit" || given === "warn" || given === "block" ? given : "block";
    if (restriction === null || RESTRICTION_RANK[r] > RESTRICTION_RANK[restriction]) restriction = r;
  }
  return { restriction, actions: actions.length, scopeModified: b.protectionScopeState === "modified", unavailable: false };
}

/** The outcome when Purview could not be reached, by the caller's choice. */
export function purviewUnavailable(onUnavailable: PurviewOnUnavailable): PurviewOutcome {
  const restriction: PurviewRestriction | null = onUnavailable === "deny" ? "block" : onUnavailable === "ask" ? "warn" : null;
  return { restriction, actions: 0, scopeModified: false, unavailable: true };
}

type Verdict = "allow" | "redact" | "ask" | "deny";
const VERDICT_RANK: Record<Verdict, number> = { allow: 0, redact: 1, ask: 2, deny: 3 };

/**
 * Deliverd's verdict with Purview's held beside it: the stricter wins, and
 * the reason says it was Purview. `enforce` false is the report-only mode,
 * where Deliverd holds nothing back of its own but a Purview block still
 * stands, because it is the organisation's own policy, not Deliverd's.
 */
export function applyPurview<T extends { verdict: Verdict; reasons: string[] }>(
  assessment: T,
  outcome: PurviewOutcome | null | undefined,
  enforce = true
): T {
  if (!outcome) return assessment;
  const reasons = [...assessment.reasons];
  let verdict = assessment.verdict;
  const raise = (to: Verdict) => {
    if (VERDICT_RANK[to] > VERDICT_RANK[verdict]) verdict = to;
  };
  if (outcome.unavailable) {
    if (outcome.restriction === "block") {
      raise("deny");
      reasons.push("Microsoft Purview could not be reached, and this agent is set not to send text Purview has not checked.");
    } else if (outcome.restriction === "warn" && enforce) {
      raise("ask");
      reasons.push("Microsoft Purview could not be reached, so a person decides whether to send it unchecked.");
    } else {
      reasons.push("Microsoft Purview could not be reached, so this was not checked against your Purview policies.");
    }
    return { ...assessment, verdict, reasons };
  }
  if (outcome.restriction === "block") {
    raise("deny");
    reasons.push("Your organisation's Microsoft Purview policy blocks sending this text.");
  } else if (outcome.restriction === "warn") {
    if (enforce) {
      raise("ask");
      reasons.push("Your organisation's Microsoft Purview policy warns about this text, so a person decides.");
    } else {
      reasons.push("Your organisation's Microsoft Purview policy warns about this text.");
    }
  }
  return { ...assessment, verdict, reasons };
}
