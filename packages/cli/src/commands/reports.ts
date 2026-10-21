import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { api, apiText } from "../api.js";
import { requireConfig } from "../config.js";
import { readBundle } from "../bundle.js";
import { listing } from "../paging.js";
import { day, emit, openBrowser, plural, run } from "../ui.js";

interface ReportRow {
  id: string;
  title: string;
  slug: string;
  currentVersion: number | null;
  isLiving: boolean;
  updatedAt: string;
  url: string;
}

interface PublishResponse {
  report: { id: string; title: string; slug: string };
  version: { versionNumber: number };
  url: string;
  warnings: string[];
  status: "published" | "updated" | "pending_approval";
  approval?: { id: string; rule: string | null; reason: string | null };
}

/**
 * Put a bundle where the API can read it.
 *
 * Both publish and update do the same two steps — ticket, PUT — and did them
 * in two copies. One of those copies was the one that got `--change-summary`
 * and the other was not.
 */
async function upload(
  config: ReturnType<typeof requireConfig>,
  path: string
): Promise<string> {
  const bundle = readBundle(path);
  const ticket = await api<{ uploadId: string; uploadUrl: string }>(
    config,
    "POST",
    "/uploads"
  );
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    body: bundle.data.slice().buffer as ArrayBuffer,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return ticket.uploadId;
}

/** What a publish or an update prints, held or live. */
function reportPublishResult(result: PublishResponse, json: boolean | undefined, updated: boolean): void {
  emit(
    json,
    {
      id: result.report.id,
      title: result.report.title,
      slug: result.report.slug,
      url: result.url,
      version: result.version.versionNumber,
      warnings: result.warnings ?? [],
      status: result.status,
      ...(result.approval ? { approval: result.approval } : {}),
    },
    () => {
      if (result.status === "pending_approval") {
        // Stored and scanned, not live. Saying "published" here would be a
        // lie the next step in the pipeline acts on.
        console.log(
          `\n⏳ ${result.report.title} submitted for approval (v${result.version.versionNumber})`
        );
        console.log(
          `  ${result.approval?.reason ?? "A publishing rule holds it until an administrator approves it."}`
        );
        console.log(
          updated
            ? `  Readers keep seeing the previous version until then: ${result.url}\n`
            : `  The link serves once approved: ${result.url}\n`
        );
      } else {
        console.log(
          `\n✓ ${result.report.title} ${updated ? `updated to v${result.version.versionNumber}` : `published (v${result.version.versionNumber})`}`
        );
        console.log(`  ${result.url}\n`);
      }
      for (const warning of result.warnings ?? []) console.warn(`  ⚠ ${warning}`);
    }
  );
}

export function reportCommands(program: Command): void {
  program
    .command("publish")
    .description("Publish an HTML file, ZIP, or folder")
    .argument("<path>", "Path to the report")
    .option("--title <title>", "Report title")
    .option("--slug <slug>", "Custom URL path, e.g. finance/weekly")
    .option("--audience <audience...>", 'Audience, e.g. --audience "Finance team" "Sarah Jones"')
    .option("--living", "Create a living report (stable URL, updated over time)")
    .option("--classification <level>", "public | internal | confidential | restricted")
    .option(
      "--change-summary <text>",
      "What changed in this version — in CI, the commit subject is a good default"
    )
    .option(
      "--task <id>",
      "The task this report is for: it is listed on the task and in its context (`deliverd tasks context`)"
    )
    .option(
      "--flow <id>",
      "The project (flow) this report belongs to. Set on a first publish; a later version keeps the report's flow"
    )
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (path: string, options: {
        title?: string;
        slug?: string;
        audience?: string[];
        living?: boolean;
        classification?: string;
        changeSummary?: string;
        task?: string;
        flow?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const uploadId = await upload(config, path);
        const result = await api<PublishResponse>(config, "POST", "/reports", {
          uploadId,
          title: options.title,
          slug: options.slug,
          audience: options.audience,
          living: options.living ?? false,
          classification: options.classification,
          changeSummary: options.changeSummary,
          taskId: options.task,
          flowId: options.flow,
          sourceTool: "cli",
        });
        reportPublishResult(result, options.json, false);
      })
    );

  program
    .command("update")
    .description("Publish a new version of an existing report")
    .argument("<report>", "Report id or slug")
    .argument("<path>", "Path to the new report content")
    .option("--title <title>", "Change the title with this version")
    .option(
      "--change-summary <text>",
      "What changed in this version — in CI, the commit subject is a good default"
    )
    /*
     * Both of these were in the API from the start and reachable from
     * everywhere except here, which made the CLI the one surface that could
     * overwrite somebody else's version without noticing. `versions` prints
     * `latestVersion` for exactly this.
     */
    .option(
      "--expected-version <n>",
      "Refuse if the report has moved on — pass latestVersion from `deliverd versions`"
    )
    .option("--task <id>", "Move the report to this task; without it, it keeps the task it has")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, path: string, options: {
        title?: string;
        changeSummary?: string;
        expectedVersion?: string;
        task?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const expected =
          options.expectedVersion === undefined
            ? undefined
            : Number(options.expectedVersion);
        if (expected !== undefined && !Number.isInteger(expected)) {
          throw new Error("--expected-version takes a whole number, e.g. --expected-version 4");
        }
        const uploadId = await upload(config, path);
        const result = await api<PublishResponse>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/versions`,
          {
            uploadId,
            title: options.title,
            changeSummary: options.changeSummary,
            expectedVersion: expected,
            taskId: options.task,
            sourceTool: "cli",
          }
        );
        reportPublishResult(result, options.json, true);
      })
    );

  program
    .command("rename")
    .description("Rename a report, or move it to a new address")
    .argument("<report>", "Report id or slug")
    .option("--title <title>", "New display name")
    .option("--slug <slug>", "New address, e.g. finance/weekly")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { title?: string; slug?: string; json?: boolean }) => {
        if (!options.title && !options.slug) {
          throw new Error("Nothing to change. Pass --title, --slug, or both.");
        }
        const config = requireConfig();
        const result = await api<{
          report: { title: string; slug: string };
          url: string;
          previousSlug: string | null;
        }>(config, "PATCH", `/reports/${encodeURIComponent(report)}`, {
          ...(options.title ? { title: options.title } : {}),
          ...(options.slug ? { slug: options.slug } : {}),
        });

        emit(options.json, result, () => {
          console.log(`\n✓ ${result.report.title}`);
          console.log(`  ${result.url}`);
          // The reassurance is the point: people hesitate to rename something
          // they have already sent to colleagues.
          if (result.previousSlug) {
            console.log(`\n  /${result.previousSlug} still works and redirects here,`);
            console.log(`  so links you have already shared are unaffected.`);
          }
          console.log("");
        });
      })
    );

  program
    .command("list")
    .description("List your reports")
    .option("-q, --query <text>", "Search title, slug and description")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (options: { query?: string; limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const { items, nextCursor } = await listing<ReportRow>(config, "/reports", "reports", {
          q: options.query,
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });

        emit(options.json, { reports: items, nextCursor }, () => {
          if (items.length === 0) {
            console.log(options.query ? "Nothing matched." : "No reports yet.");
            return;
          }
          for (const r of items) {
            const living = r.isLiving ? " [living]" : "";
            const version = r.currentVersion ? `v${r.currentVersion}` : "—";
            console.log(
              `${r.title}${living}\n  ${version} · updated ${day(r.updatedAt)} · ${r.url}\n`
            );
          }
          if (nextCursor) {
            console.log(`More to come — deliverd list --cursor ${nextCursor}`);
          }
        });
      })
    );

  program
    .command("open")
    .description("Open a report in the browser")
    .argument("<report>", "Report id or slug")
    .action(
      run(async (report: string) => {
        const config = requireConfig();
        const result = await api<{ report: { url: string } }>(
          config,
          "GET",
          `/reports/${encodeURIComponent(report)}`
        );
        openBrowser(result.report.url);
        console.log(result.report.url);
      })
    );

  program
    .command("share")
    .description("Give people, teams or groups access to a report")
    .argument("<report>", "Report id or slug")
    .requiredOption(
      "--audience <audience...>",
      'Who, in plain English — e.g. --audience "Finance team" sarah@acme.com'
    )
    .option("--capability <level>", "What they may do: view (the default) or comment")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { audience: string[]; capability?: string; json?: boolean }) => {
        const { capability } = options;
        // "Can manage" is a person's decision in the app; the API refuses it.
        if (capability !== undefined && capability !== "view" && capability !== "comment") {
          throw new Error("--capability takes view or comment, e.g. --capability comment");
        }
        const config = requireConfig();
        const { granted } = await api<{ granted: { type: string; label?: string; email?: string }[] }>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/share`,
          capability ? { audience: options.audience, capability } : { audience: options.audience }
        );
        emit(options.json, { granted }, () => {
          const can = capability === "comment" ? " (can comment)" : "";
          console.log(`\n✓ Shared with ${plural(granted.length, "recipient")}${can}`);
          for (const g of granted) {
            console.log(`  ${g.label ?? g.email ?? g.type}`);
          }
          console.log("");
        });
      })
    );

  program
    .command("unshare")
    .description("Take a report's access away from people, teams or groups")
    .argument("<report>", "Report id or slug")
    .requiredOption(
      "--audience <audience...>",
      'Who to take it away from — the same phrase you shared with, e.g. --audience sarah@acme.com'
    )
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { audience: string[]; json?: boolean }) => {
        const config = requireConfig();
        const { revoked } = await api<{ revoked: { type: string; label?: string; email?: string }[] }>(
          config,
          "DELETE",
          `/reports/${encodeURIComponent(report)}/share`,
          { audience: options.audience }
        );
        emit(options.json, { revoked }, () => {
          console.log(`\n✓ Revoked from ${plural(revoked.length, "recipient")}`);
          for (const g of revoked) {
            console.log(`  ${g.label ?? g.email ?? g.type}`);
          }
          console.log("");
        });
      })
    );

  program
    .command("send")
    .description("Email a report to a list of addresses, with a covering note")
    .argument("<report>", "Report id or slug")
    .requiredOption("--to <email...>", "Who to send it to, up to 50 addresses")
    .option("-m, --message <text>", "The covering note, shown above the link")
    .option("--no-comments", "Read only; they cannot comment back")
    .option("--expires <days>", "Revoke their access automatically after this many days")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: {
        to: string[];
        message?: string;
        comments?: boolean;
        expires?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const result = await api<{
          sent: { email: string; delivered: boolean }[];
          alreadyHadAccess: string[];
        }>(config, "POST", `/reports/${encodeURIComponent(report)}/send`, {
          to: options.to,
          message: options.message,
          // Commander turns `--no-comments` into `comments: false`; absent
          // means undefined, which the API reads as the default.
          allowComments: options.comments,
          expiresInDays: options.expires ? Number(options.expires) : undefined,
        });

        emit(options.json, result, () => {
          console.log(`\n✓ Sent to ${plural(result.sent.length, "person", "people")}`);
          for (const s of result.sent) {
            // `delivered` is the mail provider accepting it, and saying so
            // matters: a false here is a bounce the sender should chase.
            console.log(`  ${s.delivered ? "✓" : "⚠"} ${s.email}`);
          }
          if (result.alreadyHadAccess.length > 0) {
            console.log(
              `\n  ${plural(result.alreadyHadAccess.length, "recipient")} already had access and ` +
                `${result.alreadyHadAccess.length === 1 ? "was" : "were"} emailed again.`
            );
          }
          console.log(
            `\n  Each has their own link, and it shows the latest version — there is\n` +
              `  nothing to send again when the report changes.\n`
          );
        });
      })
    );

  program
    .command("archive")
    .description("Stop a report's URL serving. Nothing is deleted")
    .argument("<report>", "Report id or slug")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const result = await api<{ id: string; status: string }>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/archive`,
          { archived: true }
        );
        emit(options.json, result, () => {
          console.log(`\n✓ Archived. The URL stops serving.`);
          console.log(`  Put it back with: deliverd unarchive ${report}\n`);
        });
      })
    );

  program
    .command("unarchive")
    .description("Put an archived report back, at the same URL and audience")
    .argument("<report>", "Report id or slug")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { json?: boolean }) => {
        const config = requireConfig();
        const result = await api<{ id: string; status: string }>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/archive`,
          { archived: false }
        );
        emit(options.json, result, () => {
          console.log(`\n✓ Serving again, at the version that was current.\n`);
        });
      })
    );

  program
    .command("rollback")
    .description("Serve an earlier version again, at the same URL")
    .argument("<report>", "Report id or slug")
    .requiredOption("--version <n>", "The version number to restore, from `deliverd versions`")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { version: string; json?: boolean }) => {
        const version = Number(options.version);
        if (!Number.isInteger(version) || version < 1) {
          throw new Error("--version takes a whole number, e.g. --version 3");
        }
        const config = requireConfig();
        const result = await api<{ ok: true; version: number; versionId: string }>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/rollback`,
          { version }
        );
        emit(options.json, result, () => {
          console.log(`\n✓ v${result.version} is live again at the same URL.`);
          // Said out loud because it is the thing people get wrong: the
          // markup went back, the figures a living report fetches did not.
          console.log(`  Datasets are not versioned, so the numbers are unchanged.\n`);
        });
      })
    );

  program
    .command("versions")
    .description("Every version of a report, newest first")
    .argument("<report>", "Report id or slug")
    .option("--limit <n>", "One page of this size instead of all of them")
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { limit?: string; cursor?: string; json?: boolean }) => {
        const config = requireConfig();
        const path = `/reports/${encodeURIComponent(report)}/versions`;
        /*
         * `latestVersion` and the pending approval come off the first page
         * and are the reason to read this at all before an update: the
         * latest number is what `--expected-version` compares to, and it is
         * not the current one once a publish has been held or declined.
         */
        const head = await api<{
          nextCursor: string | null;
          currentVersionId: string | null;
          latestVersion: number | null;
          pendingApproval: { id: string; versionNumber: number; since: string } | null;
        }>(config, "GET", `/reports/${encodeURIComponent(report)}/versions`);

        // Two requests when draining, because the metadata above rides on a
        // page body and the walk below throws pages away. Reading the first
        // page twice is cheaper than teaching the pager to keep the rest of
        // whatever each endpoint happens to return alongside its array.
        const all = await listing<{
          versionNumber: number;
          createdAt: string;
          changeSummary: string | null;
        }>(config, path, "versions", {
          limit: options.limit ? Number(options.limit) : undefined,
          cursor: options.cursor,
        });

        emit(options.json, { ...head, versions: all.items, nextCursor: all.nextCursor }, () => {
          for (const v of all.items) {
            const marker = v.versionNumber === head.latestVersion ? " ← latest" : "";
            console.log(
              `v${v.versionNumber}${marker} · ${day(v.createdAt)}${v.changeSummary ? ` · ${v.changeSummary}` : ""}`
            );
          }
          if (head.pendingApproval) {
            console.log(
              `\n⏳ v${head.pendingApproval.versionNumber} is awaiting approval since ${day(head.pendingApproval.since)}.`
            );
          }
          if (all.nextCursor) {
            console.log(`\nMore to come — --cursor ${all.nextCursor}`);
          }
        });
      })
    );

  program
    .command("copy")
    .description("Start a new report from an existing one, or from a template")
    .argument("<report>", "Report id or slug to copy")
    .option("--title <title>", "Title for the copy")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (report: string, options: { title?: string; json?: boolean }) => {
        const config = requireConfig();
        const copy = await api<ReportRow>(
          config,
          "POST",
          `/reports/${encodeURIComponent(report)}/copy`,
          options.title ? { title: options.title } : {}
        );
        emit(options.json, copy, () => {
          console.log(`\n✓ ${copy.title}`);
          console.log(`  ${copy.url}`);
          // A copy inherits the content and nothing else, which surprises
          // people who expect the original's recipients to carry over.
          console.log(`\n  Nobody can open it yet — deliverd share ${copy.slug} --audience …\n`);
        });
      })
    );

  program
    .command("analytics")
    .description("Who read a report, and when — or the whole organisation")
    .argument("[report]", "Report id or slug. Leave it out for every report.")
    .option("--days <n>", "The window, for the organisation view")
    .option("--limit <n>", "How many reports in each list")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (
        report: string | undefined,
        options: { days?: string; limit?: string; json?: boolean }
      ) => {
        const config = requireConfig();

        if (!report) {
          const query = new URLSearchParams();
          if (options.days) query.set("days", options.days);
          if (options.limit) query.set("limit", options.limit);
          /*
           * The `?` stays in the literal rather than inside `query`. The
           * route-parity extractor reads path literals out of this file and
           * drops everything after a `?`; a query hidden inside the variable
           * read as a path segment, and `GET /analytics{}` matched no route.
           */
          const org = await api<{
            days: number;
            totalViews: number;
            uniqueViewers: number;
            activeReports: number;
            externallySharedReports: number;
            publishesInPeriod: number;
            topReports: { title: string; views: number; uniqueViewers: number }[];
            inactiveReports: { title: string; lastViewedAt: string | null }[];
          }>(config, "GET", `/analytics?${query}`);
          emit(options.json, org, () => {
            console.log(
              `\n${plural(org.totalViews, "view")} by ${plural(org.uniqueViewers, "reader")}` +
                ` over ${plural(org.days, "day")}`
            );
            console.log(
              `${plural(org.activeReports, "live report")}, ` +
                `${org.externallySharedReports} shared outside, ` +
                `${plural(org.publishesInPeriod, "publish", "publishes")} in the period\n`
            );
            if (org.topReports.length > 0) {
              console.log("Most read");
              for (const r of org.topReports) {
                console.log(`  ${plural(r.views, "view")} · ${r.title}`);
              }
              console.log("");
            }
            /*
             * The half a per-report call can never give you: a report nobody
             * has opened does not appear in anything you would think to ask
             * about.
             */
            if (org.inactiveReports.length > 0) {
              console.log("Nobody has opened");
              for (const r of org.inactiveReports) {
                console.log(
                  `  ${r.title}${r.lastViewedAt ? ` · last read ${day(r.lastViewedAt)}` : " · never"}`
                );
              }
              console.log("");
            }
          });
          return;
        }

        /*
         * These field names are the endpoint's, and they were not: this read
         * `views` and `readers` while `GET /reports/{id}/analytics` has always
         * returned `totalViews` and `uniqueViewers`, so the one line it prints
         * read "undefined views by undefined readers". The second CLI command
         * today found typed against fields the API does not return.
         */
        const stats = await api<{
          totalViews: number;
          uniqueViewers: number | null;
          lastViewedAt: string | null;
          byVersion?: { versionNumber: number; views: number }[];
        }>(config, "GET", `/reports/${encodeURIComponent(report)}/analytics`);
        emit(options.json, stats, () => {
          console.log(
            `\n${plural(stats.totalViews, "view")}` +
              (stats.uniqueViewers === null
                ? ""
                : ` by ${plural(stats.uniqueViewers, "reader")}`) +
              (stats.lastViewedAt ? `, last on ${day(stats.lastViewedAt)}` : "")
          );
          for (const v of stats.byVersion ?? []) {
            console.log(`  v${v.versionNumber}: ${plural(v.views, "view")}`);
          }
          console.log("");
        });
      })
    );

  program
    .command("evidence")
    .description("The full record behind a report: who decided what, and when")
    .argument("<report>", "Report id or slug")
    .option("--format <format>", "json or csv", "json")
    .option("-o, --out <file>", "Write to a file instead of standard output")
    .action(
      run(async (report: string, options: { format?: string; out?: string }) => {
        const format = options.format === "csv" ? "csv" : "json";
        const config = requireConfig();
        const body = await apiText(
          config,
          "GET",
          `/reports/${encodeURIComponent(report)}/evidence?format=${format}`
        );
        if (options.out) {
          writeFileSync(options.out, body);
          console.log(`Written to ${options.out}`);
          return;
        }
        // Straight to stdout, unformatted: this is the one command whose
        // output a person redirects into a file or pipes into `jq`.
        console.log(body);
      })
    );
}
