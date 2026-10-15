import { randomUUID } from "node:crypto";
import { DeliverdError } from "./errors.js";

/**
 * The one place a request is made.
 *
 * No dependencies: Node 20 has `fetch`, and an SDK that drags a request
 * library into every agent runtime for the sake of four verbs is a tax on
 * everyone who installs it.
 *
 * Retries are deliberately narrow. A 429 or a 5xx or a dropped connection is
 * worth repeating; a 4xx is the API saying the request itself is wrong, and it
 * will be just as wrong in a second. `Retry-After` is honoured when the server
 * sends one, because guessing against a server that has told you the answer is
 * how a client turns a rate limit into an outage.
 */

export interface ClientOptions {
  /** A `dlv_` key from Settings → API tokens, or an OAuth access token. */
  apiKey: string;
  /** Override for self-hosted or preview deployments. */
  baseUrl?: string;
  /** Attempts for a retryable failure, the first included. Default 3. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Swapped in tests; defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_BASE_URL = "https://deliverd.dev";

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /**
   * Overrides the key generated for this call. Pass one when the *caller's*
   * own retry should be recognised too — a job that reruns from the start
   * after a crash wants the key its first run used, which only the caller
   * knows how to derive.
   */
  idempotencyKey?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function abortError(signal: AbortSignal): DeliverdError {
  return new DeliverdError(0, "aborted", "The request was aborted.", undefined, {
    cause: signal.reason,
  });
}

/** Exponential from 500ms with jitter, so a fleet of agents does not resonate. */
function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new DeliverdError(0, "no_api_key", "An apiKey is required.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = Math.max(1, options.maxRetries ?? 3);
    this.timeout = options.timeout ?? 30_000;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const correlationId = randomUUID();
    /*
     * One key per logical request, held across every attempt below — which is
     * the whole point. These retries are why the server needs replay
     * protection at all: a POST that arrived and lost its response on the way
     * back used to be retried as a second create, and for an approval that
     * means two people asked to authorise one act.
     *
     * Only on POST: nothing else here creates anything.
     */
    const idempotencyKey =
      options.method === "POST" ? (options.idempotencyKey ?? randomUUID()) : undefined;
    let lastError: DeliverdError | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (attempt > 1) await sleep(lastError ? retryDelay(lastError, attempt) : backoffMs(attempt), options.signal);

      // The caller's signal and our own timeout, whichever fires first.
      const timer = AbortSignal.timeout(this.timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;

      let response: Response;
      try {
        response = await this.doFetch(url, {
          method: options.method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            // One id per logical request, kept across retries: it is the
            // thing to quote when something went wrong, and generating it
            // here means nobody has to remember to.
            "deliverd-correlation-id": correlationId,
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal,
        });
      } catch (cause) {
        if (options.signal?.aborted) throw abortError(options.signal);
        lastError = new DeliverdError(0, "network_error", describeNetworkError(cause), undefined, { cause });
        if (attempt === this.maxRetries) throw lastError;
        continue;
      }

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        lastError = new DeliverdError(
          response.status,
          "invalid_response",
          `Expected JSON from ${url.pathname} and got ${text.slice(0, 120)}`
        );
        if (isRetryable(response.status) && attempt < this.maxRetries) continue;
        throw lastError;
      }

      if (response.ok) return json as T;

      const envelope = (json as { error?: { code?: string; message?: string; details?: unknown } }).error;
      lastError = new DeliverdError(
        response.status,
        envelope?.code ?? "error",
        envelope?.message ?? `Request failed (${response.status})`,
        envelope?.details
      );
      (lastError as { retryAfter?: number }).retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (isRetryable(response.status) && attempt < this.maxRetries) continue;
      throw lastError;
    }
    throw lastError ?? new DeliverdError(0, "error", "Request failed.");
  }
}

export const USER_AGENT = "deliverd-sdk";

/**
 * A 5xx the server might get right next time. 501 is not one of them: it means
 * the call is not built, which is a fact about the server rather than about
 * this moment — the same argument as a 4xx.
 *
 * Ported from the Python SDK, which found it first and where the symptom was a
 * development-mode call taking two and a half seconds to say three times that
 * it is not implemented. The fix was never brought back here, and nothing
 * compared the two until `packages/conformance/cases.json` existed.
 */
const RETRYABLE_5XX_EXCEPTIONS = new Set([501]);

/** 429 and most 5xx: a 4xx will be just as wrong on the next attempt. */
function isRetryable(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && !RETRYABLE_5XX_EXCEPTIONS.has(status);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(error: DeliverdError, attempt: number): number {
  const after = (error as { retryAfter?: number }).retryAfter;
  return after !== undefined ? after : backoffMs(attempt);
}

/**
 * A dropped connection says nothing useful on its own, and the first thing
 * anyone wonders is whether they typed the host wrong.
 */
function describeNetworkError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed? ?out|TimeoutError/i.test(message)) return `The request timed out: ${message}`;
  return `Could not reach Deliverd: ${message}`;
}
