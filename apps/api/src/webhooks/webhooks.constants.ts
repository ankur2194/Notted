// Part 66 — outbound webhooks: shared constants.
//
// Kept Nest-free so the pure signature helpers, the URL guard, the sender, the
// service and the delivery worker all read the same values without importing a
// module.

/** `audit_logs.entity_type` for a webhook endpoint row (varchar(50)). */
export const WEBHOOK_AUDIT_ENTITY_TYPE = "webhook";

/** `audit_logs.action` values written by the webhooks service. */
export const WEBHOOK_AUDIT_ACTIONS = Object.freeze({
  created: "webhook.created",
  updated: "webhook.updated",
  deleted: "webhook.deleted",
  secretRotated: "webhook.secretRotated",
  verified: "webhook.verified",
  redelivered: "webhook.redelivered",
} as const);

/** Sent as `user-agent` on every delivery, so a receiver can filter our traffic. */
export const WEBHOOK_USER_AGENT = "Notted-Webhook/1";

/** Signature scheme version, carried in the `v1=` field of the header. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/**
 * We read at most 8 KB off the wire and store at most 500 characters of it, so
 * a hostile receiver cannot use our own delivery log as unbounded storage: the
 * endpoint URL is admin-supplied, and an endpoint that answers with megabytes
 * would otherwise write megabytes per attempt into `webhook_deliveries`.
 */
export const WEBHOOK_RESPONSE_READ_LIMIT_BYTES = 8 * 1_024;
export const WEBHOOK_SNIPPET_MAX_LENGTH = 500;

/** Notted.md: "max 5 attempts" — the initial send plus four retries. */
export const WEBHOOK_MAXIMUM_ATTEMPTS = 5;

/**
 * The verification challenge is the ONE place a receiver's latency touches a
 * request thread instead of a worker, so it gets its own tighter budget and is
 * never retried. Ordinary deliveries use `securityConfig.webhookRequestTimeoutMs`.
 */
export const WEBHOOK_VERIFY_TIMEOUT_MS = 5_000;

/**
 * The replay window we ask RECEIVERS to enforce on `t=` (documented in
 * `docs/API.md`), and the window we enforce ourselves on the verification
 * challenge response. Outbound deliveries are NOT time-gated by us — see
 * `webhook-signature.ts`.
 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
