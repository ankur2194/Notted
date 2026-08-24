// Part 67 — module vocabulary: audit actions, price table, governance keys, and
// the two pure helpers (`parseAiSettings`, `startOfUtcDay`) that both the
// application service and the governance gate must agree on exactly.

import {
  AI_DEFAULT_DAILY_TOKEN_QUOTA,
  AI_DEFAULT_RATE_LIMIT_PER_MINUTE,
  AI_MAX_DAILY_TOKEN_QUOTA,
  AI_MAX_RATE_LIMIT_PER_MINUTE,
} from "@notted/shared-validators";
import { z } from "zod";

import type { AiRateLimitedProvider } from "../queue/ai-provider-rate-limiter.service";
import type { AiProviderName } from "@notted/shared-types";

export { AI_DEFAULT_DAILY_TOKEN_QUOTA, AI_DEFAULT_RATE_LIMIT_PER_MINUTE };

export const AI_AUDIT_ENTITY_TYPE = "ai_provider_config" as const;

/**
 * Audit metadata for these actions records the PROVIDER, the MODEL and the
 * booleans — never the API key, never a key prefix, never a ciphertext. A
 * credential change is recorded as the fact that it happened.
 */
export const AI_AUDIT_ACTIONS = Object.freeze({
  configure: "ai.configured",
  disable: "ai.disabled",
  credentialRotated: "ai.credential_rotated",
} as const);

export type AiAuditAction = (typeof AI_AUDIT_ACTIONS)[keyof typeof AI_AUDIT_ACTIONS];

/**
 * Bridges the two vocabularies that already exist in this codebase: the DB enum
 * says `anthropic`, while `AiProviderRateLimiterService` and
 * `config/queue.config.ts` say `claude`. Mapping in ONE place beats a string
 * literal at each call site that a rename would silently miss.
 */
export const AI_LIMITER_PROVIDER: Readonly<
  Record<Exclude<AiProviderName, "disabled">, AiRateLimitedProvider>
> = Object.freeze({ openai: "openai", anthropic: "claude" });

/** Per-workspace fixed-window key. Versioned so a policy change starts clean. */
export const AI_WORKSPACE_RATE_LIMIT_KEY_PREFIX = "notted:ai:ws-limit:v1:" as const;
export const AI_WORKSPACE_RATE_LIMIT_WINDOW_MS = 60_000;

/** AAD prefix binding a credential blob to its config row and key version. */
export const AI_CREDENTIAL_AAD_PREFIX = "notted:ai-credential:v1" as const;

interface AiModelPrice {
  readonly promptMicrosPerMillion: number;
  readonly completionMicrosPerMillion: number;
}

/**
 * Cost in MICROS (1e-6 USD) per 1,000,000 tokens, split by direction.
 *
 * Deliberately a small static table, not a config surface and not a live price
 * feed. An unknown model yields a NULL cost rather than a guess: a wrong number
 * on a billing screen is worse than an honest blank, and `ai_usage.cost_micros`
 * is nullable precisely so this can abstain. Token counts are always recorded
 * either way, so a missing price never loses the underlying measurement.
 *
 * `ponytail:` static table; move to configuration only when a workspace needs
 * negotiated pricing, not merely when a vendor changes a rate card.
 */
export const AI_MODEL_PRICES: Readonly<Record<string, AiModelPrice>> = Object.freeze({
  "gpt-4o": { promptMicrosPerMillion: 2_500_000, completionMicrosPerMillion: 10_000_000 },
  "gpt-4o-mini": { promptMicrosPerMillion: 150_000, completionMicrosPerMillion: 600_000 },
  "gpt-4.1": { promptMicrosPerMillion: 2_000_000, completionMicrosPerMillion: 8_000_000 },
  "gpt-4.1-mini": { promptMicrosPerMillion: 400_000, completionMicrosPerMillion: 1_600_000 },
  "claude-3-5-haiku-latest": {
    promptMicrosPerMillion: 800_000,
    completionMicrosPerMillion: 4_000_000,
  },
  "claude-3-5-sonnet-latest": {
    promptMicrosPerMillion: 3_000_000,
    completionMicrosPerMillion: 15_000_000,
  },
  "claude-sonnet-4-5": {
    promptMicrosPerMillion: 3_000_000,
    completionMicrosPerMillion: 15_000_000,
  },
});

/**
 * Cost of one request, or `null` when the model is not priced.
 *
 * Rounded UP: under-reporting spend is the failure mode that matters.
 */
export function estimateCostMicros(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  const price = AI_MODEL_PRICES[model];
  if (price === undefined) return null;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return Math.ceil(
    (prompt * price.promptMicrosPerMillion + completion * price.completionMicrosPerMillion) /
      1_000_000,
  );
}

export interface AiSettings {
  readonly dailyTokenQuota: number;
  readonly rateLimitPerMinute: number;
  readonly contentConsent: boolean;
}

const AI_SETTINGS_DEFAULTS: AiSettings = Object.freeze({
  dailyTokenQuota: AI_DEFAULT_DAILY_TOKEN_QUOTA,
  rateLimitPerMinute: AI_DEFAULT_RATE_LIMIT_PER_MINUTE,
  contentConsent: false,
});

/**
 * `ai_provider_config.settings` is `jsonb`, so it is `unknown` at the type level
 * and its contents are whatever the last writer — or a hand-run UPDATE during
 * an incident — left there. Every field therefore falls back INDIVIDUALLY to
 * its documented default instead of throwing: a bad `rateLimitPerMinute` must
 * not take the consent flag down with it, and a settings blob that is not even
 * an object must not make the whole workspace unreadable.
 *
 * Every fallback is the SAFE direction. `contentConsent` is the one that
 * matters: anything that is not literally `true` reads as false, so a missing,
 * stringified, or corrupted flag denies rather than permits.
 */
const aiSettingsSchema = z
  .object({
    dailyTokenQuota: z
      .number()
      .int()
      .min(0)
      .max(AI_MAX_DAILY_TOKEN_QUOTA)
      .catch(AI_DEFAULT_DAILY_TOKEN_QUOTA),
    rateLimitPerMinute: z
      .number()
      .int()
      .min(1)
      .max(AI_MAX_RATE_LIMIT_PER_MINUTE)
      .catch(AI_DEFAULT_RATE_LIMIT_PER_MINUTE),
    contentConsent: z.boolean().catch(false),
  })
  .catch(() => ({ ...AI_SETTINGS_DEFAULTS }));

export function parseAiSettings(value: unknown): AiSettings {
  return Object.freeze(aiSettingsSchema.parse(value));
}

/**
 * The daily quota window opens at UTC midnight, not at the workspace's local
 * midnight: `ai_usage.created_at` is stored with a time zone and there is no
 * per-workspace time zone to consult, so one fixed boundary is the only one the
 * quota check and the usage report can both compute identically.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
