import { createHmac, timingSafeEqual } from "node:crypto";
import { DeliverdError } from "./errors.js";
import type { CallbackEnvelope, WebhookEvent } from "./types.js";

/**
 * Verifying what Deliverd sends you.
 *
 * The scheme is Stripe's — a timestamp and a signature in one header, the
 * timestamp inside the signed material — so this is the verification everyone
 * has written before. It is here anyway because a receiver that skips it is
 * accepting anything anyone posts at the URL, and "write your own HMAC check"
 * is the step every integration guide shows and half of them get wrong.
 *
 * Kept byte-for-byte with the server's own `lib/webhooks/signature.ts`;
 * `sdk-parity.test.ts` on the server holds the two together.
 */

export const SIGNATURE_HEADER = "deliverd-signature";
export const EVENT_HEADER = "deliverd-event";
export const DELIVERY_HEADER = "deliverd-delivery";

/** How old a signature may be. Five minutes, as the server sends. */
export const TOLERANCE_SECONDS = 300;

export function signedPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/**
 * Whether the header is this secret's signature over this body, recently.
 *
 * `body` must be the raw request body, before any JSON parsing — a re-encoded
 * object is a different string and will never verify. In Express that means
 * `express.raw({ type: "application/json" })`; in Next.js `await request.text()`.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  options: { now?: number; toleranceSeconds?: number } = {}
): boolean {
  if (!header) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;

  const parts = new Map(
    header.split(",").map((p) => {
      const at = p.indexOf("=");
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    })
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = createHmac("sha256", secret).update(signedPayload(t, body)).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  // Length first: timingSafeEqual throws on a mismatch, which leaks length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify and parse in one step, the way a handler wants it.
 *
 * Throws rather than returning null, because a webhook route that treats an
 * unverifiable body as "no event" answers 200 and tells the sender everything
 * is fine.
 */
export function constructEvent(
  secret: string,
  body: string,
  header: string | null | undefined,
  options: { now?: number; toleranceSeconds?: number } = {}
): WebhookEvent {
  if (!verifySignature(secret, body, header, options)) {
    throw new DeliverdError(
      400,
      "invalid_signature",
      "The signature did not verify. Check the endpoint's secret, and that you passed the raw request body rather than a re-encoded object."
    );
  }
  try {
    return JSON.parse(body) as WebhookEvent;
  } catch (cause) {
    throw new DeliverdError(400, "invalid_json", "The body verified but is not JSON.", undefined, { cause });
  }
}

/**
 * Verify and parse a per-request callback: what Deliverd POSTs to the
 * `callbackUrl` you gave when you asked, when a person answers.
 *
 * Signed exactly as a webhook is, with the request's own `callbackSecret`
 * (returned once, by the call that made the request) in place of an
 * endpoint's. Throws on a body that does not verify, for the same reason
 * `constructEvent` does.
 */
export function constructCallback(
  callbackSecret: string,
  body: string,
  header: string | null | undefined,
  options: { now?: number; toleranceSeconds?: number } = {}
): CallbackEnvelope {
  return constructEvent(callbackSecret, body, header, options) as unknown as CallbackEnvelope;
}

export class Webhooks {
  verifySignature = verifySignature;
  constructEvent = constructEvent;
  constructCallback = constructCallback;
  readonly signatureHeader = SIGNATURE_HEADER;
  readonly eventHeader = EVENT_HEADER;
  readonly deliveryHeader = DELIVERY_HEADER;
}
