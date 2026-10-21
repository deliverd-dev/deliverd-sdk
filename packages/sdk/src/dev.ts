import type {
  ApprovalData,
  CollectionData,
  EvidencePack,
  FlowData,
  GateData,
  ReviewData,
  TaskData,
  TaskFinding,
  TaskLink,
  TaskNode,
  TaskState,
} from "./types.js";
import { assessCounts, DEFAULT_SCREEN_POLICY, describeCounts, type ScreenCounts } from "./data-screen.js";

/**
 * Development mode: the whole loop, on your machine, with nobody in it.
 *
 * ```ts
 * const deliverd = new Deliverd({ mode: "development" });
 * const decision = await deliverd.approve({ title: "Deploy production" });
 * ```
 *
 * No key, no network, no colleague to interrupt — and the four things that
 * can happen to a real request all reachable before you have an account:
 * approved, rejected, nobody answered, and somebody asked you a question.
 * That last one is the path people forget to write, which is exactly why it
 * should be one line to try.
 *
 * Implemented as a stand-in `fetch` rather than a branch inside the client,
 * so development mode runs the *same* code as production — the same retries,
 * the same error mapping, the same polling in `wait()`. A simulator that
 * bypassed all that would prove your integration works against the simulator.
 */

/**
 * What development mode makes happen.
 *
 * Four for the primitives that ask a person, and a fifth for the gate:
 * `denied` is a **policy** refusal, which nothing else can have — an approval
 * cannot be refused without somebody refusing it. It is the outcome an agent
 * must handle by not retrying, and rehearsing that offline is worth a word of
 * its own. The four that involve a person mean the same thing everywhere;
 * `denied` on an approval is treated as `rejected`, because a request nobody
 * was asked about is not a thing that surface can represent.
 */
export type DevelopmentOutcome = "approved" | "rejected" | "denied" | "timeout" | "question";

export interface DevelopmentOptions {
  /**
   * What the imaginary approver does. Default `approved`, or the value of
   * `DELIVERD_DEV_OUTCOME`, so a whole test suite can be flipped from the
   * command line without touching the code.
   */
  outcome?: DevelopmentOutcome | ((request: ApprovalData) => DevelopmentOutcome);
  /** How long they take to do it, in milliseconds. Default 0. */
  delay?: number;
  /** What they say. Defaults suit the outcome. */
  note?: string;
  /**
   * Corrections the imaginary approver makes when approving a request that
   * sent an `input`, so the approve-with-changes path can be run offline.
   * Only fields you named in `editableFields` are applied, as in production.
   */
  edits?: Record<string, unknown>;
  /** What they ask, when the outcome is `question`. */
  question?: string;
  /** Print what the approver would have seen. Default true. */
  log?: boolean;
}

const DEFAULT_QUESTION = "Has this been through staging?";

let counter = 0;

interface Stored {
  data: ApprovalData;
  /** When the imaginary approver acts. */
  decideAt: number;
  outcome: DevelopmentOutcome;
  options: DevelopmentOptions;
}

/**
 * A `fetch` that serves the approvals, reviews and collections APIs from memory.
 *
 * Deliberately narrow: it answers the calls the primitives make and 501s the
 * rest, with a message saying so, rather than pretending to be the whole API
 * and quietly returning something plausible.
 */
export function developmentFetch(options: DevelopmentOptions = {}): typeof globalThis.fetch {
  const store = new Map<string, Stored>();
  const reviewStore = new Map<string, StoredReview>();
  const gateStore = new Map<string, StoredGate>();
  const collectionStore = new Map<string, StoredCollection>();
  const flowStore = new Map<string, FlowData>();
  const tasks = developmentTasks(options);

  const handle = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && path === "/approvals") {
      const id = `apr_dev_${++counter}`;
      const outcome = resolveOutcome(options.outcome, body);
      const data: ApprovalData = {
        id,
        status: "pending",
        url: `https://deliverd.dev/approve/${id}`,
        title: String(body.title ?? "Untitled"),
        description: (body.description as string | undefined) ?? null,
        risk: (body.risk as ApprovalData["risk"] | undefined) ?? "medium",
        factors: (body.factors as ApprovalData["factors"]) ?? [],
        links: (body.links as ApprovalData["links"]) ?? [],
        reportId: (body.reportId as string | undefined) ?? null,
        externalId: (body.externalId as string | undefined) ?? null,
        metadata: (body.metadata as Record<string, unknown>) ?? {},
        input: (body.input as Record<string, unknown> | undefined) ?? null,
        editableFields: (body.editableFields as string[] | undefined) ?? [],
        approvedInput: null,
        changes: [],
        concerns: [],
        requestedBy: "You (development mode)",
        approvers: (body.approvers as string[] | undefined) ?? [],
        /*
         * One, always. A standing rule could raise it on a real organisation,
         * but development mode has no rules to read and an imaginary approver
         * cannot be two people — pretending otherwise would let a caller test
         * an escalation that never happened.
         */
        requiredApprovals: 1,
        approvalsSoFar: 0,
        decidedBy: null,
        decidedById: null,
        decidedAt: null,
        note: null,
        expiresAt: (body.expiresAt as string | undefined) ?? null,
        questions:
          outcome === "question"
            ? [
                {
                  id: `q_dev_${counter}`,
                  question: options.question ?? DEFAULT_QUESTION,
                  answer: null,
                  askedAt: new Date().toISOString(),
                  answeredAt: null,
                },
              ]
            : [],
        createdAt: new Date().toISOString(),
      };
      store.set(id, {
        data,
        decideAt: Date.now() + (options.delay ?? 0),
        outcome,
        options,
      });
      if (options.log !== false) announce(data, outcome);
      return json(data, 201);
    }

    const match = /^\/approvals\/([^/]+)(\/answers|\/cancel)?$/.exec(path);
    if (match) {
      const stored = store.get(match[1]!);
      if (!stored) {
        return json({ error: { code: "not_found", message: "No such approval in this development session." } }, 404);
      }
      if (match[2] === "/answers") {
        const question = stored.data.questions.find((q) => q.id === body.questionId);
        if (!question) {
          return json({ error: { code: "question_not_found", message: "No such question." } }, 404);
        }
        question.answer = String(body.answer);
        question.answeredAt = new Date().toISOString();
        // Answered: the imaginary approver is satisfied and approves.
        stored.outcome = "approved";
        stored.decideAt = Date.now() + (stored.options.delay ?? 0);
        if (stored.options.log !== false) {
          console.log(`  ↳ answered: ${question.answer}\n`);
        }
        return json(stored.data);
      }
      if (match[2] === "/cancel") {
        stored.data.status = "cancelled";
        return json(stored.data);
      }
      settle(stored);
      return json(stored.data);
    }

    if (method === "POST" && path === "/reviews") {
      const id = `rev_dev_${++counter}`;
      /*
       * The same outcome switch as approvals, mapped onto a review's endings:
       * a rejection is "changes requested", because that is what saying no to
       * a piece of work means. A simulated question has nothing to ask about
       * here — there is no question mechanism on a review — so it approves.
       */
      const outcome = resolveOutcome(options.outcome, body);
      const verdict = outcome === "rejected" ? "changes_requested" : "approved";
      const reviewers = ((body.reviewers as string[] | undefined) ?? []).map((email, i) => ({
        kind: "user" as const,
        id: `usr_dev_${i + 1}`,
        label: email,
      }));
      const data: ReviewData = {
        id,
        status: "pending",
        url: `https://deliverd.dev/reviews/${id}`,
        title: String(body.title ?? "Untitled"),
        instructions: (body.instructions as string | undefined) ?? null,
        reportId: (body.reportId as string | undefined) ?? null,
        versionId: (body.versionId as string | undefined) ?? null,
        externalId: (body.externalId as string | undefined) ?? null,
        metadata: (body.metadata as Record<string, unknown>) ?? {},
        requestedBy: "You (development mode)",
        requiredApprovals: (body.requiredApprovals as number | undefined) ?? 1,
        reviewers,
        verdicts: [],
        /*
         * A review that asks for changes has something to read, and the count
         * is what the caller acts on. Zero made the one path that matters read
         * as "changes requested — 0 threads", which tells somebody running
         * this for the first time that the feature does not work.
         */
        threadCount: verdict === "changes_requested" ? 2 : 0,
        settledAt: null,
        expiresAt: (body.expiresAt as string | undefined) ?? null,
        createdAt: new Date().toISOString(),
      };
      reviewStore.set(id, {
        data,
        settleAt: Date.now() + (options.delay ?? 0),
        verdict,
        timeout: outcome === "timeout",
      });
      if (options.log !== false) announceReview(data, verdict, outcome === "timeout");
      return json(data, 201);
    }

    /*
     * The gate, offline.
     *
     * `DELIVERD_DEV_OUTCOME` means the same thing here as everywhere else, with
     * one addition: `denied` is a *policy* refusal, which has no equivalent on
     * the other primitives because nothing else can be refused without a person
     * being asked. The default stays `approved`, so `gate()` runs green out of
     * the box and the interesting cases are the ones you opt into.
     *
     * `allowed` and `denied` settle instantly, as a real rule does. `approved`
     * and `rejected` go through `pending` first, because that is the path with
     * a `wait()` in it and the one worth being able to rehearse.
     */
    if (method === "POST" && path === "/gates") {
      const id = `gat_dev_${++counter}`;
      const externalId = String(body.externalId ?? "");

      /*
       * Server-side reuse, which the real endpoint enforces in the database.
       * Offline it is a map lookup, and it is here rather than left out
       * because the one thing `gate()` promises over `approve()` is that a
       * retry re-reads its decision — testing that without an account is the
       * whole point of this file.
       */
      for (const stored of gateStore.values()) {
        if (stored.data.externalId === externalId) {
          settleGate(stored);
          return json({ ...stored.data.gate, reused: true });
        }
      }

      const outcome = resolveOutcome(options.outcome, body);
      /*
       * `denied` is settled by a rule and reaches nobody; everything else goes
       * through a person, which is where `wait()` earns its place. The default
       * `approved` therefore rehearses the escalation path rather than the
       * auto-allow — the opposite of production's common case, and the right
       * default here, because the path with a wait in it is the one worth
       * being able to run before you have an account.
       */
      const byRule = outcome === "denied";
      const gate: GateData = {
        id,
        status: byRule ? "denied" : "pending",
        allowed: false,
        input: (body.input as Record<string, unknown>) ?? {},
        changes: [],
        concerns: [],
        basis: byRule ? "policy" : "human",
        reason: byRule
          ? "Development mode refused it. A real rule would say which one and why."
          : "No rule covers this action yet, so it needs a person.",
        rule: byRule ? "Development mode" : null,
        policyVersionId: null,
        approvalId: byRule ? null : `apr_dev_${id}`,
        approvalUrl: byRule ? null : `https://deliverd.dev/approve/apr_dev_${id}`,
        outcome: null,
        settledAt: null,
        reused: false,
        decision: byRule ? "DENY" : "APPROVAL_REQUIRED",
        canExecute: false,
        blockedBecause: byRule ? "Policy does not allow this action." : "Waiting for a person to decide.",
        scope: {
          destination: (body.destination as GateData["scope"]["destination"]) ?? null,
          // Offline there is no directory to consult, so nothing is known to be internal.
          recipientScope: body.destination ? "external" : null,
          classification: (body.classification as GateData["scope"]["classification"]) ?? null,
          risk: (body.risk as GateData["scope"]["risk"]) ?? null,
          artifact: body.artifact
            ? {
                kind: (body.artifact as { versionId?: string }).versionId ? "report_version" : "external",
                reportId: (body.artifact as { reportId?: string }).reportId ?? null,
                versionId: (body.artifact as { versionId?: string }).versionId ?? null,
                versionNumber: null,
                sha256: ((body.artifact as { sha256?: string }).sha256 ?? null)?.toLowerCase() ?? null,
                name: (body.artifact as { name?: string }).name ?? null,
                mimeType: null,
                size: null,
                uri: null,
                verified: false,
              }
            : null,
          digest: null,
        },
        authorisation: { validUntil: null, maxUses: 1, usesRemaining: 1 },
        actionId: String(body.actionId ?? ""),
        agentId: null,
        flowId: (body.flowId as string | undefined) ?? null,
        supersedesGateId: (body.supersedesGateId as string | undefined) ?? null,
        description: ((body.description ?? body.reason) as string | undefined) ?? null,
        requestedBy: "Development agent",
        createdAt: new Date().toISOString(),
      };
      gateStore.set(id, {
        data: { gate, externalId },
        outcome,
        decideAt: Date.now() + (options.delay ?? 0),
      });
      return json(gate, 201);
    }

    /*
     * What was done with a permission, offline: one use, spent by the first
     * claim, and a hash that has to match the one asked about — the two
     * refusals worth rehearsing before there is an account to be refused by.
     */
    const executionMatch = /^\/gates\/([^/]+)\/(execution|cancel)$/.exec(path);
    if (executionMatch && method === "POST") {
      const stored = gateStore.get(executionMatch[1]!);
      if (!stored) {
        return json({ error: { code: "not_found", message: "No such gate in this development session." } }, 404);
      }
      settleGate(stored);
      const gate = stored.data.gate;
      if (executionMatch[2] === "cancel") {
        gate.status = "cancelled";
        gate.canExecute = false;
        gate.blockedBecause = "This request was withdrawn.";
        return json(gate);
      }
      if (!gate.canExecute) {
        const code = gate.status === "used" ? "gate_used" : "not_authorised";
        return json({ error: { code, message: gate.blockedBecause ?? "Not authorised." } }, code === "gate_used" ? 409 : 403);
      }
      const sha = typeof body.artifactSha256 === "string" ? body.artifactSha256.toLowerCase() : null;
      if (gate.scope.artifact?.sha256 && sha !== gate.scope.artifact.sha256) {
        return json(
          { error: { code: sha ? "approval_invalidated" : "artifact_missing", message: "The artifact is not the one that was approved." } },
          sha ? 409 : 400
        );
      }
      gate.status = "used";
      gate.canExecute = false;
      gate.blockedBecause = "This permission has been used. A further action needs a new request.";
      gate.authorisation = { ...gate.authorisation, usesRemaining: 0 };
      const receipt = {
        id: `exe_dev_${++counter}`,
        gateId: gate.id,
        phase: (body.phase as string | undefined) ?? "completed",
        claimId: null,
        executedAt: new Date().toISOString(),
        artifactSha256: sha,
        destination: (body.destination as GateData["scope"]["destination"]) ?? null,
        result: (body.result as Record<string, unknown> | undefined) ?? {},
        verification: gate.scope.artifact?.sha256 ? "hash_matched" : "reported",
        detail: (body.detail as string | undefined) ?? null,
        reportedBy: "Development agent",
        createdAt: new Date().toISOString(),
      };
      return json({ receipt, gate }, 201);
    }

    const gateMatch = /^\/gates\/([^/]+)$/.exec(path);
    if (gateMatch && method === "GET") {
      const stored = gateStore.get(gateMatch[1]!);
      if (!stored) {
        return json(
          { error: { code: "not_found", message: "No such gate in this development session." } },
          404
        );
      }
      settleGate(stored);
      return json(stored.data.gate);
    }

    const reviewMatch = /^\/reviews\/([^/]+)(\/cancel)?$/.exec(path);
    if (reviewMatch) {
      const stored = reviewStore.get(reviewMatch[1]!);
      if (!stored) {
        return json(
          { error: { code: "not_found", message: "No such review in this development session." } },
          404
        );
      }
      if (reviewMatch[2] === "/cancel") {
        stored.data.status = "cancelled";
        return json(stored.data);
      }
      settleReview(stored);
      return json(stored.data);
    }

    /*
     * Listing approvals, which `findByExternalId` needs.
     *
     * Missing until an example used `externalId` for retry safety and got a
     * 501 instead. Reviews, collections and flows all had their list route
     * from the start; approvals — the primitive the feature is most documented
     * on — did not, so the one thing that stops a restarted agent asking twice
     * was the one thing you could not try without an account.
     */
    if (method === "GET" && path === "/approvals") {
      const externalId = url.searchParams.get("externalId");
      const status = url.searchParams.get("status");
      const approver = url.searchParams.get("approver")?.toLowerCase();
      // Settle first: a caller listing before polling should see the same
      // state a poll would have shown it, not a stale `pending`.
      for (const stored of store.values()) settle(stored);
      let all = [...store.values()].map((a) => a.data);
      if (externalId) all = all.filter((a) => a.externalId === externalId);
      if (status) all = all.filter((a) => a.status === status);
      if (approver) all = all.filter((a) => a.approvers.some((who) => who.toLowerCase() === approver));
      return json({ approvals: all });
    }

    if (method === "GET" && path === "/reviews") {
      const externalId = url.searchParams.get("externalId");
      const all = [...reviewStore.values()].map((r) => r.data);
      return json({
        reviews: externalId ? all.filter((r) => r.externalId === externalId) : all,
      });
    }

    if (method === "POST" && path === "/collections") {
      const id = `col_dev_${++counter}`;
      const outcome = resolveOutcome(options.outcome, body);
      const asked = ((body.respondents as string[] | undefined) ?? []).map(String);
      const questions = ((body.questions as Record<string, unknown>[] | undefined) ?? []).map(
        (q, i) => ({
          id: `q_dev_${i + 1}`,
          prompt: String(q.prompt ?? "Question"),
          help: (q.help as string | undefined) ?? null,
          kind: (q.kind as CollectionData["questions"][number]["kind"]) ?? "text",
          required: q.required !== false,
          options: (q.options as string[] | undefined) ?? [],
        })
      );
      const data: CollectionData = {
        id,
        status: "pending",
        url: `https://deliverd.dev/collect/${id}`,
        title: String(body.title ?? "Untitled"),
        instructions: (body.instructions as string | undefined) ?? null,
        reportId: (body.reportId as string | undefined) ?? null,
        externalId: (body.externalId as string | undefined) ?? null,
        metadata: (body.metadata as Record<string, unknown>) ?? {},
        requestedBy: "You (development mode)",
        requiredResponses: (body.requiredResponses as number | undefined) ?? (asked.length || 1),
        questions,
        responses: asked.map((who) => ({
          respondent: who,
          status: "pending" as const,
          submittedAt: null,
          answers: [],
        })),
        submittedCount: 0,
        askedCount: asked.length,
        settledAt: null,
        dueAt: (body.dueAt as string | undefined) ?? null,
        expiresAt: (body.expiresAt as string | undefined) ?? null,
        createdAt: new Date().toISOString(),
      };
      collectionStore.set(id, {
        data,
        settleAt: Date.now() + (options.delay ?? 0),
        /*
         * A simulated rejection becomes an expiry here: there is no way to
         * say no to a question, only to leave it unanswered, and that is the
         * ending a caller most needs to have thought about.
         */
        expire: outcome === "rejected",
        timeout: outcome === "timeout",
      });
      if (options.log !== false) announceCollection(data, outcome);
      return json(data, 201);
    }

    const collectionMatch = /^\/collections\/([^/]+)(\/cancel)?$/.exec(path);
    if (collectionMatch) {
      const stored = collectionStore.get(collectionMatch[1]!);
      if (!stored) {
        return json(
          { error: { code: "not_found", message: "No such request in this development session." } },
          404
        );
      }
      if (collectionMatch[2] === "/cancel") {
        stored.data.status = "cancelled";
        return json(stored.data);
      }
      settleCollection(stored);
      return json(stored.data);
    }

    if (method === "GET" && path === "/collections") {
      const externalId = url.searchParams.get("externalId");
      const all = [...collectionStore.values()].map((c) => c.data);
      return json({
        collections: externalId ? all.filter((c) => c.externalId === externalId) : all,
      });
    }

    /*
     * Flows in development are real objects with no simulation attached:
     * there is nobody to imagine, and the thing worth exercising offline is
     * that `flow.approve()` reaches the same code as `deliverd.approve()`.
     * Members are not tracked here — the server derives them from rows this
     * store does not keep — so a development flow reports what it knows and
     * does not invent a membership.
     */
    if (method === "POST" && path === "/flows") {
      const id = `flw_dev_${++counter}`;
      const data: FlowData = {
        id,
        status: "open",
        url: `https://deliverd.dev/flows/${id}`,
        title: String(body.title ?? "Untitled"),
        description: (body.description as string | undefined) ?? null,
        externalId: (body.externalId as string | undefined) ?? null,
        metadata: (body.metadata as Record<string, unknown>) ?? {},
        startedBy: "You (development mode)",
        members: [],
        memberCount: 0,
        openCount: 0,
        allSettled: false,
        timeline: [],
        settledAt: null,
        createdAt: new Date().toISOString(),
      };
      flowStore.set(id, data);
      if (options.log !== false) {
        console.log(`\n  \u25B8 Flow started: ${data.title}\n    ${data.url}\n`);
      }
      return json(data, 201);
    }

    /*
     * Evidence in development is the shape and not the substance: this store
     * holds no audit rows, so the pack comes back with the subject and an
     * empty record rather than an invented one. What it proves is that
     * `flow.evidence()` reaches the right path and returns something a caller
     * can destructure — an imaginary approval trail would be worse than none.
     */
    const evidenceMatch = /^\/(flows|reports)\/([^/]+)\/evidence$/.exec(path);
    if (evidenceMatch && method === "GET") {
      const kind = evidenceMatch[1] === "flows" ? "flow" : "report";
      const id = evidenceMatch[2]!;
      const title = kind === "flow" ? (flowStore.get(id)?.title ?? "A flow") : "A report";
      const now = new Date().toISOString();
      const pack: EvidencePack = {
        packVersion: 2,
        generatedAt: now,
        generatedBy: "You (development mode)",
        organisation: { id: "org_dev", name: "Development" },
        subject: {
          kind,
          id,
          title,
          url: `https://deliverd.dev/${evidenceMatch[1]}/${id}`,
          status: "open",
          startedBy: "You (development mode)",
          startedAt: now,
        },
        summary: { steps: 0, events: 0, firstEventAt: null, lastEventAt: null },
        steps: [],
        timeline: [],
        integrity: {
          algorithm: "sha256",
          digest: "development",
          covers: "Nothing: this pack was produced in development mode and holds no records.",
          doesNotCover: "Everything. Do not hand this to anybody.",
          recordsAreInsertOnly: true,
        },
      };
      return json(pack);
    }

    const flowMatch = /^\/flows\/([^/]+)(\/complete|\/cancel)?$/.exec(path);
    if (flowMatch) {
      const flow = flowStore.get(flowMatch[1]!);
      if (!flow) {
        return json(
          { error: { code: "not_found", message: "No such flow in this development session." } },
          404
        );
      }
      if (flowMatch[2] === "/complete" || flowMatch[2] === "/cancel") {
        if (flow.status !== "open") {
          return json(
            { error: { code: "not_open", message: `This flow is already ${flow.status}.` } },
            409
          );
        }
        flow.status = flowMatch[2] === "/complete" ? "complete" : "cancelled";
        flow.settledAt = new Date().toISOString();
      }
      return json(flow);
    }

    if (method === "GET" && path === "/flows") {
      const externalId = url.searchParams.get("externalId");
      const all = [...flowStore.values()];
      return json({ flows: externalId ? all.filter((f) => f.externalId === externalId) : all });
    }

    /*
     * Task Graph in development: real objects with no simulation attached,
     * the same reasoning as flows. Nothing here is decided by anybody, so
     * there is nobody to imagine — what is worth running offline is the loop
     * itself: start an objective, branch a side task, complete it, apply it,
     * and read the context the parent comes back with. Putting a decision to
     * an approval is the one call left to the real API, because the approval
     * it raises lives in a store this simulation does not join to.
     */
    if (method === "POST" && path === "/tasks") {
      const { task, resumed } = tasks.create(body);
      return json({ ...task, resumed }, resumed ? 200 : 201);
    }

    if (method === "GET" && path === "/tasks") {
      return json({ tasks: tasks.list(url.searchParams), nextCursor: null });
    }

    /*
     * Screening with no organisation behind it: no register record and no
     * policy, so the defaults decide — internal data and no personal data
     * approved — and an `ask` files an ordinary development approval, which
     * the imaginary approver decides like any other.
     */
    if (method === "POST" && path === "/screen") {
      const counts = (body.counts ?? {}) as ScreenCounts;
      const termClassification = body.termClassification === "restricted" ? "restricted" : "confidential";
      const assessment = assessCounts(counts, null, DEFAULT_SCREEN_POLICY, termClassification);
      let approval: { id: string; url: string; status: string } | null = null;
      if (assessment.verdict === "ask" && body.ask !== false) {
        const created = (await (
          await handle(`${url.origin}/api/v1/approvals`, {
            method: "POST",
            body: JSON.stringify({
              title: `Send ${describeCounts(counts)} to an AI model?`,
              description: assessment.reasons.join("\n"),
              risk: assessment.classification === "restricted" ? "high" : "medium",
              externalId: body.externalId,
            }),
          })
        ).json()) as ApprovalData;
        approval = { id: created.id, url: created.url, status: created.status };
      }
      return json({
        verdict: assessment.verdict,
        allowed: assessment.verdict === "allow" || assessment.verdict === "redact",
        classification: assessment.classification,
        personalData: assessment.personalData,
        categories: assessment.categories,
        counts,
        offending: assessment.offending,
        reasons: assessment.reasons,
        target: null,
        findings: null,
        redactedText: null,
        approval,
      });
    }

    const taskMatch = /^\/tasks\/([^/]+)(?:\/(context|graph|side-tasks|findings|complete|apply|reopen|cancel|links))?$/.exec(path);
    if (taskMatch) {
      const [status, payload] = tasks.act(method, taskMatch[1]!, taskMatch[2] ?? null, body);
      return json(payload, status);
    }

    return json(
      {
        error: {
          code: "not_in_development_mode",
          message: `Development mode simulates approvals, reviews, collections, flows, tasks and screening only, and something called ${method} ${path}. Use a real API key for the rest of the API.`,
        },
      },
      501
    );
  }) as typeof globalThis.fetch;
  return handle;
}

function resolveOutcome(
  outcome: DevelopmentOptions["outcome"],
  body: Record<string, unknown>
): DevelopmentOutcome {
  const fromEnv = process.env.DELIVERD_DEV_OUTCOME as DevelopmentOutcome | undefined;
  const chosen = outcome ?? fromEnv ?? "approved";
  return typeof chosen === "function" ? chosen(body as unknown as ApprovalData) : chosen;
}

/** Move a pending request to its outcome once the imaginary approver has had time. */
function settle(stored: Stored): void {
  if (stored.data.status !== "pending") return;
  if (Date.now() < stored.decideAt) return;
  if (stored.outcome === "timeout") return;
  if (stored.outcome === "question" && stored.data.questions.some((q) => !q.answer)) return;

  stored.data.status = stored.outcome === "rejected" ? "rejected" : "approved";
  /*
   * The same shape production sends: a person's name in `decidedBy` and the
   * key in `decidedById`. It used to be an email-shaped string alone, so the
   * offline loop taught a shape a real organisation never delivers.
   */
  stored.data.decidedBy = "Development approver";
  stored.data.decidedById = "00000000-0000-0000-0000-00000000dev0";
  stored.data.decidedAt = new Date().toISOString();
  stored.data.note =
    stored.options.note ??
    (stored.data.status === "rejected" ? "Not yet — development mode says no." : null);
  if (stored.data.status === "approved" && stored.data.input) {
    const proposed = stored.data.input;
    const edits = Object.entries(stored.options.edits ?? {}).filter(
      ([field, value]) => stored.data.editableFields.includes(field) && !Object.is(proposed[field], value)
    );
    stored.data.approvedInput = { ...proposed, ...Object.fromEntries(edits) };
    stored.data.changes = edits.map(([field, to]) => ({ field, from: proposed[field] ?? null, to }));
  }
}

/**
 * What the approver would have seen, in the terminal.
 *
 * The reason this is worth the lines: the title and the factors are copy
 * somebody has to read on a phone at nine at night, and the only way to know
 * whether it reads well is to see it written out.
 */
function announce(data: ApprovalData, outcome: DevelopmentOutcome): void {
  const lines = [
    "",
    "  ┌─ Deliverd · development mode ─────────────────────────",
    `  │ ${data.title}`,
  ];
  if (data.description) lines.push(`  │ ${data.description}`);
  lines.push(`  │ Risk: ${data.risk}`);
  for (const factor of data.factors) {
    const mark = factor.status === "ok" ? "✓" : factor.status === "warning" ? "⚠" : "·";
    lines.push(`  │ ${mark} ${factor.label}`);
  }
  if (data.approvers.length > 0) lines.push(`  │ To: ${data.approvers.join(", ")}`);
  lines.push(
    "  │",
    `  │ Simulating: ${outcome}${outcome === "question" ? " (needs an onQuestion handler)" : ""}`,
    "  └───────────────────────────────────────────────────────",
    ""
  );
  console.log(lines.join("\n"));
}


interface StoredGate {
  /** The decision, plus the caller's id kept beside it for the reuse lookup. */
  data: { gate: GateData; externalId: string };
  outcome: DevelopmentOutcome;
  decideAt: number;
}

/**
 * A gate that went to a person, once that person has answered.
 *
 * Only the two outcomes that involve one. `allowed` and `denied` were settled
 * by a rule at creation and have nothing to wait for — which is the honest
 * shape, because in production most gated calls never reach a human either.
 */
function settleGate(stored: StoredGate): void {
  const gate = stored.data.gate;
  if (gate.status !== "pending") return;
  if (Date.now() < stored.decideAt) return;
  if (stored.outcome === "timeout" || stored.outcome === "question") return;
  if (stored.outcome === "denied") return;

  const approved = stored.outcome === "approved";
  gate.status = approved ? "approved" : "rejected";
  gate.allowed = approved;
  gate.canExecute = approved;
  gate.blockedBecause = approved ? null : "A person rejected this action.";
  gate.outcome = approved ? "approved" : "rejected";
  gate.settledAt = new Date().toISOString();
  gate.basis = "human";
  gate.reason = approved
    ? "A development approver agreed to it."
    : "A development approver refused it.";
}

interface StoredReview {
  data: ReviewData;
  settleAt: number;
  verdict: "approved" | "changes_requested";
  timeout: boolean;
}

/** Settle it once its moment has passed, unless it is meant to hang. */
function settleReview(stored: StoredReview): void {
  if (stored.timeout || stored.data.status !== "pending") return;
  if (Date.now() < stored.settleAt) return;
  stored.data.verdicts = [
    {
      verdict: stored.verdict,
      by: stored.data.reviewers[0]?.label ?? "A reviewer (development mode)",
      note:
        stored.verdict === "changes_requested"
          ? "Simulated: the figures on page two do not tie back."
          : null,
      at: new Date().toISOString(),
    },
  ];
  stored.data.status = stored.verdict;
  stored.data.settledAt = new Date().toISOString();
}

function announceReview(
  data: ReviewData,
  verdict: "approved" | "changes_requested",
  willHang: boolean
): void {
  const lines = [
    `  ┌─ Deliverd · development mode ─────────────────────────`,
    `  │ ${data.title}`,
    ...(data.instructions ? [`  │ Check: ${data.instructions}`] : []),
    `  │ Reviewers: ${data.reviewers.map((r) => r.label).join(", ") || "nobody named"}`,
    `  │`,
    `  │ Simulating: ${willHang ? "nobody reviews it" : verdict.replace("_", " ")}`,
    `  └───────────────────────────────────────────────────────`,
    "",
  ];
  console.log(lines.join("\n"));
}


interface StoredCollection {
  data: CollectionData;
  settleAt: number;
  expire: boolean;
  timeout: boolean;
}

/**
 * Everyone answers, at the same moment, with a plausible value for the kind
 * of question asked. Plausible rather than empty, because a caller writing
 * `answers["Headcount at 30 September"] + 1` should find out here that it is
 * a number, not in production.
 */
function settleCollection(stored: StoredCollection): void {
  if (stored.timeout || stored.data.status !== "pending") return;
  if (Date.now() < stored.settleAt) return;
  if (stored.expire) {
    stored.data.status = "expired";
    stored.data.settledAt = new Date().toISOString();
    return;
  }
  const at = new Date().toISOString();
  stored.data.responses = stored.data.responses.map((r) => ({
    ...r,
    status: "submitted" as const,
    submittedAt: at,
    answers: stored.data.questions.map((q) => ({
      question: q.prompt,
      kind: q.kind,
      value: sampleAnswer(q),
    })),
  }));
  stored.data.submittedCount = stored.data.responses.length;
  stored.data.status = "complete";
  stored.data.settledAt = at;
}

function sampleAnswer(q: CollectionData["questions"][number]): string | number | boolean | string[] {
  switch (q.kind) {
    case "number":
      return 42;
    case "boolean":
      return true;
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "choice":
      return q.options[0] ?? "";
    case "multi_choice":
      return q.options.slice(0, 1);
    case "long_text":
      return "Simulated: a longer answer than a line.";
    default:
      return "Simulated answer";
  }
}

function announceCollection(data: CollectionData, outcome: string): void {
  const lines = [
    `  ┌─ Deliverd · development mode ─────────────────────────`,
    `  │ ${data.title}`,
    `  │ Asking: ${data.questions.map((q) => q.prompt).join(" · ") || "nothing"}`,
    `  │ Of: ${data.responses.map((r) => r.respondent).join(", ") || "nobody named"}`,
    `  │`,
    `  │ Simulating: ${
      outcome === "timeout"
        ? "nobody answers"
        : outcome === "rejected"
          ? "it expires unanswered"
          : "everyone answers"
    }`,
    `  └───────────────────────────────────────────────────────`,
    "",
  ];
  console.log(lines.join("\n"));
}

/* ── Tasks ────────────────────────────────────────────────────────────────── */

type TaskReply = [status: number, payload: unknown];

const notFound = (what: string): TaskReply => [
  404,
  { error: { code: "not_found", message: `No such ${what} in this development session.` } },
];
const refused = (code: string, message: string, status = 409): TaskReply => [
  status,
  { error: { code, message } },
];

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function mergeState(current: TaskState, patch: Record<string, unknown> | undefined): TaskState {
  if (!patch) return current;
  const next: TaskState = { ...current };
  if ("currentState" in patch) next.currentState = (patch.currentState as string | null) ?? null;
  if ("nextAction" in patch) next.nextAction = (patch.nextAction as string | null) ?? null;
  if (patch.openQuestions) next.openQuestions = strings(patch.openQuestions);
  if (patch.constraints) next.constraints = strings(patch.constraints);
  if (patch.blockedBy) next.blockedBy = strings(patch.blockedBy);
  for (const q of strings(patch.addOpenQuestions)) {
    if (!next.openQuestions.includes(q)) next.openQuestions = [...next.openQuestions, q];
  }
  const gone = new Set(strings(patch.resolveOpenQuestions).map((q) => q.toLowerCase()));
  if (gone.size) next.openQuestions = next.openQuestions.filter((q) => !gone.has(q.toLowerCase()));
  return next;
}

/**
 * The Task Graph, in memory: enough of the server's rules that the loop an
 * agent actually runs — objective, side task, result, apply, context — does
 * offline what it does live. Not the whole service: no workspaces, no
 * permissions, no audit, and a context assembled from what this store holds.
 */
function developmentTasks(options: DevelopmentOptions) {
  const store = new Map<string, TaskData>();
  const findings = new Map<string, TaskFinding[]>();
  const links: TaskLink[] = [];

  const active = (t: TaskData) => t.status !== "completed" && t.status !== "cancelled";
  const childrenOf = (id: string) => [...store.values()].filter((t) => t.parentTaskId === id);
  const node = (t: TaskData): TaskNode => ({
    id: t.id,
    parentTaskId: t.parentTaskId,
    kind: t.kind,
    depth: t.depth,
    status: t.status,
    title: t.title,
    outcome: t.outcome,
    resultSummary: t.result?.summary ?? null,
    url: t.url,
  });
  const pathTo = (t: TaskData) => {
    const path = [];
    for (let at: TaskData | undefined = t; at; at = at.parentTaskId ? store.get(at.parentTaskId) : undefined) {
      path.unshift({ id: at.id, title: at.title, kind: at.kind });
    }
    return path;
  };
  const bump = (t: TaskData) => {
    t.version += 1;
    t.updatedAt = new Date().toISOString();
  };
  const listed = (t: TaskData): TaskData => {
    const { sideTasks: _counts, path: _path, children: _children, findings: _findings, links: _links, resumed: _resumed, ...rest } = t;
    return rest;
  };

  function make(body: Record<string, unknown>, parent: TaskData | null): TaskData {
    const id = `tsk_dev_${++counter}`;
    const now = new Date().toISOString();
    const parentDecisions = parent
      ? (findings.get(parent.id) ?? []).filter((f) => f.kind === "decision" && f.decisionStatus !== "rejected")
      : [];
    return {
      id,
      kind: parent ? ((body.kind as TaskData["kind"] | undefined) ?? "side_task") : "objective",
      status: "open",
      url: `https://deliverd.dev/tasks/${id}`,
      title: String(body.title ?? "Untitled"),
      objective: String((parent ? body.goal : body.objective) ?? ""),
      rootTaskId: parent ? parent.rootTaskId : id,
      parentTaskId: parent ? parent.id : null,
      depth: parent ? parent.depth + 1 : 0,
      workspaceId: parent ? parent.workspaceId : ((body.workspaceId as string | undefined) ?? null),
      flowId: parent ? parent.flowId : ((body.flowId as string | undefined) ?? null),
      state: mergeState(
        { currentState: null, openQuestions: [], constraints: [], blockedBy: [], nextAction: null },
        body.state as Record<string, unknown> | undefined
      ),
      snapshot: parent
        ? {
            rootObjective: store.get(parent.rootTaskId)?.objective ?? parent.objective,
            parentObjective: parent.objective,
            sideTaskGoal: String(body.goal ?? ""),
            relevantContext: body.relevantContext
              ? strings(body.relevantContext)
              : parent.state.currentState
                ? [parent.state.currentState]
                : [],
            knownConstraints: body.knownConstraints ? strings(body.knownConstraints) : parent.state.constraints,
            relatedDecisions: parentDecisions.map((d) =>
              d.decisionStatus === "confirmed" ? d.title : `${d.title} (suggested)`
            ),
            resolvesQuestion: (body.resolvesQuestion as string | undefined) ?? null,
          }
        : null,
      result: null,
      previousResults: [],
      outcome: null,
      origin: (body.origin as TaskData["origin"] | undefined) ?? "manual",
      externalId: parent ? null : ((body.externalId as string | undefined) ?? null),
      sessionUrl: (body.sessionUrl as string | undefined) ?? null,
      version: 1,
      startedBy: "You (development mode)",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  function context(t: TaskData) {
    const root = store.get(t.rootTaskId) ?? t;
    const isSideTask = t.kind !== "objective";
    const own = findings.get(t.id) ?? [];
    const decisions = [...(t.id === root.id ? [] : (findings.get(root.id) ?? [])), ...own].filter(
      (f) => f.kind === "decision"
    );
    const children = childrenOf(t.id);
    const finished = children.filter((c) => c.status === "completed");
    const awaiting = finished.filter((c) => c.outcome === null);
    const next = t.state.nextAction ?? (isSideTask ? null : root.state.nextAction);
    return {
      rootObjective: root.objective,
      task: { id: t.id, kind: t.kind, title: t.title, objective: t.objective, status: t.status, isSideTask },
      path: pathTo(t),
      currentState: t.state.currentState,
      nextAction: next,
      openQuestions: t.state.openQuestions,
      constraints: t.state.constraints.length ? t.state.constraints : (t.snapshot?.knownConstraints ?? []),
      blockedBy: t.state.blockedBy,
      decisions: {
        confirmed: decisions.filter((d) => d.decisionStatus === "confirmed").map((d) => d.title),
        suggested: decisions.filter((d) => d.decisionStatus === "suggested").map((d) => d.title),
      },
      snapshot: t.snapshot,
      relevantFindings: own
        .filter((f) => f.kind !== "decision")
        .slice(0, 12)
        .map((f) => ({ kind: f.kind, title: f.title, body: f.body })),
      sideTasks: {
        active: children.filter(active).map((c) => ({ id: c.id, title: c.title, kind: c.kind, status: c.status })),
        awaitingOutcome: awaiting.map((c) => ({ id: c.id, title: c.title, summary: c.result?.summary ?? null })),
        completed: finished
          .filter((c) => c.outcome !== null)
          .map((c) => ({ id: c.id, title: c.title, summary: c.result?.summary ?? null, outcome: c.outcome })),
      },
      // Development mode publishes nothing, so no task has a report to name.
      reports: [],
      reanchor: [
        `Objective: ${root.objective}`,
        isSideTask ? `You are in a side task: ${t.title}. Its goal: ${t.objective}` : null,
        t.state.currentState ? `Where it stands: ${t.state.currentState}` : null,
        next ? `Next: ${next}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  function addFinding(t: TaskData, body: Record<string, unknown>, sourceTaskId: string | null = null): TaskFinding {
    const kind = (body.kind as TaskFinding["kind"] | undefined) ?? "finding";
    const finding: TaskFinding = {
      id: `fnd_dev_${++counter}`,
      taskId: t.id,
      kind,
      title: String(body.title ?? "Untitled"),
      body: String(body.body ?? ""),
      evidence: strings(body.evidence),
      decisionStatus: kind === "decision" ? "suggested" : null,
      decidedBy: null,
      decidedAt: null,
      approvalId: null,
      approvalStatus: null,
      sourceTaskId,
      createdBy: "You (development mode)",
      createdAt: new Date().toISOString(),
    };
    findings.set(t.id, [finding, ...(findings.get(t.id) ?? [])]);
    return finding;
  }

  return {
    create(body: Record<string, unknown>): { task: TaskData; resumed: boolean } {
      const externalId = body.externalId as string | undefined;
      if (externalId) {
        const existing = [...store.values()].find(
          (t) => t.kind === "objective" && t.externalId === externalId && active(t)
        );
        if (existing) return { task: listed(existing), resumed: true };
      }
      const task = make(body, null);
      store.set(task.id, task);
      if (options.log !== false) console.log(`\n  ▸ Objective: ${task.title}\n    ${task.url}\n`);
      return { task: listed(task), resumed: false };
    },

    list(query: URLSearchParams): TaskData[] {
      const status = query.get("status");
      const externalId = query.get("externalId");
      const q = query.get("q")?.toLowerCase();
      return [...store.values()]
        .filter((t) => t.kind === "objective")
        .filter((t) => !status || (status === "active" ? active(t) : t.status === status))
        .filter((t) => !externalId || t.externalId === externalId)
        .filter((t) => !q || `${t.title} ${t.objective}`.toLowerCase().includes(q))
        .map((t) => {
          const below = [...store.values()].filter((s) => s.rootTaskId === t.id && s.id !== t.id);
          return {
            ...listed(t),
            sideTasks: {
              open: below.filter(active).length,
              done: below.filter((s) => s.status === "completed" && s.outcome !== null).length,
              awaiting: below.filter((s) => s.status === "completed" && s.outcome === null).length,
            },
          };
        });
    },

    act(method: string, id: string, action: string | null, body: Record<string, unknown>): TaskReply {
      const t = store.get(id);
      if (!t) return notFound("task");

      if (method === "GET" && action === null) {
        return [
          200,
          {
            ...listed(t),
            path: pathTo(t),
            children: childrenOf(t.id).map(node),
            findings: findings.get(t.id) ?? [],
            links: links.filter((l) => l.sourceTaskId === t.id || l.targetTaskId === t.id),
          },
        ];
      }
      if (method === "GET" && action === "context") return [200, context(t)];
      if (method === "GET" && action === "graph") {
        const root = store.get(t.rootTaskId) ?? t;
        const tree = [...store.values()].filter((n) => n.rootTaskId === root.id);
        const ids = new Set(tree.map((n) => n.id));
        return [
          200,
          {
            root: listed(root),
            nodes: tree.map(node),
            links: links.filter((l) => ids.has(l.sourceTaskId) || ids.has(l.targetTaskId)),
          },
        ];
      }

      if (method === "PATCH" && action === null) {
        if (typeof body.expectedVersion === "number" && body.expectedVersion !== t.version) {
          return refused("version_conflict", "The task changed since you read it. Read it again and retry.");
        }
        if (typeof body.title === "string") t.title = body.title;
        if (typeof body.objective === "string") t.objective = body.objective;
        if (typeof body.status === "string") t.status = body.status as TaskData["status"];
        if ("sessionUrl" in body) t.sessionUrl = (body.sessionUrl as string | null) ?? null;
        t.state = mergeState(t.state, body.state as Record<string, unknown> | undefined);
        bump(t);
        return [200, listed(t)];
      }

      if (method !== "POST") return refused("not_in_development_mode", `${method} ${action ?? ""} is not simulated.`, 501);

      switch (action) {
        case "side-tasks": {
          if (!active(t)) return refused("not_open", "The task this belongs to is finished. Reopen it first.");
          if (t.depth >= 3) {
            return refused("invalid", "Side tasks nest at most three deep. Branch from a task higher up instead.", 400);
          }
          const side = make(body, t);
          store.set(side.id, side);
          if (options.log !== false) console.log(`\n  ↳ Side task: ${side.title}\n    ${side.url}\n`);
          return [201, listed(side)];
        }
        case "findings":
          return [201, addFinding(t, body)];
        case "complete": {
          if (!active(t)) return refused("not_open", "This task is already complete or cancelled.");
          t.result = {
            summary: String(body.summary ?? ""),
            findings: (body.findings as NonNullable<TaskData["result"]>["findings"] | undefined) ?? [],
            decisions: (body.decisions as NonNullable<TaskData["result"]>["decisions"] | undefined) ?? [],
            recommendations: strings(body.recommendations),
            unresolvedQuestions: strings(body.unresolvedQuestions),
            parentImpact: (body.parentImpact as string | undefined) ?? null,
            suggestedNextAction: (body.suggestedNextAction as string | undefined) ?? null,
          };
          for (const f of t.result.findings) addFinding(t, { kind: "finding", title: f.title, body: f.description, evidence: f.evidence });
          for (const d of t.result.decisions) addFinding(t, { kind: "decision", title: d.title, body: d.rationale });
          t.status = "completed";
          t.completedAt = new Date().toISOString();
          bump(t);
          return [200, listed(t)];
        }
        case "apply": {
          const parent = t.parentTaskId ? store.get(t.parentTaskId) : undefined;
          if (!parent) return refused("invalid", "An objective has no parent to apply to.", 400);
          if (t.status !== "completed" || !t.result) {
            return refused("not_completed", "This side task has not been completed yet, so there is no result to use.");
          }
          if (t.outcome !== null) {
            return refused("already_applied", "This result has already been applied to the main task. Reopen the side task to change it.");
          }
          const outcome = (body.outcome as TaskData["outcome"] | undefined) ?? "applied";
          t.outcome = outcome;
          bump(t);
          if (outcome === "applied") {
            for (const f of findings.get(t.id) ?? []) {
              addFinding(parent, { kind: f.kind, title: f.title, body: f.body, evidence: f.evidence }, t.id);
            }
            const resolves = t.snapshot?.resolvesQuestion;
            parent.state = mergeState(parent.state, {
              addOpenQuestions: t.result.unresolvedQuestions,
              ...(resolves ? { resolveOpenQuestions: [resolves] } : {}),
              ...(t.result.suggestedNextAction ? { nextAction: t.result.suggestedNextAction } : {}),
            });
            bump(parent);
          }
          const message =
            outcome === "applied"
              ? `The result of "${t.title}" is now part of "${parent.title}".`
              : outcome === "kept"
                ? `"${t.title}" is kept for reference; nothing in "${parent.title}" changed.`
                : `"${t.title}" was discarded; nothing in "${parent.title}" changed.`;
          return [200, { sideTask: listed(t), parent: listed(parent), message, context: context(parent) }];
        }
        case "reopen": {
          if (t.status !== "completed" && t.status !== "cancelled") {
            return refused("not_open", "Only a completed or cancelled task can be reopened.");
          }
          if (t.result) t.previousResults = [t.result, ...t.previousResults];
          t.result = null;
          t.outcome = null;
          t.status = "open";
          t.completedAt = null;
          bump(t);
          return [200, listed(t)];
        }
        case "cancel": {
          if (!active(t)) return refused("not_open", "This task is already complete or cancelled.");
          t.status = "cancelled";
          t.completedAt = new Date().toISOString();
          bump(t);
          return [200, listed(t)];
        }
        case "links": {
          const targetTaskId = String(body.targetTaskId ?? "");
          if (targetTaskId === t.id) return refused("invalid", "A task cannot be linked to itself.", 400);
          if (!store.has(targetTaskId)) return notFound("task");
          const kind = body.kind as TaskLink["kind"];
          const exists = links.some((l) => l.sourceTaskId === t.id && l.targetTaskId === targetTaskId && l.kind === kind);
          if (!exists) links.push({ sourceTaskId: t.id, targetTaskId, kind });
          return [201, { linked: true, sourceTaskId: t.id, targetTaskId, kind, created: !exists }];
        }
        default:
          return refused("not_in_development_mode", `POST /tasks/${id}/${action ?? ""} is not simulated.`, 501);
      }
    },
  };
}
