import {
  purviewOutcomeFromResponse,
  purviewUnavailable,
  type PurviewOnUnavailable,
  type PurviewOutcome,
} from "./purview-rules.js";

export { type PurviewOutcome, type PurviewOnUnavailable, type PurviewRestriction } from "./purview-rules.js";

/**
 * Ask your organisation's Microsoft Purview about a text before it goes to a
 * model, and hold its answer beside Deliverd's.
 *
 * ```ts
 * const purview = purviewCheck({
 *   token: () => credential.getToken("https://graph.microsoft.com/.default").then((t) => t.token),
 *   userId: entraObjectIdOfTheUser,
 *   app: { name: "Claims assistant", entraAppId: "11111111-…" },
 * });
 * const screened = await deliverd.screen(prompt, { aiSystemId: CLAIMS_MODEL, purview });
 * ```
 *
 * The call goes from where your agent runs straight to Microsoft Graph
 * (`processContent`), with your own Entra app's token, so the text goes to
 * Microsoft and never to Deliverd. Deliverd is sent only the outcome: block,
 * warn, audit or nothing. A block stops the text; a warn puts it to a person.
 *
 * The Entra app needs `Content.Process.User` or `Content.Process.All`
 * (application permission with `userId`, or delegated with the signed-in
 * user's token and no `userId`). Purview applies DLP policies to an
 * Entra-registered app only when they were created with
 * `New-DlpComplianceRule`; one made in the portal alone does not apply.
 */

export interface PurviewCheckOptions {
  /** A Microsoft Graph access token, or a function that returns one. Called on every check, so a credential can refresh it. */
  token: string | (() => string | Promise<string>);
  /** The Entra object id of the user the text is for. Omit to use `/me` with a delegated token. */
  userId?: string;
  /** Your app as Purview knows it: its name and its Entra application (client) id. */
  app: { name: string; entraAppId: string; version?: string };
  /** The agent sending the text, when it is one, as Purview's AI agent info. */
  agent?: { id: string; name: string; version?: string; blueprintId?: string };
  /** One id per conversation, so Purview can group the texts in it. */
  correlationId?: string;
  /** What to do when Purview cannot be reached. Default `ask`: a person decides. */
  onUnavailable?: PurviewOnUnavailable;
  /** Milliseconds to wait for Purview. Default 10,000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A check `screen()` runs on the text before asking Deliverd. */
export type PurviewCheck = (text: string) => Promise<PurviewOutcome>;

const GRAPH = "https://graph.microsoft.com/v1.0";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

/** The body `processContent` takes for a prompt about to be sent to a model. */
export function processContentBody(text: string, options: Pick<PurviewCheckOptions, "app" | "agent" | "correlationId">, sequenceNumber = 0) {
  const now = new Date().toISOString();
  return {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: uuid(),
          content: { "@odata.type": "microsoft.graph.textContent", data: text },
          name: `${options.app.name} prompt`,
          correlationId: options.correlationId ?? uuid(),
          sequenceNumber,
          isTruncated: false,
          createdDateTime: now,
          modifiedDateTime: now,
          ...(options.agent
            ? {
                agents: [
                  {
                    "@odata.type": "microsoft.graph.aiAgentInfo",
                    identifier: options.agent.id,
                    name: options.agent.name,
                    ...(options.agent.version ? { version: options.agent.version } : {}),
                    ...(options.agent.blueprintId ? { blueprintId: options.agent.blueprintId } : {}),
                  },
                ],
              }
            : {}),
        },
      ],
      activityMetadata: { activity: "uploadText" },
      deviceMetadata: {},
      protectedAppMetadata: {
        name: options.app.name,
        version: options.app.version ?? "1.0",
        applicationLocation: { "@odata.type": "microsoft.graph.policyLocationApplication", value: options.app.entraAppId },
      },
      integratedAppMetadata: { name: options.app.name, version: options.app.version ?? "1.0" },
    },
  };
}

export interface EntraAppTokenOptions {
  /** The customer's Entra tenant id: where the DLP policies are. */
  tenantId: string;
  /** The app's application (client) id. */
  clientId: string;
  /** A client secret for it. Keep it in a secret store, never in code. */
  clientSecret: string;
  fetch?: typeof fetch;
}

/**
 * A Microsoft Graph token for an app acting as itself (client credentials),
 * for `purviewCheck`'s `token` where there is no signed-in user: a pipeline,
 * a local MCP server, a back-end agent. Cached until five minutes before it
 * expires. Use it with `userId`, the person the text is about or on behalf of.
 */
export function entraAppToken(options: EntraAppTokenOptions): () => Promise<string> {
  if (!GUID.test(options.tenantId)) throw new Error("entraAppToken: tenantId is your Entra tenant id, a GUID.");
  const doFetch = options.fetch ?? fetch;
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const res = await doFetch(`https://login.microsoftonline.com/${options.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Entra refused the token request (${res.status}).`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Entra returned no access token.");
    cached = { token: body.access_token, until: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 300) * 1000 };
    return cached.token;
  };
}

export function purviewCheck(options: PurviewCheckOptions): PurviewCheck {
  if (!GUID.test(options.app.entraAppId)) throw new Error("purviewCheck: app.entraAppId is your Entra app's application (client) id, a GUID.");
  if (options.userId !== undefined && !GUID.test(options.userId)) throw new Error("purviewCheck: userId is the user's Entra object id, a GUID.");
  const doFetch = options.fetch ?? fetch;
  const url = `${GRAPH}/${options.userId ? `users/${options.userId}` : "me"}/dataSecurityAndGovernance/processContent`;
  const onUnavailable = options.onUnavailable ?? "ask";
  let etag: string | null = null;
  let sequence = 0;

  return async (text: string) => {
    try {
      const token = typeof options.token === "function" ? await options.token() : options.token;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        body: JSON.stringify(processContentBody(text, options, sequence++)),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (res.status === 202 || res.status === 204) return { restriction: null, actions: 0, scopeModified: false, unavailable: false };
      if (!res.ok) return purviewUnavailable(onUnavailable);
      etag = res.headers.get("ETag") ?? etag;
      const outcome = purviewOutcomeFromResponse(await res.json());
      // Purview's policies changed: the next call starts from the new state.
      if (outcome.scopeModified) etag = res.headers.get("ETag");
      return outcome;
    } catch {
      return purviewUnavailable(onUnavailable);
    }
  };
}
