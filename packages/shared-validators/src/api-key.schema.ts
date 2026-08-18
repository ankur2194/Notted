import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

/**
 * Part 65 — public REST API key contracts.
 *
 * The raw secret shape is validated here so the transport can reject a
 * malformed credential before any database round-trip (no timing or
 * enumeration signal from an unauthenticated caller).
 */
export const API_KEY_SECRET_PREFIX = "ntd_pk_";
/** `ntd_pk_` + 32 base64url characters (24 random bytes). */
export const API_KEY_SECRET_PATTERN = /^ntd_pk_[A-Za-z0-9_-]{32}$/u;
/** `key_prefix` is `varchar(8)`: the literal prefix plus one secret character. */
export const API_KEY_PREFIX_LENGTH = 8;

export const apiKeySecretSchema = z.string().regex(API_KEY_SECRET_PATTERN);

/** Matches `varchar(100)` in `apps/api/src/database/schema/api-keys.ts`. */
export const apiKeyNameSchema = z.string().trim().min(1).max(100);

export const apiKeyScopeSchema = z.enum(["read", "write", "admin"]);
export type ApiKeyScopeInput = z.infer<typeof apiKeyScopeSchema>;

/**
 * Non-empty and duplicate-free: an empty scope set is a credential that can do
 * nothing but still authenticates, and duplicates would round-trip through the
 * stored CSV as a different value than the caller sent.
 */
export const apiKeyScopesSchema = z
  .array(apiKeyScopeSchema)
  .min(1)
  .max(3)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: "Scopes must be unique",
  });

export const apiKeySortFieldSchema = z.enum(["createdAt", "lastUsedAt", "name"]);

export const createApiKeySchema = z
  .object({
    name: apiKeyNameSchema,
    scopes: apiKeyScopesSchema.default(["read", "write"]),
    expiresAt: isoTimestampSchema.optional(),
  })
  .strict()
  .refine((value) => value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.now(), {
    message: "expiresAt must be in the future",
    path: ["expiresAt"],
  });
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

/** Route-scoped query: workspaceId comes only from the route selector. */
export const apiKeyListQuerySchema = paginationQuerySchema
  .extend({
    // Revoked keys are hidden unless explicitly requested: the common admin
    // question is "what can reach my workspace right now".
    includeRevoked: explicitBooleanQuerySchema.optional(),
    sortBy: apiKeySortFieldSchema.default("createdAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });
export type ApiKeyListQueryInput = z.input<typeof apiKeyListQuerySchema>;

/** `keyHash` is intentionally absent — it is never projected to any transport. */
export const apiKeySummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: apiKeyNameSchema,
    keyPrefix: z.string().min(1).max(API_KEY_PREFIX_LENGTH),
    scopes: apiKeyScopesSchema,
    lastUsedAt: isoTimestampSchema.nullable(),
    expiresAt: isoTimestampSchema.nullable(),
    isRevoked: z.boolean(),
    createdById: uuidSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const apiKeyPageSchema = z
  .object({
    items: z.array(apiKeySummarySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

/** The one response shape that carries the raw secret, returned exactly once. */
export const apiKeyCreateResultSchema = z
  .object({ apiKey: apiKeySummarySchema, secret: apiKeySecretSchema })
  .strict();

export const apiKeyRevokeResultSchema = z
  .object({ apiKeyId: uuidSchema, revoked: z.literal(true) })
  .strict();
