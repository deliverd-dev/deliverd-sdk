/**
 * The API's objects, by hand.
 *
 * Not imported from the server's zod schemas on purpose: this package is
 * published to npm and must not drag the monorepo's internals with it. The
 * cost of that is drift, so `apps/web/src/lib/services/api-approvals.test.ts`
 * holds these shapes to the schemas the API actually validates — a field added
 * there and not here fails the build on the server side, where someone is
 * looking.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "cancelled";
export type ApprovalRisk = "low" | "medium" | "high" | "critical";

/**
 * What a gate decision can be.
 *
 * Seven, and the extra four over `allowed | denied | pending` are worth the
 * width. `allowed` and `denied` are what a *rule* said; the rest are what a
 * *person* did about a request no rule settled. An action that went through
 * because policy permitted it and one that went through because somebody
 * agreed to it are not the same fact — the ratio between them is the number
 * this whole layer exists to make computable — so collapsing them would throw
 * away the distinction at the one place a caller can see it.
 */
export type GateStatus =
  | "allowed"
  | "denied"
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "expired"
  | "cancelled"
  /** A person took the permission back before it was used. */
  | "revoked"
  /** The permission has been used. A further act needs a new gate. */
  | "used";

/** What a person decided about a gate, once one has. */
export type GateOutcomeName = "approved" | "rejected" | "changes_requested" | "cancelled" | "expired";

/**
 * What policy said, in the words agents are told: fixed when the gate is made.
 * `status` is where it stands now; this is what it was.
 */
export type GateDecisionName = "ALLOW" | "APPROVAL_REQUIRED" | "REVIEW_REQUIRED" | "DENY";

/** Where an act lands. Deliverd decides whether it is inside the organisation. */
export interface Destination {
  /** `workspace`, `report`, `user`, `group`, `email`, `url`, `channel`, `repository`, … */
  type: string;
  id: string;
  label?: string;
}

/**
 * What an act is about. A Deliverd report version (the approval binds to that
 * version and no other), or a file you hold, by its sha256.
 */
export interface GateArtifactRef {
  reportId?: string;
  versionId?: string;
  sha256?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  uri?: string;
}

/** Who is asking, when you ask through a person's connection rather than an agent key. */
export interface GateAgentRef {
  /** A Deliverd agent id. */
  id?: string;
  /** `openai_dot`, `openai_chatgpt`, `openai_codex`, `anthropic`, `google`, `custom`, … */
  provider?: string;
  /** Your id on that platform. */
  externalId?: string;
  name?: string;
}

/** The run a gate belongs to, found by its id or started. */
export interface GateExecutionRef {
  providerExecutionId?: string;
  objective?: string;
  title?: string;
  /** The run that delegated this one. */
  parentFlowId?: string;
}

/** What a gate's permission covers. Every field is fixed when the gate is made. */
export interface GateScope {
  destination: Destination | null;
  /** Worked out by Deliverd, never taken from the request. */
  recipientScope: "internal" | "external" | null;
  classification: "public" | "internal" | "confidential" | "restricted" | null;
  risk: ApprovalRisk | null;
  artifact: {
    kind: "report_version" | "external";
    reportId: string | null;
    versionId: string | null;
    versionNumber: number | null;
    sha256: string | null;
    name: string | null;
    mimeType: string | null;
    size: number | null;
    uri: string | null;
    /** True when Deliverd holds the artifact and the hash is its own. */
    verified: boolean;
  } | null;
  digest: string | null;
}

/**
 * A receipt: what the agent reported doing with a permission, and how much of
 * it Deliverd checked. `verified` only when Deliverd did the act itself;
 * `hash_matched` when it checked the hash; otherwise `reported`.
 */
export interface ExecutionReceipt {
  id: string;
  gateId: string;
  phase: "started" | "completed" | "failed";
  claimId: string | null;
  executedAt: string | null;
  artifactSha256: string | null;
  destination: Destination | null;
  result: Record<string, unknown>;
  verification: "verified" | "hash_matched" | "reported";
  detail: string | null;
  reportedBy: string;
  createdAt: string;
}

/** What you tell Deliverd you did. Recorded as your report, never as verified fact. */
export interface RecordExecutionInput {
  /** `started` claims a use before you act; `completed` (the default) or `failed` reports the outcome. */
  phase?: "started" | "completed" | "failed";
  /** The id of your `started` receipt, when this finishes it. */
  claimId?: string;
  executedAt?: string;
  /** Required when the permission names an artifact; a different hash is refused. */
  artifactSha256?: string;
  /** Where it landed. Must be where it was authorised to. */
  destination?: Destination;
  result?: Record<string, unknown>;
  detail?: string;
  agent?: GateAgentRef;
}

export interface CreateGateInput {
  /** The registered action you are about to perform: `finance.refund`. */
  actionId: string;
  /** The arguments you will actually execute with. Validated against the action's schema. */
  input: Record<string, unknown>;
  /**
   * Your id for this unit of work — `refund:ord_8812`. **Required**, which no
   * other create in this SDK is.
   *
   * Every other POST mints a random idempotency key per attempt, which guards a
   * retried *request*. This guards a retried *decision*: a crashed agent that
   * re-runs its refund step must re-read the answer it already got, not ask a
   * second person about the same money. No id the SDK invented could know which
   * two calls are the same attempt, so you name it.
   */
  externalId: string;
  /** Where this is running, for rules that tell staging from production. */
  environment?: string;
  /** Why, shown to whoever is asked to decide. */
  reason?: string;
  flowId?: string;
  /** What you are about to do, in a sentence a person will read. Same as `reason`. */
  description?: string;
  /** Where the act lands. An approval covers this destination and no other. */
  destination?: Destination;
  /** How sensitive the data is. Raises, never lowers, what Deliverd knows. */
  classification?: "public" | "internal" | "confidential" | "restricted";
  /** How risky you judge it. Raises, never lowers, the action's own risk. */
  risk?: ApprovalRisk;
  /** What the act is about. An approval covers this artifact and no other. */
  artifact?: GateArtifactRef;
  /** Who you are, when you ask through a person's connection. */
  agent?: GateAgentRef;
  /** The run this belongs to. Use instead of flowId. */
  execution?: GateExecutionRef;
  /** The gate this revises, after a person asked for changes. */
  supersedesGateId?: string;
  /** An https address for the gate's settlement and execution, signed. */
  callbackUrl?: string;
  /** Anything else a person deciding should see. Read by no rule. */
  metadata?: Record<string, unknown>;
}

export interface GateData {
  id: string;
  status: GateStatus;
  /** The one to branch on: a rule permitted it, or a person agreed to it. */
  allowed: boolean;
  /**
   * What to execute with: the input as the action's schema validated it, or
   * the approver's correction of it when they approved with changes.
   */
  input: Record<string, unknown>;
  /** What the approver changed in it. Empty unless they did. */
  changes: FieldChange[];
  /**
   * What the organisation's ethics rules asked whoever decides to weigh, as
   * they read when this was asked. Empty when nothing matched. A flagged
   * request is approved with a written reason, never from a sign-in-free link.
   */
  concerns: { principle: string; rule: string; concern: string }[];
  /** Whether a rule decided this or a person did. */
  basis: "policy" | "human";
  reason: string | null;
  /** The rule that decided, by name. Null when nothing matched. */
  rule: string | null;
  policyVersionId: string | null;
  approvalId: string | null;
  approvalUrl: string | null;
  outcome: GateOutcomeName | null;
  settledAt: string | null;
  /** True when this call found a decision already made under your `externalId`. */
  reused: boolean;
  /** What policy said, fixed when the gate was made. */
  decision: GateDecisionName;
  /**
   * Whether you may act on this now: authorised, inside its window, with a use
   * left, not revoked. `allowed` says it was ever authorised; this says it
   * still is. The organisation's authorisation only — the platform you run on
   * may still require its user's confirmation.
   */
  canExecute: boolean;
  /** Why not, when `canExecute` is false. */
  blockedBecause: string | null;
  scope: GateScope;
  authorisation: { validUntil: string | null; maxUses: number; usesRemaining: number };
  actionId: string;
  agentId: string | null;
  flowId: string | null;
  supersedesGateId: string | null;
  description: string | null;
  requestedBy: string;
  createdAt: string | null;
  /** Returned once, by the call that made the gate and named a callbackUrl. */
  callbackSecret?: string;
  /** On a single read: what has been reported against it. */
  executions?: ExecutionReceipt[];
}

/**
 * The answer, flattened — what `gate()` hands back.
 *
 * `allowed` is a boolean so `if (decision.allowed)` reads as the sentence it
 * is; `status` is the narrowing union for a switch. The same pairing, for the
 * same reason, as `Decision` on an approval.
 */
export interface GateDecision {
  allowed: boolean;
  status: GateStatus;
  reason: string | null;
  rule: string | null;
  /** What to execute with, corrections included. */
  input: Record<string, unknown>;
  /** What the approver changed. Empty unless they did. */
  changes: FieldChange[];
  id: string;
  approvalUrl: string | null;
  gate: unknown;
}

/** One field an approver corrected before approving. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** One line of evidence, as the approval page shows it. */
export interface ApprovalFactor {
  label: string;
  status?: "ok" | "warning" | "info";
  detail?: string;
}

export interface ApprovalLink {
  label: string;
  url: string;
}

export interface ApprovalQuestion {
  id: string;
  question: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface ApprovalData {
  id: string;
  status: ApprovalStatus;
  /** The page the approver decides on. */
  url: string;
  title: string;
  description: string | null;
  risk: ApprovalRisk;
  factors: ApprovalFactor[];
  links: ApprovalLink[];
  reportId: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
  /** What you proposed to run with, unchanged. */
  input: Record<string, unknown> | null;
  /** Which fields of it the approver may correct. */
  editableFields: string[];
  /** What to run with once approved: `input` with any corrections. Null until then. */
  approvedInput: Record<string, unknown> | null;
  /** What the approver changed. */
  changes: FieldChange[];
  /**
   * What the organisation's ethics rules asked whoever decides to weigh, as
   * they read when this was asked. Empty when nothing matched. A flagged
   * request is approved with a written reason, never from a sign-in-free link.
   */
  concerns: { principle: string; rule: string; concern: string }[];
  requestedBy: string;
  approvers: string[];
  /**
   * How many people must agree before it settles. One unless a standing rule
   * in the organisation escalated it — an agent cannot set this, and a rule
   * can only push it up.
   */
  requiredApprovals: number;
  /** How many have approved so far. Compare with `requiredApprovals`. */
  approvalsSoFar: number;
  /** Who decided, as a name rather than an id — the same as a review's `by`. */
  decidedBy: string | null;
  /** Their user id, for anything that needs the key rather than the person. */
  decidedById: string | null;
  decidedAt: string | null;
  /** The approver's reason, on a rejection or an approval that carried one. */
  note: string | null;
  expiresAt: string | null;
  questions: ApprovalQuestion[];
  createdAt: string;
}

export interface CreateApprovalInput {
  /** What is being asked, as a headline. */
  title: string;
  /** Why, what it affects, what it costs — what the approver reads first. */
  description?: string;
  /** How the approver should weigh it. Medium when omitted. */
  risk?: ApprovalRisk;
  /** Evidence, one line each, shown as a checklist. */
  factors?: ApprovalFactor[];
  /** Where to read more. */
  links?: ApprovalLink[];
  /** A published report the request is about. */
  reportId?: string;
  /**
   * Who may decide. Each entry is a person — an email or a user id — or the
   * name of a directory group or workspace, or a word meaning the whole
   * organisation ("everyone"). Naming a team is usually what you want: a
   * request addressed to one person waits for that person to come back from
   * holiday, and anyone on a team can answer.
   *
   * The organisation's owners and admins decide when this is omitted. You
   * cannot name only yourself; being *on* a team you address is fine and means
   * the rest of it. A name matching both a person and a team is refused rather
   * than guessed — name it by id.
   */
  approvers?: string[];
  /** After this the request expires undecided. ISO 8601. */
  expiresAt?: string;
  /** Your own reference, returned unchanged and searchable. */
  externalId?: string;
  /**
   * The flow this belongs to, when it is one step of a larger piece of work.
   * Must be an open flow in your organisation. `flow.approve()` and its
   * siblings set this for you.
   */
  flowId?: string;
  /**
   * Where to POST the outcome when a person answers, instead of polling:
   * HTTPS, and a public address. The call that makes the request returns the
   * secret its callbacks are signed with (`callbackSecret` on the handle).
   */
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * The arguments you will run with if this is approved, shown to the
   * approver. The decision's `input` is what to actually run with.
   */
  input?: Record<string, unknown>;
  /**
   * Fields of `input` the approver may correct before approving: strings,
   * numbers and true/false. Omitted, it is approve or reject only.
   */
  editableFields?: string[];
}

/**
 * The answer to `approve()`.
 *
 * Flat on purpose: the line after the call is `if (decision.approved)`, and
 * anything a caller has to reach through to get there is a step this SDK
 * exists to remove. The whole request is on `approval` when a field here does
 * not cover it.
 */
export type Decision = {
  /** True only for an approval. False for rejected, changes requested, expired and cancelled. */
  approved: boolean;
  /** For a switch, and for narrowing. */
  status: "approved" | "rejected" | "changes_requested" | "expired" | "cancelled";
  /** Their reason, when they gave one. */
  note: string | null;
  /** Who decided, as a name rather than an id. Log it; put it in a message. */
  decidedBy: string | null;
  /** Their user id, when the key is what you need. */
  decidedById: string | null;
  decidedAt: string | null;
  id: string;
  /** The page they decided on. Worth logging. */
  url: string;
  /**
   * What to run with, when you sent an `input` and it was approved: yours,
   * with any corrections the approver made. Null otherwise — never run the
   * proposal when this is null.
   */
  input: Record<string, unknown> | null;
  /** What the approver changed. Empty when they approved it as proposed. */
  changes: FieldChange[];
  /** The request itself, for anything the fields above do not name. */
  approval: unknown;
};

export interface ListApprovalsInput {
  status?: ApprovalStatus;
  externalId?: string;
  /**
   * The requests naming one person — a member's id or email, or an admitted
   * guest's email. An approver's inbox, to render in your own product.
   */
  approver?: string;
  /** One page of this size. Leave it unset to get every row. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

/* ── Decision sessions ───────────────────────────────────────────────────── */

/**
 * A page on which one approver decides one request, inside your product.
 * `hosted` gives you a `url` to send them to; `embedded` gives you a
 * `clientSecret` to mount with `https://deliverd.dev/elements/v1.js`.
 */
export interface CreateDecisionSessionInput {
  /** The approver, by email or user id. They must already be on the request. */
  approver: string;
  /** Defaults to `hosted`. */
  mode?: "hosted" | "embedded";
  /**
   * Embedded only: the site that frames it, such as `https://app.example.com`.
   * On the organisation's embedding allow-list, or `http://localhost` while
   * you develop.
   */
  origin?: string;
  /** Hosted only: where to send them afterwards. `deliverd_session` and `deliverd_decision` are added. */
  returnUrl?: string;
  /** Seconds, 60 to 86400. Never past the request's own deadline. Defaults to an hour. */
  expiresIn?: number;
}

export type DecisionSessionStatus = "open" | "verified" | "complete" | "expired";

export interface DecisionSession {
  id: string;
  object: "decision_session";
  approvalId: string;
  approver: { type: "member" | "guest"; email: string };
  mode: "hosted" | "embedded";
  origin: string | null;
  returnUrl: string | null;
  /** The page, with the secret in it. Returned once, when the session is made. */
  url?: string;
  /** What `Deliverd.mountDecision` takes. Returned once, when the session is made. */
  clientSecret?: string;
  /** `verified` once the approver has confirmed who they are; `complete` once they have decided. */
  status: DecisionSessionStatus;
  decision: "approved" | "rejected" | "changes_requested" | null;
  /** The request's own status, which another approver may have settled. */
  approvalStatus: ApprovalStatus;
  expiresAt: string;
  verifiedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/* ── Reports ─────────────────────────────────────────────────────────────── */

export interface InlineFile {
  path: string;
  content: string;
  /** `base64` for an image or a font; text otherwise. */
  encoding?: "utf8" | "base64";
}

export interface PublishReportInput {
  title?: string;
  slug?: string;
  description?: string;
  workspaceId?: string;
  /** Names, teams, groups or emails — resolved server-side. */
  audience?: unknown;
  classification?: string;
  living?: boolean;
  sourceTool?: string;
  sourceModel?: string;
  changeSummary?: string;
  /** Publish only if this is still the current version; 0 claims a new slug. */
  expectedVersion?: number;
  /**
   * The flow this report belongs to, from `flows.create()`. Set on the first
   * publish; a new version keeps whatever flow the report already has.
   */
  flowId?: string;
  /**
   * The task (an objective or a side task) this report is written for. It is
   * then listed on the task and returned in `task.context()`, so the next
   * agent publishes a new version rather than a second report. A later
   * publish naming another task moves it; leaving this out keeps it where it
   * is. Needs `tasks:read` on the key.
   */
  taskId?: string;
  uploadId?: string;
  content?: string;
  files?: InlineFile[];
}

export type UpdateReportInput = Pick<
  PublishReportInput,
  | "uploadId"
  | "content"
  | "files"
  | "title"
  | "description"
  | "sourceTool"
  | "sourceModel"
  | "changeSummary"
  | "expectedVersion"
  | "taskId"
>;

export interface ReportData {
  id: string;
  slug: string;
  title: string;
  url: string;
  status: string;
  currentVersion: number | null;
  /** The task this report was written for, when it was published with one. */
  taskId?: string | null;
  [key: string]: unknown;
}

/**
 * A publish held by a policy rule answers 202 with this instead of going live.
 * `status` says which happened, so a caller that ignores it still gets a
 * report object and a caller that reads it knows nobody can see the thing yet.
 */
export interface PublishResult {
  status?: "published" | "updated" | "pending_approval";
  report: ReportData;
  version?: { id: string; versionNumber: number; [key: string]: unknown };
  approval?: { id: string; status: string };
  warnings?: string[];
  [key: string]: unknown;
}

/**
 * One open thread, as the organisation-wide list returns it.
 *
 * Deliberately thinner than a `CommentThread`: this answers "where is the
 * feedback" across every report, so it carries the report and the quoted
 * passage rather than the whole conversation. Fetch the thread itself with
 * `comments.list(reportId)` once you know which report to look at.
 */
export interface OpenThread {
  threadId: string;
  reportId: string;
  reportTitle: string;
  reportSlug: string;
  /** Who owns the report — filter on it to find the threads on yours. */
  reportOwnerId: string | null;
  quote: string | null;
  author: string;
  authorType: string;
  messages: number;
  lastActivityAt: string;
}

/**
 * What a send did, per address.
 *
 * `delivered` is the mail provider accepting it, not the person reading it —
 * and `alreadyHadAccess` names the recipients who could already open the
 * report, who were emailed again anyway. Re-sending to somebody who says
 * they never got the first one is the point.
 */
export interface SendResult {
  sent: { email: string; delivered: boolean }[];
  alreadyHadAccess: string[];
}

/**
 * What a share lets its audience do. `"view"` is the default.
 *
 * "Can manage", which lets someone share the report on, is not here: it is a
 * person's decision, made in the app, and the API refuses it from a key.
 */
export type ShareCapability = "view" | "comment";

export interface ShareOptions {
  capability?: ShareCapability;
}

/* ── Schedules ───────────────────────────────────────────────────────────── */

/**
 * A recurring publish an agent is expected to perform.
 *
 * `due` is the useful field: true once the schedule has fired and nobody has
 * acted on that firing. Publishing a new version clears it, and so does
 * writing a dataset — for a report that reads its numbers from `_data/…`,
 * updating the data is the whole job.
 */
export interface ScheduleSummary {
  id: string;
  reportId: string;
  reportSlug: string;
  reportTitle: string;
  reportUrl: string;
  agentId: string;
  agentName: string;
  /** Five-field cron expression, evaluated in UTC. */
  recurrence: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  currentVersion: number | null;
  due: boolean;
  dueSince: string | null;
}

/* ── Comments ────────────────────────────────────────────────────────────── */

export interface CommentThread {
  threadId: string;
  status: "open" | "resolved";
  quote: string | null;
  messages: {
    /** What `comments.retract` takes. */
    commentId: string;
    author: string;
    authorType: string;
    body: string;
    createdAt: string;
    /** True for the one message this credential could still take back. */
    retractable: boolean;
  }[];
  [key: string]: unknown;
}

/* ── Analytics ───────────────────────────────────────────────────────────── */

/** Who read one report. The detail beyond `totalViews` needs the analytics plan. */
export interface ReportAnalytics {
  reportId: string;
  title: string;
  totalViews: number;
  uniqueViewers: number | null;
  internalViewers: number | null;
  externalViewers: number | null;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  byDay: { day: string; views: number; uniqueViewers: number }[];
  byVersion: {
    versionNumber: number;
    views: number;
    uniqueViewers: number;
    lastViewedAt: string | null;
  }[];
  /** Names only where the organisation shows viewer identities. */
  recentViewers: {
    displayName: string;
    principalType: string;
    viewCount: number;
    lastViewedAt: string;
  }[];
}

/** What is being read across every report, and what is not being read at all. */
export interface OrgAnalytics {
  days: number;
  totalViews: number;
  uniqueViewers: number;
  activeReports: number;
  externallySharedReports: number;
  publicReports: number;
  publishesInPeriod: number;
  topReports: {
    reportId: string;
    title: string;
    views: number;
    uniqueViewers: number;
    lastViewedAt: string | null;
  }[];
  /** Live reports with no view in the period — oldest silence first. */
  inactiveReports: {
    reportId: string;
    title: string;
    lastViewedAt: string | null;
    publishedAt: string | null;
  }[];
}

/* ── Webhooks ────────────────────────────────────────────────────────────── */

export type WebhookEventName =
  | "report.published"
  | "report.updated"
  | "report.shared"
  | "report.viewed"
  | "comment.created"
  | "access.requested"
  | "schedule.due"
  | "publish.held"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.changes_requested"
  | "approval.expired"
  | "approval.escalated"
  | "approval.question"
  | "approval.answered"
  | "review.requested"
  | "review.approved"
  | "review.changes_requested"
  | "collection.requested"
  | "collection.completed"
  | "flow.completed"
  /** A gate refused. The only gate event that relays: an allow fires on every
   * auto-allowed action, and an escalation already arrives as
   * `approval.requested`. */
  | "gate.denied"
  /** A gate's whole life. Opt-in: sent only to an endpoint that names them. */
  | "gate.created"
  | "gate.approved"
  | "gate.rejected"
  | "gate.changes_requested"
  | "gate.expired"
  | "gate.cancelled"
  | "gate.revoked"
  | "gate.executed"
  /** An objective finished. */
  | "task.completed"
  /** Opt-in: a task moved into blocked, or a side task finished and its
   * result waits to be applied, kept or discarded. */
  | "task.blocked"
  | "side_task.completed";

export interface WebhookEvent {
  event: WebhookEventName;
  sentAt: string;
  /** Present and true when sent by the Send test button, not by real activity. */
  test?: boolean;
  data: Record<string, unknown>;
}

/**
 * How an endpoint's body is shaped: the signed JSON envelope, a Slack Block
 * Kit message for an Incoming Webhook, a Teams Adaptive Card for a Workflows
 * webhook, or a Discord embed with a link button for a channel webhook. The
 * signature headers are sent with all four.
 */
export type WebhookEndpointFormat = "json" | "slack" | "teams" | "discord";

/** An organisation's webhook endpoint, as `deliverd.webhookEndpoints` reads it. Never its secret. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  /** Empty means every event, including ones added later, except the opt-in ones. */
  events: WebhookEventName[];
  format: WebhookEndpointFormat;
  enabled: boolean;
  /** Consecutive failed deliveries. At twenty the endpoint is switched off. */
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/**
 * What `webhookEndpoints.create()` returns: the endpoint and its signing
 * secret. **The only time the secret is returned** — no other call carries
 * it, and it cannot be retrieved afterwards. Keep it with your receiver and
 * pass it to `constructEvent()`.
 */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventName[];
  format: WebhookEndpointFormat;
  enabled: boolean;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** `dlvw_…`. Shown once. */
  secret: string;
}

export interface CreateWebhookEndpointInput {
  /** HTTPS, on a public host. */
  url: string;
  /** Leave it out, or send `[]`, for every event except the opt-in ones. */
  events?: WebhookEventName[];
  description?: string | null;
  /** Default `"json"`. */
  format?: WebhookEndpointFormat;
}

/** Only what you send changes; send at least one. The secret cannot be changed. */
export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: WebhookEventName[];
  description?: string | null;
  format?: WebhookEndpointFormat;
  /** Turning it back on clears its run of failures. */
  enabled?: boolean;
}

export interface TestWebhookEndpointInput {
  /** Default `"report.published"`. */
  event?: WebhookEventName;
}

/** What the endpoint said to a test send. `delivered: false` is an answer, not an error. */
export interface WebhookTestResult {
  delivered: boolean;
  /** Null when it could not be reached. */
  responseStatus: number | null;
  error: string | null;
}

export interface ListWebhookEndpointsInput {
  /** One page of this size. Leave it unset to get every endpoint. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

/* ── Reviews ──────────────────────────────────────────────────────────────── */

export type ReviewStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "expired"
  | "cancelled";

export interface CreateReviewInput {
  /** What is being reviewed, as a headline the reviewer sees first. */
  title: string;
  /**
   * What to check. Without this a reviewer decides what "review" means, and
   * usually decides it means "looks fine".
   */
  instructions?: string;
  /** The published report under review; the reviewer reads it and comments on it. */
  reportId?: string;
  /** Pin a version, so publishing again mid-review does not move the ground. */
  versionId?: string;
  /**
   * Emails or user ids. An active member, or a guest who can already open the
   * report — anyone else is refused rather than emailed. You cannot name
   * yourself.
   */
  reviewers: string[];
  /**
   * How many approvals settle it; one when omitted. A single "changes
   * requested" settles it regardless.
   */
  requiredApprovals?: number;
  /** After this the review expires unanswered. ISO 8601. */
  expiresAt?: string;
  /** Your own reference, returned unchanged and searchable. */
  externalId?: string;
  /**
   * The flow this belongs to, when it is one step of a larger piece of work.
   * Must be an open flow in your organisation. `flow.approve()` and its
   * siblings set this for you.
   */
  flowId?: string;
  /**
   * Where to POST the outcome when a person answers, instead of polling:
   * HTTPS, and a public address. The call that makes the request returns the
   * secret its callbacks are signed with (`callbackSecret` on the handle).
   */
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewerRef {
  kind: "user" | "guest";
  id: string;
  label: string;
}

export interface ReviewVerdict {
  verdict: "approved" | "changes_requested";
  /** Who gave it, as a name rather than an id. */
  by: string;
  note: string | null;
  at: string;
}

export interface ReviewData {
  id: string;
  status: ReviewStatus;
  /** The page the reviewer reads and decides on. */
  url: string;
  title: string;
  instructions: string | null;
  reportId: string | null;
  versionId: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
  requestedBy: string;
  requiredApprovals: number;
  reviewers: ReviewerRef[];
  verdicts: ReviewVerdict[];
  /** How many comment threads the reviewers opened while reading. */
  threadCount: number;
  settledAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** The answer, flattened — what `review()` hands back. */
export interface ReviewOutcome {
  /** The one to branch on. False for changes requested, expired and cancelled. */
  approved: boolean;
  status: Exclude<ReviewStatus, "pending">;
  /** Every verdict returned, in the order they arrived. */
  verdicts: ReviewVerdict[];
  /** How many comment threads to read before producing the next version. */
  threadCount: number;
  id: string;
  url: string;
  review: ReviewData;
}

export interface ListReviewsInput {
  status?: ReviewStatus;
  externalId?: string;
  reportId?: string;
  /** One page of this size. Leave it unset to get every row. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

/* ── Collections ──────────────────────────────────────────────────────────── */

export type CollectionStatus = "pending" | "complete" | "expired" | "cancelled";

export type QuestionKind =
  | "text"
  | "long_text"
  | "number"
  | "date"
  | "choice"
  | "multi_choice"
  | "boolean";

/** What an answer can hold, shaped by its question's kind. */
export type AnswerValue = string | number | boolean | string[];

export interface QuestionInput {
  /** The question, as you would ask it out loud. */
  prompt: string;
  /** The sentence under the field that stops the wrong answer being given. */
  help?: string;
  kind: QuestionKind;
  /** Required unless you say otherwise; a required question blocks submission. */
  required?: boolean;
  /** For `choice` and `multi_choice`. At least two, or it is not a question. */
  options?: string[];
}

export interface CreateCollectionInput {
  /** What you need, as a headline the person sees first. */
  title: string;
  /** Why you are asking, shown above the questions. */
  instructions?: string;
  questions: QuestionInput[];
  /**
   * Emails or user ids. An active member, or a guest the organisation already
   * knows — anyone else is refused rather than emailed.
   */
  respondents: string[];
  /** How many submitted replies complete it; everyone asked, when omitted. */
  requiredResponses?: number;
  /** A published report the request is about. */
  reportId?: string;
  /** Shown to the person, and what the single reminder is measured against. */
  dueAt?: string;
  /** After this the request closes unanswered. ISO 8601. */
  expiresAt?: string;
  externalId?: string;
  /**
   * The flow this belongs to, when it is one step of a larger piece of work.
   * Must be an open flow in your organisation. `flow.approve()` and its
   * siblings set this for you.
   */
  flowId?: string;
  /**
   * Where to POST the outcome when a person answers, instead of polling:
   * HTTPS, and a public address. The call that makes the request returns the
   * secret its callbacks are signed with (`callbackSecret` on the handle).
   */
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CollectionQuestion {
  id: string;
  prompt: string;
  help: string | null;
  kind: QuestionKind;
  required: boolean;
  options: string[];
}

export interface CollectionReply {
  /** Who answered, as a name rather than an id. */
  respondent: string;
  status: "pending" | "submitted";
  submittedAt: string | null;
  /** Empty until they submit: a half-typed draft is not what they meant to say. */
  answers: { question: string; kind: QuestionKind; value: AnswerValue }[];
}

export interface CollectionData {
  id: string;
  status: CollectionStatus;
  /** The page the person fills in. */
  url: string;
  title: string;
  instructions: string | null;
  reportId: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
  requestedBy: string;
  requiredResponses: number;
  questions: CollectionQuestion[];
  responses: CollectionReply[];
  submittedCount: number;
  askedCount: number;
  settledAt: string | null;
  dueAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** The answers, flattened — what `collect()` hands back. */
export interface CollectedAnswers {
  /** True when enough people replied; false if it expired or was withdrawn. */
  complete: boolean;
  status: Exclude<CollectionStatus, "pending">;
  /** Every submitted reply, in the order they arrived. */
  responses: CollectionReply[];
  /**
   * The first submitted answer to each question, by its prompt — the shape
   * most callers want when they asked one person for three facts.
   */
  answers: Record<string, AnswerValue>;
  id: string;
  url: string;
  collection: CollectionData;
}

export interface ListCollectionsInput {
  status?: CollectionStatus;
  externalId?: string;
  /** One page of this size. Leave it unset to get every row. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

/* ── Flows ────────────────────────────────────────────────────────────────── */

export type FlowStatus = "open" | "complete" | "cancelled";
export type FlowMemberKind = "approval" | "review" | "collection" | "report";

export interface FlowMember {
  kind: FlowMemberKind;
  id: string;
  title: string;
  /** The member's own status word, which differs by kind. */
  status: string;
  /** Still waiting on somebody. Always false for a report. */
  open: boolean;
  createdAt: string;
}

/** One line of the history: what happened, who did it, when. */
export interface FlowEvent {
  event: string;
  actor: string;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  at: string;
}

export interface FlowData {
  id: string;
  status: FlowStatus;
  /** The timeline page a person can open. */
  url: string;
  title: string;
  description: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
  startedBy: string;
  members: FlowMember[];
  memberCount: number;
  openCount: number;
  /** Nothing outstanding right now — not a claim that the job is finished. */
  allSettled: boolean;
  /** Present on a single read, absent from a list. */
  timeline?: FlowEvent[];
  settledAt: string | null;
  createdAt: string;
}

export interface CreateFlowInput {
  /** What this piece of work is, as the timeline will be titled. */
  title: string;
  /** What it is for, for whoever reads the history a year from now. */
  description?: string;
  workspaceId?: string;
  /** Your own reference. Pass it and use `resume()` so a restart does not start a second flow. */
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListFlowsInput {
  status?: FlowStatus;
  externalId?: string;
  /** One page of this size. Leave it unset to get every row. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

/* ── Tasks ────────────────────────────────────────────────────────────────── */

/*
 * Task Graph: an objective kept apart from the conversation doing the work,
 * the side tasks branched out of it, and the findings each one produced.
 *
 * Every nested shape is named rather than written inline, so the Python SDK
 * can carry the same class under the same name and the parity guard can hold
 * the two to each other field by field.
 */

export type TaskKind = "objective" | "side_task" | "investigation" | "research" | "debug" | "decision";
export type SideTaskKind = "side_task" | "investigation" | "research" | "debug" | "decision";
export type TaskStatus = "open" | "in_progress" | "blocked" | "awaiting_approval" | "completed" | "cancelled";
/** The statuses `update()` may set. Completing and cancelling have their own calls. */
export type SettableTaskStatus = "open" | "in_progress" | "blocked" | "awaiting_approval";
/** What became of a finished side task's result: carried into the parent, kept for reference, or not used. */
export type TaskOutcome = "applied" | "kept" | "discarded";
export type FindingKind =
  | "hypothesis"
  | "test"
  | "evidence"
  | "finding"
  | "conclusion"
  | "recommendation"
  | "decision"
  | "risk"
  | "question"
  | "action";
/** A decision is a suggestion until a person confirms it. */
export type DecisionStatus = "suggested" | "confirmed" | "rejected";
export type TaskLinkKind = "depends_on" | "blocks" | "related_to" | "supersedes" | "resulted_in";

/** The short working state of a task: where it stands, what is open, what is in the way, what comes next. */
export interface TaskState {
  currentState: string | null;
  openQuestions: string[];
  constraints: string[];
  blockedBy: string[];
  nextAction: string | null;
}

/**
 * A change to a task's state. Fields left out stay as they were; a list sent
 * replaces the list; `addOpenQuestions` and `resolveOpenQuestions` change it
 * item by item, so two writers do not have to agree on the whole list.
 */
export interface TaskStatePatch {
  currentState?: string | null;
  openQuestions?: string[];
  addOpenQuestions?: string[];
  resolveOpenQuestions?: string[];
  constraints?: string[];
  blockedBy?: string[];
  nextAction?: string | null;
}

/** What a side task was given when it began. Not a transcript: the facts it needs. */
export interface TaskSnapshot {
  rootObjective: string;
  parentObjective: string;
  sideTaskGoal: string;
  relevantContext: string[];
  knownConstraints: string[];
  relatedDecisions: string[];
  /** The parent's open question this side task was opened to answer, if any. */
  resolvesQuestion: string | null;
}

export interface TaskResultFinding {
  title: string;
  description: string;
  evidence?: string[];
}

export interface TaskResultDecision {
  title: string;
  rationale?: string;
}

/** What a side task came back with. Structured, so the parent can use it. */
export interface TaskResult {
  summary: string;
  findings: TaskResultFinding[];
  decisions: TaskResultDecision[];
  recommendations: string[];
  unresolvedQuestions: string[];
  parentImpact: string | null;
  suggestedNextAction: string | null;
}

/** An objective's side tasks, counted. On a list only. */
export interface SideTaskCounts {
  open: number;
  done: number;
  /** Finished and waiting for somebody to apply, keep or discard the result. */
  awaiting: number;
}

/** One step from the objective down to a task. */
export interface TaskPathEntry {
  id: string;
  title: string;
  kind: TaskKind;
}

export interface TaskLink {
  sourceTaskId: string;
  targetTaskId: string;
  kind: TaskLinkKind;
}

/** A task as the tree shows it: no state, no snapshot, one line of the result. */
export interface TaskNode {
  id: string;
  parentTaskId: string | null;
  kind: TaskKind;
  depth: number;
  status: TaskStatus;
  title: string;
  outcome: TaskOutcome | null;
  resultSummary: string | null;
  url: string;
}

/** An inspectable work product: what was tested, seen or concluded. Never private reasoning. */
export interface TaskFinding {
  id: string;
  taskId: string;
  kind: FindingKind;
  title: string;
  body: string;
  evidence: string[];
  /** For a decision: suggested, confirmed or rejected, with any approval taken into account. */
  decisionStatus: DecisionStatus | null;
  decidedBy: string | null;
  decidedAt: string | null;
  approvalId: string | null;
  /** The approval's own status, when a decision was put to one. */
  approvalStatus: string | null;
  /** The side task it came from, when it arrived with an applied result. */
  sourceTaskId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface TaskData {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  /** The page a person can open. */
  url: string;
  title: string;
  /** What the work is for: the objective's purpose, or a side task's goal. */
  objective: string;
  rootTaskId: string;
  /** Null on the objective itself. */
  parentTaskId: string | null;
  depth: number;
  workspaceId: string | null;
  flowId: string | null;
  state: TaskState;
  /** For a side task: what it was given when it began. */
  snapshot: TaskSnapshot | null;
  /** Once completed: what it came back with. */
  result: TaskResult | null;
  /** Earlier results, kept when a completed task is reopened. */
  previousResults: TaskResult[];
  outcome: TaskOutcome | null;
  origin: "manual" | "suggested";
  externalId: string | null;
  sessionUrl: string | null;
  /** Pass it back as `expectedVersion` to refuse an update somebody else got in before. */
  version: number;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** On a list only. */
  sideTasks?: SideTaskCounts;
  /** On a single read: from the objective down to this task. */
  path?: TaskPathEntry[];
  /** On a single read: the side tasks directly under this one. */
  children?: TaskNode[];
  /** On a single read. */
  findings?: TaskFinding[];
  /** On a single read. */
  links?: TaskLink[];
  /** On create only: true when an open objective with this `externalId` was returned instead of a new one. */
  resumed?: boolean;
}

export interface TaskContextTask {
  id: string;
  kind: TaskKind;
  title: string;
  objective: string;
  status: TaskStatus;
  isSideTask: boolean;
}

export interface TaskContextDecisions {
  confirmed: string[];
  suggested: string[];
}

export interface TaskContextFinding {
  kind: FindingKind;
  title: string;
  body: string;
}

export interface ActiveSideTask {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
}

/** Finished, and waiting for somebody to apply, keep or discard the result. */
export interface AwaitingSideTask {
  id: string;
  title: string;
  summary: string | null;
}

export interface CompletedSideTask {
  id: string;
  title: string;
  summary: string | null;
  outcome: TaskOutcome | null;
}

export interface TaskContextSideTasks {
  active: ActiveSideTask[];
  awaitingOutcome: AwaitingSideTask[];
  completed: CompletedSideTask[];
}

/**
 * What an agent reads instead of the history: the objective first, always,
 * then where this task stands and what is settled. Small on purpose.
 */
export interface TaskContext {
  rootObjective: string;
  task: TaskContextTask;
  path: TaskPathEntry[];
  currentState: string | null;
  nextAction: string | null;
  openQuestions: string[];
  constraints: string[];
  blockedBy: string[];
  decisions: TaskContextDecisions;
  snapshot: TaskSnapshot | null;
  relevantFindings: TaskContextFinding[];
  sideTasks: TaskContextSideTasks;
  /**
   * Reports published for this task, newest first, up to ten. Revise one with
   * `reports.update()` rather than publishing a second on the same thing.
   */
  reports: TaskContextReport[];
  /** One paragraph to say back to yourself to re-anchor on the objective. */
  reanchor: string;
}

/** A report published for a task, as its context names it. */
export interface TaskContextReport {
  id: string;
  title: string;
  url: string;
  /** The live version; null until one has gone live. */
  version: number | null;
  publishedAt: string | null;
}

export interface TaskGraph {
  root: TaskData;
  nodes: TaskNode[];
  links: TaskLink[];
}

/** What applying a side task's result did: both tasks as they now are, and the parent's fresh context. */
export interface AppliedSideTask {
  sideTask: TaskData;
  parent: TaskData;
  message: string;
  context: TaskContext;
}

export interface DecisionApproval {
  finding: TaskFinding;
  approvalId: string;
  approvalUrl: string;
}

export interface TaskLinkResult {
  linked: boolean;
  sourceTaskId: string;
  targetTaskId: string;
  kind: TaskLinkKind;
  /** False when the link already existed. */
  created: boolean;
}

export interface CreateTaskInput {
  /** A short name for the objective. */
  title: string;
  /** What the work is ultimately for. Returned at the top of every context. */
  objective: string;
  workspaceId?: string;
  /** The flow its approvals and reviews belong to. */
  flowId?: string;
  /** Your own reference. An open objective you started under it is returned instead of a new one. */
  externalId?: string;
  /** A link to the conversation where the work happens. */
  sessionUrl?: string;
  /** The starting state, if anything is already known. */
  state?: TaskStatePatch;
  /**
   * Govern it from the start (Compliance Mode, Business and Enterprise): the
   * AI system, purpose, owners, risk, data and oversight. Refused on a plan
   * without Compliance Mode.
   */
  governance?: GovernanceProfileInput;
}

/** A governed task's profile, as far as it is known. Every field is optional. */
export interface GovernanceProfileInput {
  aiSystemId?: string | null;
  purpose?: string | null;
  businessOwner?: string | null;
  technicalOwner?: string | null;
  risk?: "low" | "medium" | "high" | "critical";
  dataClassification?: "public" | "internal" | "confidential" | "restricted" | null;
  personalData?: boolean;
  sensitiveData?: boolean;
  customerFacing?: boolean;
  productionUse?: boolean;
  /**
   * Supports a critical or important function (DORA Art. 3(22)). `null` until
   * classified, when production use stands in. An agent may raise it to
   * `true`; only a person lowers or clears it.
   */
  criticalFunction?: boolean | null;
  autonomy?: "assist" | "recommend" | "act_with_approval" | "act_autonomously" | null;
  decisionImpact?: "none" | "informs" | "supports_decision" | "automated_decision" | null;
  oversight?:
    | "none"
    | "post_action_review"
    | "sampled_review"
    | "human_on_the_loop"
    | "human_in_the_loop"
    | "pre_action_approval"
    | "dual_approval"
    | null;
  jurisdictions?: string[];
}

/*
 * Compliance Mode: a governed task's controls, the evidence that satisfies
 * them, and the gate. Evidence can carry what a run measured; a control with
 * thresholds (set by a person) is met only when the newest evidence with
 * results meets them.
 */

/** What a piece of evidence is. */
export type EvidenceType =
  | "assessment"
  | "test_result"
  | "approval"
  | "decision"
  | "policy"
  | "risk_assessment"
  | "security_review"
  | "privacy_review"
  | "data_assessment"
  | "model_evaluation"
  | "human_review"
  | "incident"
  | "mitigation"
  | "external_document"
  | "system_log"
  | "execution_receipt"
  | "red_team";

/** One thing an evaluation, test suite or red-team run measured. */
export interface EvidenceResult {
  /** As the tool names it — `pass_rate`, `attack_success_rate` — so a threshold can name it too. */
  metric: string;
  value: number;
  /** The tool's own verdict on this result, where it gives one. */
  passed?: boolean;
  /** How serious a failure of this result is. */
  severity?: ApprovalRisk;
  /** A grouping the tool gives it: a red-team plugin, a risk category. */
  category?: string;
  dataset?: string;
  /** The trace or row it can be inspected at. https. */
  url?: string;
}

/** The run a set of results came from. */
export interface EvidenceRun {
  tool: string;
  runId?: string;
  name?: string;
  /** The run in the tool, for a reviewer to open. https. */
  url?: string;
  startedAt?: string;
  /** The release the run tested. Evidence naming another release than the AI system now runs does not count. */
  release?: EvidenceRelease;
}

/**
 * The release a run tested: the parts of the AI system's fingerprint it names.
 * A part left out is not compared. Digests, never the text: `sha256:…`, a
 * commit or a tag — what `deliverd governance release` records.
 */
export interface EvidenceRelease {
  provider?: string;
  model?: string;
  modelVersion?: string;
  promptHash?: string;
  guardrailsHash?: string;
}

/** The tools whose own report the server reads. `deliverd` is a results file in `EvidenceResult` shape. */
export type EvidenceReportFormat = "deliverd" | "promptfoo" | "inspect" | "garak" | "weave" | "braintrust" | "junit";

export interface SubmitEvidenceInput {
  type: EvidenceType;
  title: string;
  /** What it shows, for a reviewer. */
  description?: string;
  /** An https link to it. */
  url?: string;
  /** The controls it speaks to; one item may satisfy several. */
  controls?: string[];
  /** The finding in this task it rests on. */
  findingId?: string;
  /** What was measured. */
  results?: EvidenceResult[];
  run?: EvidenceRun;
  /** A tool's own report, as it wrote it, read by the server into results. Instead of `results`. Up to 4 MB. */
  report?: EvidenceReport;
  /**
   * Read the results from the organisation's connected Langfuse, LangSmith,
   * Braintrust or Weave, with its key, which you never hold. Instead of `results` or `report`.
   * Connected by an owner or an administrator in Admin → Integrations.
   */
  pull?: EvidencePull;
  /** The release the results tested, with results, a report or a pull. Results of another release than the system runs now do not count. */
  release?: EvidenceRelease;
}

export interface EvidenceReport {
  format: EvidenceReportFormat;
  content: string;
}

/** Which experiment (in Weave, which evaluation) to read, from which connected tool. */
export interface EvidencePull {
  source: "langfuse" | "langsmith" | "braintrust" | "weave";
  /**
   * The experiment's name: the newest with it is read. In LangSmith and
   * Braintrust, also the name a run suffixed; in Weave, the name the
   * evaluation or its run was given.
   */
  experiment?: string;
  /** Or its id, exactly (in Weave, the run's call id). */
  experimentId?: string;
  /** An ISO time to look from; 90 days back when absent. */
  since?: string;
}

export interface ThresholdRule {
  metric: string;
  comparator: ">=" | ">" | "<=" | "<" | "==";
  value: number;
}

/** What a control's scored evidence must meet. Set by a person; an agent's key is refused. */
export interface ControlThresholds {
  rules: ThresholdRule[];
  /** Fail on any result the tool marked failed at this severity or above. */
  failOnSeverity: ApprovalRisk | null;
}

/** What the newest scored evidence came to, against a control's thresholds. */
export interface ControlScores {
  passed: boolean;
  reason: string;
  evidenceId: string;
}

export interface GovernanceControl {
  key: string;
  title: string;
  family: string;
  /** How it is satisfied: by the profile, by evidence, or by an approval. */
  kind: "profile" | "evidence" | "approval";
  /** The organisation's own control rather than a common one. */
  custom: boolean;
  status: "outstanding" | "satisfied" | "waived";
  required: boolean;
  /** Pieces of evidence that count towards it: since the last material change, and of the release the system runs now. */
  evidence: number;
  /** Evidence that tested another release than the system runs now, and so does not count. */
  otherRelease: number;
  /** What scored evidence must meet: the task's own, or the organisation's default when it has none. */
  thresholds: ControlThresholds | null;
  /** Whose the thresholds are: set on this task, or the organisation's default. Null with none. */
  thresholdsSource: "task" | "organisation" | null;
  thresholdsSetBy: string | null;
  /** The organisation's default for this control, whether or not the task has its own. */
  defaultThresholds: ControlThresholds | null;
  scores: ControlScores | null;
  /** The framework requirements that ask for it. */
  sources: GovernanceControlSource[];
}

export interface GovernanceControlSource {
  framework: string;
  version: string;
  ref: string;
}

export interface GovernanceEvidence {
  id: string;
  type: EvidenceType;
  title: string;
  description: string;
  url: string | null;
  controls: string[];
  results: EvidenceResult[] | null;
  run: EvidenceRun | null;
  /** How the release its run tested differs from the one the system runs now, or null. */
  otherRelease: string | null;
  createdByLabel: string;
  createdAt: string;
}

export interface GovernanceReadiness {
  required: number;
  done: number;
  missing: string[];
  /** Controls satisfied or waived, of those required. Never a legal claim. */
  percent: number;
}

export interface GovernanceBlocker {
  kind: string;
  message: string;
  id?: string;
}

export interface GovernanceGateScore {
  control: string;
  passed: boolean;
  reason: string;
  evidenceId: string | null;
}

/** Whether governed work may proceed. `allowed: false` names what stands in the way. */
export interface GovernanceGateCheck {
  taskId: string;
  allowed: boolean;
  reason: string;
  missingControls: string[];
  blockers: GovernanceBlocker[];
  /** Each required control with thresholds, and why its newest run passed or failed. */
  scores: GovernanceGateScore[];
  readiness: GovernanceReadiness;
}

export interface GovernanceFramework {
  key: string;
  name: string;
  version: string;
  applies: boolean;
  covered: number;
  applicable: number;
}

/** A governed task's governance: its profile, controls, evidence, readiness and gate. */
export interface Governance {
  taskId: string;
  title: string;
  url: string;
  profile: GovernanceProfileInput;
  controls: GovernanceControl[];
  evidence: GovernanceEvidence[];
  readiness: GovernanceReadiness;
  gate: GovernanceGate;
  frameworks: GovernanceFramework[];
  /** That this records governance and certifies nothing. */
  statement: string;
}

export interface GovernanceGate {
  allowed: boolean;
  reason: string;
  missingControls: string[];
  blockers: GovernanceBlocker[];
}

export interface ListTasksInput {
  /** A status, or `active` for anything not completed or cancelled. */
  status?: TaskStatus | "active";
  externalId?: string;
  /** Search the titles and objectives. */
  q?: string;
  /** One page of this size. Leave it unset to get every row. */
  limit?: number;
  /** `nextCursor` from a previous page. Only meaningful with `limit`. */
  cursor?: string;
}

export interface UpdateTaskInput {
  title?: string;
  /** Refused to an agent: only a person changes what the work is for. Propose it as a finding. */
  objective?: string;
  status?: SettableTaskStatus;
  sessionUrl?: string | null;
  state?: TaskStatePatch;
  /** The version you read; the update is refused if somebody wrote in between. */
  expectedVersion?: number;
}

export interface CreateSideTaskInput {
  title: string;
  /** What exactly it has to solve. Narrow is better: it is done when this is answered. */
  goal: string;
  kind?: SideTaskKind;
  /** The context it needs, replacing what Deliverd would select from the parent. */
  relevantContext?: string[];
  /** What it must respect; the parent's constraints when omitted. */
  knownConstraints?: string[];
  /** One of the parent's open questions; it comes off the list when the result is applied. */
  resolvesQuestion?: string;
  /** `suggested` when you proposed the side task and the person agreed. */
  origin?: "manual" | "suggested";
  sessionUrl?: string;
}

export interface AddFindingInput {
  /** A `decision` is recorded as a suggestion until a person confirms it. */
  kind: FindingKind;
  title: string;
  /** The substance, written for a person: what you tested, saw or concluded. */
  body?: string;
  /** Short pieces of evidence: a log line, a value, a measurement. */
  evidence?: string[];
}

export interface CompleteTaskInput {
  /** What was found, in a few sentences. */
  summary: string;
  findings?: TaskResultFinding[];
  /** Decisions you propose. They reach the parent as suggestions. */
  decisions?: TaskResultDecision[];
  recommendations?: string[];
  /** Added to the parent's open questions when applied. */
  unresolvedQuestions?: string[];
  /** What this means for the main task. */
  parentImpact?: string;
  /** Becomes the parent's next action when applied. */
  suggestedNextAction?: string;
}

export interface ApplySideTaskInput {
  /** `applied` (the default) carries the result into the parent; `kept` records it as reference; `discarded` records it was not used. */
  outcome?: TaskOutcome;
}

export interface CancelTaskInput {
  /** Why it was called off, for whoever reads the history. */
  reason?: string;
}

export interface RequestDecisionApprovalInput {
  /** Emails, names or groups; the organisation's administrators when omitted. */
  approvers?: string[];
  note?: string;
  expiresAt?: string;
}

export interface LinkTasksInput {
  targetTaskId: string;
  kind: TaskLinkKind;
}

/* ── Evidence ─────────────────────────────────────────────────────────────── */

export type EvidenceStepKind = "approval" | "review" | "collection" | "report";

export interface EvidenceOutcome {
  who: string;
  /** What they said, in the words the step uses: "approved", "answered". */
  said: string;
  note: string | null;
  at: string;
}

export interface EvidenceStep {
  kind: EvidenceStepKind;
  id: string;
  title: string;
  status: string;
  url: string;
  createdAt: string;
  settledAt: string | null;
  requestedBy: string;
  /** Whether an agent asked for this, which is the point of the record. */
  requestedByAgent: boolean;
  asked: string[];
  outcomes: EvidenceOutcome[];
  /** Whatever else the step records: the description, the questions, the answers. */
  detail: Record<string, unknown>;
}

export interface EvidenceEvent {
  at: string;
  event: string;
  actor: string;
  actorType: string;
  /** Which step it happened to, when it happened to one. */
  step: string | null;
  metadata: Record<string, unknown>;
}

export interface EvidencePack {
  packVersion: number;
  generatedAt: string;
  generatedBy: string;
  organisation: { id: string; name: string };
  subject: {
    kind: "flow" | "report";
    id: string;
    title: string;
    url: string;
    status: string;
    startedBy: string;
    startedAt: string;
  };
  summary: {
    steps: number;
    events: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
  };
  steps: EvidenceStep[];
  timeline: EvidenceEvent[];
  /**
   * What the digest does and does not stand for, in the pack's own words.
   *
   * `covers` says it detects a file altered after export. `doesNotCover` says
   * it makes no claim about the database. Both travel with the pack rather
   * than living only in documentation, because a reader who sees a hash and
   * no sentence will assume the stronger one.
   */
  integrity: {
    algorithm: "sha256";
    digest: string;
    covers: string;
    doesNotCover: string;
    recordsAreInsertOnly: boolean;
  };
}

/**
 * What arrives at a request's `callbackUrl`.
 *
 * `data` is the same object an organisation webhook carries for the event.
 * `approval.question` means the approver asked something and is waiting on
 * your answer (`answerQuestion`); every other event is the request settling.
 */
export interface CallbackEnvelope {
  event:
    | "approval.approved"
    | "approval.rejected"
    | "approval.changes_requested"
    | "approval.expired"
    | "approval.question"
    | "review.approved"
    | "review.changes_requested"
    | "review.expired"
    | "collection.completed"
    | "collection.expired"
    | "gate.approved"
    | "gate.rejected"
    | "gate.changes_requested"
    | "gate.expired"
    | "gate.cancelled"
    | "gate.revoked"
    | "gate.executed";
  sentAt: string;
  requestType: "approval" | "review" | "collection" | "gate";
  requestId: string;
  data: Record<string, unknown>;
}
