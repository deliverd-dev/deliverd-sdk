/**
 * Microsoft Purview for the MCP server, from environment variables, so a
 * coding agent's screening honours the organisation's DLP policies without a
 * line of code:
 *
 *   DELIVERD_PURVIEW_TENANT_ID      your Entra tenant id
 *   DELIVERD_PURVIEW_CLIENT_ID      an Entra app with Content.Process.All
 *   DELIVERD_PURVIEW_CLIENT_SECRET  a secret for that app
 *   DELIVERD_PURVIEW_USER_ID        the Entra object id of the person using it
 *   DELIVERD_PURVIEW_APP_NAME       optional; how Purview names the app
 *   DELIVERD_PURVIEW_ON_UNAVAILABLE optional; allow, ask (the default) or deny
 *
 * All four required ones, or none: with none, nothing is sent anywhere.
 */

import { entraAppToken, purviewCheck, type PurviewCheck } from "./purview.js";
import type { PurviewOnUnavailable } from "./purview-rules.js";

const REQUIRED = ["DELIVERD_PURVIEW_TENANT_ID", "DELIVERD_PURVIEW_CLIENT_ID", "DELIVERD_PURVIEW_CLIENT_SECRET", "DELIVERD_PURVIEW_USER_ID"] as const;

export function purviewFromEnv(env: Record<string, string | undefined> = process.env, doFetch?: typeof fetch): PurviewCheck | null {
  const set = REQUIRED.filter((k) => env[k]?.trim());
  if (set.length === 0) return null;
  if (set.length < REQUIRED.length) {
    throw new Error(`Microsoft Purview needs all of ${REQUIRED.join(", ")}; missing ${REQUIRED.filter((k) => !set.includes(k)).join(", ")}.`);
  }
  const onUnavailable = env.DELIVERD_PURVIEW_ON_UNAVAILABLE?.trim() || "ask";
  if (!["allow", "ask", "deny"].includes(onUnavailable)) throw new Error("DELIVERD_PURVIEW_ON_UNAVAILABLE is allow, ask or deny.");
  const clientId = env.DELIVERD_PURVIEW_CLIENT_ID!.trim();
  return purviewCheck({
    token: entraAppToken({
      tenantId: env.DELIVERD_PURVIEW_TENANT_ID!.trim(),
      clientId,
      clientSecret: env.DELIVERD_PURVIEW_CLIENT_SECRET!.trim(),
      fetch: doFetch,
    }),
    userId: env.DELIVERD_PURVIEW_USER_ID!.trim(),
    app: { name: env.DELIVERD_PURVIEW_APP_NAME?.trim() || "Deliverd Screen", entraAppId: clientId },
    onUnavailable: onUnavailable as PurviewOnUnavailable,
    fetch: doFetch,
  });
}
