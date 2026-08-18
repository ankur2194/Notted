// Part 66 — the signed webhook envelope and its HMAC.
//
// Pure and Nest-free: no injection, no I/O, no clock of its own, so the exact
// bytes a receiver has to reproduce can be reasoned about (and tested) alone.
//
// SERIALIZE ONCE. `webhookBody` produces the string; that same string is what
// gets signed and what gets written to the socket. Re-serializing between
// signing and sending — even through an equivalent JSON encoder — is how a
// signature silently stops matching, so no caller may re-stringify the payload.
//
// TIMESTAMP TOLERANCE IS THE RECEIVER'S JOB. We sign the timestamp and publish
// the recommended window (`WEBHOOK_SIGNATURE_TOLERANCE_SECONDS`), but we do not
// enforce a window on outbound sends: a queued retry is legitimately minutes
// old, and refusing to send it would turn our own backlog into dropped events.
// `verifyWebhookSignature` exists for our own verification-challenge round trip
// and as the executable statement of the algorithm documented for receivers in
// `docs/API.md`.

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_SIGNATURE_VERSION,
} from "./webhooks.constants";

export interface WebhookBodyInput {
  /** The stable event id: identical across every attempt and across a replay. */
  readonly id: string;
  readonly event: string;
  /** ISO-8601 with an explicit offset. */
  readonly occurredAt: string;
  readonly workspaceId: string;
  readonly actorId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * THE KEY ORDER BELOW IS PART OF THE SIGNED CONTRACT.
 *
 * `JSON.stringify` serializes an object literal in its written order, so
 * reordering these six properties changes the bytes, changes the HMAC, and
 * silently invalidates every receiver's signature check with no error on our
 * side. The `data` object's own key order is fixed by whoever builds it, for
 * the same reason.
 */
export function webhookBody(input: WebhookBodyInput): string {
  return JSON.stringify({
    id: input.id,
    event: input.event,
    occurredAt: input.occurredAt,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    data: input.data,
  });
}

/**
 * The canonical signed string is exactly `${timestampSeconds}.${body}`, with
 * the timestamp in unix SECONDS and `body` the exact bytes that go on the wire.
 * Binding the timestamp into the HMAC is what stops a captured delivery from
 * being replayed with a fresher `t=`.
 */
function canonicalString(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

export function webhookSignature(secret: string, timestampSeconds: number, body: string): string {
  return createHmac("sha256", secret)
    .update(canonicalString(timestampSeconds, body), "utf8")
    .digest("hex");
}

/** The `x-notted-signature` value: `t=<unix seconds>,v1=<lowercase hex>`. */
export function signatureHeader(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},${WEBHOOK_SIGNATURE_VERSION}=${webhookSignature(secret, timestampSeconds, body)}`;
}

const HEADER_PATTERN = new RegExp(
  `^t=(\\d{1,15}),${WEBHOOK_SIGNATURE_VERSION}=([0-9a-f]{64})$`,
  "u",
);

/**
 * Verifies a header we received back (the verification challenge), and the
 * reference implementation receivers copy.
 *
 * The digest comparison uses `timingSafeEqual` rather than `===`: a plain
 * string compare short-circuits at the first differing byte, and the timing of
 * that short circuit leaks how much of a candidate signature is correct — which
 * is enough to forge one byte at a time. `timingSafeEqual` THROWS on a length
 * mismatch, so the lengths are checked first and separately.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds: number = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const match = HEADER_PATTERN.exec(header.trim());
  if (match === null) return false;

  const timestampSeconds = Number(match[1]);
  if (!Number.isSafeInteger(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  const presented = Buffer.from(match[2]!, "hex");
  const expected = Buffer.from(webhookSignature(secret, timestampSeconds, body), "hex");
  if (presented.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(presented, expected);
}
