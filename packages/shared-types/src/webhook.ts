import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

/**
 * Part 66 — outbound webhooks and their delivery logs.
 *
 * Endpoints are workspace-owned. The signing secret is returned exactly once
 * (create and rotate) and is never retrievable afterwards: only its AES-256-GCM
 * ciphertext is stored. A freshly created endpoint is DISABLED and UNVERIFIED;
 * it must echo a signed verification challenge before it can be enabled.
 */
export const WEBHOOK_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/webhooks`,
  detail: (workspaceId: string, webhookId: string) =>
    `/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}`,
  rotateSecret: (workspaceId: string, webhookId: string) =>
    `/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}/rotate-secret`,
  verify: (workspaceId: string, webhookId: string) =>
    `/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}/verify`,
  deliveries: (workspaceId: string, webhookId: string) =>
    `/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
  retryDelivery: (workspaceId: string, webhookId: string, deliveryId: string) =>
    `/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
} as const);

/**
 * The subscribable event catalog. `webhook.verification` is deliberately NOT a
 * member: the verification challenge is sent to one endpoint on demand and can
 * never be subscribed to, so it can never be fanned out by the producer.
 */
export const WEBHOOK_EVENTS = Object.freeze([
  "note.created",
  "note.updated",
  "note.deleted",
  "project.created",
  "member.joined",
] as const);

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The one non-subscribable event name, sent only by the verify route. */
export const WEBHOOK_VERIFICATION_EVENT = "webhook.verification" as const;

/** Every workspace is capped at this many endpoints (409 beyond it). */
export const WEBHOOK_ENDPOINT_LIMIT = 10;

/** Prefix carried by every raw signing secret. */
export const WEBHOOK_SECRET_PREFIX = "whsec_" as const;

export type WebhookDeliveryStatus = "pending" | "success" | "failed" | "retrying";

/**
 * The closed set of stored failure reasons. Node's own `error.message` is NEVER
 * persisted: it can quote the endpoint URL, which is admin-supplied and
 * routinely carries a bearer token in its path or query.
 */
export const WEBHOOK_DELIVERY_ERROR_CODES = Object.freeze([
  "timeout",
  "connection_failed",
  "dns_blocked",
  "url_rejected",
  "tls_failed",
  "http_error",
  "response_too_large",
  "resource_unavailable",
  "resource_forbidden",
  "secret_unavailable",
] as const);

export type WebhookDeliveryErrorCode = (typeof WEBHOOK_DELIVERY_ERROR_CODES)[number];

/** Safe projection of a `webhooks` row. The secret column is never projected. */
export interface WebhookEndpoint {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly isEnabled: boolean;
  readonly isVerified: boolean;
  readonly createdById: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** One immutable delivery attempt. */
export interface WebhookDelivery {
  readonly id: string;
  readonly webhookId: string;
  /** Stable across every attempt AND across a manual replay of the same event. */
  readonly eventId: string;
  readonly event: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly responseStatus: number | null;
  readonly responseBodySnippet: string | null;
  readonly errorMessage: WebhookDeliveryErrorCode | null;
  readonly payloadHash: string | null;
  readonly deliveredAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

export interface WebhookEndpointPage {
  readonly items: readonly WebhookEndpoint[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface WebhookDeliveryPage {
  readonly items: readonly WebhookDelivery[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** The only two responses that ever carry the raw secret. */
export interface WebhookCreateResult {
  readonly webhook: WebhookEndpoint;
  readonly secret: string;
}

export interface WebhookSecretRotationResult {
  readonly webhook: WebhookEndpoint;
  readonly secret: string;
}

export interface WebhookVerificationResult {
  readonly webhook: WebhookEndpoint;
  readonly isVerified: boolean;
  readonly delivery: WebhookDelivery;
}

export interface WebhookDeleteResult {
  readonly webhookId: string;
  readonly deleted: true;
}

export interface WebhookRetryResult {
  readonly webhookId: string;
  readonly eventId: string;
  readonly scheduled: boolean;
}

export interface WebhookDeliveryListQuery {
  readonly page: number;
  readonly limit: number;
  readonly status?: WebhookDeliveryStatus;
}
