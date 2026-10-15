import { explain } from "./messages.js";

/**
 * Every failure the SDK raises, with the API's own code on it.
 *
 * One class rather than a hierarchy: callers branch on `code`, which is the
 * string the API document lists, and a `instanceof` tree would make that the
 * second way to ask the same question. The helpers below name the handful of
 * cases worth branching on so nobody has to memorise the codes.
 */
export class DeliverdError extends Error {
  /** The one thing to do next, when we know it. Also the tail of `message`. */
  readonly hint?: string;

  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    public readonly status: number,
    /** The API's error code: `not_found`, `rate_limited`, `self_approval`… */
    public readonly code: string,
    message: string,
    /** Whatever the API attached — validation issues, the unknown approvers. */
    public readonly details?: unknown,
    options?: { cause?: unknown }
  ) {
    const explained = explain(code, message);
    super(explained.message, options);
    this.name = "DeliverdError";
    this.hint = explained.hint;
  }

  /** The key is missing, wrong, or lacks the scope the call needs. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Slow down; the client already retried and gave up. */
  get isRateLimit(): boolean {
    return this.status === 429;
  }

  /** Nothing there, or nothing this key may see. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * The request was fine and the state was not: someone published between
   * your read and your write, a version is awaiting approval, a question was
   * already answered. Re-read and try again.
   */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/** Thrown when a wait is abandoned rather than answered. */
export class DeliverdTimeoutError extends DeliverdError {
  constructor(message: string) {
    super(0, "timeout", message);
    this.name = "DeliverdTimeoutError";
  }
}
