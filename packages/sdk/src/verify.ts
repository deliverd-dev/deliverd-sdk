import {
  claimOnce,
  verifyDecisionToken,
  DecisionTokens,
  type DecisionTokenExpectation,
  type DecisionTokenResult,
  type ReplayGuard,
} from "./decision-token.js";
import type { KeyObject } from "node:crypto";

/**
 * Drop-in checks for the service that performs an action, so "the action
 * cannot happen without a yes" takes a few lines instead of a project.
 *
 * The agent sends the gate's `decisionToken` in the `Deliverd-Decision`
 * header (or wherever you choose). Your service says which action the route
 * performs and what input it is about to act on; the check refuses anything
 * Deliverd did not agree to, exactly, for that action, before your handler
 * runs.
 *
 * ```ts
 * import { requireDecision, memoryReplayGuard } from "@deliverd/sdk/verify";
 *
 * const refunds = requireDecision({
 *   deliverd: "https://deliverd.dev",
 *   action: "finance.refund",
 *   input: (req) => ({ customer_id: req.body.customer_id, amount: req.body.amount, currency: req.body.currency }),
 *   replay: memoryReplayGuard(),
 * });
 * app.post("/refunds", express.json(), refunds, handler);          // Express, Connect
 * fastify.post("/refunds", { preHandler: refunds.fastify }, handler); // Fastify
 * ```
 *
 * For fetch-style handlers (Next.js route handlers, Hono, Workers, Bun),
 * `checkDecision(request, options)` returns null when the request may go
 * ahead, or a `403` Response to send back.
 */

export const DECISION_HEADER = "deliverd-decision";

export interface RequireDecisionOptions<Req> {
  /** The Deliverd deployment you trust, e.g. `https://deliverd.dev`. Its public key is fetched once. */
  deliverd?: string;
  /** Or a key you already hold, with the issuer origin it must name. */
  key?: { publicKey: string | KeyObject; issuer: string };
  /** The action this route performs. */
  action: string | ((req: Req) => string);
  /** The input it is about to act on, exactly as the gate was asked. */
  input: (req: Req) => unknown | Promise<unknown>;
  destination?: (req: Req) => DecisionTokenExpectation["destination"];
  artifactSha256?: (req: Req) => string | null | undefined;
  /** The Deliverd agent id that must have asked. */
  agent?: string | ((req: Req) => string | undefined);
  /** Refuse a token seen before. Use one shared store when you run more than one instance. */
  replay?: ReplayGuard;
  /** Where the token is. Default: the `Deliverd-Decision` header, then `Authorization: Deliverd <token>`. */
  token?: (req: Req) => string | null | undefined;
}

type Headerish = { headers?: Record<string, string | string[] | undefined> | Headers };

function headerOf(req: Headerish, name: string): string | null {
  const h = req.headers;
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export function tokenFrom(req: Headerish): string | null {
  const direct = headerOf(req, DECISION_HEADER);
  if (direct) return direct.trim();
  const auth = headerOf(req, "authorization");
  const m = auth?.match(/^Deliverd\s+(\S+)$/i);
  return m ? m[1]! : null;
}

/** The check itself, for any request shape. */
export function decisionChecker<Req>(options: RequireDecisionOptions<Req>): (req: Req) => Promise<DecisionTokenResult> {
  if (!options.deliverd && !options.key) throw new Error("requireDecision needs `deliverd` (the deployment URL) or `key`.");
  const tokens = options.deliverd ? new DecisionTokens(options.deliverd) : null;
  return async (req) => {
    const token = options.token ? options.token(req) : tokenFrom(req as Headerish);
    if (!token) return { ok: false, reason: "missing" };
    const agent = typeof options.agent === "function" ? options.agent(req) : options.agent;
    const expected: DecisionTokenExpectation = {
      action: typeof options.action === "function" ? options.action(req) : options.action,
      input: await options.input(req),
      destination: options.destination?.(req) ?? null,
      artifactSha256: options.artifactSha256?.(req) ?? null,
      ...(agent !== undefined ? { agent } : {}),
    };
    if (tokens) return tokens.verify(token, expected, { replay: options.replay });
    return claimOnce(verifyDecisionToken(token, expected, options.key!), options.replay);
  };
}

const MESSAGE: Record<string, string> = {
  missing: "This action needs a Deliverd decision token, and none was sent.",
  replayed: "This decision token has already been used.",
};

function refusal(result: Extract<DecisionTokenResult, { ok: false }>) {
  return { error: "decision_required", reason: result.reason, message: MESSAGE[result.reason] ?? `The Deliverd decision token does not authorise this request (${result.reason}).` };
}

type NodeRes = { statusCode?: number; setHeader?(k: string, v: string): void; end?(body: string): void; status?(code: number): NodeRes; json?(body: unknown): void };

/** Express/Connect middleware, with `.fastify` for a Fastify preHandler. */
export function requireDecision<Req = any>(options: RequireDecisionOptions<Req>) {
  const check = decisionChecker(options);
  const middleware = async (req: Req, res: NodeRes, next: (err?: unknown) => void) => {
    try {
      const result = await check(req);
      if (result.ok) {
        (req as { deliverdDecision?: unknown }).deliverdDecision = result.claims;
        return next();
      }
      const body = refusal(result);
      if (typeof res.status === "function" && typeof res.json === "function") return res.status(403)!.json!(body);
      res.statusCode = 403;
      res.setHeader?.("content-type", "application/json");
      res.end?.(JSON.stringify(body));
    } catch (err) {
      next(err);
    }
  };
  const fastify = async (req: Req, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    const result = await check(req);
    if (result.ok) {
      (req as { deliverdDecision?: unknown }).deliverdDecision = result.claims;
      return;
    }
    return reply.code(403).send(refusal(result));
  };
  return Object.assign(middleware, { fastify, check });
}

/** For fetch-style handlers: null to go ahead, or the 403 Response to return. */
export async function checkDecision(request: Request, options: RequireDecisionOptions<Request>): Promise<Response | null> {
  const result = await decisionChecker(options)(request);
  if (result.ok) return null;
  return new Response(JSON.stringify(refusal(result)), { status: 403, headers: { "content-type": "application/json" } });
}

export { memoryReplayGuard, type ReplayGuard } from "./decision-token.js";
