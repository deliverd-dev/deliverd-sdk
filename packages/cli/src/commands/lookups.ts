import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { day, emit, plural, run } from "../ui.js";

/**
 * The things you look up before doing something else: which workspaces
 * exist, which reports are offered as starting points, what is due, and
 * whether the name you are about to share with means one thing or two.
 */
interface Schedule {
  id: string;
  reportTitle: string;
  reportSlug: string;
  agentName: string;
  recurrence: string;
  enabled: boolean;
  nextRunAt: string | null;
  due: boolean;
}

export function lookupCommands(program: Command): void {
  const schedules = program
    .command("schedules")
    .description("Recurring publishes an agent is asked for");

  schedules
    .command("list", { isDefault: true })
    .description("Every schedule, and which are due")
    .option("--due", "Only the ones waiting on a publish")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { due?: boolean; json?: boolean }) => {
        const config = requireConfig();
        const { schedules: rows } = await api<{ schedules: Schedule[] }>(
          config,
          "GET",
          options.due ? "/schedules?due=1" : "/schedules"
        );
        emit(options.json, { schedules: rows }, () => {
          if (rows.length === 0) {
            console.log(options.due ? "Nothing is due." : "No schedules.");
            return;
          }
          for (const s of rows) {
            console.log(
              `${s.due ? "▶" : s.enabled ? "·" : "○"} ${s.reportTitle} (${s.recurrence})`
            );
            console.log(
              `  ${s.id}\n  ${s.agentName} · next ${day(s.nextRunAt)}${s.enabled ? "" : " · off"}\n`
            );
          }
        });
      })
    );

  schedules
    .command("create")
    .description("Ask an agent for a recurring publish")
    .argument("<report>", "Report id or slug to keep current")
    .requiredOption("--agent <id>", "The agent expected to publish it")
    .requiredOption(
      "--every <cron>",
      'Five-field cron expression in UTC, e.g. --every "0 9 * * 5" for Fridays at nine'
    )
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { agent: string; every: string; json?: boolean }) => {
        const config = requireConfig();
        /*
         * The report is named the way every other command names one — id or
         * slug — and the API wants an id, so it is resolved here rather than
         * asking a person at a terminal to find a uuid first.
         */
        const { report: resolved } = await api<{ report: { id: string } }>(
          config,
          "GET",
          `/reports/${encodeURIComponent(report)}`
        );
        const schedule = await api<Schedule>(config, "POST", "/schedules", {
          reportId: resolved.id,
          agentId: options.agent,
          recurrence: options.every,
        });
        emit(options.json, schedule, () => {
          console.log(`\n✓ ${schedule.reportTitle} — ${schedule.recurrence}`);
          console.log(`  ${schedule.agentName} is asked next on ${day(schedule.nextRunAt)}`);
          // Said out loud because it is the thing people assume: a schedule
          // is when the agent is asked, not a publish that happens by itself.
          console.log(`\n  Nothing publishes on its own — the agent polls and does the work.\n`);
        });
      })
    );

  schedules
    .command("update")
    .description("Change a schedule's cadence, or turn it on or off")
    .argument("<id>", "Schedule id, from `deliverd schedules`")
    .option("--every <cron>", "New five-field cron expression in UTC")
    .option("--off", "Turn it off, keeping it and its history")
    .option("--on", "Turn it back on")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (id: string, options: {
        every?: string;
        off?: boolean;
        on?: boolean;
        json?: boolean;
      }) => {
        if (options.on && options.off) {
          throw new Error("Pick one of --on and --off.");
        }
        const config = requireConfig();
        const schedule = await api<Schedule>(
          config,
          "PATCH",
          `/schedules/${encodeURIComponent(id)}`,
          {
            recurrence: options.every,
            enabled: options.on ? true : options.off ? false : undefined,
          }
        );
        emit(options.json, schedule, () => {
          console.log(
            `\n✓ ${schedule.reportTitle} — ${schedule.recurrence}${schedule.enabled ? "" : " (off)"}`
          );
          if (schedule.enabled) console.log(`  Next asked on ${day(schedule.nextRunAt)}`);
          console.log("");
        });
      })
    );

  schedules
    .command("rm")
    .description("Stop asking for a recurring publish")
    .argument("<id>", "Schedule id")
    .action(
      run(async (id: string) => {
        const config = requireConfig();
        await api<void>(config, "DELETE", `/schedules/${encodeURIComponent(id)}`);
        console.log(`\n✓ Removed. The report and its versions are untouched.`);
        console.log(`  Use --off instead to pause one and keep the record.\n`);
      })
    );

  program
    .command("templates")
    .description("Reports the organisation offers as starting points")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { json?: boolean }) => {
        const config = requireConfig();
        const { templates } = await api<{
          templates: { title: string; slug: string; description: string | null }[];
        }>(config, "GET", "/templates");
        emit(options.json, { templates }, () => {
          if (templates.length === 0) {
            console.log("No templates yet.");
            return;
          }
          for (const t of templates) {
            console.log(`${t.title}\n  ${t.description ?? t.slug}`);
            console.log(`  deliverd copy ${t.slug}\n`);
          }
        });
      })
    );

  program
    .command("workspaces")
    .description("The workspaces in this organisation")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { json?: boolean }) => {
        const config = requireConfig();
        const { workspaces } = await api<{
          workspaces: { id: string; name: string; slug: string; description: string | null }[];
        }>(config, "GET", "/workspaces");
        emit(options.json, { workspaces }, () => {
          if (workspaces.length === 0) {
            console.log("No workspaces.");
            return;
          }
          for (const w of workspaces) {
            console.log(`${w.name}\n  ${w.description ?? w.slug}\n`);
          }
        });
      })
    );

  program
    .command("who")
    .description("Check what an audience phrase resolves to, before you share")
    .argument("<phrase...>", 'e.g. deliverd who "Finance team" sarah@acme.com')
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (phrase: string[], options: { json?: boolean }) => {
        const config = requireConfig();
        const result = await api<{
          principals: { type: string; label?: string; email?: string }[];
          ambiguous: { phrase: string; candidates: { type: string; label: string }[] }[];
          unresolved: string[];
        }>(config, "POST", "/audiences/resolve", { audience: phrase });

        emit(options.json, result, () => {
          for (const p of result.principals) {
            console.log(`✓ ${p.label ?? p.email ?? p.type} (${p.type})`);
          }
          /*
           * The two failure kinds are why this command exists: `share`
           * refuses on either, and finding out which name was the problem
           * from the refusal alone means re-reading the whole list.
           */
          for (const a of result.ambiguous) {
            console.log(`? "${a.phrase}" means ${plural(a.candidates.length, "thing")}:`);
            for (const c of a.candidates) console.log(`    ${c.label} (${c.type})`);
          }
          for (const u of result.unresolved) {
            console.log(`✗ "${u}" matched nothing.`);
          }
        });
      })
    );
}
