import type { Command } from "commander";
import { api } from "../api.js";
import type { CliConfig } from "../config.js";
import { requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { day, emit, plural, run } from "../ui.js";
import { changeLines, checkEditable, parseInput, type FieldChange } from "../input.js";

/**
 * Putting a person in the loop from a shell script.
 *
 * This is the product's own sentence and the CLI could not say it. An agent
 * over MCP could raise an approval and wait; a program using the SDK could
 * `await approval.wait()`; a build step — the place where "do not ship this
 * until a partner says so" is most often wanted — had nothing at all.
 *
 * `--wait` is the whole point of putting it here. Without it a CI job would
 * open a request, exit zero, and carry straight on doing the thing it was
 * supposed to be asking about.
 */

interface Approval {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  url: string;
  title: string;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  questions: { id: string; question: string; answer: string | null }[];
  /** What the request proposed to run with, and which of it an approver may correct. */
  input?: Record<string, unknown> | null;
  editableFields?: string[];
  /** What to run with once approved: `input` with any corrections applied. */
  approvedInput?: Record<string, unknown> | null;
  changes?: FieldChange[];
  /** Only on the response that created the request, and only with --callback. */
  callbackSecret?: string;
  createdAt: string;
}

interface Review {
  id: string;
  status: string;
  url: string;
  title: string;
  verdicts?: { reviewer: string; verdict: string; note: string | null }[];
  createdAt: string;
}

interface Collection {
  id: string;
  status: string;
  url: string;
  title: string;
  responses?: { respondent: string; answers: Record<string, unknown> }[];
  createdAt: string;
}

interface Flow {
  id: string;
  status: string;
  url: string;
  title: string;
  createdAt: string;
}

const POLL_SECONDS = 10;

/**
 * Block until somebody decides, or the deadline passes.
 *
 * Ten seconds between polls: a person reading a request and clicking takes
 * minutes, so anything tighter is load without an answer any sooner. An
 * unanswered question stops the wait rather than letting it time out
 * silently — the request is not stuck, it is waiting on the requester, and
 * that is a different thing to tell somebody.
 */
async function waitForDecision(
  config: CliConfig,
  id: string,
  timeoutSeconds: number,
  quiet: boolean
): Promise<Approval> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let approval = await api<Approval>(config, "GET", `/approvals/${encodeURIComponent(id)}`);
  while (approval.status === "pending") {
    const unanswered = approval.questions.find((q) => !q.answer);
    if (unanswered) {
      throw new Error(
        `An approver asked a question and nothing has answered it: "${unanswered.question}"\n` +
          `Answer it with: deliverd approvals answer ${id} --question ${unanswered.id} --answer "…"`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Nobody decided "${approval.title}" within ${timeoutSeconds}s. It is still open at ${approval.url}`
      );
    }
    if (!quiet) process.stderr.write(".");
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
    approval = await api<Approval>(config, "GET", `/approvals/${encodeURIComponent(id)}`);
  }
  if (!quiet) process.stderr.write("\n");
  return approval;
}

function printApproval(a: Approval): void {
  const mark = a.status === "approved" ? "✓" : a.status === "pending" ? "⏳" : "✗";
  console.log(`${mark} ${a.title} — ${a.status}`);
  if (a.decidedBy) console.log(`  by ${a.decidedBy} on ${day(a.decidedAt)}`);
  if (a.note) console.log(`  “${a.note}”`);
  const changed = changeLines(a.changes);
  if (changed.length > 0) {
    console.log("  Approved with changes:");
    for (const line of changed) console.log(`    ${line}`);
  }
  if (a.status === "approved" && a.approvedInput) {
    // What to run with — the approver's corrections included, never the proposal.
    console.log(`  Run with: ${JSON.stringify(a.approvedInput)}`);
  }
  for (const q of a.questions) {
    console.log(`  ? ${q.question}`);
    console.log(`    ${q.answer ?? "(unanswered — the requester has to reply)"}`);
  }
  console.log(`  ${a.url}`);
}

export function controlCommands(program: Command): void {
  program
    .command("ask")
    .description("Ask named people to approve something before it happens")
    .argument("<title>", "What is being asked, as a headline")
    .option("--why <text>", "Why, what it affects, what it costs — what they read first")
    .option("--approver <who...>", "Emails or user ids; the organisation's admins when omitted")
    .option("--risk <level>", "low | medium | high | critical")
    .option(
      "--input <json>",
      "The arguments you will run with, as a JSON object: inline, @file.json, or @- for stdin"
    )
    .option("--editable <field...>", "Fields of --input the approver may correct before approving")
    .option("--callback <url>", "Where to POST the outcome when someone decides, instead of waiting")
    .option("--report <id>", "A published report the request is about")
    .option("--flow <id>", "The flow this belongs to")
    .option("--ref <id>", "Your own reference, returned unchanged")
    .option("--expires <iso>", "After this the request expires undecided")
    /*
     * Exit codes, because this is the command a shell script branches on:
     * 0 approved, 1 anything else. `set -e` then does the right thing with
     * no `if` around it.
     */
    .option("--wait [seconds]", "Block until it is decided; exit 0 only if approved")
    .option("--quiet", "No progress dots while waiting")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (title: string, options: {
        why?: string;
        approver?: string[];
        risk?: string;
        input?: string;
        editable?: string[];
        callback?: string;
        report?: string;
        flow?: string;
        ref?: string;
        expires?: string;
        wait?: string | boolean;
        quiet?: boolean;
        json?: boolean;
      }) => {
        // Checked before anything is sent, so a typo raises no request.
        const input = options.input === undefined ? undefined : parseInput(options.input);
        checkEditable(options.editable, input);
        const config = requireConfig();
        let approval = await api<Approval>(config, "POST", "/approvals", {
          title,
          description: options.why,
          approvers: options.approver,
          risk: options.risk,
          input,
          editableFields: options.editable,
          callbackUrl: options.callback,
          reportId: options.report,
          flowId: options.flow,
          externalId: options.ref,
          expiresAt: options.expires,
        });
        /*
         * The secret that signs the callback exists on this one response and
         * nowhere else. Printed before any wait, so a script that is killed
         * mid-wait has already seen it; in --json it is in the object.
         */
        const secret = approval.callbackSecret;
        if (secret && !options.json) {
          console.error(`Callback secret (shown once; verify each POST with it): ${secret}`);
        }

        if (!options.wait) {
          emit(options.json, approval, () => {
            console.log(`\n⏳ Asked. ${approval.title}`);
            console.log(`  ${approval.url}`);
            console.log(`\n  Check back with: deliverd approvals get ${approval.id}\n`);
          });
          return;
        }

        const seconds = options.wait === true ? 3600 : Number(options.wait);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error("--wait takes a number of seconds, e.g. --wait 1800");
        }
        if (!options.quiet && !options.json) {
          console.error(`Waiting for a decision on ${approval.url}`);
        }
        approval = await waitForDecision(config, approval.id, seconds, options.quiet || options.json === true);

        // The wait re-reads the request, which no longer carries the secret.
        if (secret) approval = { ...approval, callbackSecret: secret };
        emit(options.json, approval, () => printApproval(approval));
        // Non-zero on anything but approved, so a build step stops without
        // the caller having to parse the status back out.
        if (approval.status !== "approved") process.exit(1);
      })
    );

  const approvals = program
    .command("approvals")
    .description("The approvals you have asked for");

  approvals
    .command("list", { isDefault: true })
    .description("Requests you raised, newest first")
    .option("--status <status>", "pending | approved | rejected | expired | cancelled")
    .option("--ref <id>", "Find by your own reference")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: {
        status?: string;
        ref?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Approval>(config, "/approvals", "approvals", {
          status: options.status,
          externalId: options.ref,
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { approvals: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("Nothing to show.");
            return;
          }
          for (const a of items) {
            printApproval(a);
            console.log("");
          }
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  approvals
    .command("get")
    .description("One request and its decision")
    .argument("<id>", "Approval id")
    .option("--wait [seconds]", "Block until it is decided; exit 0 only if approved")
    .option("--quiet", "No progress dots while waiting")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { wait?: string | boolean; quiet?: boolean; json?: boolean }) => {
        const config = requireConfig();
        let approval: Approval;
        if (options.wait) {
          const seconds = options.wait === true ? 3600 : Number(options.wait);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new Error("--wait takes a number of seconds, e.g. --wait 1800");
          }
          approval = await waitForDecision(config, id, seconds, options.quiet || options.json === true);
        } else {
          approval = await api<Approval>(config, "GET", `/approvals/${encodeURIComponent(id)}`);
        }
        emit(options.json, approval, () => printApproval(approval));
        if (options.wait && approval.status !== "approved") process.exit(1);
      })
    );

  approvals
    .command("answer")
    .description("Answer a question an approver asked about your request")
    .argument("<id>", "Approval id")
    .requiredOption("--question <id>", "Question id, from `deliverd approvals get`")
    .requiredOption("--answer <text>", "What to tell them")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { question: string; answer: string; json?: boolean }) => {
        const config = requireConfig();
        const approval = await api<Approval>(
          config,
          "POST",
          `/approvals/${encodeURIComponent(id)}/answers`,
          { questionId: options.question, answer: options.answer }
        );
        emit(options.json, approval, () => {
          console.log("\n✓ Answered. The approver sees it on the request page.\n");
        });
      })
    );

  approvals
    .command("cancel")
    .description("Withdraw a request you raised, while it is still undecided")
    .argument("<id>", "Approval id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const approval = await api<Approval>(
          config,
          "POST",
          `/approvals/${encodeURIComponent(id)}/cancel`,
          {}
        );
        emit(options.json, approval, () => {
          console.log("\n✓ Withdrawn. The record stays as evidence it was asked.\n");
        });
      })
    );

  const reviews = program
    .command("reviews")
    .description("Asking people to read work and say whether it is right");

  reviews
    .command("ask")
    .description("Ask named people or a team to review something")
    .argument("<title>", "What they are being asked to read")
    .option("--instructions <text>", "What to look at, and what would make it wrong")
    .option("--reviewer <who...>", "Emails, user ids, or a team name")
    .option("--report <id>", "The report being reviewed")
    .option("--flow <id>", "The flow this belongs to")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (title: string, options: {
        instructions?: string;
        reviewer?: string[];
        report?: string;
        flow?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const review = await api<Review>(config, "POST", "/reviews", {
          title,
          instructions: options.instructions,
          reviewers: options.reviewer,
          reportId: options.report,
          flowId: options.flow,
        });
        emit(options.json, review, () => {
          console.log(`\n⏳ Asked for a review. ${review.title}`);
          console.log(`  ${review.url}\n`);
        });
      })
    );

  reviews
    .command("list", { isDefault: true })
    .description("Reviews you asked for")
    .option("--status <status>", "pending | approved | changes_requested")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { status?: string; limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Review>(config, "/reviews", "reviews", {
          status: options.status,
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { reviews: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("Nothing to show.");
            return;
          }
          for (const r of items) {
            console.log(`${r.title} — ${r.status}\n  ${r.url}\n`);
          }
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  reviews
    .command("get")
    .description("A review and each reviewer's verdict")
    .argument("<id>", "Review id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const review = await api<Review>(config, "GET", `/reviews/${encodeURIComponent(id)}`);
        emit(options.json, review, () => {
          console.log(`\n${review.title} — ${review.status}`);
          for (const v of review.verdicts ?? []) {
            console.log(`  ${v.reviewer}: ${v.verdict}${v.note ? ` — “${v.note}”` : ""}`);
          }
          console.log(`  ${review.url}\n`);
        });
      })
    );

  reviews
    .command("cancel")
    .description("Withdraw a review you asked for, while it is still unanswered")
    .argument("<id>", "Review id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const review = await api<Review>(
          config,
          "POST",
          `/reviews/${encodeURIComponent(id)}/cancel`,
          {}
        );
        emit(options.json, review, () => console.log("\n✓ Withdrawn.\n"));
      })
    );

  const collect = program
    .command("collect")
    .description("Asking named people typed questions, and getting answers back");

  collect
    .command("ask")
    .description("Ask people for information you do not have")
    .argument("<title>", "What you are asking for")
    .option("--instructions <text>", "Context for whoever answers")
    .option(
      "--question <text...>",
      'One per question, e.g. --question "Which quarter?" "Budget owner?"'
    )
    .option("--respondent <who...>", "Emails, user ids, or a team name")
    .option("--report <id>", "A report the request is about")
    .option("--flow <id>", "The flow this belongs to")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (title: string, options: {
        instructions?: string;
        question?: string[];
        respondent?: string[];
        report?: string;
        flow?: string;
        json?: boolean;
      }) => {
        if (!options.question || options.question.length === 0) {
          throw new Error('Ask at least one question, e.g. --question "Which quarter?"');
        }
        const config = requireConfig();
        const collection = await api<Collection>(config, "POST", "/collections", {
          title,
          instructions: options.instructions,
          // Short text is the only kind a flag can carry honestly; the
          // richer field types are a form, and a form belongs in the app.
          questions: options.question.map((q) => ({ prompt: q, type: "text" })),
          respondents: options.respondent,
          reportId: options.report,
          flowId: options.flow,
        });
        emit(options.json, collection, () => {
          console.log(`\n⏳ Asked. ${collection.title}`);
          console.log(`  ${collection.url}\n`);
        });
      })
    );

  collect
    .command("list", { isDefault: true })
    .description("Requests for information you made")
    .option("--status <status>", "open | complete | cancelled")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { status?: string; limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Collection>(
          config,
          "/collections",
          "collections",
          {
            status: options.status,
            limit: options.limit ? Number(options.limit) : undefined,
            cursor: options.cursor,
          }
        );
        emit(options.json, { collections: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("Nothing to show.");
            return;
          }
          for (const c of items) console.log(`${c.title} — ${c.status}\n  ${c.url}\n`);
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  collect
    .command("get")
    .description("The answers, with who replied and what they said")
    .argument("<id>", "Collection id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const collection = await api<Collection>(
          config,
          "GET",
          `/collections/${encodeURIComponent(id)}`
        );
        emit(options.json, collection, () => {
          console.log(`\n${collection.title} — ${collection.status}`);
          for (const r of collection.responses ?? []) {
            console.log(`  ${r.respondent}:`);
            for (const [q, a] of Object.entries(r.answers)) {
              console.log(`    ${q}: ${String(a)}`);
            }
          }
          console.log(`  ${collection.url}\n`);
        });
      })
    );

  collect
    .command("cancel")
    .description("Withdraw a request for information, while it is still open")
    .argument("<id>", "Collection id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const collection = await api<Collection>(
          config,
          "POST",
          `/collections/${encodeURIComponent(id)}/cancel`,
          {}
        );
        emit(options.json, collection, () => console.log("\n✓ Withdrawn.\n"));
      })
    );

  const flows = program
    .command("flows")
    .description("The thread tying one job's approvals, reviews and publishes together");

  flows
    .command("start")
    .description("Start a flow, and pass its id to everything that belongs to it")
    .argument("<title>", "What the work is")
    .option("--description <text>", "What it covers")
    .option("--ref <id>", "Your own reference, returned unchanged")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (title: string, options: { description?: string; ref?: string; json?: boolean }) => {
        const config = requireConfig();
        const flow = await api<Flow>(config, "POST", "/flows", {
          title,
          description: options.description,
          externalId: options.ref,
        });
        emit(options.json, flow, () => {
          console.log(`\n✓ ${flow.title}`);
          console.log(`  ${flow.url}`);
          console.log(`\n  Attach work to it with --flow ${flow.id}\n`);
        });
      })
    );

  flows
    .command("list", { isDefault: true })
    .description("Flows in this organisation")
    .option("--status <status>", "open | complete | cancelled")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { status?: string; limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<Flow>(config, "/flows", "flows", {
          status: options.status,
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });
        emit(options.json, { flows: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("No flows.");
            return;
          }
          for (const f of items) console.log(`${f.title} — ${f.status}\n  ${f.url}\n`);
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  flows
    .command("get")
    .description("A flow with everything in it, in the order it happened")
    .argument("<id>", "Flow id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const flow = await api<
          Flow & {
            members?: { kind: string; title: string; status: string }[];
            timeline?: { at: string; what: string }[];
          }
        >(config, "GET", `/flows/${encodeURIComponent(id)}`);
        emit(options.json, flow, () => {
          console.log(`\n${flow.title} — ${flow.status}`);
          for (const m of flow.members ?? []) {
            console.log(`  ${m.kind}: ${m.title} — ${m.status}`);
          }
          if (flow.timeline?.length) {
            console.log(`\n  ${plural(flow.timeline.length, "event")}:`);
            for (const t of flow.timeline) console.log(`    ${day(t.at)} ${t.what}`);
          }
          console.log(`  ${flow.url}\n`);
        });
      })
    );

  flows
    .command("complete")
    .description("Say the work a flow covers is done")
    .argument("<id>", "Flow id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const flow = await api<Flow>(
          config,
          "POST",
          `/flows/${encodeURIComponent(id)}/complete`,
          {}
        );
        emit(options.json, flow, () => {
          console.log("\n✓ Closed as done. It takes no new members now.\n");
        });
      })
    );

  flows
    .command("cancel")
    .description("Close a flow as abandoned rather than done")
    .argument("<id>", "Flow id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const flow = await api<Flow>(config, "POST", `/flows/${encodeURIComponent(id)}/cancel`, {});
        emit(options.json, flow, () => {
          // The distinction is the reason both commands exist: the history
          // should say which of the two happened.
          console.log("\n✓ Closed as abandoned.\n");
        });
      })
    );
}
