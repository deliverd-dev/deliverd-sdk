import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { api, apiText } from "../api.js";
import { requireConfig } from "../config.js";
import { emit, plural, run } from "../ui.js";
import { releaseOf, type ReleaseOptions } from "../release.js";

/**
 * Compliance Mode from a build step: submit what an evaluation or a red-team
 * run measured, and stop the pipeline when the governance gate is closed.
 *
 * The shape of a release gate in CI:
 *
 *   promptfoo eval -o results.json
 *   deliverd governance evidence $TASK --report results.json --format promptfoo --control resilience_testing
 *   deliverd governance check $TASK         # exits 1 unless the gate is open
 *
 * Or, with Langfuse, LangSmith, Braintrust or Weave connected in Admin →
 * Integrations, read the experiment's scores from the tool itself, with a key
 * the pipeline never holds:
 *
 *   deliverd governance evidence $TASK --langfuse credit-memo-v12 --control model_evaluation
 *   deliverd governance evidence $TASK --langsmith credit-memo-v12 --control model_evaluation
 *   deliverd governance evidence $TASK --braintrust credit-memo-v12 --control model_evaluation
 *   deliverd governance evidence $TASK --weave credit-memo-v12 --control model_evaluation
 *
 * Name the release a run tested, and results from another release never meet
 * the gate. The build records the release it is making — the prompt and
 * guardrail files hashed here, never sent — and the evidence names it:
 *
 *   deliverd governance release $SYSTEM --prompt prompts/ --guardrails guardrails.yaml --model-version 2026-10
 *   promptfoo eval -o results.json
 *   deliverd governance evidence $TASK --report results.json --format promptfoo --control model_evaluation --prompt prompts/ --guardrails guardrails.yaml
 *   deliverd governance check $TASK
 *
 * The report is sent as the tool wrote it and turned into results by the
 * server, so every surface — this, MCP, REST — reads a tool's output the same
 * way. Thresholds are a person's to set, on the task's page in the app: no
 * key sets them, a person's own included, because whatever submits the
 * results must not also decide what passes and an agent may be holding that
 * key. So there is no `thresholds` command; 0.10.0 had one, refused to every
 * key, and 0.11.0 removed it.
 */

interface ControlView {
  key: string;
  title: string;
  kind: string;
  status: string;
  required: boolean;
  evidence: number;
  thresholds: { rules: { metric: string; comparator: string; value: number }[]; failOnSeverity: string | null } | null;
  /** The task's own, or the organisation's default (absent from a server before 0111). */
  thresholdsSource?: "task" | "organisation" | null;
  scores: { passed: boolean; reason: string; evidenceId: string } | null;
}

interface GovernanceView {
  taskId: string;
  title: string;
  url: string;
  readiness: { required: number; done: number; percent: number; missing: string[] };
  gate: { allowed: boolean; reason: string; missingControls: string[]; blockers: { kind: string; message: string }[] };
  controls: ControlView[];
  frameworks: { name: string; version: string; applies: boolean; covered: number; applicable: number }[];
}

interface GateCheck {
  allowed: boolean;
  reason: string;
  missingControls: string[];
  blockers: { kind: string; message: string }[];
  scores: { control: string; passed: boolean; reason: string; evidenceId: string | null }[];
  readiness: { required: number; done: number; percent: number };
}

/** The evidence type a report usually is, when `--type` is not given. */
const DEFAULT_TYPE: Record<string, string> = {
  garak: "red_team",
  junit: "test_result",
};

/** The server's limit on a report, checked here so a large file fails with a sentence rather than a 413. */
const MAX_REPORT_BYTES = 4_000_000;

export interface EvidenceOptions extends ReleaseOptions {
  control: string[];
  title?: string;
  type?: string;
  report?: string;
  format: string;
  langfuse?: string;
  langsmith?: string;
  braintrust?: string;
  weave?: string;
  description?: string;
  url?: string;
  runUrl?: string;
  runName?: string;
}

const PULL_TOOL = { langfuse: "Langfuse", langsmith: "LangSmith", braintrust: "Braintrust", weave: "Weave" } as const;
type PullSource = keyof typeof PULL_TOOL;

/** Which connected tool a pull reads, and the experiment: at most one of --langfuse, --langsmith, --braintrust and --weave. */
export function pullOf(options: Partial<Record<PullSource, string>>): { source: PullSource; experiment: string } | null {
  const named = (Object.keys(PULL_TOOL) as PullSource[]).filter((s) => options[s]);
  if (named.length > 1) throw new Error(`Pull from one of --langfuse, --langsmith, --braintrust and --weave, not both ${named.map((s) => `--${s}`).join(" and ")}.`);
  return named[0] ? { source: named[0], experiment: options[named[0]]! } : null;
}

/** What `governance evidence` sends: the report's content, or a pull from a connected tool, never both; and the release the run tested, when named. */
export function evidenceBody(
  options: EvidenceOptions,
  content: string | undefined,
  since: Date | undefined,
  release: Record<string, string> | null = null
): Record<string, unknown> {
  const pull = pullOf(options);
  const run =
    options.runUrl || options.runName
      ? { tool: pull ? pull.source : options.format, ...(options.runUrl ? { url: options.runUrl } : {}), ...(options.runName ? { name: options.runName } : {}) }
      : undefined;
  return {
    type: options.type ?? (pull ? "model_evaluation" : (DEFAULT_TYPE[options.format] ?? "model_evaluation")),
    title: options.title ?? (pull ? `${PULL_TOOL[pull.source]}: ${pull.experiment}` : options.report ? `${options.format} run` : "Evidence"),
    controls: options.control,
    ...(options.description ? { description: options.description } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(content !== undefined ? { report: { format: options.format, content } } : {}),
    ...(pull ? { pull: { ...pull, ...(since ? { since: since.toISOString() } : {}) } } : {}),
    ...(run ? { run } : {}),
    ...(release ? { release } : {}),
  };
}

const describeThresholds = (t: NonNullable<ControlView["thresholds"]>) =>
  [...t.rules.map((r) => `${r.metric} ${r.comparator} ${r.value}`), ...(t.failOnSeverity ? [`no failed result at ${t.failOnSeverity}+`] : [])].join("; ");

function printControls(view: GovernanceView): void {
  for (const c of view.controls.filter((x) => x.required)) {
    const mark = c.status === "satisfied" ? "✓" : c.status === "waived" ? "~" : "✗";
    console.log(`  ${mark} ${c.title} (${c.key}) — ${c.status}`);
    if (c.thresholds) console.log(`      thresholds: ${describeThresholds(c.thresholds)}${c.thresholdsSource === "organisation" ? " (organisation default)" : ""}`);
    if (c.scores) console.log(`      newest run ${c.scores.passed ? "passed" : "failed"}: ${c.scores.reason}`);
  }
}

export function complianceCommands(program: Command): void {
  const governance = program
    .command("governance")
    .description("A governed task's controls, scored evidence and gate — the release gate for CI");

  governance
    .command("show")
    .description("A governed task's controls, their thresholds and what the newest evidence came to")
    .argument("<task>", "Task id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (task: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const view = await api<GovernanceView>(config, "GET", `/tasks/${encodeURIComponent(task)}/governance`);
        emit(options.json, view, () => {
          console.log(`\n${view.title}`);
          console.log(`  ${view.readiness.done} of ${view.readiness.required} required controls complete (${view.readiness.percent}%)`);
          console.log(`  Gate: ${view.gate.allowed ? "open" : `closed — ${view.gate.reason}`}\n`);
          printControls(view);
          for (const f of view.frameworks.filter((x) => x.applies)) {
            console.log(`\n  ${f.name} ${f.version}: ${f.covered} of ${f.applicable} requirements covered`);
          }
          console.log(`\n  ${view.url}\n`);
        });
      })
    );

  governance
    .command("evidence")
    .description("Record evidence for a governed task: a tool's report, a results file, a Langfuse, LangSmith or Braintrust experiment, a Weave evaluation, or a link")
    .argument("<task>", "Task id")
    .requiredOption("--control <key...>", "The controls it speaks to, e.g. resilience_testing model_evaluation")
    .option("--title <text>", "What it is, in a line (default: from the report)")
    .option("--type <type>", "model_evaluation, red_team, test_result, security_review, … (default: by format)")
    .option("--report <file>", "A tool's own report, as it wrote it ('-' reads standard input)")
    .option("--format <format>", "The tool that wrote --report: promptfoo, inspect, garak, weave, braintrust, junit, deliverd, …", "deliverd")
    .option("--langfuse <experiment>", "Pull the newest Langfuse experiment with this name, with the organisation's connected keys (instead of --report)")
    .option("--langsmith <experiment>", "Pull the newest LangSmith experiment with this name or prefix, with the organisation's connected key (instead of --report)")
    .option("--braintrust <experiment>", "Pull the newest Braintrust experiment with this name in the connected project, with the organisation's key (instead of --report)")
    .option("--weave <evaluation>", "Pull the newest finished Weave evaluation with this name, or run name, in the connected W&B project, with the organisation's key (instead of --report)")
    .option("--since <date>", "With --langfuse, --langsmith, --braintrust or --weave: look for it from this date (default: 90 days back)")
    .option("--description <text>", "What it shows, for a reviewer")
    .option("--url <url>", "An https link to it, e.g. the CI run")
    .option("--run-url <url>", "The run in the tool, when the report does not carry it")
    .option("--run-name <name>", "The run's name, when the report does not carry it")
    .option("--prompt <paths...>", "The prompt files the run tested, hashed here and never sent: results of another release then do not count")
    .option("--guardrails <paths...>", "The guardrail configuration the run tested, hashed the same way")
    .option("--provider <name>", "The model provider the run tested")
    .option("--model <name>", "The model the run tested")
    .option("--model-version <version>", "The model version the run tested")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (
          task: string,
          options: ReleaseOptions & {
            control: string[];
            title?: string;
            type?: string;
            report?: string;
            format: string;
            langfuse?: string;
            langsmith?: string;
            braintrust?: string;
            weave?: string;
            since?: string;
            description?: string;
            url?: string;
            runUrl?: string;
            runName?: string;
            json?: boolean;
          }
        ) => {
          const config = requireConfig();
          const pull = pullOf(options);
          if (pull && options.report) throw new Error(`Use --report or --${pull.source}, not both.`);
          if (options.since && !pull) throw new Error("--since goes with --langfuse, --langsmith, --braintrust or --weave.");
          const since = options.since ? new Date(options.since) : undefined;
          if (since && Number.isNaN(since.getTime())) throw new Error(`--since ${options.since} is not a date.`);
          let content: string | undefined;
          if (options.report) {
            if (options.report !== "-" && statSync(options.report).size > MAX_REPORT_BYTES) {
              throw new Error(
                `${options.report} is larger than ${MAX_REPORT_BYTES / 1_000_000} MB. Write a summary report (most tools have one) or send the results as a deliverd results file.`
              );
            }
            content = options.report === "-" ? readFileSync(0, "utf8") : readFileSync(options.report, "utf8");
          }
          const release = releaseOf(options);
          const view = await api<GovernanceView>(
            config,
            "POST",
            `/tasks/${encodeURIComponent(task)}/governance/evidence`,
            evidenceBody(options, content, since, release)
          );
          emit(options.json, view, () => {
            console.log(`\nRecorded for ${plural(options.control.length, "control")} on ${view.title}\n`);
            printControls({ ...view, controls: view.controls.filter((c) => options.control.includes(c.key)) });
            console.log(`\n  Gate: ${view.gate.allowed ? "open" : `closed — ${view.gate.reason}`}\n`);
          });
        }
      )
    );

  governance
    .command("release")
    .description("Record the release an AI system is built from: the prompt and guardrail files hashed here, never sent, and the model. Governed work using it is reassessed")
    .argument("<system>", "AI system id, from the register")
    .option("--prompt <paths...>", "The prompt files or directory")
    .option("--guardrails <paths...>", "The guardrail configuration files or directory")
    .option("--provider <name>", "The model provider")
    .option("--model <name>", "The model")
    .option("--model-version <version>", "The model version")
    .option("--note <text>", "What changed and why, for the record")
    .option("--print", "Print the fingerprint without recording it")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (system: string, options: ReleaseOptions & { note?: string; print?: boolean; json?: boolean }) => {
        const release = releaseOf(options);
        if (!release) throw new Error("Name the release: --prompt, --guardrails, --provider, --model or --model-version.");
        if (options.print) {
          emit(options.json, release, () => {
            for (const [k, v] of Object.entries(release)) console.log(`${k} ${v}`);
          });
          return;
        }
        const config = requireConfig();
        const recorded = await api<{ system: { name: string }; reassessments: { taskId: string }[]; changed?: string[] }>(
          config,
          "POST",
          `/ai-systems/${encodeURIComponent(system)}/model-change`,
          { ...release, ...(options.note ? { note: options.note } : {}) }
        );
        emit(options.json, recorded, () => {
          // `changed` is absent from a server older than this command.
          if (recorded.changed && recorded.changed.length === 0) {
            console.log(`\n${recorded.system.name} already runs this release: nothing changed, nothing reassessed.\n`);
            return;
          }
          console.log(`\nRecorded the release of ${recorded.system.name}`);
          for (const [k, v] of Object.entries(release)) console.log(`  ${k.padEnd(14)} ${v}${recorded.changed?.includes(k) ? "  (changed)" : ""}`);
          const n = recorded.reassessments.length;
          console.log(
            n
              ? `\n  ${plural(n, "governed task")} reassessed: each gate stays closed until a person completes the reassessment and the evidence of this release is in.\n`
              : "\n  Nothing reassessed: a first fingerprint changes nothing, and no governed work may use the system.\n"
          );
        });
      })
    );

  governance
    .command("check")
    .description("Whether governed work may proceed. Exits 1 when the gate is closed, so a pipeline stops")
    .argument("<task>", "Task id")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (task: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const gate = await api<GateCheck>(config, "GET", `/tasks/${encodeURIComponent(task)}/governance/gate`);
        emit(options.json, gate, () => {
          console.log(`\nGate ${gate.allowed ? "open" : "closed"}: ${gate.reason}`);
          for (const s of gate.scores) console.log(`  ${s.passed ? "✓" : "✗"} ${s.control}: ${s.reason}`);
          if (gate.missingControls.length) console.log(`  Outstanding: ${gate.missingControls.join(", ")}`);
          for (const b of gate.blockers) console.log(`  Blocked: ${b.message}`);
          console.log("");
        });
        if (!gate.allowed) process.exit(1);
      })
    );

  governance
    .command("pack")
    .description("The AI governance evidence pack for an auditor: controls, scores, approvals and the timeline")
    .argument("<task>", "Task id")
    .option("--format <format>", "json or html", "json")
    .option("-o, --out <file>", "Write to a file instead of standard output")
    .action(
      run(async (task: string, options: { format: string; out?: string }) => {
        const config = requireConfig();
        const body = await apiText(config, "GET", `/tasks/${encodeURIComponent(task)}/governance/pack?format=${encodeURIComponent(options.format)}`);
        if (options.out) {
          writeFileSync(options.out, body);
          console.log(`Wrote ${options.out}`);
        } else {
          process.stdout.write(body);
        }
      })
    );
}
