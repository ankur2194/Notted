import { z } from "zod";

import { isoTimestampSchema, paginationQuerySchema, uuidSchema } from "./common.schema";

/**
 * Part 66 — outbound webhook contracts.
 *
 * `webhookUrlSchema` is SYNTAX ONLY. It proves the string parses as an absolute
 * `http(s)` URL of a bounded length and carries no credentials; it deliberately
 * does NOT decide whether the host is reachable, private, or self-targeting.
 * That verdict is server-side (`webhook-url-guard.ts`), because it depends on
 * DNS resolution, the deployment environment, and the app's own hostnames —
 * none of which a shared schema can see, and none of which a client may be
 * trusted to have checked.
 */

/** `whsec_` + 43 base64url characters (32 random bytes). */
export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/u;
export const webhookSecretSchema = z.string().regex(WEBHOOK_SECRET_PATTERN);

export const webhookEventSchema = z.enum([
  "note.created",
  "note.updated",
  "note.deleted",
  "project.created",
  "member.joined",
]);
export type WebhookEventInput = z.infer<typeof webhookEventSchema>;

/**
 * Non-empty and duplicate-free: an endpoint subscribed to nothing is an
 * endpoint that can never fire, and a duplicate would be stored as a different
 * jsonb array than the caller sent.
 */
export const webhookEventsSchema = z
  .array(webhookEventSchema)
  .min(1)
  .max(webhookEventSchema.options.length)
  .refine((events) => new Set(events).size === events.length, {
    message: "Events must be unique",
  });

/**
 * 2048 characters is the practical ceiling every proxy and browser agrees on.
 * Embedded credentials are refused here as well as server-side: a URL that
 * carries `user:pass@` would have its password written into `webhooks.url` in
 * cleartext, which is a storage problem before it is an SSRF problem.
 */
/**
 * Rejects `https://user:pass@host/…` by requiring the authority — everything
 * between `//` and the first `/`, `?` or `#` — to contain no `@`. A later `@`
 * in a path or query is untouched, because that is ordinary data and not a
 * credential.
 *
 * This is a regex rather than a `new URL()` inspection on purpose: this package
 * compiles under `"lib": ["ES2022"]` with no DOM lib and no `@types/node`, so
 * the `URL` global does not exist here. Zod's own `z.url()` does the parsing
 * (it owns the platform detail), and this pattern adds only the credential rule
 * zod has no option for.
 */
const NO_EMBEDDED_CREDENTIALS = /^https?:\/\/[^/?#@]+(?:[/?#]|$)/iu;

export const webhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .pipe(z.url({ protocol: /^https?$/u }))
  .refine((value) => NO_EMBEDDED_CREDENTIALS.test(value), {
    message: "Must be an absolute http(s) URL without embedded credentials",
  });

export const webhookCreateSchema = z
  .object({ url: webhookUrlSchema, events: webhookEventsSchema })
  .strict();
export type WebhookCreateInput = z.input<typeof webhookCreateSchema>;

/**
 * Every field optional, at least one present. Changing `url` resets
 * verification server-side, so the client cannot enable a moved endpoint in the
 * same request.
 */
export const webhookUpdateSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    events: webhookEventsSchema.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });
export type WebhookUpdateInput = z.input<typeof webhookUpdateSchema>;

export const webhookDeliveryStatusSchema = z.enum(["pending", "success", "failed", "retrying"]);

export const webhookDeliveryErrorCodeSchema = z.enum([
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
]);

export const webhookDeliveryListQuerySchema = paginationQuerySchema
  .extend({ status: webhookDeliveryStatusSchema.optional() })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });
export type WebhookDeliveryListQueryInput = z.input<typeof webhookDeliveryListQuerySchema>;

/** `encrypted_secret` is intentionally absent — it is never projected. */
export const webhookEndpointSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    url: webhookUrlSchema,
    events: webhookEventsSchema,
    isEnabled: z.boolean(),
    isVerified: z.boolean(),
    createdById: uuidSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const webhookDeliverySchema = z
  .object({
    id: uuidSchema,
    webhookId: uuidSchema,
    eventId: uuidSchema,
    event: z.string().min(1).max(100),
    status: webhookDeliveryStatusSchema,
    attempt: z.number().int().min(1),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    responseBodySnippet: z.string().max(500).nullable(),
    errorMessage: webhookDeliveryErrorCodeSchema.nullable(),
    payloadHash: z.string().length(64).nullable(),
    deliveredAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const webhookEndpointPageSchema = z
  .object({
    items: z.array(webhookEndpointSchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const webhookDeliveryPageSchema = z
  .object({
    items: z.array(webhookDeliverySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

/** The two responses that carry the raw secret, each returning it exactly once. */
export const webhookCreateResultSchema = z
  .object({ webhook: webhookEndpointSchema, secret: webhookSecretSchema })
  .strict();

export const webhookSecretRotationResultSchema = z
  .object({ webhook: webhookEndpointSchema, secret: webhookSecretSchema })
  .strict();

export const webhookVerificationResultSchema = z
  .object({
    webhook: webhookEndpointSchema,
    isVerified: z.boolean(),
    delivery: webhookDeliverySchema,
  })
  .strict();

export const webhookDeleteResultSchema = z
  .object({ webhookId: uuidSchema, deleted: z.literal(true) })
  .strict();

export const webhookRetryResultSchema = z
  .object({ webhookId: uuidSchema, eventId: uuidSchema, scheduled: z.boolean() })
  .strict();
