import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig, requireConfig } from "../config.js";
import { listing } from "../paging.js";
import { emit, plural, run } from "../ui.js";
import { EVIDENCE_KEY_PATH, parsePublicKey, verified, verifyPack, type Verdict } from "../verify.js";

/**
 * The audit trail, from a terminal: reading it, and checking a pack made
 * from it.
 *
 * `verify` needs no account. It is run by whoever was handed a pack — an
 * auditor, a regulator, opposing counsel — and it checks offline: the key
 * comes from `--key`, or is fetched once, over https, from `--url`, the
 * deployment this CLI is signed in to, or — counted only with
 * `--trust-pack-key` — the address the pack names.
 */
interface AuditEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorLabel: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  chainSeq: number | null;
  rowHash: string | null;
}

/**
 * Where a key may be fetched from: https. Plain http only to this machine,
 * and only when you named the address (`--url`, or the deployment you are
 * signed in to, for a local one): never for the address a pack names.
 */
export function assertSecureKeyUrl(raw: string, allowLoopback = false): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${raw} is not an address. Pass the key with --key.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (allowLoopback && url.protocol === "http:" && loopback)) return;
  throw new Error(
    `Refusing to fetch the public key over ${url.protocol.replace(":", "")} from ${url.host}: ` +
      "anybody on the way could swap it. Use an https address, or pass the key with --key."
  );
}

/**
 * Which address the key is fetched from, checked before anything is fetched:
 * `--url`, else the deployment this CLI is signed in to, else the address
 * the pack names. Null when there is none.
 */
export function keyAddress(
  options: { url?: string },
  signedInTo: string | undefined,
  verdict: Pick<Verdict, "keyUrl">
): { url: string; fromPack: boolean } | null {
  const base = options.url ?? signedInTo;
  if (base) {
    const url = `${base.replace(/\/+$/, "")}${EVIDENCE_KEY_PATH}`;
    assertSecureKeyUrl(url, true);
    return { url, fromPack: false };
  }
  if (!verdict.keyUrl) return null;
  assertSecureKeyUrl(verdict.keyUrl);
  return { url: verdict.keyUrl, fromPack: true };
}

/** Exit codes: verified; not verified; checked only against the key the pack itself names. */
export const VERIFY_EXIT = { verified: 0, notVerified: 1, untrustedKey: 2 } as const;

/**
 * What the check comes to. A pack whose digest and signature both pass is
 * verified only when the key came from somewhere other than the pack: a
 * forger names their own key, and it checks out. `--trust-pack-key` accepts
 * the pack's own address for the key, which is the caller's call to make,
 * not this command's.
 */
export function verifyOutcome(
  verdict: Verdict,
  key: { fromPack: boolean } | null,
  trustPackKey = false
): { verified: boolean; exitCode: number; keyTrusted: boolean } {
  const checksOut = verified(verdict);
  const keyTrusted = !!key && (!key.fromPack || trustPackKey);
  if (checksOut && keyTrusted) return { verified: true, exitCode: VERIFY_EXIT.verified, keyTrusted };
  if (checksOut) return { verified: false, exitCode: VERIFY_EXIT.untrustedKey, keyTrusted };
  return { verified: false, exitCode: VERIFY_EXIT.notVerified, keyTrusted };
}

/**
 * The key: `--key`, else fetched from `--url`, else from the deployment this
 * CLI is signed in to, and only last from where the pack says it is
 * published. A forged pack can name a key of its forger's own, so a key
 * taken from the pack only shows the pack is self-consistent, and
 * `verifyOutcome` does not count it unless `--trust-pack-key` says to.
 * Fetched over https only (`keyAddress`).
 */
async function resolveKey(
  options: { key?: string; url?: string },
  verdict: Verdict
): Promise<{ text: string; from: string; fromPack: boolean } | null> {
  if (options.key) {
    const isFile = existsSync(options.key);
    const text = isFile ? readFileSync(options.key, "utf8") : options.key;
    return { text, from: isFile ? options.key : "--key", fromPack: false };
  }
  const address = keyAddress(options, options.url ? undefined : loadConfigQuietly()?.baseUrl, verdict);
  if (!address) return null;
  const { url, fromPack } = address;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not fetch the public key from ${url} (${response.status}). Pass it with --key.`
    );
  }
  const body = (await response.json()) as { publicKey?: string };
  if (typeof body.publicKey !== "string") throw new Error(`${url} did not return a public key.`);
  return { text: body.publicKey, from: url, fromPack };
}

function loadConfigQuietly(): { baseUrl: string } | null {
  // Only a hint for where the key lives; never a reason to stop.
  if (process.env.DELIVERD_TOKEN && !process.env.DELIVERD_URL) return null;
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

const SIGNATURE_LINE: Record<Verdict["signature"], string> = {
  valid: "✓ Signed by the deployment's key",
  invalid: "✗ The signature does not check out against this key",
  unsigned: "○ Not signed",
  no_key: "? Signed, but there is no key to check it with",
};

export function auditCommands(program: Command): void {
  program
    .command("verify")
    .description("Check an evidence pack's digest and signature, offline")
    .argument("<pack>", "The pack, as JSON ('-' reads standard input)")
    .option("--key <file|pem>", "The deployment's public key, as a file or the key itself")
    .option("--url <url>", "Fetch the key from this deployment instead of the one the pack names")
    .option("--trust-pack-key", "Accept a key fetched from the address the pack itself names")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(async (file: string, options: { key?: string; url?: string; trustPackKey?: boolean; json?: boolean }) => {
        const text = readFileSync(file === "-" ? 0 : file, "utf8");
        let pack: Record<string, unknown>;
        try {
          pack = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error(`${file} is not JSON. Verify the JSON pack, not the CSV.`);
        }
        const first = verifyPack(pack, null);
        const key = first.signature === "unsigned" ? null : await resolveKey(options, first);
        const verdict = key ? verifyPack(pack, parsePublicKey(key.text)) : first;
        const outcome = verifyOutcome(verdict, key, options.trustPackKey);
        const ok = outcome.verified;
        const result = {
          verified: ok,
          ...verdict,
          keyFrom: key?.from ?? null,
          keyFromPack: key?.fromPack ?? false,
          keyTrusted: outcome.keyTrusted,
        };
        emit(options.json, result, () => {
          console.log(
            verdict.digestValid
              ? "✓ The digest recomputes: the file matches itself"
              : "✗ The digest does not recompute: the file was changed after it was made"
          );
          console.log(SIGNATURE_LINE[verdict.signature]);
          if (verdict.keyId) console.log(`  key ${verdict.keyId}${key ? ` (from ${key.from})` : ""}`);
          if (verdict.unsignedReason) console.log(`  ${verdict.unsignedReason}`);
          if (key?.fromPack) {
            console.log(
              options.trustPackKey
                ? "  ⚠ The key came from the address the pack itself names, accepted because\n" +
                    "    you passed --trust-pack-key."
                : "  ⚠ The key came from the address the pack itself names, so this only shows\n" +
                    "    the pack agrees with itself: a forger names their own key. Pass --url or\n" +
                    "    --key for the deployment you expect, or --trust-pack-key to accept it."
            );
          }
          console.log(
            ok
              ? "\nVerified."
              : outcome.exitCode === VERIFY_EXIT.untrustedKey
                ? "\nNot verified: checked only against the key the pack names."
                : "\nNot verified."
          );
        });
        process.exitCode = outcome.exitCode;
      })
    );

  const audit = program.command("audit").description("The organisation's audit log");

  audit
    .command("list", { isDefault: true })
    .description("Audit log entries, newest first (owners, administrators and security administrators)")
    .option("--since <time>", "Entries at or after this time (ISO 8601)")
    .option("--until <time>", "Entries at or before this time (ISO 8601)")
    .option("--type <eventType>", "An event type, or a family ending in a dot, e.g. legal_hold.")
    .option("--actor <id>", "The person, agent or key that acted")
    .option("--actor-type <type>", "user, agent, api_key, link, guest or system")
    .option("--resource-type <type>", "What the entry is about, e.g. report")
    .option("--resource <id>", "The id of what it is about")
    .option("--flow <id>", "Entries about this project and everything attached to it")
    .option("--after-seq <n>", "Entries after this chain position, oldest first: the way to tail the log", (v) => Number(v))
    .option("--limit <n>", "One page of this many (default: all of them)", (v) => Number(v))
    .option("--cursor <cursor>", "Continue from a previous page")
    .option("--json", "Print the result as JSON, for scripting")
    .action(
      run(
        async (options: {
          since?: string;
          until?: string;
          type?: string;
          actor?: string;
          actorType?: string;
          resourceType?: string;
          resource?: string;
          flow?: string;
          afterSeq?: number;
          limit?: number;
          cursor?: string;
          json?: boolean;
        }) => {
          const config = requireConfig();
          const { items, nextCursor } = await listing<AuditEvent>(config, "/audit-events", "auditEvents", {
            since: options.since,
            until: options.until,
            eventType: options.type,
            actorId: options.actor,
            actorType: options.actorType,
            resourceType: options.resourceType,
            resourceId: options.resource,
            flowId: options.flow,
            afterSeq: options.afterSeq,
            limit: options.limit,
            cursor: options.cursor,
          });
          emit(options.json, { auditEvents: items, nextCursor }, () => {
            if (items.length === 0) {
              console.log("No entries.");
              return;
            }
            for (const e of items) {
              const about = e.resourceType ? ` · ${e.resourceType} ${e.resourceId ?? ""}`.trimEnd() : "";
              console.log(
                `${e.createdAt}  ${e.eventType}  ${e.actorLabel ?? e.actorType}${about}` +
                  (e.chainSeq !== null ? `  #${e.chainSeq}` : "")
              );
            }
            console.log(`\n${plural(items.length, "entry", "entries")}`);
            if (nextCursor) console.log(`More: --cursor ${nextCursor}`);
          });
        }
      )
    );
}
