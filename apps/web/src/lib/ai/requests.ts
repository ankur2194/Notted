import { AI_API_PATHS } from "@notted/shared-types";
import {
  aiConfigUpdateSchema,
  aiConfigViewSchema,
  aiGrammarCheckRequestSchema,
  aiGrammarCheckResultSchema,
  aiMeetingExtractionRequestSchema,
  aiMeetingExtractionResultSchema,
  aiStatusSchema,
  aiTagSuggestionRequestSchema,
  aiTagSuggestionResultSchema,
  aiUsageQuerySchema,
  aiUsageSummarySchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type {
  AiConfigView,
  AiStatus,
  AiUsageSummary,
  GrammarCheckResult,
  MeetingExtractionResult,
  TagSuggestionResult,
} from "@notted/shared-types";
import type {
  AiConfigUpdateInput,
  AiGrammarCheckRequestInput,
  AiMeetingExtractionRequestInput,
  AiTagSuggestionRequestInput,
} from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

/**
 * Part 67 — the browser half of workspace AI configuration.
 *
 * Mirrors `@/lib/api-keys/requests`: every response is `safeParse`d against the
 * shared schema so an off-contract body is a failure rather than a silent cast,
 * and the workspace id is UUID-checked before a request is allowed to leave.
 *
 * Part 68 added `fetchAiStatus`, which Part 67 deliberately left out for want of
 * a reader. The AI panel is that reader: it is offered to every member, and a
 * member may not call the admin-only config endpoint, so the narrow status
 * projection — enabled, provider, model, and nothing else — is the only thing
 * an author's browser is allowed to learn about the workspace's AI setup.
 */

/**
 * What a member may know: whether to offer AI at all, and by whom. Readable at
 * any workspace role, unlike {@link fetchAiConfig}.
 */
export function fetchAiStatus(workspaceId: string): Promise<ApiRequestResult<AiStatus>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(AI_API_PATHS.status(workspaceId), {}, (value) =>
    aiStatusSchema.safeParse(value),
  );
}

/** The stored configuration. Never carries the credential — only `hasCredentials`. */
export function fetchAiConfig(workspaceId: string): Promise<ApiRequestResult<AiConfigView>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(AI_API_PATHS.config(workspaceId), {}, (value) =>
    aiConfigViewSchema.safeParse(value),
  );
}

/**
 * Replaces the whole configuration.
 *
 * `parsed.data` is what goes on the wire, and that matters for one field: the
 * schema leaves `apiKey` ABSENT when the caller omitted it, which is how the
 * server is told "keep the stored credential". Sending `""` would instead be a
 * rejected value, so the property is never synthesized here.
 */
export function updateAiConfig(
  workspaceId: string,
  input: AiConfigUpdateInput,
): Promise<ApiRequestResult<AiConfigView>> {
  const parsed = aiConfigUpdateSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(AI_API_PATHS.config(workspaceId), json("PUT", parsed.data), (value) =>
    aiConfigViewSchema.safeParse(value),
  );
}

/**
 * Token, request, and cost roll-up over a bounded window.
 *
 * The window is validated in its serialized form for the same reason as the API
 * key list query: that is exactly what goes on the wire, and an out-of-range
 * `days` would otherwise be a 400 the reader can do nothing about.
 */
export function fetchAiUsage(
  workspaceId: string,
  days = 30,
): Promise<ApiRequestResult<AiUsageSummary>> {
  const search = new URLSearchParams({ days: String(days) });
  if (!validIds(workspaceId) || !aiUsageQuerySchema.safeParse({ days: String(days) }).success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(`${AI_API_PATHS.usage(workspaceId)}?${search.toString()}`, {}, (value) =>
    aiUsageSummarySchema.safeParse(value),
  );
}

/* ------------------------------------------------------------------------- *
 * Part 69 — meeting extraction and tag suggestion.
 *
 * Unlike Part 68's three features these answer ORDINARY JSON rather than an
 * event stream, so they go through `requestJson` like every other typed client
 * in this app: one structured object, `safeParse`d as a whole, with nothing
 * useful to show a reader halfway through a half-parsed extraction.
 *
 * BOTH NEED A TIMEOUT THE HOUSE DEFAULT DOES NOT GIVE THEM. `requestJson`
 * aborts at 8 seconds, which is right for a CRUD round trip and wrong for a
 * provider call: a model reading a 100 000-character transcript routinely runs
 * past a minute, and the 8s abort would land in the `unavailable` bucket and
 * tell the author their network failed while the request was working perfectly.
 * The ceilings below are generous rather than tight for the same reason — an
 * over-long wait is visible and cancellable, a false "try again" is neither.
 * ------------------------------------------------------------------------- */

/** Roughly a two-hour transcript's worth of model time, plus provider latency. */
const MEETING_EXTRACTION_TIMEOUT_MS = 120_000;
/** A note is at most 50 000 characters and the answer is a handful of tags. */
const TAG_SUGGESTION_TIMEOUT_MS = 30_000;

/** Cancellation the caller owns: a closed dialog, an unmounted panel. */
export interface AiRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Structure pulled out of a pasted transcript, for a human to review.
 *
 * Nothing here is written anywhere: the response is a proposal, and the review
 * screen is what turns any of it into note content or tasks.
 */
export function requestMeetingExtraction(
  workspaceId: string,
  input: AiMeetingExtractionRequestInput,
  options: AiRequestOptions = {},
): Promise<ApiRequestResult<MeetingExtractionResult>> {
  const parsed = aiMeetingExtractionRequestSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    AI_API_PATHS.meetingExtraction(workspaceId),
    json("POST", parsed.data),
    (value) => aiMeetingExtractionResultSchema.safeParse(value),
    { timeoutMs: MEETING_EXTRACTION_TIMEOUT_MS, signal: options.signal },
  );
}

/**
 * Tags for a note: workspace tags matched server-side against the real tag pool
 * (`existing`, with real ids) kept apart from names that do not exist yet
 * (`proposed`). Selecting one and creating one are different consequences, so
 * the contract never mixes them into one nullable-id list.
 */
export function requestTagSuggestions(
  workspaceId: string,
  input: AiTagSuggestionRequestInput,
  options: AiRequestOptions = {},
): Promise<ApiRequestResult<TagSuggestionResult>> {
  const parsed = aiTagSuggestionRequestSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    AI_API_PATHS.tagSuggestions(workspaceId),
    json("POST", parsed.data),
    (value) => aiTagSuggestionResultSchema.safeParse(value),
    { timeoutMs: TAG_SUGGESTION_TIMEOUT_MS, signal: options.signal },
  );
}

/* ------------------------------------------------------------------------- *
 * Part 70 — grammar and style checking.
 *
 * Same shape as tag suggestions, and for the same reasons: one structured
 * answer, `safeParse`d as a whole, under a ceiling the CRUD default does not
 * give it. Nothing here knows what a document position is — the request carries
 * opaque segment ids and plain text, and the browser is the only thing that can
 * turn an answer back into a range.
 * ------------------------------------------------------------------------- */

/** A note's changed blocks; the answer is a handful of small spans. */
const GRAMMAR_CHECK_TIMEOUT_MS = 30_000;

/**
 * Check a batch of prose blocks (at most `AI_GRAMMAR_SEGMENT_MAX` of them).
 *
 * The caller batches, dedupes, and decides what has changed since the last
 * check; this function only proves the batch against the shared contract before
 * it is allowed to leave the browser.
 */
export function requestGrammarCheck(
  workspaceId: string,
  input: AiGrammarCheckRequestInput,
  options: AiRequestOptions = {},
): Promise<ApiRequestResult<GrammarCheckResult>> {
  const parsed = aiGrammarCheckRequestSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    AI_API_PATHS.grammarCheck(workspaceId),
    json("POST", parsed.data),
    (value) => aiGrammarCheckResultSchema.safeParse(value),
    { timeoutMs: GRAMMAR_CHECK_TIMEOUT_MS, signal: options.signal },
  );
}
