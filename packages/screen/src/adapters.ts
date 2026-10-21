/**
 * Detectors to plug in beside the patterns, for what patterns cannot find:
 * people's names above all.
 *
 * Each adapter returns a `SpanDetector`, a function from the text to spans,
 * for `screen(text, { detectors })` here or `deliverd.screen(text, { detectors })`
 * in `@deliverd/sdk`. This package depends on none of them: you install the
 * model or run the service, and pass it in.
 *
 * Whatever runs the model should run where the text already is. A detector
 * that sends the text to a hosted service has sent it somewhere, which is the
 * thing this check exists to prevent.
 */

import { DATA_KINDS, type DataKind, type DetectedSpan, type SpanDetector } from "./data-screen.js";

/** One entity, as a token classifier returns it. Field names differ by library; any of these are read. */
export interface ClassifiedToken {
  entity?: string;
  entity_group?: string;
  label?: string;
  score?: number;
  start?: number | null;
  end?: number | null;
  word?: string;
}

/** A model's label, without its B-/I-/E-/S- position prefix, to a kind; null to ignore it. */
export type LabelMap = (label: string) => DataKind | null;

/**
 * What the common label sets mean. Person labels (`PER`, `PERSON`,
 * `private_person`, `NAME`, `GIVENNAME`, `SURNAME`) become names; email and
 * phone labels map to those kinds, which the patterns find too and the
 * overlap rules keep once. Anything else is ignored.
 */
export const defaultLabels: LabelMap = (label) => {
  const l = label.toLowerCase();
  if (/^(per|person|private_person|name|full_?name|first_?name|last_?name|given_?name|surname|username)$/.test(l)) return "person_name";
  if (/email/.test(l)) return "email";
  if (/phone|telephone/.test(l)) return "phone";
  if (/iban/.test(l)) return "iban";
  if (/credit_?card|card_?number/.test(l)) return "payment_card";
  if (/^ip(_?address)?$/.test(l)) return "ip_address";
  return null;
};

const stripPosition = (label: string) => label.replace(/^[BIESL]-/, "");

export interface TokenClassifierOptions {
  /** Ignore entities scored below this. Default 0.5. */
  minScore?: number;
  labels?: LabelMap;
}

/**
 * A Hugging Face token classifier as a detector: transformers.js in Node, or
 * anything with the same output, such as Perplexity's PII-Tracer or a GLiNER
 * model behind a small local server. Check the model's licence before you
 * ship it.
 *
 * ```ts
 * import { pipeline } from "@huggingface/transformers";
 * const ner = await pipeline("token-classification", "Xenova/bert-base-NER");
 * const names = tokenClassifier((text) => ner(text));
 * ```
 *
 * Offsets are used when the model gives them. When it gives only words, each
 * word is found in the text from where the last one ended. Adjacent tokens of
 * one kind become one span, so "Mary" and "Byrne" are one name.
 */
export function tokenClassifier(
  classify: (text: string) => readonly ClassifiedToken[] | Promise<readonly ClassifiedToken[]>,
  options: TokenClassifierOptions = {}
): SpanDetector {
  const minScore = options.minScore ?? 0.5;
  const labels = options.labels ?? defaultLabels;
  return async (text) => {
    const tokens = await classify(text);
    const spans: DetectedSpan[] = [];
    let cursor = 0;
    for (const t of tokens) {
      const raw = t.entity_group ?? t.entity ?? t.label;
      if (!raw || (t.score ?? 1) < minScore) continue;
      const kind = labels(stripPosition(raw));
      let start = typeof t.start === "number" ? t.start : -1;
      let end = typeof t.end === "number" ? t.end : -1;
      if (start < 0 || end <= start) {
        const word = (t.word ?? "").replace(/^##|^▁|^Ġ/, "").trim();
        if (!word) continue;
        start = text.indexOf(word, cursor);
        if (start < 0) continue;
        end = start + word.length;
      }
      cursor = end;
      if (!kind || !Object.hasOwn(DATA_KINDS, kind)) continue;
      const last = spans.at(-1);
      // "Mary" "Byrne", or a word split into sub-word pieces: one span.
      if (last && last.kind === kind && /^[\s-]?$/.test(text.slice(last.end, start))) last.end = end;
      else spans.push({ kind, start, end });
    }
    return spans;
  };
}

/** Presidio's entity types to kinds. */
const PRESIDIO: Record<string, DataKind> = {
  PERSON: "person_name",
  EMAIL_ADDRESS: "email",
  PHONE_NUMBER: "phone",
  IBAN_CODE: "iban",
  CREDIT_CARD: "payment_card",
  IP_ADDRESS: "ip_address",
  US_SSN: "us_ssn",
  UK_NINO: "uk_national_insurance",
};

export interface PresidioOptions {
  /** The analyzer's address. Run it on your own machine or network. Default http://localhost:5002. */
  url?: string;
  language?: string;
  /** Default 0.5. */
  minScore?: number;
  /** Which Presidio entity types to ask for. Default the ones with a kind here. */
  entities?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

/**
 * A Presidio analyzer as a detector, through its REST API (`POST /analyze`).
 * Run the analyzer yourself, next to the agent:
 * `docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer`.
 */
export function presidio(options: PresidioOptions = {}): SpanDetector {
  const url = (options.url ?? "http://localhost:5002").replace(/\/$/, "");
  const minScore = options.minScore ?? 0.5;
  const doFetch = options.fetch ?? globalThis.fetch;
  return async (text) => {
    const res = await doFetch(`${url}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language: options.language ?? "en", entities: options.entities ?? Object.keys(PRESIDIO) }),
    });
    if (!res.ok) throw new Error(`Presidio answered ${res.status}. Is the analyzer running at ${url}?`);
    const results = (await res.json()) as { entity_type: string; start: number; end: number; score: number }[];
    return results
      .filter((r) => r.score >= minScore && PRESIDIO[r.entity_type])
      .map((r) => ({ kind: PRESIDIO[r.entity_type]!, start: r.start, end: r.end }));
  };
}
