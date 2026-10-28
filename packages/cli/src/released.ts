/**
 * What each published version of this CLI can actually do.
 *
 * Written after 0.3.0 went to npm in the middle of a working day and landed
 * three commands short. `send`, `unshare` and `comments retract` were all
 * built and merged and documented within hours either side of the publish, so
 * `docs/cli.md` taught three commands that `npm i -g deliverd` did not
 * install — and nothing anywhere said so. The version number had not moved
 * since before any of them existed.
 *
 * Nothing offline can check what npm is serving. What it can check is that the
 * command set has not changed since the version in `package.json` was last
 * accounted for, which is the same failure caught one step earlier: add a
 * command and the guard fails until you both record the new set and give it a
 * version to be recorded under. Publishing then ships what the number claims.
 *
 * Append-only. Old entries are the record of what a given version could do,
 * which is what somebody on 0.3.0 reading today's docs needs to know.
 */
export const RELEASED: Record<string, readonly string[]> = {
  "0.3.0": [
    "add", "analytics", "answer", "approvals", "archive", "ask", "cancel",
    "collect", "comments", "complete", "copy", "create", "data", "evidence",
    "flows", "get", "list", "login", "open", "publish", "rename", "resolve",
    "reviews", "rm", "rollback", "schedules", "set", "setup", "share", "start",
    "templates", "unarchive", "update", "versions", "who", "workspaces",
  ],
  /*
   * Three commands 0.3.0 was missing, and the `comments list` fix.
   *
   * `send` and `unshare` were the CLI halves of the send-a-report and
   * revoke-access slices; `comments retract` is the retraction slice. A minor
   * bump rather than a patch, because three new verbs is not a bugfix — even
   * though the reason it is being cut is one.
   */
  "0.4.0": [
    "add", "analytics", "answer", "approvals", "archive", "ask", "cancel",
    "collect", "comments", "complete", "copy", "create", "data", "evidence",
    "flows", "get", "list", "login", "open", "publish", "rename", "resolve",
    "retract", "reviews", "rm", "rollback", "schedules", "send", "set",
    "setup", "share", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],

  /*
   * The action registry reaches the CLI: `actions push` and `actions list`.
   *
   * `push` is why it is here at all. An action's id, its input schema and
   * which of its fields an approver may correct belong beside the function
   * that performs them, and the only thing that keeps those in step is the
   * deploy shipping both. A registry kept by hand in a web form drifts from
   * the code on the first refactor, and nobody finds out until a policy
   * stops matching the thing it was written about.
   *
   * A minor rather than a patch, on the reasoning 0.4.0 gives above: two
   * new verbs is not a bugfix.
   */
  "0.5.0": [
    "actions", "add", "analytics", "answer", "approvals", "archive",
    "ask", "cancel", "collect", "comments", "complete", "copy", "create",
    "data", "evidence", "flows", "get", "list", "login", "open", "publish",
    "push", "rename", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "start", "templates",
    "unarchive", "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Policy authoring: `policy push`, `policy list`, `policy activate`,
   * `policy simulate`.
   *
   * 0.5.0 gave the CLI the vocabulary — which actions exist and what shape
   * their arguments are. This is what any of it *costs*: allowed, refused, or
   * a person decides. The file belongs in the repository for the same reason
   * the actions file does, and for one more — a rule kept in a web form has no
   * diff, so the sentence that removes a human from a payment is changed with
   * nobody reviewing it.
   *
   * `simulate` is what makes `push` safe to run, and it is why these two verbs
   * arrived together rather than in the order the surfaces were built: pushing
   * rules you cannot try first is a worse product than not pushing them.
   *
   * Two things this does **not** do, both deliberate. It is not an upsert —
   * `push` adds a version to a policy that exists rather than overwriting it,
   * because silently replacing the rules an organisation is running under is
   * the one write nobody should make by accident. And every verb here needs a
   * key belonging to an owner or an administrator: writing a rule is how
   * authority is granted, so the scope on the key is not the control.
   *
   * A minor rather than a patch, on the reasoning 0.4.0 gives above.
   */
  "0.6.0": [
    "actions", "activate", "add", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],

  /*
   * Opened because 0.6.0 is now on npm. Same commands: publishing does not
   * change what the CLI can do, it changes what somebody can install. A new
   * verb added here fails "only ever grew" until this number moves to 0.7.0.
   */
  "0.6.1": [
    "actions", "activate", "add", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],

  /*
   * Approve with changes and callbacks reach the CLI. No new verb: `ask`
   * gains `--input`, `--editable`, `--callback` and `critical` risk, and an
   * approval prints what the approver changed and what to run with. The
   * command set is 0.6.1's, and 0.6.1 was never published. A minor rather
   * than a patch anyway, because new options are new things a script can do,
   * and a script pinned to `~0.6` should not receive them without a line to
   * read.
   */
  "0.7.0": [
    "actions", "activate", "add", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],

  /*
   * Opened because 0.7.0 is now on npm (24 September 2026, from 877e05b). Same
   * commands; a new option here is a minor, so it moves this to 0.8.0.
   */
  "0.7.1": [
    "actions", "activate", "add", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],

  /*
   * Agent governance, read from a terminal: `agents list|get` and
   * `gates show|evidence`. 0.7.1 was never published, so this replaces it as
   * the working version.
   */
  "0.8.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "gates", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share", "show",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],
  /*
   * Opened because 0.8.0 is now on npm (1 October 2026, from c77a501). Same
   * commands; a new one makes this 0.9.0.
   */
  "0.8.1": [
    "actions", "activate", "add", "agents", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "gates", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share", "show",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],
  "0.8.2": [
    "actions", "activate", "add", "agents", "analytics", "answer", "approvals",
    "archive", "ask", "cancel", "collect", "comments", "complete", "copy",
    "create", "data", "evidence", "flows", "gates", "get", "list", "login", "open",
    "policy", "publish", "push", "rename", "resolve", "retract", "reviews",
    "rm", "rollback", "schedules", "send", "set", "setup", "share", "show",
    "simulate", "start", "templates", "unarchive", "unshare", "update",
    "versions", "who", "workspaces",
  ],
  /*
   * Task Graph: `tasks start|list|get|context|graph|update|side-task|finding|
   * approve-decision|complete|apply|reopen|cancel|link`. 0.8.2 was never
   * published and carried no new command; nine new verbs make this a minor.
   */
  "0.9.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "collect",
    "comments", "complete", "context", "copy", "create", "data", "evidence",
    "finding", "flows", "gates", "get", "graph", "link", "list", "login",
    "open", "policy", "publish", "push", "rename", "reopen", "resolve",
    "retract", "reviews", "rm", "rollback", "schedules", "send", "set",
    "setup", "share", "show", "side-task", "simulate", "start", "tasks",
    "templates", "unarchive", "unshare", "update", "versions", "who",
    "workspaces",
  ],
  /* Opened because 0.9.0 is on npm (7 October 2026, from cf43636). Same commands. */
  "0.9.1": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "collect",
    "comments", "complete", "context", "copy", "create", "data", "evidence",
    "finding", "flows", "gates", "get", "graph", "link", "list", "login",
    "open", "policy", "publish", "push", "rename", "reopen", "resolve",
    "retract", "reviews", "rm", "rollback", "schedules", "send", "set",
    "setup", "share", "show", "side-task", "simulate", "start", "tasks",
    "templates", "unarchive", "unshare", "update", "versions", "who",
    "workspaces",
  ],
  /* Opened because 0.9.1 is on npm (8 October 2026, from 87414b1). Same commands; 0.9.1 added `--task` on `publish` and `update`. */
  "0.9.2": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "collect",
    "comments", "complete", "context", "copy", "create", "data", "evidence",
    "finding", "flows", "gates", "get", "graph", "link", "list", "login",
    "open", "policy", "publish", "push", "rename", "reopen", "resolve",
    "retract", "reviews", "rm", "rollback", "schedules", "send", "set",
    "setup", "share", "show", "side-task", "simulate", "start", "tasks",
    "templates", "unarchive", "unshare", "update", "versions", "who",
    "workspaces",
  ],

  /* Opened because 0.9.2 is on npm (12 October 2026, from 8d8877b). Same commands. */
  "0.9.3": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "collect",
    "comments", "complete", "context", "copy", "create", "data", "evidence",
    "finding", "flows", "gates", "get", "graph", "link", "list", "login",
    "open", "policy", "publish", "push", "rename", "reopen", "resolve",
    "retract", "reviews", "rm", "rollback", "schedules", "send", "set",
    "setup", "share", "show", "side-task", "simulate", "start", "tasks",
    "templates", "unarchive", "unshare", "update", "versions", "who",
    "workspaces",
  ],
  /*
   * Compliance Mode from a build step: `governance show`, `evidence`, `check`,
   * `thresholds` and `pack`. Scored evidence from an eval or red-team tool's
   * own report, and a gate that exits non-zero, are the release gate in CI.
   * New verbs, so a minor; 0.9.3 was opened and never published.
   */
  "0.10.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "thresholds", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.10.1 because 0.10.0 is on npm (13 October 2026, from 29fa0bb),
   * and renamed when a command went: `governance thresholds` is removed. No key
   * sets thresholds — a person does, in the app — so it was refused to everyone.
   */
  "0.11.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.11.1 because 0.11.0 is on npm (13 October 2026, from 3e504e2),
   * and renamed for an addition: `governance evidence --langfuse`. Same commands.
   */
  "0.12.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* Opened because 0.12.0 is on npm (14 October 2026, from d3fb8c8). Same commands. */
  "0.12.1": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.12.2 because 0.12.1 is on npm (14 October 2026, from fdba5f5),
   * and renamed for an addition: `governance evidence --langsmith`. Same commands.
   */
  "0.13.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.13.1 because 0.13.0 is on npm (14 October 2026, from 5bdd3a4),
   * and renamed for an addition: `governance evidence --braintrust`. Same commands.
   */
  "0.14.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.14.1 because 0.14.0 is on npm (14 October 2026, from 9aa2d17),
   * and renamed for an addition: `governance evidence --weave`. Same commands.
   */
  "0.15.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* Opened because 0.15.0 is on npm (14 October 2026, from 75da897). Same commands. */
  "0.15.1": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /*
   * Opened as 0.15.2 because 0.15.1 is on npm (14 October 2026, from ae28b1c),
   * and renamed for an addition: `governance release`, and the release a run
   * tested on `governance evidence`.
   */
  "0.16.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* Opened because 0.16.0 is on npm (14 October 2026, from e914335). Same commands. */
  "0.16.1": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* Opened because 0.16.1 is on npm (15 October 2026, from 4c58d4e). Same commands. */
  "0.16.2": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* Opened because 0.16.2 is on npm (21 October 2026, from 80475ec). Same commands. */
  "0.16.3": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "versions", "who", "workspaces",
  ],

  /* `verify`, which checks an evidence pack offline, and `audit`, which reads the audit log. Two new verbs, so a minor. */
  "0.17.0": [
    "actions", "activate", "add", "agents", "analytics", "answer", "apply",
    "approvals", "approve-decision", "archive", "ask", "audit", "cancel", "check",
    "collect", "comments", "complete", "context", "copy", "create", "data",
    "evidence", "finding", "flows", "gates", "get", "governance", "graph",
    "link", "list", "login", "open", "pack", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm", "rollback",
    "schedules", "send", "set", "setup", "share", "show", "side-task",
    "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "verify", "versions", "who", "workspaces",
  ],

  /* Opened as 0.17.1 because 0.17.0 is on npm (25 October 2026, from f7e9136). `knowledge` and `playbooks` for Context, so a minor. */
  "0.18.0": [
    "actions", "activate", "add", "agents", "agents-md", "analytics", "answer",
    "apply", "approvals", "approve-decision", "archive", "ask", "audit",
    "cancel", "check", "collect", "comments", "complete", "context", "copy",
    "create", "data", "evidence", "export", "finding", "flows", "gates", "get",
    "given", "governance", "graph", "import", "knowledge", "link", "list",
    "login", "open", "pack", "playbooks", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm",
    "rollback", "schedules", "search", "send", "set", "setup", "share", "show",
    "side-task", "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "verify", "versions", "who", "workspaces",
  ],

  /* Opened as 0.18.1 because 0.18.0 is on npm (25 October 2026, from ae62d74). `playbooks use` for approved prompts, so a minor. */
  "0.19.0": [
    "actions", "activate", "add", "agents", "agents-md", "analytics", "answer",
    "apply", "approvals", "approve-decision", "archive", "ask", "audit",
    "cancel", "check", "collect", "comments", "complete", "context", "copy",
    "create", "data", "evidence", "export", "finding", "flows", "gates", "get",
    "given", "governance", "graph", "import", "knowledge", "link", "list",
    "login", "open", "pack", "playbooks", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm",
    "rollback", "schedules", "search", "send", "set", "setup", "share", "show",
    "side-task", "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "use", "verify", "versions", "who", "workspaces",
  ],

  /* Opened because 0.19.0 is on npm (28 October 2026, from d1ffe75). Same commands. */
  "0.19.1": [
    "actions", "activate", "add", "agents", "agents-md", "analytics", "answer",
    "apply", "approvals", "approve-decision", "archive", "ask", "audit",
    "cancel", "check", "collect", "comments", "complete", "context", "copy",
    "create", "data", "evidence", "export", "finding", "flows", "gates", "get",
    "given", "governance", "graph", "import", "knowledge", "link", "list",
    "login", "open", "pack", "playbooks", "policy", "publish", "push",
    "release", "rename", "reopen", "resolve", "retract", "reviews", "rm",
    "rollback", "schedules", "search", "send", "set", "setup", "share", "show",
    "side-task", "simulate", "start", "tasks", "templates", "unarchive",
    "unshare", "update", "use", "verify", "versions", "who", "workspaces",
  ],
};

/**
 * Commands a version removed on purpose, each with the decision behind it.
 * `version.test.ts` refuses a command that disappears between versions unless
 * it is written down here — a removal breaks whoever scripted against it, so
 * it has to have been decided, and this is where the decision is kept.
 */
export const REMOVED: Record<string, Record<string, string>> = {
  "0.11.0": {
    thresholds:
      "Thresholds are set by a person in the app and no key sets them, a person's own included, because whatever submits the results must not also decide what passes and an agent may be holding that key. The command was refused to everyone, so it went (decided 13 October 2026).",
  },
};

/**
 * Every version of this CLI npm has served.
 *
 * `RELEASED` above records what each version *can do*, and it was found not
 * to be enough on its own: 0.5.0 and 0.6.0 were recorded correctly, with the
 * `actions` and `policy` commands they introduced, and `docs/cli.md` taught
 * all six — while npm served 0.4.0, which has none of them. A version being
 * accounted for says nothing about whether it exists anywhere but this tree.
 *
 * So this is the second fact, kept beside the first the way `@deliverd/sdk`
 * keeps it. `docs.test.ts` in the web app reads it and refuses to let
 * `docs/cli.md` show a command without saying, in the same section, that npm
 * does not carry it yet — and refuses the caveat once npm does.
 *
 * **Add the version here when you publish it, not before.** An entry is a
 * claim that `npm i -g deliverd@x` works today. 0.1.0 through 0.2.1 predate
 * `RELEASED` and are listed because they were published, not because anybody
 * recorded what they could do.
 */
export const PUBLISHED_TO_NPM = [
  "0.1.0",
  "0.2.0",
  "0.2.1",
  "0.3.0",
  "0.4.0",
  /*
   * 0.5.0 is missing from this list and that is correct: npm went from 0.4.0
   * to 0.6.0. The `actions` commands 0.5.0 records were never installable
   * under that number, so listing it would be a claim that
   * `npm i -g deliverd@0.5.0` works — and it does not. The order check below
   * asks that entries ascend, not that they are contiguous, for exactly this.
   */
  "0.6.0",
  "0.7.0",
  "0.8.0",
  "0.8.1",
  "0.9.0",
  "0.9.1",
  "0.9.2",
  "0.10.0",
  "0.11.0",
  "0.12.0",
  "0.12.1",
  "0.13.0",
  "0.14.0",
  "0.15.0",
  "0.15.1",
  "0.16.0",
  "0.16.1",
  "0.16.2",
  "0.17.0",
  "0.18.0",
  "0.19.0",
] as const;
