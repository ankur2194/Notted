import { z } from "zod";

import { isoTimestampSchema, uuidSchema } from "./common.schema";

/**
 * Part 67 — AI configuration and governance contracts.
 *
 * These are the canonical DEFAULTS for a workspace that has never been
 * configured. They live here, next to the schema that applies them, so the API
 * constants file and the settings form cannot drift into two different notions
 * of "the default quota".
 */
export const AI_DEFAULT_DAILY_TOKEN_QUOTA = 50_000;
export const AI_DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
/** A ceiling, not a recommendation: it exists so a typo cannot uncap spend. */
export const AI_MAX_DAILY_TOKEN_QUOTA = 10_000_000;
export const AI_MAX_RATE_LIMIT_PER_MINUTE = 600;

/** Mirrors the `ai_provider` Postgres enum; `"disabled"` is the default value. */
export const aiProviderNameSchema = z.enum(["openai", "anthropic", "disabled"]);

/** Matches `varchar(100)` on `ai_provider_config.model`. */
export const aiModelSchema = z.string().trim().min(1).max(100);

/**
 * Syntax only. A key that parses is not a key that works — the provider is the
 * only authority on that — but a 4-character "key" is a paste accident worth
 * rejecting before it is encrypted and stored. The upper bound keeps an
 * oversized paste out of the ciphertext column.
 */
export const aiApiKeySchema = z.string().trim().min(20).max(400);

/**
 * The full desired configuration, applied as a replacement rather than a patch:
 * a settings form that submits every field cannot half-apply.
 *
 * `apiKey` is OPTIONAL and means "leave the stored credential alone" when
 * absent — a form can never round-trip a secret it was never shown. The
 * service, not this schema, enforces that switching providers requires a NEW
 * key (the old ciphertext belongs to the old provider).
 */
export const aiConfigUpdateSchema = z
  .object({
    provider: aiProviderNameSchema,
    model: aiModelSchema.nullable().default(null),
    apiKey: aiApiKeySchema.optional(),
    isEnabled: z.boolean().default(false),
    dailyTokenQuota: z
      .number()
      .int()
      .min(0)
      .max(AI_MAX_DAILY_TOKEN_QUOTA)
      .default(AI_DEFAULT_DAILY_TOKEN_QUOTA),
    rateLimitPerMinute: z
      .number()
      .int()
      .min(1)
      .max(AI_MAX_RATE_LIMIT_PER_MINUTE)
      .default(AI_DEFAULT_RATE_LIMIT_PER_MINUTE),
    contentConsent: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.provider !== "disabled" || !value.isEnabled, {
    message: "Choose a provider before enabling AI features",
    path: ["provider"],
  })
  .refine((value) => !value.isEnabled || value.model !== null, {
    message: "A model is required to enable AI features",
    path: ["model"],
  })
  // Consent is a precondition of the feature, not a preference recorded beside
  // it: enabling AI sends note content to a third party, so the flag is checked
  // here AND again, fail-closed, before every single provider call.
  .refine((value) => !value.isEnabled || value.contentConsent, {
    message: "Data-retention consent is required to enable AI features",
    path: ["contentConsent"],
  });

export type AiConfigUpdateInput = z.input<typeof aiConfigUpdateSchema>;

/**
 * Bounded window for the usage roll-up. 90 days is the reporting ceiling.
 *
 * The string branch mirrors `integerQueryValue` in `common.schema.ts` (which is
 * module-private there): query strings arrive as text, and only QUERY schemas
 * accept the lookalike — body schemas stay strictly typed.
 */
export const aiUsageQuerySchema = z
  .object({
    days: z
      .union([
        z.number().int(),
        z
          .string()
          .regex(/^(0|[1-9]\d*)$/u, "Expected a base-10 non-negative integer")
          .transform((value) => Number(value)),
      ])
      .pipe(z.number().int().min(1).max(90))
      .default(30),
  })
  .strict();

export type AiUsageQueryInput = z.input<typeof aiUsageQuerySchema>;

/**
 * The response projection. `hasCredentials` is the ONLY thing said about the
 * stored key, and there is no field that could carry the key itself.
 */
export const aiConfigViewSchema = z
  .object({
    workspaceId: uuidSchema,
    provider: aiProviderNameSchema,
    model: aiModelSchema.nullable(),
    isEnabled: z.boolean(),
    hasCredentials: z.boolean(),
    dailyTokenQuota: z.number().int().min(0),
    rateLimitPerMinute: z.number().int().min(1),
    contentConsent: z.boolean(),
    updatedById: uuidSchema.nullable(),
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const aiUsageFeatureSummarySchema = z
  .object({
    feature: z.string().min(1).max(50),
    requests: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    costMicros: z.number().int().min(0),
  })
  .strict();

export const aiUsageSummarySchema = z
  .object({
    workspaceId: uuidSchema,
    since: isoTimestampSchema,
    until: isoTimestampSchema,
    totalRequests: z.number().int().min(0),
    successfulRequests: z.number().int().min(0),
    failedRequests: z.number().int().min(0),
    rateLimitedRequests: z.number().int().min(0),
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    costMicros: z.number().int().min(0),
    dailyTokenQuota: z.number().int().min(0),
    tokensUsedToday: z.number().int().min(0),
    features: z.array(aiUsageFeatureSummarySchema).max(50).readonly(),
  })
  .strict();

/** What a member (not an admin) may learn about the workspace's AI setup. */
export const aiStatusSchema = z
  .object({
    enabled: z.boolean(),
    provider: aiProviderNameSchema,
    model: aiModelSchema.nullable(),
  })
  .strict();
