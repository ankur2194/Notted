import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

/**
 * Part 67 — provider-neutral AI configuration, governance, and usage.
 *
 * A workspace has exactly one AI configuration row and it is DISABLED BY
 * DEFAULT. The provider credential is stored encrypted and is never projected
 * here: the only thing a read path ever reveals is {@link AiConfigView.hasCredentials},
 * a boolean. There is no deployment-wide fallback key — `FEATURE_AI_ENABLED` is
 * a kill-switch, never a credential source.
 *
 * Usage rows carry token counts and cost only. Prompts, note excerpts, and
 * model output are never retained (ADR 0007), so nothing in this file has a
 * field that could hold them.
 */
export const AI_API_PATHS = Object.freeze({
  config: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/config`,
  usage: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/usage`,
  status: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/status`,
} as const);

/**
 * Mirrors the `ai_provider` Postgres enum. `"disabled"` is a real member, not
 * an absence: deny-by-default is stored, not inferred from a missing row.
 */
export const AI_PROVIDER_NAMES = Object.freeze(["openai", "anthropic", "disabled"] as const);

export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

/**
 * The closed set of governance refusals. Every one of them is a FAIL-CLOSED
 * outcome: the request never reached a provider. They are stable enough for the
 * web client to map to copy, which is why they live in the shared package
 * rather than in the API module.
 */
export const AI_FAILURE_CODES = Object.freeze([
  "ai_disabled",
  "ai_not_configured",
  "ai_consent_required",
  "ai_quota_exceeded",
  "ai_rate_limited",
  "ai_provider_error",
] as const);

export type AiFailureCode = (typeof AI_FAILURE_CODES)[number];

/**
 * Why a provider call failed, derived from the HTTP STATUS ALONE. Provider
 * response bodies are never parsed into this, never logged, and never surfaced:
 * they quote request content back and would defeat the no-retention rule.
 */
export const AI_PROVIDER_ERROR_CODES = Object.freeze([
  "auth",
  "rate_limited",
  "overloaded",
  "invalid_request",
  "network",
] as const);

export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number];

/** Outcome recorded on an `ai_usage` row. */
export type AiUsageStatus = "success" | "failed" | "rate_limited";

/**
 * Safe projection of an `ai_provider_config` row.
 *
 * `encrypted_credentials` and `encryption_key_version` are absent BY
 * CONSTRUCTION — there is no field they could be assigned to — rather than
 * stripped after the fact by a projection that one refactor could forget.
 */
export interface AiConfigView {
  readonly workspaceId: WorkspaceId;
  readonly provider: AiProviderName;
  readonly model: string | null;
  readonly isEnabled: boolean;
  /** True when a credential is stored. The credential itself is never returned. */
  readonly hasCredentials: boolean;
  readonly dailyTokenQuota: number;
  readonly rateLimitPerMinute: number;
  readonly contentConsent: boolean;
  readonly updatedById: UserId | null;
  readonly updatedAt: IsoTimestamp;
}

/** Per-feature roll-up inside {@link AiUsageSummary}. */
export interface AiUsageFeatureSummary {
  readonly feature: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly costMicros: number;
}

/** Workspace-scoped usage roll-up over a bounded window. Never cross-tenant. */
export interface AiUsageSummary {
  readonly workspaceId: WorkspaceId;
  readonly since: IsoTimestamp;
  readonly until: IsoTimestamp;
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly rateLimitedRequests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costMicros: number;
  readonly dailyTokenQuota: number;
  /** Tokens spent since UTC midnight — the number the quota is checked against. */
  readonly tokensUsedToday: number;
  readonly features: readonly AiUsageFeatureSummary[];
}

/**
 * What a non-admin member is allowed to know: whether AI features should be
 * offered at all, and by whom. Deliberately carries no quota, no consent flag,
 * and no credential state.
 */
export interface AiStatus {
  readonly enabled: boolean;
  readonly provider: AiProviderName;
  readonly model: string | null;
}
