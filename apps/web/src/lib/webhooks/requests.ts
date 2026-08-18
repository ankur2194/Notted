import {
  WEBHOOK_API_PATHS,
  WEBHOOK_DELIVERY_ERROR_CODES,
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_PREFIX,
} from "@notted/shared-types";
import {
  webhookCreateSchema,
  webhookDeliveryListQuerySchema,
  webhookUpdateSchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type {
  WebhookCreateResult,
  WebhookDeleteResult,
  WebhookDelivery,
  WebhookDeliveryErrorCode,
  WebhookDeliveryListQuery,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointPage,
  WebhookEvent,
  WebhookRetryResult,
  WebhookSecretRotationResult,
  WebhookVerificationResult,
} from "@notted/shared-types";
import type { WebhookCreateInput, WebhookUpdateInput } from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

/*
 * Part 66 — the browser half of outbound webhook management.
 *
 * REQUESTS are validated with the shared Zod contracts, exactly like
 * `@/lib/api-keys/requests` and `@/lib/api/export-requests`: the server owns
 * the rule, and re-stating "an absolute http(s) URL without credentials" here
 * would be a second copy free to drift.
 *
 * RESPONSES are parsed by hand, the `export-requests` way. The shared response
 * schemas are `.strict()`, so a field the server adds before this client is
 * redeployed would fail the whole parse and blank the settings page over an
 * addition that changed nothing. The parsers below ignore unknown properties
 * and still refuse anything off-contract — and they reuse the shared enums, so
 * a new event or delivery error code can never be accepted here without being
 * accepted by the server first.
 *
 * `WEBHOOK_API_PATHS` interpolates ids without escaping them, which is safe
 * only because every function below refuses a non-UUID id before a request can
 * leave the browser.
 */

type ParseResult<T> = { readonly success: true; readonly data: T } | { readonly success: false };

const FAILED: ParseResult<never> = { success: false };

/**
 * `WebhookDeliveryStatus` ships as a type with no companion array, so the wire
 * values are restated here. `satisfies` keeps the restatement honest: a value
 * the union does not contain is a compile error.
 */
const DELIVERY_STATUSES = [
  "pending",
  "success",
  "failed",
  "retrying",
] as const satisfies readonly WebhookDeliveryStatus[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

/** Non-empty and entirely inside the shared catalog; order is the server's. */
function parseEvents(value: unknown): readonly WebhookEvent[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const events: WebhookEvent[] = [];
  for (const entry of value) {
    if (!isString(entry)) return null;
    const known = WEBHOOK_EVENTS.find((event) => event === entry);
    if (known === undefined) return null;
    events.push(known);
  }
  return events;
}

/** `undefined` means "off contract"; `null` is the legitimate absent value. */
function parseDeliveryErrorCode(value: unknown): WebhookDeliveryErrorCode | null | undefined {
  if (value === null) return null;
  if (!isString(value)) return undefined;
  return WEBHOOK_DELIVERY_ERROR_CODES.find((code) => code === value);
}

export function parseWebhookEndpoint(value: unknown): ParseResult<WebhookEndpoint> {
  if (!isRecord(value)) return FAILED;
  const events = parseEvents(value.events);
  if (events === null) return FAILED;
  const { id, workspaceId, url, isEnabled, isVerified, createdById, createdAt, updatedAt } = value;
  if (
    !isString(id) ||
    !isString(workspaceId) ||
    !isString(url) ||
    !isString(createdById) ||
    !isString(createdAt) ||
    !isString(updatedAt)
  ) {
    return FAILED;
  }
  if (typeof isEnabled !== "boolean" || typeof isVerified !== "boolean") return FAILED;
  return {
    success: true,
    data: {
      id,
      workspaceId,
      url,
      events,
      isEnabled,
      isVerified,
      createdById,
      createdAt,
      updatedAt,
    },
  };
}

export function parseWebhookDelivery(value: unknown): ParseResult<WebhookDelivery> {
  if (!isRecord(value)) return FAILED;
  const { id, webhookId, eventId, event, attempt, payloadHash, deliveredAt, createdAt } = value;
  const status = DELIVERY_STATUSES.find((candidate) => candidate === value.status);
  const errorMessage = parseDeliveryErrorCode(value.errorMessage);
  if (status === undefined || errorMessage === undefined) return FAILED;
  if (!isString(id) || !isString(webhookId) || !isString(eventId) || !isString(event)) {
    return FAILED;
  }
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return FAILED;
  const { responseStatus, responseBodySnippet } = value;
  if (!isNullableInteger(responseStatus) || !isNullableString(responseBodySnippet)) return FAILED;
  if (!isNullableString(payloadHash) || !isNullableString(deliveredAt) || !isString(createdAt)) {
    return FAILED;
  }
  return {
    success: true,
    data: {
      id,
      webhookId,
      eventId,
      event,
      status,
      attempt,
      responseStatus,
      responseBodySnippet,
      errorMessage,
      payloadHash,
      deliveredAt,
      createdAt,
    },
  };
}

/** Both pages share one envelope, so they share one parser. */
function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => ParseResult<T>,
): ParseResult<{
  readonly items: readonly T[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}> {
  if (!isRecord(value)) return FAILED;
  const { page, limit, hasMore } = value;
  if (typeof page !== "number" || typeof limit !== "number") return FAILED;
  if (typeof hasMore !== "boolean" || !Array.isArray(value.items)) return FAILED;
  const items: T[] = [];
  for (const entry of value.items) {
    const parsed = parseItem(entry);
    if (!parsed.success) return FAILED;
    items.push(parsed.data);
  }
  return { success: true, data: { items, page, limit, hasMore } };
}

/**
 * The raw secret, checked for its prefix only. The exact 43-character body is
 * the server's business; what matters here is that the panel never presents an
 * arbitrary server string to the admin as "your signing secret".
 */
function parseSecret(value: unknown): string | null {
  return isString(value) && value.startsWith(WEBHOOK_SECRET_PREFIX) ? value : null;
}

function parseSecretResult(value: unknown): ParseResult<WebhookCreateResult> {
  if (!isRecord(value)) return FAILED;
  const webhook = parseWebhookEndpoint(value.webhook);
  const secret = parseSecret(value.secret);
  if (!webhook.success || secret === null) return FAILED;
  return { success: true, data: { webhook: webhook.data, secret } };
}

function parseVerificationResult(value: unknown): ParseResult<WebhookVerificationResult> {
  if (!isRecord(value)) return FAILED;
  const webhook = parseWebhookEndpoint(value.webhook);
  const delivery = parseWebhookDelivery(value.delivery);
  if (!webhook.success || !delivery.success || typeof value.isVerified !== "boolean") return FAILED;
  return {
    success: true,
    data: { webhook: webhook.data, isVerified: value.isVerified, delivery: delivery.data },
  };
}

function parseRetryResult(value: unknown): ParseResult<WebhookRetryResult> {
  if (!isRecord(value)) return FAILED;
  const { webhookId, eventId, scheduled } = value;
  if (!isString(webhookId) || !isString(eventId) || typeof scheduled !== "boolean") return FAILED;
  return { success: true, data: { webhookId, eventId, scheduled } };
}

/** Every endpoint in the workspace. The cap is 10, so there is no pagination UI. */
export function loadWebhooks(workspaceId: string): Promise<ApiRequestResult<WebhookEndpointPage>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(WEBHOOK_API_PATHS.collection(workspaceId), {}, (value) =>
    parsePage(value, parseWebhookEndpoint),
  );
}

/**
 * Creates an endpoint and returns one of the only two responses that ever carry
 * the raw signing secret. A new endpoint arrives disabled and unverified.
 */
export function createWebhook(
  workspaceId: string,
  input: WebhookCreateInput,
): Promise<ApiRequestResult<WebhookCreateResult>> {
  const parsed = webhookCreateSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    WEBHOOK_API_PATHS.collection(workspaceId),
    json("POST", parsed.data),
    parseSecretResult,
  );
}

/** Partial update. Changing `url` resets verification server-side. */
export function updateWebhook(
  workspaceId: string,
  webhookId: string,
  input: WebhookUpdateInput,
): Promise<ApiRequestResult<WebhookEndpoint>> {
  const parsed = webhookUpdateSchema.safeParse(input);
  if (!validIds(workspaceId, webhookId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    WEBHOOK_API_PATHS.detail(workspaceId, webhookId),
    json("PATCH", parsed.data),
    parseWebhookEndpoint,
  );
}

/**
 * Deletion answers 200 with `{ webhookId, deleted: true }` — the same shape
 * `api-keys` and `tags` use for a scoped DELETE, since neither controller sets
 * `@HttpCode`. There is no no-content route here, so this goes through
 * `requestJson` like every other call in this module.
 */
function parseDeleteResult(value: unknown): ParseResult<WebhookDeleteResult> {
  if (!isRecord(value)) return FAILED;
  const webhookId = value.webhookId;
  if (typeof webhookId !== "string" || value.deleted !== true) return FAILED;
  return { success: true, data: { webhookId, deleted: true } };
}

export function deleteWebhook(
  workspaceId: string,
  webhookId: string,
): Promise<ApiRequestResult<WebhookDeleteResult>> {
  if (!validIds(workspaceId, webhookId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    WEBHOOK_API_PATHS.detail(workspaceId, webhookId),
    { method: "DELETE" },
    parseDeleteResult,
  );
}

/**
 * Issues a new signing secret and returns it once. The previous secret stops
 * being accepted immediately, so a receiver that has not been updated will
 * start rejecting deliveries — the UI says so before the admin presses it.
 */
export function rotateWebhookSecret(
  workspaceId: string,
  webhookId: string,
): Promise<ApiRequestResult<WebhookSecretRotationResult>> {
  if (!validIds(workspaceId, webhookId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    WEBHOOK_API_PATHS.rotateSecret(workspaceId, webhookId),
    json("POST", {}),
    parseSecretResult,
  );
}

/**
 * Sends one signed challenge the endpoint has to echo back. A 2xx with the
 * wrong body is still a failure, so `isVerified` is read from the response
 * rather than inferred from the request having succeeded.
 */
export function verifyWebhook(
  workspaceId: string,
  webhookId: string,
): Promise<ApiRequestResult<WebhookVerificationResult>> {
  if (!validIds(workspaceId, webhookId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    WEBHOOK_API_PATHS.verify(workspaceId, webhookId),
    json("POST", {}),
    parseVerificationResult,
  );
}

/**
 * One page of delivery attempts.
 *
 * The query is validated in its SERIALIZED form, as `listApiKeys` does: the
 * shared schema's input contract is the string a URL carries, not the parsed
 * number, and checking the params validates exactly what goes on the wire.
 */
export function loadWebhookDeliveries(
  workspaceId: string,
  webhookId: string,
  query: WebhookDeliveryListQuery,
): Promise<ApiRequestResult<WebhookDeliveryPage>> {
  const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
  if (query.status !== undefined) params.set("status", query.status);
  const valid = webhookDeliveryListQuerySchema.safeParse(Object.fromEntries(params)).success;
  if (!validIds(workspaceId, webhookId) || !valid) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    `${WEBHOOK_API_PATHS.deliveries(workspaceId, webhookId)}?${params.toString()}`,
    {},
    (value) => parsePage(value, parseWebhookDelivery),
  );
}

/**
 * Queues one more attempt at an already-recorded delivery. The `eventId` is
 * stable across retries, so a receiver that deduplicates on it sees a replay
 * rather than a second event.
 */
export function retryWebhookDelivery(
  workspaceId: string,
  webhookId: string,
  deliveryId: string,
): Promise<ApiRequestResult<WebhookRetryResult>> {
  if (!validIds(workspaceId, webhookId, deliveryId)) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    WEBHOOK_API_PATHS.retryDelivery(workspaceId, webhookId, deliveryId),
    json("POST", {}),
    parseRetryResult,
  );
}
