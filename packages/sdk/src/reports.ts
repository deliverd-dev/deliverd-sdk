import { collect, type PageInput, type PageOf } from "./paging.js";
import type { HttpClient } from "./http.js";
import type {
  CommentThread,
  OpenThread,
  OrgAnalytics,
  ReportAnalytics,
  PublishReportInput,
  PublishResult,
  ReportData,
  ScheduleSummary,
  SendResult,
  ShareOptions,
  UpdateReportInput,
  EvidencePack,
} from "./types.js";

/**
 * The publishing half: get what the agent wrote to the people who need it, at
 * an address that does not change.
 *
 * Thin on purpose. These are the REST routes with their names spelled the way
 * a person would say them, and nothing else — the service decides what a
 * publish means, and an SDK that reimplemented any of it would be a second
 * answer to the same question.
 */
export class Reports {
  constructor(private readonly http: HttpClient) {}

  /**
   * Publish HTML to a secure URL.
   *
   * Check `result.status`: a publishing policy can hold the version for a
   * person's approval, in which case nothing is live yet and `result.approval`
   * names the request.
   */
  publish(input: PublishReportInput, signal?: AbortSignal): Promise<PublishResult> {
    return this.http.request({ method: "POST", path: "/reports", body: input, signal });
  }

  /** A new version of an existing report, keeping its URL and its audience. */
  update(
    idOrSlug: string,
    input: UpdateReportInput,
    signal?: AbortSignal
  ): Promise<PublishResult> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/versions`,
      body: input,
      signal,
    });
  }

  /**
   * The whole record behind a report: the approvals, reviews and requests for
   * information that point at it, its version history, and the timeline across
   * all of it.
   *
   * The subject an auditor usually names — and unlike a flow, it works for
   * work that was done before flows existed. Needs every read scope.
   */
  evidence(idOrSlug: string, signal?: AbortSignal): Promise<EvidencePack> {
    return this.http.request<EvidencePack>({
      method: "GET",
      path: `/reports/${encodeURIComponent(idOrSlug)}/evidence`,
      signal,
    });
  }

  get(idOrSlug: string, signal?: AbortSignal): Promise<ReportData> {
    return this.http.request({
      method: "GET",
      path: `/reports/${encodeURIComponent(idOrSlug)}`,
      signal,
    });
  }

  /**
   * Every report, newest change first. `query` searches title, slug and
   * description.
   *
   * This one used to be the worst of them: the API had no limit at all, so an
   * organisation past PostgREST's own cap was handed a prefix of its reports
   * and nothing said so. It follows the cursor now, so the array really is all
   * of them; `listPage` is there when one page is what you want.
   */
  async list(query?: string, signal?: AbortSignal): Promise<ReportData[]> {
    return collect(async (cursor: string | null) => {
      const page = await this.listPage({ query, cursor: cursor ?? undefined }, signal);
      return { items: page.items, nextCursor: page.nextCursor };
    });
  }

  /** One page, and the cursor to continue from — null when it is the end. */
  async listPage(
    input: { query?: string } & PageInput = {},
    signal?: AbortSignal
  ): Promise<PageOf<ReportData>> {
    const { reports, nextCursor } = await this.http.request<{
      reports: ReportData[];
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/reports",
      query: { q: input.query, limit: input.limit, cursor: input.cursor },
      signal,
    });
    return { items: reports, nextCursor };
  }

  /** Change the title, the address, or both. The old address keeps working. */
  rename(
    idOrSlug: string,
    input: { title?: string; slug?: string; description?: string; workspaceId?: string },
    signal?: AbortSignal
  ): Promise<ReportData> {
    return this.http.request({
      method: "PATCH",
      path: `/reports/${encodeURIComponent(idOrSlug)}`,
      body: input,
      signal,
    });
  }

  /**
   * Grant people, teams or groups access. Filing is not access; this is.
   *
   * `{ capability: "comment" }` lets them comment as well as read; leave it
   * out for view. A signal in third place, as before options existed, still
   * works.
   */
  async share(
    idOrSlug: string,
    audience: unknown,
    options?: ShareOptions | AbortSignal,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    if (options instanceof AbortSignal) {
      signal = options;
      options = undefined;
    }
    const capability = options?.capability;
    const { granted } = await this.http.request<{ granted: unknown[] }>({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/share`,
      body: capability ? { audience, capability } : { audience },
      signal,
    });
    return granted;
  }

  /**
   * Take it away again, from the same audience phrase that granted it.
   *
   * By audience rather than by grant id because that is all a caller has:
   * `get()` returns each grant's principal id, never the grant row's. Refuses
   * when the audience never had access, so a script that revokes and carries
   * on is not told the door is shut when it is open.
   */
  async revoke(idOrSlug: string, audience: unknown, signal?: AbortSignal): Promise<unknown[]> {
    const { revoked } = await this.http.request<{ revoked: unknown[] }>({
      method: "DELETE",
      path: `/reports/${encodeURIComponent(idOrSlug)}/share`,
      body: { audience },
      signal,
    });
    return revoked;
  }

  /**
   * Email it to a list of addresses, inside or outside the organisation.
   *
   * `share` grants access to people the organisation already knows. This
   * takes bare email addresses, creates the guest records behind them, and
   * emails each recipient their own link with your covering note. Not a
   * mailing list: one link per person, which is what makes the audit trail
   * and the per-reader analytics mean anything.
   *
   * A publishing rule can refuse it — a report classified confidential or
   * restricted does not leave the organisation.
   */
  send(
    idOrSlug: string,
    input: {
      to: string[];
      message?: string;
      allowComments?: boolean;
      expiresInDays?: number;
    },
    signal?: AbortSignal
  ): Promise<SendResult> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/send`,
      body: input,
      signal,
    });
  }

  /**
   * Stop the URL serving. A reader following a link they already hold is told
   * the report is no longer available; nothing is deleted and the audience is
   * kept, so `unarchive` puts it back exactly as it was.
   */
  archive(idOrSlug: string, archived = true, signal?: AbortSignal): Promise<ReportData> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/archive`,
      body: { archived },
      signal,
    });
  }

  /** Put an archived report back at the same URL, to the same audience. */
  unarchive(idOrSlug: string, signal?: AbortSignal): Promise<ReportData> {
    return this.archive(idOrSlug, false, signal);
  }

  /**
   * Serve an earlier version again, at the same URL. The newer version is
   * kept — roll forward the same way.
   *
   * The version number is the one `versions()` and `get()` report, not a
   * version uuid.
   */
  rollback(
    idOrSlug: string,
    version: number,
    signal?: AbortSignal
  ): Promise<{ ok: true; version: number; versionId: string }> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/rollback`,
      body: { version },
      signal,
    });
  }

  /**
   * Every version, with `latestVersion` beside `currentVersion`. Pass
   * `latestVersion` as `expectedVersion` on an update: a held or declined
   * version takes a number without going live.
   */
  versions(idOrSlug: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.http.request({
      method: "GET",
      path: `/reports/${encodeURIComponent(idOrSlug)}/versions`,
      signal,
    });
  }

  /**
   * What is being read across every report — and what is not.
   *
   * `analytics` needs to be told which report, so "what is getting read" meant
   * walking the list and adding up. The half that cannot be reconstructed that
   * way is `inactiveReports`: a report nobody has opened does not appear in
   * anything you would think to ask about.
   *
   * Part of analytics, so Team and above; `analytics` returns a total view
   * count on every plan.
   */
  orgAnalytics(
    options: { days?: number; limit?: number } = {},
    signal?: AbortSignal
  ): Promise<OrgAnalytics> {
    return this.http.request({
      method: "GET",
      path: "/analytics",
      query: { days: options.days, limit: options.limit },
      signal,
    });
  }

  /** Who read it and when. The detail needs the analytics plan. */
  analytics(idOrSlug: string, signal?: AbortSignal): Promise<ReportAnalytics> {
    return this.http.request({
      method: "GET",
      path: `/reports/${encodeURIComponent(idOrSlug)}/analytics`,
      signal,
    });
  }

  /** Replace a dataset a living report reads. No new version, same URL. */
  putData(
    idOrSlug: string,
    name: string,
    data: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.http.request({
      method: "PUT",
      path: `/reports/${encodeURIComponent(idOrSlug)}/data/${encodeURIComponent(name)}`,
      body: data,
      signal,
    });
  }

  listData(idOrSlug: string, signal?: AbortSignal): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: `/reports/${encodeURIComponent(idOrSlug)}/data`,
      signal,
    });
  }

  /**
   * Remove a dataset. The published version is untouched; a report that
   * fetches this name will show its readers an error from the next open, so
   * `listData` first if you are not sure what reads it.
   */
  deleteData(idOrSlug: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/reports/${encodeURIComponent(idOrSlug)}/data/${encodeURIComponent(name)}`,
      signal,
    });
  }

  /**
   * The open feedback composed into one prompt, with the readers' images as
   * signed links: everything needed to write the next version.
   */
  revisionBrief(
    idOrSlug: string,
    input: { threadIds?: string[]; instructions?: string } = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/revision-briefs`,
      body: input,
      signal,
    });
  }
}

/** Reader feedback, anchored to the passage it is about. */
export class Comments {
  constructor(private readonly http: HttpClient) {}

  /** Every thread on a report, newest activity first. */
  async list(
    idOrSlug: string,
    status: "open" | "resolved" | "all" = "open",
    signal?: AbortSignal
  ): Promise<CommentThread[]> {
    return collect(async (cursor: string | null) => {
      const { threads, nextCursor } = await this.http.request<{
        threads: CommentThread[];
        nextCursor: string | null;
      }>({
        method: "GET",
        path: `/reports/${encodeURIComponent(idOrSlug)}/comments`,
        query: { status, cursor: cursor ?? undefined },
        signal,
      });
      return { items: threads, nextCursor };
    });
  }

  /**
   * Every open thread in the organisation, newest activity first — the
   * answer to "is anything waiting on me?" without naming a report first.
   *
   * `list` needs one, which means enumerating every report to find the two
   * with feedback on them. Threads on archived reports are left out: the URL
   * does not serve, so nothing can be done about them.
   */
  async open(signal?: AbortSignal): Promise<OpenThread[]> {
    return collect(async (cursor: string | null) => {
      const { threads, nextCursor } = await this.http.request<{
        threads: OpenThread[];
        nextCursor: string | null;
      }>({
        method: "GET",
        path: "/comments",
        query: { cursor: cursor ?? undefined },
        signal,
      });
      return { items: threads, nextCursor };
    });
  }

  /** `quote` anchors it to a passage; `threadId` replies to one. */
  create(
    idOrSlug: string,
    input: { body: string; quote?: string; threadId?: string },
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.http.request({
      method: "POST",
      path: `/reports/${encodeURIComponent(idOrSlug)}/comments`,
      body: input,
      signal,
    });
  }

  /**
   * Take back a comment you posted.
   *
   * Your own last comment in a thread, while the thread is open. Once
   * somebody has replied it stays — their reply would otherwise be left
   * answering something no longer on the page. Retracting the only comment in
   * a thread takes the thread with it.
   *
   * `commentId` comes back from `create`, and `list` carries one on every
   * message with `retractable` beside it. This closes what a reader can see
   * and unsends nothing: the report's owner may already have been emailed.
   */
  retract(
    idOrSlug: string,
    commentId: string,
    signal?: AbortSignal
  ): Promise<{ status: "retracted"; threadId: string; threadRetracted: boolean }> {
    return this.http.request({
      method: "DELETE",
      path: `/reports/${encodeURIComponent(idOrSlug)}/comments/${encodeURIComponent(commentId)}`,
      signal,
    });
  }

  /** Mark a thread resolved, with a note on what changed. */
  resolve(
    threadId: string,
    input: { note?: string; reopen?: boolean } = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.http.request({
      method: "POST",
      path: `/comments/${encodeURIComponent(threadId)}/resolve`,
      body: input,
      signal,
    });
  }
}

/**
 * Recurring publishes.
 *
 * A schedule says when an agent is asked for a new version. It says nothing
 * about who hears about one — publishing emails the report's audience either
 * way.
 *
 * Read-only over the API until now, which made the timetable the one thing
 * about an agent that could be set from the admin screen and nowhere else.
 * An agent key cannot write here on purpose: a schedule is an instruction
 * *to* an agent.
 */
export class Schedules {
  constructor(private readonly http: HttpClient) {}

  /** Every schedule, or only the ones waiting on a publish. */
  async list(
    options: { dueOnly?: boolean } = {},
    signal?: AbortSignal
  ): Promise<ScheduleSummary[]> {
    const { schedules } = await this.http.request<{ schedules: ScheduleSummary[] }>({
      method: "GET",
      path: "/schedules",
      query: options.dueOnly ? { due: "1" } : {},
      signal,
    });
    return schedules;
  }

  /**
   * `recurrence` is a five-field cron expression in UTC, and it has to have a
   * next occurrence — `0 0 30 2 *` is well-formed and never arrives, and is
   * refused rather than stored.
   */
  create(
    input: { reportId: string; agentId: string; recurrence: string },
    signal?: AbortSignal
  ): Promise<ScheduleSummary> {
    return this.http.request({ method: "POST", path: "/schedules", body: input, signal });
  }

  /**
   * Change the cadence, or turn it on or off.
   *
   * Changing the cadence re-times the next run, so moving a weekly publish
   * from Friday to Monday does not fire once more on the Friday.
   */
  update(
    id: string,
    input: { recurrence?: string; enabled?: boolean },
    signal?: AbortSignal
  ): Promise<ScheduleSummary> {
    return this.http.request({
      method: "PATCH",
      path: `/schedules/${encodeURIComponent(id)}`,
      body: input,
      signal,
    });
  }

  /** Remove it. `update(id, { enabled: false })` pauses it instead. */
  delete(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/schedules/${encodeURIComponent(id)}`,
      signal,
    });
  }
}
