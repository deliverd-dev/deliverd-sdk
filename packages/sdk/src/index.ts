import { HttpClient, type ClientOptions } from "./http.js";
import { Approvals, DecisionSessions, FAST_POLL_SCHEDULE, type WaitOptions } from "./approvals.js";
import { Gates, type GateOptions } from "./gates.js";
import { Comments, Reports, Schedules } from "./reports.js";
import { Reviews, type ReviewWaitOptions } from "./reviews.js";
import { Collections, type CollectWaitOptions } from "./collections.js";
import { Flows } from "./flows.js";
import { Tasks } from "./tasks.js";
import { AiGovernance } from "./governance.js";
import { Webhooks } from "./webhooks.js";
import { WebhookEndpoints } from "./webhook-endpoints.js";
import { screen, Screened, type ScreenOptions } from "./screen.js";
import { developmentFetch, type DevelopmentOptions } from "./dev.js";
import { durationMs, type Duration } from "./duration.js";
import { DeliverdError } from "./errors.js";
import type {
  CollectedAnswers,
  CreateApprovalInput,
  CreateCollectionInput,
  CreateReviewInput,
  Decision,
  GateDecision,
  PublishReportInput,
  PublishResult,
  ReviewOutcome,
} from "./types.js";

export { Approval, Approvals, DecisionSessions, POLL_SCHEDULE, type WaitOptions } from "./approvals.js";
export { Gate, Gates, type GateOptions, type GateWaitOptions } from "./gates.js";
export { Comments, Reports, Schedules } from "./reports.js";
export { Review, Reviews, type ReviewWaitOptions } from "./reviews.js";
export { Collection, Collections, type CollectWaitOptions } from "./collections.js";
export { Flow, Flows, type FlowPrimitives } from "./flows.js";
export { Task, Tasks } from "./tasks.js";
export { AiGovernance, AiSystems, Incidents } from "./governance.js";
export { WebhookEndpoints } from "./webhook-endpoints.js";
export { Screened, type ScreenOptions } from "./screen.js";
export {
  DATA_KINDS,
  redact,
  restore,
  screenText,
  summarise,
  type DataKind,
  type Redaction,
  type ScreenFinding,
  type ScreenTerm,
} from "./data-screen.js";
export {
  constructCallback,
  constructEvent,
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TOLERANCE_SECONDS,
  verifySignature,
  Webhooks,
} from "./webhooks.js";
export { DeliverdError, DeliverdTimeoutError } from "./errors.js";
export { DEFAULT_BASE_URL, type ClientOptions } from "./http.js";
export { durationMs, type Duration } from "./duration.js";
export type { DevelopmentOptions, DevelopmentOutcome } from "./dev.js";
export type * from "./types.js";

/** How long a request waits for a person before it expires, unless you say. */
export const DEFAULT_EXPIRY: Duration = "24h";

export interface DeliverdOptions extends Partial<ClientOptions> {
  /**
   * `development` runs the whole loop on this machine: no key, no network,
   * nobody interrupted. Defaults to `development` when `DELIVERD_MODE` says
   * so, and to `live` otherwise.
   */
  mode?: "live" | "development";
  development?: DevelopmentOptions;
}

/** Everything `approve()` takes, plus the conveniences it adds on top. */
export interface ApproveOptions extends Omit<CreateApprovalInput, "expiresAt"> {
  /** `"4h"`, `"30m"`, `"2d"`, or milliseconds. Default 24 hours. */
  expiresIn?: Duration;
  /** An exact moment instead, if you have one. */
  expiresAt?: string;
  /**
   * Answer a question the approver asks, without leaving the wait. Return a
   * string and it is posted; return null to leave it for a person.
   */
  onQuestion?: WaitOptions["onQuestion"];
  /** Called after each poll — a progress line in a CLI. */
  onPoll?: WaitOptions["onPoll"];
  /** Give up waiting after this. The request stays open until it expires. */
  timeout?: Duration;
  signal?: AbortSignal;
  /**
   * With an `externalId`, reuse an existing request rather than filing a
   * second one. On by default, so restarting a crashed agent does not ask
   * twice. See `approvals.findByExternalId` for exactly how far that goes.
   */
  reuse?: boolean;
}

/** Everything `review()` takes, plus the conveniences it adds on top. */
export interface ReviewOptions extends Omit<CreateReviewInput, "expiresAt"> {
  /** `"4h"`, `"30m"`, `"2d"`, or milliseconds. Default 24 hours. */
  expiresIn?: Duration;
  /** An exact moment instead, if you have one. */
  expiresAt?: string;
  /** Called after each poll — a progress line in a CLI. */
  onPoll?: ReviewWaitOptions["onPoll"];
  /** Give up waiting after this. The review stays open until it expires. */
  timeout?: Duration;
  signal?: AbortSignal;
  /**
   * With an `externalId`, reuse an existing review rather than filing a
   * second one, so a restarted agent does not ask the same people twice.
   */
  reuse?: boolean;
}

/** Everything `collect()` takes, plus the conveniences it adds on top. */
export interface CollectOptions extends Omit<CreateCollectionInput, "expiresAt"> {
  /** `"4h"`, `"30m"`, `"2d"`, or milliseconds. Default 24 hours. */
  expiresIn?: Duration;
  /** An exact moment instead, if you have one. */
  expiresAt?: string;
  /** Called after each poll — a progress line in a CLI. */
  onPoll?: CollectWaitOptions["onPoll"];
  /** Give up waiting after this. The request stays open until it expires. */
  timeout?: Duration;
  signal?: AbortSignal;
  /**
   * With an `externalId`, reuse an existing request rather than filing a
   * second one, so a restarted agent does not ask the same people twice.
   */
  reuse?: boolean;
}

/**
 * Deliverd: you build the action, Deliverd handles the human.
 *
 * ```ts
 * import { deliverd } from "@deliverd/sdk";
 *
 * const decision = await deliverd.approve({ title: "Deploy to production" });
 * if (decision.approved) await deploy();
 * ```
 *
 * That is the whole integration. What it stands in for: an approval page, the
 * emails and the reminders, identity and single sign-on, who is allowed to
 * decide, a table to keep it in, an audit trail, and the dashboard somebody
 * uses to do it. None of that is yours to build.
 *
 * With no arguments the key comes from `DELIVERD_API_KEY`. Before you have
 * one, `new Deliverd({ mode: "development" })` runs the same code with an
 * imaginary approver.
 */
export class Deliverd {
  readonly approvals: Approvals;
  /** Pages on which an approver decides inside your product: `approvals.createSession` makes one. */
  readonly decisionSessions: DecisionSessions;
  readonly gates: Gates;
  readonly reviews: Reviews;
  readonly collections: Collections;
  readonly flows: Flows;
  readonly tasks: Tasks;
  /** Compliance Mode across the organisation: AI systems, incidents, authority, frameworks, the ICT register. */
  readonly governance: AiGovernance;
  readonly reports: Reports;
  readonly comments: Comments;
  readonly schedules: Schedules;
  readonly webhooks: Webhooks;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly http: HttpClient;
  /** Whether an imaginary approver is deciding these. */
  readonly development: boolean;

  constructor(options: DeliverdOptions = {}) {
    const mode = options.mode ?? (process.env.DELIVERD_MODE === "development" ? "development" : "live");
    this.development = mode === "development";

    this.http = new HttpClient({
      ...options,
      // A key is not needed when nothing leaves the machine.
      apiKey: options.apiKey ?? process.env.DELIVERD_API_KEY ?? (this.development ? "dlv_development" : ""),
      baseUrl: options.baseUrl ?? process.env.DELIVERD_BASE_URL,
      fetch: this.development ? developmentFetch(options.development) : options.fetch,
    });

    this.approvals = new Approvals(this.http);
    this.decisionSessions = new DecisionSessions(this.http);
    this.gates = new Gates(this.http);
    this.reviews = new Reviews(this.http);
    this.collections = new Collections(this.http);
    /*
     * The handle takes the client so `flow.approve()` is the same call as
     * `deliverd.approve()` with the flow filled in, rather than a second
     * implementation that can drift from it.
     */
    this.flows = new Flows(this.http, this);
    this.tasks = new Tasks(this.http);
    this.governance = new AiGovernance(this.http);
    this.reports = new Reports(this.http);
    this.comments = new Comments(this.http);
    this.schedules = new Schedules(this.http);
    this.webhooks = new Webhooks();
    this.webhookEndpoints = new WebhookEndpoints(this.http);
  }

  /**
   * Ask a person, and wait for the answer.
   *
   * Resolves when they decide — including when they say no, because a refusal
   * is an answer and `if (decision.approved)` is the line that follows. It
   * throws only when the wait itself failed: a timeout, an abort, or an API
   * that could not be reached.
   *
   * Requests expire after a day unless you say otherwise, so a wait always
   * ends.
   */
  async approve(options: ApproveOptions): Promise<Decision> {
    const { expiresIn, timeout, onQuestion, onPoll, signal, reuse, ...input } = options;

    if (input.externalId && reuse !== false) {
      const existing = await this.approvals.findByExternalId(input.externalId, signal);
      if (existing) {
        const settled = await existing.wait({
          onQuestion,
          onPoll,
          signal,
          timeout: durationOrUndefined(timeout),
          ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
        });
        return settled.toDecision();
      }
    }

    const approval = await this.approvals.create(
      {
        ...input,
        expiresAt: options.expiresAt ?? new Date(Date.now() + durationMs(expiresIn ?? DEFAULT_EXPIRY)).toISOString(),
      },
      signal
    );
    const settled = await approval.wait({
      onQuestion,
      onPoll,
      signal,
      /*
       * In development the approver is imaginary and instant, so a wait still
       * running after a moment is a path that will never settle — a question
       * with nothing to answer it, usually. Ending it quickly turns that into
       * a message; leaving it turns it into a hung test suite. Two seconds
       * rather than five, because five is what a test runner gives a whole
       * test and losing the race to it reports the wrong failure.
       */
      timeout: durationOrUndefined(timeout) ?? (this.development ? 2_000 : undefined),
      ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
    });
    return settled.toDecision();
  }

  /**
   * Ask whether to act, and wait if a person has to decide.
   *
   * The other primitives ask a person to look at work already done. This one
   * asks first, and the answer comes from **policy the developer does not
   * own** — which is the whole point: what needs a human is an organisation's
   * decision, not a line in your code. Most calls never reach a person at all,
   * because a rule already settles them.
   *
   * ```ts
   * const decision = await deliverd.gate({
   *   action: "finance.refund",
   *   externalId: `refund:${order.id}`,
   *   input: { customer_id: order.customerId, amount: 1240, currency: "GBP" },
   * });
   * if (!decision.allowed) return;
   * await stripe.refunds.create(decision.input);
   * ```
   *
   * **Execute with `decision.input`, not your own object.** It is what the
   * action's schema validated and what an approver actually saw. Passing the
   * original works right up until somebody edits a value before approving, and
   * then it spends an approval for £1200 on a refund of £1240.
   *
   * It does not throw on a refusal — a no is an answer, and `if
   * (decision.allowed)` is the line that follows. It throws when the action is
   * not registered, when the input does not match its schema, or when the wait
   * itself failed.
   *
   * `wait: false` returns a pending decision immediately; `deliverd.gates`
   * is the same thing with the handle exposed.
   */
  async gate(options: GateOptions): Promise<GateDecision> {
    const { action, timeout, onPoll, signal, wait, pollIntervals, ...rest } = options;
    const gate = await this.gates.create({ actionId: action, ...rest }, signal);

    /*
     * No wait when the caller said not to, and none when there is nothing to
     * wait for — a rule that allowed or denied it has already answered, which
     * is the common case and must not cost a poll.
     */
    if (wait === false || !gate.pending) return gate.toDecision();

    const settled = await gate.wait({
      onPoll,
      signal,
      /* The same reasoning as `approve()`: an imaginary approver is instant, so
       * a wait still running after a moment is one that never settles. */
      timeout: durationOrUndefined(timeout) ?? (this.development ? 2_000 : undefined),
      ...(pollIntervals ? { pollIntervals } : this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
    });
    return settled.toDecision();
  }

  /**
   * A yes or no on something small: same mechanism, lower ceremony.
   *
   * Low risk and an hour to answer, because that is what "are you sure?"
   * means — if it deserves a day and a paragraph of evidence, it deserves
   * `approve()`.
   */
  async confirm(options: ApproveOptions): Promise<boolean> {
    const decision = await this.approve({ risk: "low", expiresIn: "1h", ...options });
    return decision.approved;
  }

  /**
   * Ask people to read what you made, and wait for their answer.
   *
   * The other half of judgement. `approve()` asks permission before you act;
   * this asks whether what you already produced is right, and comes back with
   * the reviewers' verdicts and a count of the comment threads they opened.
   *
   * ```ts
   * const outcome = await deliverd.review({
   *   title: "Q3 board pack",
   *   reportId: report.id,
   *   instructions: "Check the figures against the ledger.",
   *   reviewers: ["partner@firm.example"],
   * });
   * if (!outcome.approved) await revise(outcome.verdicts);
   * ```
   *
   * Resolves on changes requested as well as approval, because that is an
   * answer — usually the more useful one. Reviews expire after a day unless
   * you say otherwise, so a wait always ends.
   */
  async review(options: ReviewOptions): Promise<ReviewOutcome> {
    const { expiresIn, timeout, onPoll, signal, reuse, ...input } = options;

    if (input.externalId && reuse !== false) {
      const existing = await this.reviews.findByExternalId(input.externalId, signal);
      if (existing) {
        const settled = await existing.wait({
          onPoll,
          signal,
          timeout: durationOrUndefined(timeout),
          ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
        });
        return settled.toOutcome();
      }
    }

    const review = await this.reviews.create(
      {
        ...input,
        expiresAt:
          options.expiresAt ??
          new Date(Date.now() + durationMs(expiresIn ?? DEFAULT_EXPIRY)).toISOString(),
      },
      signal
    );
    const settled = await review.wait({
      onPoll,
      signal,
      // Same reasoning as approve(): in development the reviewer is imaginary
      // and instant, so a wait still running after a moment will never settle.
      timeout: durationOrUndefined(timeout) ?? (this.development ? 2_000 : undefined),
      ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
    });
    return settled.toOutcome();
  }

  /**
   * Ask people for what you do not have, and wait for it.
   *
   * `approve()` asks permission, `review()` asks judgement, and this asks for
   * a fact — a figure, a date, a choice between options, the sentence only
   * they can write.
   *
   * ```ts
   * const { answers } = await deliverd.collect({
   *   title: "Before I file the Q3 return",
   *   respondents: ["finance@firm.example"],
   *   questions: [
   *     { prompt: "Headcount at 30 September", kind: "number" },
   *     { prompt: "Any disposals in the quarter?", kind: "boolean" },
   *   ],
   * });
   * ```
   *
   * `answers` is keyed by the question you asked. Check `complete` before you
   * use it: a request that expired has whatever arrived and no more, and the
   * thing you do without the figure is usually not the thing you do with it.
   */
  async collect(options: CollectOptions): Promise<CollectedAnswers> {
    const { expiresIn, timeout, onPoll, signal, reuse, ...input } = options;

    if (input.externalId && reuse !== false) {
      const existing = await this.collections.findByExternalId(input.externalId, signal);
      if (existing) {
        const settled = await existing.wait({
          onPoll,
          signal,
          timeout: durationOrUndefined(timeout),
          ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
        });
        return settled.toCollected();
      }
    }

    const collection = await this.collections.create(
      {
        ...input,
        expiresAt:
          options.expiresAt ??
          new Date(Date.now() + durationMs(expiresIn ?? DEFAULT_EXPIRY)).toISOString(),
      },
      signal
    );
    const settled = await collection.wait({
      onPoll,
      signal,
      timeout: durationOrUndefined(timeout) ?? (this.development ? 2_000 : undefined),
      ...(this.development ? { pollIntervals: FAST_POLL_SCHEDULE } : {}),
    });
    return settled.toCollected();
  }

  /** Publish HTML to a secure URL. The sixth primitive, one call in. */
  /**
   * Check text before it goes to an AI model, and wait if a person has to decide.
   *
   * The detectors run here, so the text never leaves your machine: Deliverd is
   * told only what was found, by kind, and answers from what your AI register
   * approves that model to receive.
   *
   * ```ts
   * const screened = await deliverd.screen(prompt, { aiSystemId: CLAIMS_MODEL });
   * if (!screened.allowed) return screened.reasons;
   * const answer = await model.generate(screened.text!);
   * return screened.restore(answer);
   * ```
   *
   * `allow` sends it as it is; `redact` gives you `screened.text` with the
   * findings replaced by placeholders, and `restore()` puts them back in the
   * answer; `ask` puts it to a person and waits; `deny` sends nothing. A net,
   * not a guarantee: names in particular are not reliably found.
   */
  screen(text: string, options: ScreenOptions = {}): Promise<Screened> {
    return screen(this.http, this.approvals, text, options, this.development);
  }

  publish(input: PublishReportInput, signal?: AbortSignal): Promise<PublishResult> {
    return this.reports.publish(input, signal);
  }
}

function durationOrUndefined(value: Duration | undefined): number | undefined {
  return value === undefined ? undefined : durationMs(value);
}

/**
 * A client that builds itself from the environment the first time you touch
 * it, so the shortest integration has no setup line at all:
 *
 * ```ts
 * import { deliverd } from "@deliverd/sdk";
 * await deliverd.approve({ title: "Deploy production" });
 * ```
 *
 * Lazy rather than eager: a module that threw at import time because an
 * environment variable was missing would take a whole process down for a call
 * nobody made yet.
 */
let singleton: Deliverd | undefined;
export const deliverd: Deliverd = new Proxy({} as Deliverd, {
  get(_target, property, receiver) {
    singleton ??= new Deliverd();
    const value = Reflect.get(singleton, property, singleton);
    return typeof value === "function" ? value.bind(singleton) : value;
  },
});

export default Deliverd;
