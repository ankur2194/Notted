import type { IsoTimestamp, TagId, UserId, WorkspaceId } from "./common";

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
  // Part 68. These three answer `text/event-stream`, not JSON, so nothing that
  // wraps `fetch` in a JSON parser may call them — see `lib/ai/stream.ts`.
  summarize: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/summarize`,
  continue: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/continue`,
  rewrite: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/rewrite`,
  // Part 69. These two answer ORDINARY JSON, not an event stream: their value is
  // a structured object the client reviews as a whole, and there is nothing
  // useful to show a reader halfway through a half-parsed extraction.
  meetingExtraction: (workspaceId: string) =>
    `/api/v1/workspaces/${workspaceId}/ai/meeting-extraction`,
  tagSuggestions: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/ai/tag-suggestions`,
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
 *
 * THIS IS THE REFUSAL VOCABULARY, NOT THE `ai_usage.error_code` VOCABULARY.
 * That column is plain `text` and Part 68 deliberately writes a wider set into
 * it: an `AiProviderErrorCode` (`auth`, `overloaded`, …) when a provider call
 * failed, and `client_cancelled` when the reader closed the connection. An
 * operator reading the usage table needs to tell a wrong API key from a busy
 * provider, and collapsing both to `ai_provider_error` would hide exactly the
 * distinction that says whether an admin has to act. Anything grouping that
 * column must expect all three vocabularies.
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

/**
 * Part 68 — the three authoring features, their inputs, and the wire format of
 * a streamed generation.
 *
 * NOTHING HERE CARRIES NOTE CONTENT BACK TO THE SERVER'S STORAGE. A generation
 * is streamed to the browser and then forgotten: no transcript, no cache, no
 * `ai_usage` column that could hold it. The only durable trace of a request is
 * its token counts.
 */
export const AI_SUMMARY_LENGTHS = Object.freeze(["brief", "medium", "detailed"] as const);

export type AiSummaryLength = (typeof AI_SUMMARY_LENGTHS)[number];

/** The five rewrites offered for a selection. Closed set: one prompt each. */
export const AI_TONES = Object.freeze([
  "professional",
  "casual",
  "concise",
  "elaborate",
  "simplify",
] as const);

export type AiTone = (typeof AI_TONES)[number];

/**
 * Why a stream ended badly.
 *
 * The governance refusals are absent on purpose: those are answered as an
 * ORDINARY JSON ERROR RESPONSE before the connection ever becomes an event
 * stream, so a client that received one of these has already been streaming.
 * Only `ai_provider_error` overlaps, because the provider can fail mid-stream.
 */
/*
 * These three literals are re-listed in `aiStreamEventSchema`
 * (`@notted/shared-validators`) rather than imported: `shared-validators` does
 * not depend on `shared-types` and inverting that would make the validator
 * package depend on the type package for a three-member enum. The duplication
 * is deliberate and the frame test pins both halves together.
 */
export const AI_STREAM_ERROR_CODES = Object.freeze([
  "ai_provider_error",
  /** The model produced nothing, or only whitespace. */
  "ai_output_empty",
  /** The server's own character ceiling tripped and the generation was aborted. */
  "ai_output_truncated",
] as const);

export type AiStreamErrorCode = (typeof AI_STREAM_ERROR_CODES)[number];

/**
 * One `data:` frame on the wire.
 *
 * `done` is the ONLY successful terminator, and `error` the only unsuccessful
 * one: a stream that simply stops without either was cut off, and the client
 * must treat that as a failure rather than as a complete answer.
 */
export type AiStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "done";
      /** Which frozen prompt produced this text, e.g. `summarize.v1`. */
      readonly promptVersion: string;
      readonly promptTokens: number | null;
      readonly completionTokens: number | null;
    }
  | { readonly type: "error"; readonly code: AiStreamErrorCode; readonly message: string };

/**
 * Part 69 — meeting extraction and tag suggestion.
 *
 * BOTH OF THESE ARE PROPOSALS, NOT WRITES. Nothing described below is persisted
 * anywhere by the server: an extraction is computed, returned, and forgotten,
 * and a tag suggestion assigns nothing. The note document is only ever changed
 * by an editor transaction the author started from the review screen, and a tag
 * is only ever created or attached by an explicit "Apply". The transcript itself
 * is never stored — there is no column it could go in (ADR 0007).
 *
 * WHY EVERY LIST IS BOUNDED. A model asked for "the action items" can return
 * four hundred of them, and every one of those becomes a checkbox a human is
 * expected to review. A review screen nobody can finish reading is not a
 * safeguard, so the caps below are part of the contract rather than a rendering
 * detail — the server truncates to them before the browser ever sees the list.
 */
export const MEETING_EXTRACTION_LIST_MAX = 100;
export const MEETING_EXTRACTION_AGENDA_MAX = 50;
/** Existing workspace tags a single suggestion may name. */
export const TAG_SUGGESTION_EXISTING_MAX = 10;
/** Brand-new tag names a single suggestion may propose. */
export const TAG_SUGGESTION_PROPOSED_MAX = 5;

/**
 * One extracted action item.
 *
 * `assignee` is FREE TEXT, deliberately: it is a name the transcript used, not a
 * workspace member id. Resolving "Sam" to a `UserId` would be a guess about who
 * is accountable for something, made by a model, from a transcript — exactly the
 * kind of inference that must stay a human's to make. The review screen shows
 * the name; whoever accepts the item assigns the task themselves.
 *
 * `dueDate` is a plain `YYYY-MM-DD` calendar date rather than an instant: a
 * meeting says "by Friday", which has no time and no timezone.
 */
export interface MeetingActionItem {
  readonly text: string;
  readonly assignee?: string;
  readonly dueDate?: string;
}

export interface MeetingExtraction {
  readonly attendees: readonly string[];
  readonly agenda: readonly string[];
  readonly discussionPoints: readonly string[];
  readonly decisions: readonly string[];
  readonly actionItems: readonly MeetingActionItem[];
}

/** Wrapped in an object so the response can grow a sibling field without a break. */
export interface MeetingExtractionResult {
  readonly extraction: MeetingExtraction;
}

/**
 * A tag the workspace ALREADY has. `tagId` is real and was matched server-side
 * against the workspace's own tag pool — a model never invents one, and never
 * sees an id at all.
 */
export interface TagSuggestionExistingTag {
  readonly tagId: TagId;
  readonly name: string;
}

/**
 * A tag that does NOT exist yet. It is kept in its own list rather than mixed
 * into `existing` with a null id, because "select this" and "create this" are
 * different consequences and the UI must be able to say so without inspecting a
 * nullable field.
 */
export interface TagSuggestionProposedTag {
  readonly name: string;
}

export interface TagSuggestionResult {
  readonly existing: readonly TagSuggestionExistingTag[];
  readonly proposed: readonly TagSuggestionProposedTag[];
}
