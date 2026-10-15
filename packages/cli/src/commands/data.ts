import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { api } from "../api.js";
import { requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { day, emit, plural, run } from "../ui.js";

/**
 * The living-report loop, from a terminal.
 *
 * A report that fetches `_data/<name>` at open time shows new figures with
 * no new version, no re-share and no URL change — which makes "the numbers
 * job runs at 6am and writes today's file" a cron line rather than a
 * publish. That loop was reachable from MCP and REST and not from the one
 * surface a cron line actually uses.
 */
export function dataCommands(program: Command): void {
  const data = program
    .command("data")
    .description("The datasets a living report reads when someone opens it");

  data
    .command("list")
    .description("What datasets a report reads")
    .argument("<report>", "Report id or slug")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const { datasets } = await api<{
          datasets: { name: string; sizeBytes: number; updatedAt: string }[];
        }>(config, "GET", `/reports/${encodeURIComponent(report)}/data`);
        emit(options.json, { datasets }, () => {
          if (datasets.length === 0) {
            console.log("No datasets. This report renders whatever it was published with.");
            return;
          }
          for (const d of datasets) {
            console.log(
              `${d.name}\n  ${Math.round(d.sizeBytes / 1024)} KB · updated ${day(d.updatedAt)}\n`
            );
          }
        });
      })
    );

  data
    .command("set")
    .description("Replace a dataset — no new version, same URL and audience")
    .argument("<report>", "Report id or slug")
    .argument("<name>", "Dataset name, as the report fetches it")
    .argument("<file>", 'Path to a JSON file, or - to read standard input')
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, name: string, file: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const body = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
        /*
         * Parsed here only to refuse early. The bytes sent are the bytes
         * read — re-serialising would reorder keys and reformat numbers in
         * a file somebody may be diffing.
         */
        try {
          JSON.parse(body);
        } catch {
          throw new Error(
            `${file === "-" ? "Standard input" : file} is not valid JSON. The report calls response.json() on it.`
          );
        }
        const result = await api<{ name: string; sizeBytes: number; updatedAt: string }>(
          config,
          "PUT",
          `/reports/${encodeURIComponent(report)}/data/${encodeURIComponent(name)}`,
          JSON.parse(body)
        );
        emit(options.json, result, () => {
          console.log(`\n✓ ${result.name} updated (${Math.round(result.sizeBytes / 1024)} KB)`);
          console.log(`  Readers see it from the next open. The version number is unchanged.\n`);
        });
      })
    );

  data
    .command("rm")
    .description("Remove a dataset")
    .argument("<report>", "Report id or slug")
    .argument("<name>", "Dataset name")
    .action(
      run(async (report: string, name: string) => {
        const config = requireConfig();
        await api<void>(
          config,
          "DELETE",
          `/reports/${encodeURIComponent(report)}/data/${encodeURIComponent(name)}`
        );
        console.log(`\n✓ ${name} removed.`);
        // The honest warning: this breaks a live page rather than a draft.
        console.log(`  A report that fetches this name shows an error from the next open.\n`);
      })
    );
}

/** Reader feedback, anchored to the passage it is about. */
export function commentCommands(program: Command): void {
  const comments = program
    .command("comments")
    .description("Reader feedback, on one report or across all of them");

  comments
    .command("open", { isDefault: true })
    .description("Every open thread across all reports — what is waiting")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<{
          threadId: string;
          reportTitle: string;
          reportSlug: string;
          quote: string | null;
          author: string;
          messages: number;
          lastActivityAt: string;
        }>(config, "/comments", "threads", {
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });

        emit(options.json, { threads: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log("Nothing open. Every thread has been resolved.");
            return;
          }
          for (const t of items) {
            console.log(`${t.reportTitle} · ${t.author} · ${day(t.lastActivityAt)}`);
            if (t.quote) console.log(`  “${t.quote.slice(0, 80)}”`);
            console.log(`  ${plural(t.messages, "message")} · ${t.threadId}`);
            // The next command, said out loud: the thread id is what
            // `resolve` takes and the slug is what `comments list` takes.
            console.log(`  deliverd comments list ${t.reportSlug}\n`);
          }
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  comments
    .command("list")
    .description("Threads on a report, newest activity first")
    .argument("<report>", "Report id or slug")
    .option("--status <status>", "open | resolved | all", "open")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: {
        status?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        /*
         * These field names are the endpoint's, and they were not: this typed
         * `id` and `comments[].authorLabel` while `GET /reports/{id}/comments`
         * has always returned `threadId` and `messages[].author`. Every line
         * below read `undefined` — the thread id printed as the word, no body
         * was ever shown, and a thread with four replies reported none. The
         * CLI parity guard was green throughout, because it proves the
         * endpoint is reachable and says nothing about what comes back.
         */
        const { items, nextCursor } = await listing<{
          threadId: string;
          quote: string | null;
          status: string;
          messages: {
            commentId: string;
            body: string;
            author: string;
            createdAt: string;
            retractable: boolean;
          }[];
        }>(config, `/reports/${encodeURIComponent(report)}/comments`, "threads", {
          status: options.status,
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });

        emit(options.json, { threads: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log(options.status === "open" ? "No open threads." : "No threads.");
            return;
          }
          for (const t of items) {
            const first = t.messages[0];
            console.log(`${t.status === "open" ? "○" : "●"} ${t.threadId}`);
            if (t.quote) console.log(`  “${t.quote.slice(0, 100)}”`);
            if (first) console.log(`  ${first.author}: ${first.body.slice(0, 200)}`);
            if (t.messages.length > 1) {
              console.log(`  ${plural(t.messages.length - 1, "reply", "replies")}`);
            }
            // Only ever one per thread, and only yours — the next command,
            // said out loud, the way `comments open` names the one after it.
            const mine = t.messages.find((m) => m.retractable);
            if (mine) console.log(`  deliverd comments retract ${report} ${mine.commentId}`);
            console.log("");
          }
          if (nextCursor) console.log(`More to come — --cursor ${nextCursor}`);
        });
      })
    );

  comments
    .command("add")
    .description("Comment on a report, or reply to a thread")
    .argument("<report>", "Report id or slug")
    .argument("<body>", "What to say")
    .option("--quote <text>", "The passage it is about; must occur exactly once")
    .option("--thread <id>", "Reply to this thread instead of starting one")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, body: string, options: {
        quote?: string;
        thread?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const result = await api<{ threadId: string }>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/comments`,
          { body, quote: options.quote, threadId: options.thread }
        );
        emit(options.json, result, () => {
          console.log(`\n✓ Posted to thread ${result.threadId}\n`);
        });
      })
    );

  comments
    .command("retract")
    .description("Take back a comment you posted, while nobody has replied")
    .argument("<report>", "Report id or slug")
    .argument("<comment>", "Comment id, from `deliverd comments list`")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, comment: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const result = await api<{ threadId: string; threadRetracted: boolean }>(
          config,
          "DELETE",
          `/reports/${encodeURIComponent(report)}/comments/${encodeURIComponent(comment)}`
        );
        emit(options.json, result, () => {
          console.log(
            result.threadRetracted
              ? "\n✓ Retracted. That was the only comment, so the thread went with it.\n"
              : "\n✓ Retracted.\n"
          );
        });
      })
    );

  comments
    .command("resolve")
    .description("Mark a thread resolved, with a note on what changed")
    .argument("<thread>", "Thread id, from `deliverd comments list`")
    .option("--note <text>", "What was done about it")
    .option("--reopen", "Reopen it instead")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (thread: string, options: { note?: string; reopen?: boolean; json?: boolean }) => {
        const config = requireConfig();
        const result = await api<{ status: string }>(
          config,
          "POST",
          `/comments/${encodeURIComponent(thread)}/resolve`,
          { note: options.note, reopen: options.reopen ?? false }
        );
        emit(options.json, result, () => {
          console.log(`\n✓ Thread ${options.reopen ? "reopened" : "resolved"}.\n`);
        });
      })
    );
}
