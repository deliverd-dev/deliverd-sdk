/**
 * Deliverd Screen: a pre-send check for every prompt.
 *
 * ```ts
 * import { screen } from "@deliverd/screen";
 *
 * const checked = await screen(prompt);
 * if (!checked.allowed) throw new Error(checked.reasons.join(" "));
 * const answer = await model.generate(checked.text);
 * return checked.restore(answer);
 * ```
 *
 * Everything runs here. Nothing is sent anywhere: there is no account, no
 * key and no network call, unless you pass `purview`, which asks your own
 * Microsoft Purview about the text. The detectors are the same code Deliverd's servers
 * and SDKs run, held to the shared vectors in `packages/conformance`.
 *
 * Patterns find structured identifiers well (email addresses, phone numbers,
 * IBANs, card numbers, national ids, IP addresses, dates of birth, keys and
 * tokens) and people's names hardly at all. Plug in a model for names with
 * `detectors`; `@deliverd/screen/adapters` turns a Hugging Face token
 * classifier or a Presidio analyzer into one.
 *
 * **A net, not a guarantee.** Never tell anyone a text is clean because this
 * allowed it, and remember that pseudonymised text is still personal data in
 * law.
 *
 * When a person has to decide (the `ask` verdict), this cannot ask one: there
 * is nobody here to ask. Deliverd's Data Gate can: the same check, with the
 * policy taken from your organisation's AI register, the question routed to
 * the right person in Slack, Teams or on their phone, and a record of what
 * was decided. `deliverd.screen()` in `@deliverd/sdk` takes the same options.
 */

import {
  assessCounts,
  DEFAULT_SCREEN_POLICY,
  redactFor,
  restore,
  screenText,
  summarise,
  termClassificationOf,
  type DetectedSpan,
  type ScreenClassification,
  type ScreenCounts,
  type ScreenFinding,
  type ScreenPolicy,
  type ScreenTerm,
  type ScreenVerdict,
  type SpanDetector,
} from "./data-screen.js";

import { applyPurview, type PurviewOutcome } from "./purview-rules.js";
import type { PurviewCheck } from "./purview.js";

export * from "./data-screen.js";
export { entraAppToken, purviewCheck, type EntraAppTokenOptions, type PurviewCheck, type PurviewCheckOptions } from "./purview.js";
export type { PurviewOnUnavailable, PurviewOutcome, PurviewRestriction } from "./purview-rules.js";

/** What the model the text is going to may receive. */
export interface ScreenAllowance {
  /** The highest classification it may receive. Default `internal`. */
  classification?: ScreenClassification;
  /** Whether it may receive personal data. Default false. */
  personalData?: boolean;
}

export interface ScreenOptions {
  /** The model's name, for the reasons. Default "the model". */
  model?: string;
  /** What that model may receive. Default internal data and no personal data. */
  allow?: ScreenAllowance;
  /** What to do with what it may not receive. Default: deny secrets, redact the rest, ask about what redaction cannot fix. */
  policy?: Partial<Omit<ScreenPolicy, "unregistered">>;
  /** Words your organisation does not want sent: clients, code names, deals. */
  terms?: readonly ScreenTerm[];
  /** Detectors to run beside the patterns, such as a model for names. */
  detectors?: readonly SpanDetector[];
  /** Spans another detector already found in this text. */
  spans?: readonly DetectedSpan[];
  /**
   * Your organisation's Microsoft Purview, from `purviewCheck()`. Asked about
   * the text first, with your own Entra app, so the text goes to Microsoft and
   * nowhere else; the stricter answer wins. A Purview block denies; a warn is
   * an ask, which nobody here can answer.
   */
  purview?: PurviewCheck;
}

export interface Screened {
  verdict: ScreenVerdict;
  /** Whether to send `text`. False for a deny, and for an ask: nobody here can say yes. */
  allowed: boolean;
  /** What may be sent: the original, the redacted text, or null when nothing may be. */
  text: string | null;
  /** The redacted text, also for an ask, to show whoever decides. Null for a deny. */
  redacted: string | null;
  /** Where each finding is. Offsets into the original text; the values are not copied. */
  findings: ScreenFinding[];
  /** How many of each kind, which is all Deliverd's Data Gate is ever sent. */
  counts: ScreenCounts;
  /** One sentence each: why. Empty for a plain allow. */
  reasons: string[];
  /** Placeholder to original value, for `redact`. Yours alone: never sent anywhere. */
  replacements: Readonly<Record<string, string>>;
  /** Put the original values back into text a model wrote using the placeholders. */
  restore(answer: string): string;
  /** Microsoft Purview's answer, when `purview` was given. */
  purview: PurviewOutcome | null;
}

/** Find what is in a text, whatever it is going to: the findings and their counts, no verdict. */
export async function detect(
  text: string,
  options: Pick<ScreenOptions, "terms" | "detectors" | "spans"> = {}
): Promise<{ findings: ScreenFinding[]; counts: ScreenCounts }> {
  const spans: DetectedSpan[] = [...(options.spans ?? [])];
  for (const d of options.detectors ?? []) spans.push(...(await d(text)));
  const findings = screenText(text, options.terms ?? [], spans);
  return { findings, counts: summarise(findings) };
}

const ASK_REASON =
  "A person has to decide whether this may be sent, and nobody can be asked from here. Deliverd's Data Gate routes the question to one: https://deliverd.dev/docs/developers/screen";

/**
 * Check text before it goes to a model, and decide what may be sent.
 *
 * - `allow`: send it as it is.
 * - `redact`: `text` has the findings the model may not receive replaced by
 *   placeholders such as `[EMAIL_1]`. Send that; `restore()` puts the values
 *   back in the answer.
 * - `ask`: a person has to decide. `allowed` is false; `redacted` is what to
 *   show them.
 * - `deny`: nothing may be sent.
 */
export async function screen(text: string, options: ScreenOptions = {}): Promise<Screened> {
  const { findings, counts } = await detect(text, options);
  const policy: ScreenPolicy = { ...DEFAULT_SCREEN_POLICY, ...options.policy, unregistered: DEFAULT_SCREEN_POLICY.unregistered };
  const assessment = assessCounts(
    counts,
    {
      name: options.model ?? "the model",
      approvedClassification: options.allow?.classification ?? "internal",
      personalData: options.allow?.personalData ?? false,
      active: true,
    },
    policy,
    termClassificationOf(findings)
  );
  const purview = options.purview ? await options.purview(text) : null;
  const held = applyPurview(assessment, purview);
  const redaction = redactFor(text, findings, assessment);
  const replacements = held.verdict === "redact" ? redaction?.replacements ?? {} : {};
  const sent = held.verdict === "allow" ? text : held.verdict === "redact" ? redaction?.text ?? null : null;
  return {
    verdict: held.verdict,
    allowed: sent !== null,
    text: sent,
    redacted: held.verdict === "deny" ? null : assessment.verdict === "allow" ? text : redaction?.text ?? null,
    findings,
    counts,
    reasons: held.verdict === "ask" ? [...held.reasons, ASK_REASON] : held.reasons,
    replacements,
    restore: (answer: string) => restore(answer, replacements),
    purview,
  };
}
