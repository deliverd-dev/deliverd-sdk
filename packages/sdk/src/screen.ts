import type { Approval, Approvals } from "./approvals.js";
import {
  redactFor,
  restore,
  screenText,
  summarise,
  termClassificationOf,
  type DataKind,
  type DetectedSpan,
  type ScreenTerm,
  type SpanDetector,
} from "./data-screen.js";
import { durationMs, type Duration } from "./duration.js";
import type { HttpClient } from "./http.js";
import type { ScreenData, ScreenVerdict } from "./types.js";

/**
 * Check text before it goes to an AI model.
 *
 * ```ts
 * const screened = await deliverd.screen(prompt, { aiSystemId: CLAIMS_MODEL });
 * if (!screened.allowed) return screened.reasons;
 * const answer = await model.generate(screened.text);
 * return screened.restore(answer);
 * ```
 *
 * **The text does not leave your machine.** The detectors run here — the same
 * code the server runs — and Deliverd is sent only what was found, by kind:
 * "two email addresses, one IBAN". It answers from what the organisation's AI
 * register approves that model to receive, and from its policy:
 *
 * - `allow`: send it as it is.
 * - `redact`: `screened.text` has the findings replaced by placeholders such
 *   as `[EMAIL_1]`; send that, and `restore()` puts the values back in the
 *   model's answer.
 * - `ask`: a person decides, through an ordinary approval, and this waits for
 *   them. Approved, `screened.text` is the original.
 * - `deny`: nothing may be sent. `screened.text` is null.
 *
 * **A net, not a guarantee.** Structured identifiers are found well; names
 * are not found reliably. Never tell anyone a text is clean because this
 * allowed it.
 */

export interface ScreenOptions {
  /** The AI register's record for the model it is going to. Without one, it is held to internal data and no personal data. */
  aiSystemId?: string;
  /** What it is for, shown to a person if one is asked. */
  purpose?: string;
  /** Your own reference, kept on any approval. */
  externalId?: string;
  /**
   * Words your organisation does not want sent — clients, code names — found
   * here like any other kind. Terms an administrator set in Deliverd are
   * applied only to text the server reads, so pass yours here.
   */
  terms?: readonly ScreenTerm[];
  /**
   * Detectors to run here beside the patterns, such as a named-entity model
   * for people's names, which patterns cannot find. Each gets the text and
   * returns spans; `@deliverd/screen` has adapters for Hugging Face and
   * Presidio. They run on your machine, like the patterns, and only their
   * counts are sent.
   */
  detectors?: readonly SpanDetector[];
  /** Spans another detector already found in this text. */
  spans?: readonly DetectedSpan[];
  /** Whether to wait for a person on an `ask`. Default true. */
  wait?: boolean;
  timeout?: Duration;
  signal?: AbortSignal;
}

export class Screened {
  /** The approval a person decided, for an `ask`. */
  readonly approval: Approval | null;

  constructor(
    /** What the server answered. */
    readonly data: ScreenData,
    /** What may be sent: the original, the redacted text, or null when nothing may be. */
    readonly text: string | null,
    /** Whether to send `text`. False for a deny, and for an ask a person did not approve. */
    readonly allowed: boolean,
    private readonly replacements: Readonly<Record<string, string>>,
    approval: Approval | null = null
  ) {
    this.approval = approval;
  }

  get verdict(): ScreenVerdict {
    return this.data.verdict;
  }

  /** One sentence each: why, for logging or for telling the person. */
  get reasons(): string[] {
    return this.data.reasons;
  }

  /** Put the original values back into text a model wrote using the placeholders. */
  restore(answer: string): string {
    return restore(answer, this.replacements);
  }
}

export async function screen(
  http: HttpClient,
  approvals: Approvals,
  text: string,
  options: ScreenOptions = {},
  development = false
): Promise<Screened> {
  const spans = [...(options.spans ?? [])];
  for (const detect of options.detectors ?? []) spans.push(...(await detect(text)));
  const findings = screenText(text, options.terms ?? [], spans);
  const data = await http.request<ScreenData>({
    method: "POST",
    path: "/screen",
    body: {
      counts: summarise(findings),
      termClassification: termClassificationOf(findings),
      ...(options.aiSystemId ? { aiSystemId: options.aiSystemId } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.externalId ? { externalId: options.externalId } : {}),
    },
    signal: options.signal,
  });

  if (data.verdict === "allow") return new Screened(data, text, true, {});
  if (data.verdict === "deny") return new Screened(data, null, false, {});
  if (data.verdict === "redact") {
    const redacted = redactFor(text, findings, { verdict: data.verdict, offending: data.offending as DataKind[] });
    return new Screened(data, redacted?.text ?? null, true, redacted?.replacements ?? {});
  }

  // ask
  if (!data.approval || options.wait === false) return new Screened(data, null, false, {});
  const approval = await approvals.get(data.approval.id, options.signal);
  const settled = await approval.wait({
    signal: options.signal,
    timeout: options.timeout === undefined ? (development ? 2_000 : undefined) : durationMs(options.timeout),
  });
  return settled.approved ? new Screened(data, text, true, {}, settled) : new Screened(data, null, false, {}, settled);
}
