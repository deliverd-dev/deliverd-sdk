import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { api, apiText } from "../api.js";
import { requireConfig } from "../config.js";
import { day, emit, plural, run } from "../ui.js";

/**
 * Context from a terminal: the organisation's knowledge and its playbooks.
 *
 * Mostly for taking it somewhere: an AGENTS.md written into a repository, an
 * export kept beside the code, a notes file brought in. Agents read and
 * propose through MCP and the SDKs; confirming an entry and putting a playbook
 * in force are a person's, in the app, and nothing here does either.
 */

interface Entry {
  id: string;
  url: string;
  kind: string;
  kindLabel: string;
  title: string;
  body: string;
  tags: string[];
  status: string;
  confirmedBy: string | null;
  reviewDueOn: string | null;
  reviewOverdue: boolean;
  updatedAt: string;
}

interface Playbook {
  id: string;
  url: string;
  version: number;
  status: string;
  title: string;
  purpose: string;
  inputs: { name: string; description: string; required: boolean }[];
  steps: { key: string; title: string; instruction: string; rule: string; action?: string | null }[];
  inForce?: { id: string; version: number; url: string } | null;
}

interface UsedPrompt {
  prompt: { id: string; title: string; version: number; url: string };
  text: string;
  missingInputs: string[];
  limitations: string | null;
  ranOlderVersion: boolean;
}

interface Started {
  objective: { id: string; url: string; title: string };
  resumed: boolean;
  playbook: { id: string; title: string; version: number };
  steps: { key: string; taskId: string; title: string; rule: string }[];
  ranOlderVersion: boolean;
}

const enc = encodeURIComponent;

/** The query string, without its `?`: the paths below carry that, so the route reads plainly. */
function query(params: Record<string, string | undefined>): string {
  return new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
}

/** A file's contents to stdout, or to a path with a line saying where it went. */
function deliver(text: string, out: string | undefined, what: string): void {
  if (!out) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  writeFileSync(out, text);
  console.error(`✓ ${what} written to ${out}`);
}

export function contextCommands(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("What your agents know: proposed by agents, confirmed by people, exported to anywhere");

  knowledge
    .command("search", { isDefault: true })
    .description("Search the knowledge, ranked by relevance; confirmed entries unless --status says otherwise")
    .argument("[words...]", "What to search for; the newest when omitted")
    .option("--kind <kind>", "fact | convention | decision | procedure | glossary | contact | known_issue")
    .option("--status <status>", "confirmed | proposed | open | rejected | retired | superseded | all")
    .option("--workspace <id>", "What applies in one workspace")
    .option("--limit <n>", "At most this many (100 at most)")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (words: string[], options: { kind?: string; status?: string; workspace?: string; limit?: string; json?: boolean }) => {
        const config = requireConfig();
        const qs = query({ q: words.join(" ") || undefined, kind: options.kind, status: options.status, workspaceId: options.workspace, limit: options.limit });
        const out = await api<{ entries: Entry[]; more: boolean }>(config, "GET", `/knowledge?${qs}`);
        emit(options.json, out, () => {
          if (out.entries.length === 0) {
            console.log("Nothing found.");
            return;
          }
          for (const e of out.entries) {
            const review = e.reviewOverdue ? " · review overdue" : "";
            console.log(`${e.title} — ${e.kindLabel}, ${e.status}${review}\n  ${e.id}${e.confirmedBy ? ` · confirmed by ${e.confirmedBy}` : ""}\n  ${e.url}\n`);
          }
          if (out.more) console.log("More matched; narrow the search or raise --limit.");
        });
      })
    );

  knowledge
    .command("show")
    .description("One entry, in full")
    .argument("<id>")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const e = await api<Entry>(config, "GET", `/knowledge/${enc(id)}`);
        emit(options.json, e, () => {
          console.log(`\n${e.title} — ${e.kindLabel}, ${e.status}`);
          console.log(`\n${e.body}\n`);
          if (e.tags.length) console.log(`  Tags: ${e.tags.join(", ")}`);
          if (e.confirmedBy) console.log(`  Confirmed by ${e.confirmedBy}`);
          if (e.reviewDueOn) console.log(`  Review due ${day(e.reviewDueOn)}`);
          console.log(`  ${e.url}\n`);
        });
      })
    );

  knowledge
    .command("export")
    .description("Everything you may see, as Markdown that imports back (or JSON)")
    .option("--format <format>", "markdown | json", "markdown")
    .option("--status <status>", "confirmed (the default) | open | all")
    .option("--workspace <id>", "What applies in one workspace")
    .option("--out <file>", "Write it to a file instead of standard output")
    .action(
      run(async (options: { format: string; status?: string; workspace?: string; out?: string }) => {
        const config = requireConfig();
        const qs = query({ format: options.format === "json" ? "json" : "markdown", status: options.status, workspaceId: options.workspace });
        const text = await apiText(config, "GET", `/knowledge/export?${qs}`);
        deliver(text, options.out, "Knowledge");
      })
    );

  knowledge
    .command("agents-md")
    .description("An AGENTS.md of the confirmed knowledge and the playbooks in force, for tools that read files")
    .option("--workspace <id>", "What applies in one workspace")
    .option("--out <file>", "Write it to a file, such as AGENTS.md, instead of standard output")
    .action(
      run(async (options: { workspace?: string; out?: string }) => {
        const config = requireConfig();
        const qs = query({ workspaceId: options.workspace });
        deliver(await apiText(config, "GET", `/knowledge/agents-md?${qs}`), options.out, "AGENTS.md");
      })
    );

  knowledge
    .command("import")
    .description("Bring in a Deliverd export or a notes file (AGENTS.md, CLAUDE.md); each heading becomes a proposed entry")
    .argument("<file>", "The Markdown file, or - for standard input")
    .option("--workspace <id>", "Keep the entries inside one workspace")
    .option("--source <text>", "Where the file came from, e.g. the repository and path")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (file: string, options: { workspace?: string; source?: string; json?: boolean }) => {
        const config = requireConfig();
        const markdown = readFileSync(file === "-" ? 0 : file, "utf8");
        const out = await api<{ created: Entry[]; skipped: { title: string; reason: string }[] }>(config, "POST", "/knowledge/import", {
          markdown,
          workspaceId: options.workspace,
          source: options.source ?? (file === "-" ? undefined : file),
        });
        emit(options.json, out, () => {
          console.log(`\n✓ ${plural(out.created.length, "entry", "entries")} proposed. A person confirms each one in Deliverd before agents rely on it.`);
          for (const s of out.skipped) console.log(`  – skipped "${s.title}": ${s.reason}`);
          console.log("");
        });
      })
    );

  knowledge
    .command("given")
    .description("What an objective and its side tasks were given, and who confirmed it")
    .argument("<task-id>")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (taskId: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const out = await api<{ given: { at: string; to: string; via: string; playbook: { title: string; version: number } | null; knowledge: { title: string; confirmedBy: string | null }[] }[] }>(
          config,
          "GET",
          `/tasks/${enc(taskId)}/context-given`
        );
        emit(options.json, out, () => {
          if (out.given.length === 0) {
            console.log("Nothing has been given for this task yet.");
            return;
          }
          for (const g of out.given) {
            console.log(`${day(g.at)} — to ${g.to}${g.playbook ? `, playbook ${g.playbook.title} (version ${g.playbook.version})` : ""}`);
            for (const k of g.knowledge) console.log(`  · ${k.title}${k.confirmedBy ? ` (confirmed by ${k.confirmedBy})` : ""}`);
          }
        });
      })
    );

  const playbooks = program.command("playbooks").description("Jobs written down as steps, each with the rule that applies before it acts");

  playbooks
    .command("list", { isDefault: true })
    .description("Every playbook, with the version in force")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { json?: boolean }) => {
        const config = requireConfig();
        const { playbooks: rows } = await api<{ playbooks: Playbook[] }>(config, "GET", "/playbooks");
        emit(options.json, { playbooks: rows }, () => {
          if (rows.length === 0) {
            console.log("No playbooks yet.");
            return;
          }
          for (const p of rows) {
            const inForce = p.inForce ? `version ${p.inForce.version} in force` : "nothing in force";
            console.log(`${p.title} — ${inForce}\n  ${p.inForce?.id ?? p.id}\n  ${p.inForce?.url ?? p.url}\n`);
          }
        });
      })
    );

  playbooks
    .command("show")
    .description("A playbook's steps and the rule each one needs")
    .argument("<id>")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const p = await api<Playbook>(config, "GET", `/playbooks/${enc(id)}`);
        emit(options.json, p, () => {
          console.log(`\n${p.title} — version ${p.version}, ${p.status.replace(/_/g, " ")}`);
          console.log(`  ${p.purpose}\n`);
          for (const input of p.inputs) console.log(`  Needs ${input.name}${input.required ? "" : " (optional)"}${input.description ? `: ${input.description}` : ""}`);
          p.steps.forEach((s, i) => {
            const rule = s.rule === "none" ? "" : ` [${s.rule}${s.action ? `: ${s.action}` : ""}]`;
            console.log(`  ${i + 1}. ${s.title}${rule}\n     ${s.instruction}`);
          });
          console.log(`\n  ${p.url}\n`);
        });
      })
    );

  playbooks
    .command("start")
    .description("Run the version in force: an objective and a side task per step")
    .argument("<id>")
    .option("--input <name=value...>", "A value the playbook needs, repeatable")
    .option("--title <text>", "A name for this run")
    .option("--ref <id>", "Your own reference; an open run started under it is returned instead")
    .option("--flow <id>", "The project this run's approvals and reviews belong to")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { input?: string[]; title?: string; ref?: string; flow?: string; json?: boolean }) => {
        const config = requireConfig();
        const inputs = Object.fromEntries(
          (options.input ?? []).map((pair) => {
            const at = pair.indexOf("=");
            return at > 0 ? [pair.slice(0, at), pair.slice(at + 1)] : [pair, ""];
          })
        );
        const out = await api<Started>(config, "POST", `/playbooks/${enc(id)}/start`, {
          inputs,
          title: options.title,
          externalId: options.ref,
          flowId: options.flow,
        });
        emit(options.json, out, () => {
          console.log(`\n✓ ${out.resumed ? "Resumed" : "Started"}: ${out.objective.title} (${out.playbook.title}, version ${out.playbook.version})`);
          if (out.ranOlderVersion) console.log("  That was an older version; the one in force ran instead.");
          out.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title.replace(/^\d+\.\s*/, "")}${s.rule === "none" ? "" : ` [${s.rule}]`} · ${s.taskId}`));
          console.log(`  ${out.objective.url}\n`);
        });
      })
    );

  playbooks
    .command("use")
    .description("Print an approved prompt's version in force, filled in, ready to paste. The use is recorded")
    .argument("<id>")
    .option("--input <name=value...>", "A value the prompt needs, repeatable")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: { input?: string[]; json?: boolean }) => {
        const config = requireConfig();
        const inputs = Object.fromEntries(
          (options.input ?? []).map((pair) => {
            const at = pair.indexOf("=");
            return at > 0 ? [pair.slice(0, at), pair.slice(at + 1)] : [pair, ""];
          })
        );
        const out = await api<UsedPrompt>(config, "POST", `/playbooks/${enc(id)}/use`, { inputs });
        emit(options.json, out, () => {
          // The words alone on stdout, so they pipe straight to a clipboard; what is said about them goes to stderr.
          console.error(`${out.prompt.title}, version ${out.prompt.version}${out.ranOlderVersion ? " (the version in force, not the one named)" : ""}`);
          if (out.missingInputs.length) console.error(`Still to fill in: ${out.missingInputs.join(", ")}`);
          console.log(out.text);
          if (out.limitations) console.error(`Limitations: ${out.limitations}`);
        });
      })
    );
}
