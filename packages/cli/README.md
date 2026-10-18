# deliverd

You build the action. Deliverd handles the human.

The Deliverd CLI: ask a person from a build step, a pipeline or a script — for
an approval, a review or an answer — and carry on when they reply. It also
keeps long work on its objective, publishes what an AI wrote to a secure URL,
and connects your AI tools to Deliverd over MCP.

## Start free

1. [Create a free Deliverd account](https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=readme).
   The Free plan needs no card.
2. `npx deliverd login` opens a browser, signs this machine in to it, and
   stores a token. In CI, set `DELIVERD_URL` and `DELIVERD_TOKEN` instead.
3. Ask somebody something, below.

## Ask a person

```bash
npx deliverd login                  # opens a browser once; CI sets DELIVERD_URL and DELIVERD_TOKEN instead

npx deliverd ask "Ship the Q3 pack to Acme?" \
  --why "Final numbers, partner-reviewed" \
  --approver partner@firm.com --wait
```

`--wait` blocks until somebody decides, or an hour passes (`--wait 1800` for
half of one), and exits non-zero on anything but an approval — so `set -e` is
the whole integration. The approver gets an email and a notification, opens a
page that works on a phone, and approves, rejects with a reason, or asks a
question back; a wait stops on an unanswered question rather than timing out
silently.

Send the arguments you will run with, and name the ones a person may fix:

```bash
npx deliverd ask "Refund Acme for invoice 4821" \
  --input '{"customer": "acme", "amount": 1240}' --editable amount \
  --risk high --approver finance@firm.com --wait --json > decision.json

jq .approvedInput decision.json     # run with what they approved, not what you proposed
```

`--callback https://…` has the outcome POSTed to you when somebody decides,
instead of waiting. Everything else about a request is readable later:

```bash
npx deliverd approvals                       # what you have asked for
npx deliverd approvals get <id> --wait       # block on one already raised
npx deliverd approvals answer <id> --question <qid> --answer "Yes, signed off Friday"
npx deliverd approvals cancel <id>
```

Reviews and requests for information work the same way:

```bash
npx deliverd reviews ask "Check the Q3 commentary" --reviewer "Finance team" --report finance/weekly
npx deliverd reviews get <id>

npx deliverd collect ask "Renewal details" \
  --question "Which quarter?" "Who owns the budget?" --respondent ops@firm.com
npx deliverd collect get <id>

npx deliverd flows start "Q3 close"          # then pass --flow <id> to the above
```

## Keep long work on its objective

```bash
npx deliverd tasks start "Ship SSO" --objective "Customers sign in with their own IdP"
npx deliverd tasks                           # objectives, most recently active first
npx deliverd tasks context <id>              # what an agent is handed instead of the history
npx deliverd tasks update <id> --state "Login works in staging" --next "Roll out to one tenant"
```

## Connect your AI tools

```bash
npx deliverd setup
```

Finds Claude Code, Codex, Claude Desktop, Cursor and Muse Code on your machine and
connects whichever are installed, so each can ask a person, check a gate,
keep a task and publish through Deliverd's MCP server.

No API token is written anywhere. The server implements the MCP authorization
spec, so each client registers itself and asks you to approve it in a browser.

It merges into whatever configuration is already there, keeps a timestamped
backup of any file it changes, and refuses a file it cannot parse rather than
overwriting it — those files hold your other MCP servers.

Codex needs one more step of its own. It does not begin the approval flow on
first use the way the Claude clients do, so after `setup` run:

```bash
codex mcp login deliverd
```

Muse Code, Meta's coding agent, signs in the same way:

```bash
muse mcp login deliverd
```

| Option | |
|---|---|
| `--print` | Show the settings instead of writing anything |
| `--agent <id>` | Just one: `claude-code`, `codex`, `claude-desktop`, `cursor`, `muse-code` |
| `--url <url>` | A self-hosted server (default `https://deliverd.dev`) |

## Publish from the terminal

```bash
npx deliverd publish ./report --audience "Finance team"
npx deliverd update finance/weekly ./report
npx deliverd rename finance/weekly --title "Weekly Finance"
npx deliverd list
```

`login` opens a browser and stores a token in `~/.config/deliverd/config.json`.

Renaming keeps the old address working, so links you have already shared do not
break.

`--task <id>` on `publish` or `update` keeps a report with the task it was
written for: it is listed on the task and in `deliverd tasks context`.

## Requirements

Node.js 20 or later.

## Documentation

[deliverd.dev/docs/developers/cli](https://deliverd.dev/docs/developers/cli?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=readme) —
every command, flag and exit code. No account yet?
[Create a free one](https://deliverd.dev/sign-up?utm_source=npm&utm_medium=package&utm_campaign=cli&utm_content=readme).

## Licence

MIT. This covers the CLI only — the Deliverd service it talks to is a separate,
proprietary product.
