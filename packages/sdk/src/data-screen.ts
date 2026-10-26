/**
 * Screening what an agent is about to send to an AI model.
 *
 * Before a prompt, a document or a retrieved record goes to a model, this
 * finds the personal data, secrets and confidential terms in it, says how
 * sensitive the whole is, and decides — against what the organisation has
 * approved that model to receive — whether it may go as it is, go with the
 * findings replaced by placeholders, go only once a person agrees, or not go.
 *
 * Three lines are held throughout:
 *
 * - **The text need not leave the caller.** Everything here is pure and has no
 *   imports, so the SDKs run the same detectors where the agent runs and send
 *   Deliverd only counts: "two email addresses, one IBAN". This file is copied
 *   verbatim into `packages/sdk/src/data-screen.ts` and into the open-source
 *   `packages/screen/src/data-screen.ts`, and a test fails when they differ.
 * - **A finding never carries its value off the machine.** `ScreenFinding` has
 *   offsets into the caller's own text; `summarise` keeps only counts.
 * - **Detection is a net, not a guarantee.** Patterns find structured
 *   identifiers well and names hardly at all; a name is personal data and
 *   nothing here claims to have found every one. Pseudonymised text is still
 *   personal data in law. What this buys is fewer identifiers sent, a record of
 *   what was, and a person asked when it matters — never a certificate that a
 *   prompt is clean.
 */

/** Ordered: the stricter of two classifications is the later one. */
export const SCREEN_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type ScreenClassification = (typeof SCREEN_CLASSIFICATIONS)[number];

export const SCREEN_CATEGORIES = ["personal", "financial", "special", "secret", "confidential"] as const;
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number];

export const SCREEN_VERDICTS = ["allow", "redact", "ask", "deny"] as const;
export type ScreenVerdict = (typeof SCREEN_VERDICTS)[number];

/** What a policy may do with data the target is not approved for. */
export type ScreenAction = "redact" | "ask" | "deny";

interface KindSpec {
  label: string;
  category: ScreenCategory;
  /** The word in a placeholder: `[EMAIL_1]`. */
  placeholder: string;
  /**
   * Whether replacing the match removes the concern. An IBAN replaced by
   * `[IBAN_1]` is gone; a sentence about someone's diagnosis is still about
   * their diagnosis with the word "diagnosis" taken out.
   */
  redactable: boolean;
}

export const DATA_KINDS = {
  email: { label: "Email address", category: "personal", placeholder: "EMAIL", redactable: true },
  phone: { label: "Phone number", category: "personal", placeholder: "PHONE", redactable: true },
  iban: { label: "IBAN", category: "financial", placeholder: "IBAN", redactable: true },
  payment_card: { label: "Payment card number", category: "financial", placeholder: "CARD", redactable: true },
  uk_national_insurance: { label: "UK National Insurance number", category: "personal", placeholder: "NINO", redactable: true },
  ie_pps: { label: "Irish PPS number", category: "personal", placeholder: "PPS", redactable: true },
  us_ssn: { label: "US Social Security number", category: "personal", placeholder: "SSN", redactable: true },
  ip_address: { label: "IP address", category: "personal", placeholder: "IP", redactable: true },
  date_of_birth: { label: "Date of birth", category: "personal", placeholder: "DOB", redactable: true },
  /** Never found by a pattern here: only by a model detector the caller plugs in (`spans`). */
  person_name: { label: "Person's name", category: "personal", placeholder: "NAME", redactable: true },
  special_category: { label: "Special-category data", category: "special", placeholder: "SPECIAL", redactable: false },
  secret: { label: "Secret or credential", category: "secret", placeholder: "SECRET", redactable: true },
  term: { label: "Confidential term", category: "confidential", placeholder: "TERM", redactable: true },
} as const satisfies Record<string, KindSpec>;

export type DataKind = keyof typeof DATA_KINDS;
export const DATA_KIND_KEYS = Object.keys(DATA_KINDS) as DataKind[];

const CATEGORY_CLASSIFICATION: Record<ScreenCategory, ScreenClassification> = {
  personal: "confidential",
  financial: "confidential",
  confidential: "confidential",
  special: "restricted",
  secret: "restricted",
};

/** Categories that are personal data, for a target approved for none. */
const PERSONAL_CATEGORIES: ReadonlySet<ScreenCategory> = new Set(["personal", "financial", "special"]);

/**
 * A word or phrase the organisation does not want sent: a client's name, a
 * project's code name, a deal. Matched whole-word and case-insensitively.
 */
export interface ScreenTerm {
  term: string;
  /** Shown to people and used in the placeholder: `[CLIENT_1]`. */
  label?: string;
  classification?: "confidential" | "restricted";
}

export interface ScreenFinding {
  kind: DataKind;
  category: ScreenCategory;
  classification: ScreenClassification;
  /** Offsets into the screened text. The value itself is never copied. */
  start: number;
  end: number;
  /** For a term, its label; otherwise the kind's. */
  label: string;
  redactable: boolean;
}

export type ScreenCounts = Partial<Record<DataKind, number>>;

// ── Detectors ──────────────────────────────────────────────────────────────

interface Detector {
  kind: DataKind;
  pattern: RegExp;
  /** A second look at a match a pattern alone cannot judge: a checksum, a digit count. */
  valid?: (match: string) => boolean;
  /** The part of the match that is the value, when the pattern includes context. */
  group?: number;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** The PPS check character: weights 8 to 2 on the digits, 9 on a second letter, mod 23, 0 is W. */
function ppsValid(raw: string): boolean {
  const m = /^(\d{7})([A-W])([A-IW]?)$/.exec(raw.toUpperCase());
  if (!m) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (m[1]!.charCodeAt(i) - 48) * (8 - i);
  if (m[3]) sum += (m[3] === "W" ? 0 : m[3].charCodeAt(0) - 64) * 9;
  const r = sum % 23;
  return m[2] === (r === 0 ? "W" : String.fromCharCode(64 + r));
}

function ipv4Valid(raw: string): boolean {
  // "v1.2.3.4" and "version 1.2.3.4" are versions, and so is "1.2.3.4.5".
  if (/[a-z]/i.test(raw)) return false;
  const parts = raw.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => p > 255)) return false;
  // Loopback and the unspecified address identify nobody.
  return parts[0] !== 127 && parts[0] !== 0;
}

/** Eight groups, or a "::" and at least three, so "10:30:00" and a MAC address are not addresses. */
function ipv6Valid(raw: string): boolean {
  if (raw.includes(":::")) return false;
  const compressed = raw.split("::").length - 1;
  const groups = raw.split(":").filter(Boolean).length;
  return compressed === 0 ? groups === 8 : compressed === 1 && groups >= 3 && groups <= 7;
}

/** A value in a .env line that is a placeholder, not a credential. */
function envSecretValid(value: string): boolean {
  return !/^[<{%(]/.test(value) && !/your|example|placeholder|changeme|xxxx/i.test(value);
}

/**
 * Credential patterns. The same set the publish scanner blocks a report for,
 * because a key that must not be published must not be sent to a model either.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // The whole block, or the header and the lines of key under it when the end was cut off.
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----|(?:\r?\n[A-Za-z0-9+\/=]{16,})*)/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:password|passwd|secret_key|api_key|apikey|auth_token)\s*[:=]\s*["'][^"']{8,}["']/gi,
  /\b(?:dlv|dlvk)_[A-Za-z0-9]{24,}\b/g,
];

/**
 * Words that say a passage is about special-category data (GDPR Article 9,
 * and criminal-offence data under Article 10). A keyword is a weak signal, so
 * it is never redacted away: it sends the passage to a person when the target
 * is not approved for restricted personal data.
 */
const SPECIAL_PATTERN =
  /\b(?:diagnos(?:is|ed|es)|medical (?:record|history|condition)s?|mental health|prescri(?:bed|ption)s?|HIV|pregnan(?:t|cy)|disabilit(?:y|ies)|sexual orientation|religious belief|ethnic origin|racial origin|trade union member(?:ship)?|biometric|genetic data|criminal (?:record|conviction|offence)s?)\b/gi;

const DETECTORS: Detector[] = [
  ...SECRET_PATTERNS.map((pattern) => ({ kind: "secret" as const, pattern })),
  // The user and password in a connection string: postgres://user:password@host.
  { kind: "secret", pattern: /\b[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/([A-Za-z0-9._~%!$&'()*+,;=-]+:[A-Za-z0-9._~%!$&'()*+,;=:-]+)@/g, group: 1 },
  // A credential in a .env line, quoted or not: DB_PASSWORD=..., OPENAI_API_KEY="...".
  {
    kind: "secret",
    pattern: /\b(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH_TOKEN)[ \t]*=[ \t]*["']?([!%&(-~]{6,})/g,
    valid: envSecretValid,
    group: 1,
  },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  {
    kind: "payment_card",
    pattern: /\b[2-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b/g,
    valid: (m) => {
      const d = digitsOf(m);
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  { kind: "us_ssn", pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  {
    kind: "uk_national_insurance",
    pattern: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  { kind: "ie_pps", pattern: /\b\d{7}[A-W][A-IW]?\b/g, valid: ppsValid },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  {
    kind: "date_of_birth",
    pattern: /\b(?:date of birth|d\.?o\.?b\.?|born(?: on)?)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4})/gi,
    group: 1,
  },
  {
    kind: "phone",
    // An international number, or a national one starting with 0: a bare run
    // of digits is far more often an amount, an id or a date.
    pattern: /(?<![\w+])(?:\+\d{1,3}[ .-]?(?:\(0\)[ .-]?)?|\(?0)\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g,
    valid: (m) => {
      const d = digitsOf(m);
      return d.length >= 9 && d.length <= 15;
    },
  },
  {
    kind: "phone",
    // A North American number written the North American way: (415) 555-0132, 415-555-0132.
    pattern: /(?:\+1[ .-]?)?\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]\d{4}\b|\b[2-9]\d{2}[.-][2-9]\d{2}[.-]\d{4}\b/g,
  },
  { kind: "ip_address", pattern: /\b(?:(?:version|release|build|ver|v)[ \t:]*)?(?:\d{1,3}\.){3}\d{1,3}(?:\.\d+)*\b/gi, valid: ipv4Valid },
  { kind: "ip_address", pattern: /\b[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}\b/g, valid: ipv6Valid },
  { kind: "special_category", pattern: SPECIAL_PATTERN },
];

/** Earlier wins an overlap: a card number is not also a phone number. */
const PRIORITY: Record<DataKind, number> = Object.fromEntries(
  ["secret", "iban", "payment_card", "us_ssn", "uk_national_insurance", "ie_pps", "email", "date_of_birth", "phone", "ip_address", "term", "person_name", "special_category"].map(
    (k, i) => [k, i]
  )
) as Record<DataKind, number>;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms past this are ignored, so a pasted list cannot make every screen slow. */
export const MAX_SCREEN_TERMS = 500;

/**
 * What another detector found — a named-entity model, a DLP service — handed
 * in as offsets into the same text. Patterns cannot find names; a model can,
 * and this is where its answer joins theirs.
 */
export interface DetectedSpan {
  kind: DataKind;
  start: number;
  end: number;
}

/**
 * A detector to run beside the patterns: a function from the text to its
 * spans. The open-source `@deliverd/screen` package has adapters that turn a
 * Hugging Face token classifier or a Presidio analyzer into one.
 */
export type SpanDetector = (text: string) => readonly DetectedSpan[] | Promise<readonly DetectedSpan[]>;

/**
 * Find what is in a text. Overlapping matches keep the stronger kind, so each
 * character belongs to at most one finding. `spans` are another detector's
 * findings, held to the same rules; one outside the text or of no known kind
 * is dropped.
 */
export function screenText(text: string, terms: readonly ScreenTerm[] = [], spans: readonly DetectedSpan[] = []): ScreenFinding[] {
  const raw: ScreenFinding[] = [];
  const add = (kind: DataKind, start: number, end: number, label?: string, classification?: ScreenClassification) => {
    const spec = DATA_KINDS[kind];
    raw.push({
      kind,
      category: spec.category,
      classification: classification ?? CATEGORY_CLASSIFICATION[spec.category],
      start,
      end,
      label: label ?? spec.label,
      redactable: spec.redactable,
    });
  };

  for (const d of DETECTORS) {
    d.pattern.lastIndex = 0;
    for (const m of text.matchAll(d.pattern)) {
      const value = d.group ? m[d.group] : m[0];
      if (!value || (d.valid && !d.valid(value))) continue;
      const start = d.group ? m.index! + m[0].lastIndexOf(value) : m.index!;
      add(d.kind, start, start + value.length);
    }
  }

  for (const t of terms.slice(0, MAX_SCREEN_TERMS)) {
    const term = t.term.trim();
    if (term.length < 2) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(pattern)) {
      add("term", m.index!, m.index! + m[0].length, t.label?.trim() || DATA_KINDS.term.label, t.classification ?? "confidential");
    }
  }

  for (const s of spans) {
    if (!Object.hasOwn(DATA_KINDS, s.kind) || s.kind === "term") continue;
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end > text.length || s.end <= s.start) continue;
    add(s.kind, s.start, s.end);
  }

  raw.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: ScreenFinding[] = [];
  for (const f of raw) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue;
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Counts only: what goes over the wire when the text stays where it is. */
export function summarise(findings: readonly ScreenFinding[]): ScreenCounts {
  const counts: ScreenCounts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

// ── Redaction ──────────────────────────────────────────────────────────────

export interface Redaction {
  text: string;
  /** Placeholder to original value. Stays with the caller; never sent anywhere. */
  replacements: Record<string, string>;
}

const placeholderWord = (f: ScreenFinding) =>
  f.kind === "term" && f.label !== DATA_KINDS.term.label
    ? f.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "TERM"
    : DATA_KINDS[f.kind].placeholder;

/**
 * Replace each redactable finding with a placeholder. The same value gets the
 * same placeholder throughout, so a model can still tell that two mentions are
 * one person, and `restore` can put the values back in its answer.
 */
export function redact(text: string, findings: readonly ScreenFinding[]): Redaction {
  const replacements: Record<string, string> = {};
  const byValue = new Map<string, string>();
  const counters = new Map<string, number>();
  let out = "";
  let at = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (!f.redactable || f.start < at) continue;
    const value = text.slice(f.start, f.end);
    const key = `${f.kind}\u0000${value.toLowerCase()}`;
    let placeholder = byValue.get(key);
    if (!placeholder) {
      const word = placeholderWord(f);
      const n = (counters.get(word) ?? 0) + 1;
      counters.set(word, n);
      placeholder = `[${word}_${n}]`;
      byValue.set(key, placeholder);
      replacements[placeholder] = value;
    }
    out += text.slice(at, f.start) + placeholder;
    at = f.end;
  }
  return { text: out + text.slice(at), replacements };
}

/** Put the original values back into text a model wrote using the placeholders. */
export function restore(text: string, replacements: Readonly<Record<string, string>>): string {
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, (p) => replacements[p] ?? p);
}

// ── Deciding ───────────────────────────────────────────────────────────────

/** What the destination model is approved to receive: the AI register's record. */
export interface ScreenTarget {
  name: string;
  /** The highest classification approved; null when the record does not say. */
  approvedClassification: ScreenClassification | null;
  personalData: boolean;
  active: boolean;
}

export interface ScreenPolicy {
  /** Secrets and credentials. Default deny: a key sent to a model is a key disclosed. */
  secrets: ScreenAction;
  /** Redactable data the target is not approved for. Default redact. */
  beyondApproval: ScreenAction;
  /** Data that redaction cannot fix (special category) the target is not approved for. Default ask. */
  notRedactable: "ask" | "deny";
  /** What an unnamed target is taken to be approved for. Default internal, no personal data. */
  unregistered: { approvedClassification: ScreenClassification; personalData: boolean };
}

export const DEFAULT_SCREEN_POLICY: ScreenPolicy = {
  secrets: "deny",
  beyondApproval: "redact",
  notRedactable: "ask",
  unregistered: { approvedClassification: "internal", personalData: false },
};

export interface ScreenAssessment {
  verdict: ScreenVerdict;
  /** The classification of what was found; public when nothing was. */
  classification: ScreenClassification;
  personalData: boolean;
  categories: ScreenCategory[];
  /** The kinds behind the verdict: what redaction replaces, and what a person is asked about. */
  offending: DataKind[];
  /** One sentence each, for the agent and for the person asked. */
  reasons: string[];
}

const rank = (c: ScreenClassification) => SCREEN_CLASSIFICATIONS.indexOf(c);
const VERDICT_RANK: Record<ScreenVerdict, number> = { allow: 0, redact: 1, ask: 2, deny: 3 };
const stricter = (a: ScreenVerdict, b: ScreenVerdict) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a);

/** Reads a stored or sent policy, keeping a default for anything missing or unknown. */
export function readScreenPolicy(raw: unknown): ScreenPolicy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const actions = ["redact", "ask", "deny"];
  const pick = <T extends string>(v: unknown, allowed: readonly string[], fallback: T): T =>
    typeof v === "string" && allowed.includes(v) ? (v as T) : fallback;
  const u = (p.unregistered && typeof p.unregistered === "object" ? p.unregistered : {}) as Record<string, unknown>;
  return {
    secrets: pick(p.secrets, actions, DEFAULT_SCREEN_POLICY.secrets),
    beyondApproval: pick(p.beyondApproval, actions, DEFAULT_SCREEN_POLICY.beyondApproval),
    notRedactable: pick(p.notRedactable, ["ask", "deny"], DEFAULT_SCREEN_POLICY.notRedactable),
    unregistered: {
      approvedClassification: pick(u.approvedClassification, SCREEN_CLASSIFICATIONS, DEFAULT_SCREEN_POLICY.unregistered.approvedClassification),
      personalData: typeof u.personalData === "boolean" ? u.personalData : DEFAULT_SCREEN_POLICY.unregistered.personalData,
    },
  };
}

const plural = (n: number, label: string) => `${n} ${label.toLowerCase()}${n === 1 ? "" : "s"}`;

/** "2 email addresses and 1 IBAN", for a reason or an approval's title. */
export function describeCounts(counts: ScreenCounts): string {
  const parts = DATA_KIND_KEYS.filter((k) => (counts[k] ?? 0) > 0).map((k) => {
    const n = counts[k]!;
    const label = DATA_KINDS[k].label;
    if (k === "email") return `${n} email address${n === 1 ? "" : "es"}`;
    if (k === "special_category") return `${n} mention${n === 1 ? "" : "s"} of special-category data`;
    if (k === "secret") return `${n} secret${n === 1 ? "" : "s"} or credential${n === 1 ? "" : "s"}`;
    if (k === "term") return plural(n, "confidential term");
    if (k === "person_name") return `${n} ${n === 1 ? "person's name" : "people's names"}`;
    if (k === "ip_address") return `${n} IP address${n === 1 ? "" : "es"}`;
    if (k === "date_of_birth") return `${n} date${n === 1 ? "" : "s"} of birth`;
    if (k === "ie_pps") return `${n} Irish PPS number${n === 1 ? "" : "s"}`;
    return /^[A-Z]{2,}/.test(label) ? `${n} ${label}${n === 1 ? "" : "s"}` : plural(n, label);
  });
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Decide from counts alone, so the same answer comes back whether the text was
 * screened here or on the caller's machine.
 *
 * `termClassification` is the strictest classification among the terms found,
 * which counts cannot carry; restricted when a caller says so.
 */
export function assessCounts(
  counts: ScreenCounts,
  target: ScreenTarget | null,
  policy: ScreenPolicy = DEFAULT_SCREEN_POLICY,
  termClassification: ScreenClassification = "confidential"
): ScreenAssessment {
  const present = DATA_KIND_KEYS.filter((k) => (counts[k] ?? 0) > 0);
  const categories = SCREEN_CATEGORIES.filter((c) => present.some((k) => DATA_KINDS[k].category === c));
  const classOf = (k: DataKind) => (k === "term" ? termClassification : CATEGORY_CLASSIFICATION[DATA_KINDS[k].category]);
  const classification = present.reduce<ScreenClassification>((acc, k) => (rank(classOf(k)) > rank(acc) ? classOf(k) : acc), "public");
  const personalData = categories.some((c) => PERSONAL_CATEGORIES.has(c));

  const reasons: string[] = [];
  const offending: DataKind[] = [];
  let verdict: ScreenVerdict = "allow";

  if (target && !target.active) {
    return {
      verdict: "deny",
      classification,
      personalData,
      categories,
      offending: present,
      reasons: [`${target.name} is not an active system in the AI register, so nothing should be sent to it.`],
    };
  }
  if (present.length === 0) return { verdict, classification, personalData, categories, offending, reasons };

  const name = target?.name ?? "an AI system that is not in the register";
  const approved = target ? target.approvedClassification ?? policy.unregistered.approvedClassification : policy.unregistered.approvedClassification;
  const personalApproved = target ? target.personalData : policy.unregistered.personalData;

  const secrets = counts.secret ?? 0;
  if (secrets > 0) {
    verdict = stricter(verdict, policy.secrets);
    offending.push("secret");
    reasons.push(`It contains ${describeCounts({ secret: secrets })}, which should never be sent to a model.`);
  }

  for (const k of present) {
    if (k === "secret") continue;
    const tooSensitive = rank(classOf(k)) > rank(approved);
    const personalNotApproved = DATA_KINDS[k].category !== "confidential" && !personalApproved;
    if (!tooSensitive && !personalNotApproved) continue;
    const action: ScreenAction = DATA_KINDS[k].redactable ? policy.beyondApproval : policy.notRedactable;
    verdict = stricter(verdict, action);
    offending.push(k);
    const why = personalNotApproved
      ? "which is not approved to receive personal data"
      : `which is approved for ${approved} data at most`;
    reasons.push(`It contains ${describeCounts({ [k]: counts[k] })}, and goes to ${name}, ${why}.`);
  }

  return { verdict, classification, personalData, categories, offending, reasons };
}

/**
 * The text with the findings behind a verdict replaced: only those, so data
 * the target is approved for still reaches it. What a person asked is shown,
 * and what a `redact` verdict sends. Null for a deny, which sends nothing.
 */
export function redactFor(text: string, findings: readonly ScreenFinding[], assessment: Pick<ScreenAssessment, "verdict" | "offending">): Redaction | null {
  if (assessment.verdict === "deny") return null;
  const offending = new Set(assessment.offending);
  return redact(text, findings.filter((f) => offending.has(f.kind)));
}

/** The strictest classification among the terms found, for `assessCounts`. */
export function termClassificationOf(findings: readonly ScreenFinding[]): ScreenClassification {
  return findings.some((f) => f.kind === "term" && f.classification === "restricted") ? "restricted" : "confidential";
}
