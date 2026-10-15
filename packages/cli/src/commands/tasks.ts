import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { day, emit, plural, run } from "../ui.js";

/**
 * Task Graph from a terminal: what the work is for, kept apart from the
 * conversation doing it.
 *
 * Mostly for the person beside the agent rather than the agent itself, which
 * has the MCP tools and the SDKs. Somebody wants to see where an objective
 * stands, read the context an agent will be handed, apply a finished side
 * task's result, or put a suggested decision to an approval — from the same
 * shell the work is happening in, and in a form a script can read.
 */

interface TaskState {
  currentState: string | null;
  openQuestions: string[];
  constraints: string[];
  blockedBy: string[];
  nextAction: string | null;
}

interface Task {
  id: string;
  kind: string;
  status: string;
  url: string;
  title: string;
  objective: string;
  parentTaskId: string | null;
  depth: number;
  state: TaskState;
  outcome: string | null;
  version: number;
  result: { summary: string } | null;
  updatedAt: string;
  resumed?: boolean;
  sideTasks?: { open: number; done: number; awaiting: number };
  path?: { id: string; title: string; kind: string }[];
  children?: TaskNode[];
  findings?: Finding[];
}

interface TaskNode {
  id: string;
  parentTaskId: string | null;
  kind: string;
  depth: number;
  status: string;
  title: string;
  outcome: string | null;
  resultSummary: string | null;
}

interface Finding {
  id: string;
  kind: string;
  title: string;
  body: string;
  decisionStatus: string | null;
}

interface Context {
  rootObjective: string;
  reanchor: string;
}

interface Graph {
  root: Task;
  nodes: TaskNode[];
  links: { sourceTaskId: string; targetTaskId: string; kind: string }[];
}

interface Applied {
  sideTask: Task;
  parent: Task;
  message: string;
  context: Context;
}

interface DecisionApproval {
  finding: Finding;
  approvalId: string;
  approvalUrl: string;
}

interface Linked {
  sourceTaskId: string;
  targetTaskId: string;
  kind: string;
  created: boolean;
}

const enc = encodeURIComponent;

function label(kind: string): string {
  return kind === "objective" ? "Objective" : kind.replace(/_/g, " ");
}

function printTask(t: Task): void {
  console.log(`\n${t.title} — ${t.status} (${label(t.kind)})`);
  console.log(`  ${t.objective}`);
  if (t.state.currentState) console.log(`  Where it stands: ${t.state.currentState}`);
  if (t.state.nextAction) console.log(`  Next: ${t.state.nextAction}`);
  for (const q of t.state.openQuestions) console.log(`  ? ${q}`);
  for (const b of t.state.blockedBy) console.log(`  ⛔ ${b}`);
  if (t.result) console.log(`  Result: ${t.result.summary}`);
  console.log(`  ${t.url}\n`);
}

/** Every value of a repeatable flag, which commander hands over as an array or not at all. */
function many(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function taskCommands(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Objectives, the side tasks branched out of them, and what each found");

  tasks
    .command("start")
    .description("Start an objective: what the work is ultimately for")
    .argument("<title>", "A short name for it")
    .requiredOption("--objective <text>", "What the work is for, in a sentence or two")
    .option("--ref <id>", "Your own reference; an open objective you started under it is returned instead")
    .option("--flow <id>", "The flow its approvals and reviews belong to")
    .option("--workspace <id>", "Keep it inside one workspace")
    .option("--session <url>", "A link to the conversation where the work happens")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          title: string,
          options: { objective: string; ref?: string; flow?: string; workspace?: string; session?: string; json?: boolean }
        ) => {
          const config = requireConfig();
          const task = await api<Task>(config, "POST", "/tasks", {
            title,
            objective: options.objective,
            externalId: options.ref,
            flowId: options.flow,
            workspaceId: options.workspace,
            sessionUrl: options.session,
          });
          emit(options.json, task, () => {
            console.log(`\n✓ ${task.resumed ? "Resumed" : "Started"}: ${task.title}`);
            console.log(`  ${task.url}`);
            console.log(`\n  Branch a side task with: deliverd tasks side-task ${task.id} "<title>" --goal "…"\n`);
          });
        }
      )
    );

  tasks
    .command("list", { isDefault: true })
    .description("Objectives, most recently active first")
    .option("--status <status>", "open | in_progress | blocked | awaiting_approval | completed | cancelled | active")
    .option("--search <text>", "Only objectives whose title or purpose contains this")
    .option("--ref <id>", "Only the objective started under this reference")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (options: {
          status?: string;
          search?: string;
          ref?: string;
          limit?: string;
          cursor?: string;
          json?: boolean;
        }) => {
          const config = requireConfig();
          const { items, nextCursor } = await listing<Task>(config, "/tasks", "tasks", {
            status: options.status,
            q: options.search,
            externalId: options.ref,
            limit: options.limit ? Number(options.limit) : undefined,
            cursor: options.cursor,
          });
          emit(options.json, { tasks: items, nextCursor }, () => {
            if (items.length === 0) {
              console.log("No objectives.");
              return;
            }
            for (const t of items) {
              const counts = t.sideTasks;
              const side = counts
                ? ` · ${plural(counts.open, "side task")} open${counts.awaiting ? `, ${counts.awaiting} waiting to be applied` : ""}`
                : "";
              console.log(`${t.title} — ${t.status}${side}\n  ${t.id} · ${day(t.updatedAt)}\n  ${t.url}\n`);
            }
            if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
          });
        }
      )
    );

  tasks
    .command("get")
    .description("A task with its path, side tasks and findings")
    .argument("<id>", "Task id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const task = await api<Task>(config, "GET", `/tasks/${enc(id)}`);
        emit(options.json, task, () => {
          if (task.path && task.path.length > 1) console.log(`\n${task.path.map((p) => p.title).join(" › ")}`);
          printTask(task);
          for (const c of task.children ?? []) {
            console.log(`  ↳ ${c.title} — ${c.status}${c.outcome ? ` (${c.outcome})` : ""}  ${c.id}`);
            if (c.resultSummary) console.log(`      ${c.resultSummary}`);
          }
          if (task.findings?.length) {
            console.log(`\n  ${plural(task.findings.length, "finding")}:`);
            for (const f of task.findings) {
              const decided = f.decisionStatus ? ` [${f.decisionStatus}]` : "";
              console.log(`    ${f.kind}${decided}: ${f.title}  ${f.id}`);
            }
          }
          console.log("");
        });
      })
    );

  tasks
    .command("context")
    .description("What an agent is handed instead of the history: the objective first, always")
    .argument("<id>", "Task id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const context = await api<Context>(config, "GET", `/tasks/${enc(id)}/context`);
        emit(options.json, context, () => console.log(`\n${context.reanchor}\n`));
      })
    );

  tasks
    .command("graph")
    .description("The whole tree a task belongs to, from its objective down")
    .argument("<id>", "Any task in the tree")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const graph = await api<Graph>(config, "GET", `/tasks/${enc(id)}/graph`);
        emit(options.json, graph, () => {
          console.log("");
          const walk = (parent: string | null, indent: string) => {
            for (const n of graph.nodes.filter((x) => x.parentTaskId === parent)) {
              const outcome = n.outcome ? ` (${n.outcome})` : "";
              console.log(`${indent}${n.title} — ${n.status}${outcome}  ${n.id}`);
              walk(n.id, `${indent}  `);
            }
          };
          walk(null, "");
          for (const l of graph.links) console.log(`  ${l.sourceTaskId} ${l.kind} ${l.targetTaskId}`);
          console.log("");
        });
      })
    );

  tasks
    .command("update")
    .description("Change a task's title, status or working state")
    .argument("<id>", "Task id")
    .option("--title <text>", "A new title")
    .option("--status <status>", "open | in_progress | blocked | awaiting_approval")
    .option("--state <text>", "Where the work stands now; replaces the previous one")
    .option("--next <text>", "The single next step")
    .option("--question <text...>", "Open questions to add")
    .option("--resolve <text...>", "Open questions that are now answered")
    .option("--blocked-by <text...>", "What is in the way; replaces the list")
    .option("--constraint <text...>", "What the work must respect; replaces the list")
    .option("--expected-version <n>", "Refuse the update if the task changed since this version")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          id: string,
          options: {
            title?: string;
            status?: string;
            state?: string;
            next?: string;
            question?: string[];
            resolve?: string[];
            blockedBy?: string[];
            constraint?: string[];
            expectedVersion?: string;
            json?: boolean;
          }
        ) => {
          const config = requireConfig();
          const state = {
            currentState: options.state,
            nextAction: options.next,
            addOpenQuestions: many(options.question),
            resolveOpenQuestions: many(options.resolve),
            blockedBy: many(options.blockedBy),
            constraints: many(options.constraint),
          };
          const changed = Object.values(state).some((v) => v !== undefined);
          const task = await api<Task>(config, "PATCH", `/tasks/${enc(id)}`, {
            title: options.title,
            status: options.status,
            state: changed ? state : undefined,
            expectedVersion: options.expectedVersion ? Number(options.expectedVersion) : undefined,
          });
          emit(options.json, task, () => printTask(task));
        }
      )
    );

  tasks
    .command("side-task")
    .description("Branch a problem out of a task so it does not take over the thread")
    .argument("<parent>", "The task it branches from")
    .argument("<title>", "What the side task is")
    .requiredOption("--goal <text>", "What exactly it has to solve")
    .option("--kind <kind>", "side_task | investigation | research | debug | decision")
    .option("--context <text...>", "The facts it needs, instead of what Deliverd would select")
    .option("--constraint <text...>", "What it must respect, instead of the parent's constraints")
    .option("--resolves <question>", "The parent's open question it is meant to answer")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          parent: string,
          title: string,
          options: { goal: string; kind?: string; context?: string[]; constraint?: string[]; resolves?: string; json?: boolean }
        ) => {
          const config = requireConfig();
          const task = await api<Task>(config, "POST", `/tasks/${enc(parent)}/side-tasks`, {
            title,
            goal: options.goal,
            kind: options.kind,
            relevantContext: many(options.context),
            knownConstraints: many(options.constraint),
            resolvesQuestion: options.resolves,
          });
          emit(options.json, task, () => {
            console.log(`\n✓ ${label(task.kind)}: ${task.title}`);
            console.log(`  ${task.url}`);
            console.log(`\n  When it is answered: deliverd tasks complete ${task.id} --summary "…"\n`);
          });
        }
      )
    );

  tasks
    .command("finding")
    .description("Record what was tested, seen or concluded. A decision is a suggestion until a person confirms it")
    .argument("<id>", "Task id")
    .argument("<title>", "The finding, in a line")
    .requiredOption(
      "--kind <kind>",
      "hypothesis | test | evidence | finding | conclusion | recommendation | decision | risk | question | action"
    )
    .option("--body <text>", "The substance, written for a person")
    .option("--evidence <text...>", "Short pieces of evidence: a log line, a value, a measurement")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (id: string, title: string, options: { kind: string; body?: string; evidence?: string[]; json?: boolean }) => {
          const config = requireConfig();
          const finding = await api<Finding>(config, "POST", `/tasks/${enc(id)}/findings`, {
            kind: options.kind,
            title,
            body: options.body,
            evidence: many(options.evidence),
          });
          emit(options.json, finding, () => {
            console.log(`\n✓ Recorded ${finding.kind}: ${finding.title}  ${finding.id}`);
            if (finding.decisionStatus === "suggested") {
              console.log(`  A suggestion until a person confirms it: deliverd tasks approve-decision ${id} ${finding.id}`);
            }
            console.log("");
          });
        }
      )
    );

  tasks
    .command("approve-decision")
    .description("Put a suggested decision to a person as an approval")
    .argument("<id>", "Task id")
    .argument("<finding>", "The decision's finding id")
    .option("--approver <who...>", "Emails, names or groups; the administrators when omitted")
    .option("--note <text>", "A note for the approver")
    .option("--expires-at <iso>", "When the request lapses")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          id: string,
          finding: string,
          options: { approver?: string[]; note?: string; expiresAt?: string; json?: boolean }
        ) => {
          const config = requireConfig();
          const out = await api<DecisionApproval>(
            config,
            "POST",
            `/tasks/${enc(id)}/findings/${enc(finding)}/approval`,
            { approvers: many(options.approver), note: options.note, expiresAt: options.expiresAt }
          );
          emit(options.json, out, () => {
            console.log(`\n✓ Put to an approval: ${out.finding.title}`);
            console.log(`  ${out.approvalUrl}`);
            console.log(`\n  Wait on it with: deliverd approvals get ${out.approvalId} --wait\n`);
          });
        }
      )
    );

  tasks
    .command("complete")
    .description("Finish a task with a structured result")
    .argument("<id>", "Task id")
    .requiredOption("--summary <text>", "What was found, in a few sentences")
    .option("--finding <text...>", 'Findings, each "Title: what it means"')
    .option("--decision <title...>", "Decisions you propose; they reach the parent as suggestions")
    .option("--recommend <text...>", "Recommendations")
    .option("--unresolved <question...>", "Still open; added to the parent's questions when applied")
    .option("--impact <text>", "What this means for the main task")
    .option("--next <text>", "Becomes the parent's next action when applied")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          id: string,
          options: {
            summary: string;
            finding?: string[];
            decision?: string[];
            recommend?: string[];
            unresolved?: string[];
            impact?: string;
            next?: string;
            json?: boolean;
          }
        ) => {
          const config = requireConfig();
          const findings = many(options.finding)?.map((f) => {
            const at = f.indexOf(": ");
            return at > 0 ? { title: f.slice(0, at), description: f.slice(at + 2) } : { title: f, description: "" };
          });
          const task = await api<Task>(config, "POST", `/tasks/${enc(id)}/complete`, {
            summary: options.summary,
            findings,
            decisions: many(options.decision)?.map((title) => ({ title })),
            recommendations: many(options.recommend),
            unresolvedQuestions: many(options.unresolved),
            parentImpact: options.impact,
            suggestedNextAction: options.next,
          });
          emit(options.json, task, () => {
            console.log(`\n✓ Completed: ${task.title}`);
            if (task.parentTaskId) {
              console.log(`  Carry it into the parent with: deliverd tasks apply ${task.id}`);
            }
            console.log("");
          });
        }
      )
    );

  tasks
    .command("apply")
    .description("Carry a finished side task's result into its parent, or keep or discard it")
    .argument("<id>", "Side task id")
    .option("--outcome <outcome>", "applied (default) | kept | discarded")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { outcome?: string; json?: boolean }) => {
        const config = requireConfig();
        const out = await api<Applied>(config, "POST", `/tasks/${enc(id)}/apply`, { outcome: options.outcome });
        emit(options.json, out, () => {
          console.log(`\n✓ ${out.message}`);
          console.log(`\n${out.context.reanchor}\n`);
        });
      })
    );

  tasks
    .command("reopen")
    .description("Open a completed task again; its result is kept with the earlier ones")
    .argument("<id>", "Task id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const task = await api<Task>(config, "POST", `/tasks/${enc(id)}/reopen`, {});
        emit(options.json, task, () => console.log(`\n✓ Reopened: ${task.title}\n`));
      })
    );

  tasks
    .command("cancel")
    .description("Call a task off. It stays in the tree as a record of what was tried")
    .argument("<id>", "Task id")
    .option("--reason <text>", "Why, for whoever reads the history")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { reason?: string; json?: boolean }) => {
        const config = requireConfig();
        const task = await api<Task>(config, "POST", `/tasks/${enc(id)}/cancel`, { reason: options.reason });
        emit(options.json, task, () => console.log(`\n✓ Cancelled: ${task.title}\n`));
      })
    );

  tasks
    .command("link")
    .description("Relate one task to another")
    .argument("<id>", "The task the link starts from")
    .argument("<target>", "The task it points at")
    .requiredOption("--kind <kind>", "depends_on | blocks | related_to | supersedes | resulted_in")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, target: string, options: { kind: string; json?: boolean }) => {
        const config = requireConfig();
        const out = await api<Linked>(config, "POST", `/tasks/${enc(id)}/links`, {
          targetTaskId: target,
          kind: options.kind,
        });
        emit(options.json, out, () => {
          console.log(`\n✓ ${out.sourceTaskId} ${out.kind} ${out.targetTaskId}${out.created ? "" : " (already linked)"}\n`);
        });
      })
    );
}
