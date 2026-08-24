import { z } from "zod";

import { isoTimestampSchema, uuidSchema } from "./common.schema";
import { tagNameSchema } from "./tag.schema";

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

/**
 * Part 68 — summarize, continue writing, and tone rewrite.
 *
 * THE CHARACTER CEILINGS ARE THE COST CONTROL. Every one of these bodies is
 * note text the browser read out of the live editor, and the prompt built from
 * it is billed per token. A missing bound is not a validation nicety here, it is
 * an unbounded charge on a workspace's provider account, so each feature caps
 * its input at the smallest size that still does the job: a whole note for a
 * summary, the tail before the caret for a continuation, one selection for a
 * rewrite.
 *
 * WHY THE TEXT IS ON THE WIRE AT ALL, given the server holds the note. Part 58
 * hands `notes.content` to the Yjs projection while a collaborative session is
 * live, so the freshest document exists in the browser, not in the row. Reading
 * the row would summarise a version the writer can see is out of date.
 * `noteId` is still required and still authorized — it is what proves the caller
 * may work on this note at all — it is simply not the source of the text.
 */
export const AI_SUMMARIZE_MAX_CHARS = 24_000;
export const AI_CONTINUE_MAX_CHARS = 8_000;
export const AI_REWRITE_MAX_CHARS = 4_000;

export const aiSummaryLengthSchema = z.enum(["brief", "medium", "detailed"]);

export const aiToneSchema = z.enum(["professional", "casual", "concise", "elaborate", "simplify"]);

/**
 * `.min(1)` after trimming, on all three: a request built from an empty
 * selection or a blank note is a client bug, and sending it would spend a
 * provider call to be told the same thing.
 */
const aiFeatureText = (max: number) => z.string().trim().min(1).max(max);

export const aiSummarizeRequestSchema = z
  .object({
    noteId: uuidSchema,
    text: aiFeatureText(AI_SUMMARIZE_MAX_CHARS),
    length: aiSummaryLengthSchema,
  })
  .strict();

export type AiSummarizeRequestInput = z.input<typeof aiSummarizeRequestSchema>;

export const aiContinueRequestSchema = z
  .object({
    noteId: uuidSchema,
    /** The text immediately before the caret — never the whole note. */
    context: aiFeatureText(AI_CONTINUE_MAX_CHARS),
  })
  .strict();

export type AiContinueRequestInput = z.input<typeof aiContinueRequestSchema>;

export const aiRewriteRequestSchema = z
  .object({
    noteId: uuidSchema,
    text: aiFeatureText(AI_REWRITE_MAX_CHARS),
    tone: aiToneSchema,
  })
  .strict();

export type AiRewriteRequestInput = z.input<typeof aiRewriteRequestSchema>;

/**
 * One `data:` frame, validated on arrival.
 *
 * The browser parses these out of a raw byte stream it read itself, so they get
 * the same treatment as any other API response: an off-contract frame is a
 * failure, never a silent cast. Discriminated on `type` so a frame naming an
 * unknown kind is rejected rather than partially matched.
 */
export const aiStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("done"),
      promptVersion: z.string().min(1).max(50),
      promptTokens: z.number().int().min(0).nullable(),
      completionTokens: z.number().int().min(0).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum(["ai_provider_error", "ai_output_empty", "ai_output_truncated"]),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);

/**
 * Part 69 — meeting extraction and tag suggestion.
 *
 * TWO KINDS OF SCHEMA LIVE BELOW AND THEY ARE NOT INTERCHANGEABLE.
 *
 * The REQUEST schemas are `.strict()`, like every other body in this file: the
 * browser wrote them, an unknown key is a client bug, and rejecting it early is
 * free.
 *
 * The MODEL-OUTPUT schema ({@link meetingExtractionSchema}) is deliberately NOT
 * strict. It parses a JSON document a language model wrote, and a model that
 * answers correctly and adds one helpful `"summary"` key alongside is not a
 * failure worth a second billed provider call. Zod strips unknown keys by
 * default, so being lenient here discards the extra field rather than trusting
 * it — nothing unvalidated survives into the response. What IS enforced is
 * everything that protects the reviewer: the shape, the per-item length, and
 * the list caps.
 *
 * EVERY LIST DEFAULTS TO `[]`. A meeting with no decisions is the common case,
 * and a model expressing that by omitting the key entirely (or sending `null`)
 * is not malformed output. Defaulting means the review screen renders an empty
 * section instead of paying for a repair pass to be told the same thing.
 */
export const AI_MEETING_TRANSCRIPT_MAX_CHARS = 100_000;
export const AI_TAG_CONTENT_MAX_CHARS = 50_000;

/** Per-item ceilings. An "attendee" longer than this is not a name. */
export const AI_MEETING_ITEM_MAX_CHARS = 500;
export const AI_MEETING_NAME_MAX_CHARS = 200;

export const AI_MEETING_LIST_MAX = 100;
export const AI_MEETING_AGENDA_MAX = 50;
export const AI_TAG_SUGGESTION_EXISTING_MAX = 10;
export const AI_TAG_SUGGESTION_PROPOSED_MAX = 5;

export const aiMeetingExtractionRequestSchema = z
  .object({
    /**
     * Pasted by the author, never read from a note: a transcript is normally
     * something they have in a chat log or a meeting tool, not something already
     * in Notted. 100 000 characters is roughly a two-hour transcript, and the
     * bound is the cost control — the whole thing becomes prompt tokens.
     */
    transcript: z.string().trim().min(1).max(AI_MEETING_TRANSCRIPT_MAX_CHARS),
  })
  .strict();

export type AiMeetingExtractionRequestInput = z.input<typeof aiMeetingExtractionRequestSchema>;

/**
 * `null` and `""` both mean "the transcript did not say", which is how a model
 * expresses an absent optional far more often than by omitting the key. Mapping
 * them to `undefined` here is the difference between an ordinary answer and a
 * repair pass nobody needed.
 */
const aiOptionalText = (max: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().trim().min(1).max(max).optional(),
  );

/** Calendar date, no time and no zone: a meeting says "by Friday". */
const aiMeetingDueDate = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD calendar date")
    .optional(),
);

export const aiMeetingActionItemSchema = z.object({
  text: z.string().trim().min(1).max(AI_MEETING_ITEM_MAX_CHARS),
  /** A name the transcript used, never a workspace member id — see the type docs. */
  assignee: aiOptionalText(AI_MEETING_NAME_MAX_CHARS),
  dueDate: aiMeetingDueDate,
});

const aiMeetingList = (max: number) =>
  z
    .preprocess(
      (value) => (value === null || value === undefined ? [] : value),
      z.array(z.string().trim().min(1).max(AI_MEETING_ITEM_MAX_CHARS)),
    )
    .transform((items) => items.slice(0, max))
    .default([]);

export const aiMeetingExtractionSchema = z.object({
  attendees: aiMeetingList(AI_MEETING_LIST_MAX),
  agenda: aiMeetingList(AI_MEETING_AGENDA_MAX),
  discussionPoints: aiMeetingList(AI_MEETING_LIST_MAX),
  decisions: aiMeetingList(AI_MEETING_LIST_MAX),
  actionItems: z
    .preprocess(
      (value) => (value === null || value === undefined ? [] : value),
      z.array(aiMeetingActionItemSchema),
    )
    .transform((items) => items.slice(0, AI_MEETING_LIST_MAX))
    .default([]),
});

export const aiMeetingExtractionResultSchema = z
  .object({ extraction: aiMeetingExtractionSchema })
  .strict();

export const aiTagSuggestionRequestSchema = z
  .object({
    /**
     * Authorized for tenancy, and it is also what scopes the tag pool the
     * server matches against. The text still comes from the live editor, for
     * the same Part 58 reason the streaming features do.
     */
    noteId: uuidSchema,
    content: z.string().trim().min(1).max(AI_TAG_CONTENT_MAX_CHARS),
  })
  .strict();

export type AiTagSuggestionRequestInput = z.input<typeof aiTagSuggestionRequestSchema>;

/**
 * The intermediate shape the MODEL answers with: bare strings, no ids.
 *
 * A model is never shown a tag id and never asked to choose one. It proposes
 * names; the server matches those names against the workspace's own pool and
 * decides which are existing tags and which are new. That is what makes "only
 * authorized existing tags" a property of the code rather than of the prompt.
 */
export const aiTagSuggestionModelSchema = z.object({
  tags: z
    .preprocess(
      (value) => (value === null || value === undefined ? [] : value),
      z.array(z.string().trim().min(1).max(200)),
    )
    .transform((items) => items.slice(0, 50))
    .default([]),
});

export const aiTagSuggestionResultSchema = z
  .object({
    existing: z
      .array(z.object({ tagId: uuidSchema, name: tagNameSchema }).strict())
      .max(AI_TAG_SUGGESTION_EXISTING_MAX)
      .readonly(),
    proposed: z
      .array(z.object({ name: tagNameSchema }).strict())
      .max(AI_TAG_SUGGESTION_PROPOSED_MAX)
      .readonly(),
  })
  .strict();

/**
 * Part 70 — grammar and style assistance.
 *
 * `text` IS NOT TRIMMED, AND THAT IS THE WHOLE POINT. Every other text field in
 * this file trims, because every other one is a value. This one is a coordinate
 * system: the answer's `start`/`end` are offsets into exactly this string, so
 * silently removing a leading space here would shift every offset by one and
 * move each correction one character to the left. `.min(1)` still rejects the
 * empty segment, which is a client bug rather than a blank block — the caller
 * skips those before batching.
 *
 * THE ID IS OPAQUE AND UNUSED SERVER-SIDE. It is a key the browser chose (a
 * content hash, as it happens) and the server only ever echoes it back, so it is
 * bounded rather than parsed: nothing here indexes on it, and nothing here can
 * be addressed through it.
 *
 * It DOES trim, unlike `text` and for the opposite reason: an id is a value, not
 * a coordinate system, so there is nothing to shift. Trimming here is what keeps
 * it symmetric with `aiGrammarModelSuggestionSchema.segmentId`, which trims the
 * model's echo of the same string. Without the pair, an id sent with stray
 * whitespace would come back trimmed, miss the service's segment lookup, and be
 * dropped for a reason no reader would ever guess.
 */
export const AI_GRAMMAR_SEGMENT_MAX = 20;
export const AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS = 2_000;
export const AI_GRAMMAR_SEGMENT_ID_MAX_CHARS = 64;
export const AI_GRAMMAR_SUGGESTION_MAX = 200;
/** One sentence of explanation. Longer than this is an essay in a popover. */
export const AI_GRAMMAR_MESSAGE_MAX_CHARS = 300;

export const aiGrammarCategorySchema = z.enum(["grammar", "style", "spelling"]);

export const aiGrammarSegmentSchema = z
  .object({
    id: z.string().trim().min(1).max(AI_GRAMMAR_SEGMENT_ID_MAX_CHARS),
    text: z.string().min(1).max(AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS),
  })
  .strict();

export const aiGrammarCheckRequestSchema = z
  .object({
    segments: z.array(aiGrammarSegmentSchema).min(1).max(AI_GRAMMAR_SEGMENT_MAX),
  })
  .strict();

export type AiGrammarCheckRequestInput = z.input<typeof aiGrammarCheckRequestSchema>;

/**
 * One correction, as the RESPONSE states it. `.strict()` and fully bounded: by
 * the time a suggestion reaches here the service has already dropped everything
 * out of bounds, inverted, or identical to the text it claims to replace.
 *
 * `replacement` has no lower bound because deleting a stray word is a real
 * correction, and `end` is exclusive — the pair describes a half-open range.
 */
export const aiGrammarSuggestionSchema = z
  .object({
    segmentId: z.string().min(1).max(AI_GRAMMAR_SEGMENT_ID_MAX_CHARS),
    start: z.number().int().min(0).max(AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS),
    end: z.number().int().min(0).max(AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS),
    replacement: z.string().max(AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS),
    message: z.string().trim().min(1).max(AI_GRAMMAR_MESSAGE_MAX_CHARS),
    category: aiGrammarCategorySchema,
  })
  .strict();

export const aiGrammarCheckResultSchema = z
  .object({
    suggestions: z.array(aiGrammarSuggestionSchema).max(AI_GRAMMAR_SUGGESTION_MAX).readonly(),
  })
  .strict();

/**
 * The shape the MODEL answers with — lenient for the same reason
 * {@link aiMeetingExtractionSchema} is, and then some.
 *
 * `category` uses `.catch`: a model that answers `"punctuation"` has understood
 * the task and mislabelled the bucket, and paying for a second billed provider
 * call to be told that would be absurd. It lands in `grammar`, which is what a
 * punctuation fix is.
 *
 * `start`/`end` are `coerce`d because a model writes `"12"` as often as `12`,
 * and a string offset is a formatting slip rather than a wrong answer. What is
 * NOT forgiven here is the range itself: nothing in this schema knows how long
 * the segment was, so `grammar.service.ts` re-checks every pair against the
 * real text and drops what does not fit. Being lenient here would be unsafe if
 * this were the last check — it is not.
 */
export const aiGrammarModelSuggestionSchema = z.object({
  segmentId: z.string().trim().min(1).max(AI_GRAMMAR_SEGMENT_ID_MAX_CHARS),
  start: z.coerce.number().int().min(0),
  end: z.coerce.number().int().min(0),
  replacement: z.preprocess(
    (value) => (value === null || value === undefined ? "" : value),
    z.string().max(AI_GRAMMAR_SEGMENT_TEXT_MAX_CHARS),
  ),
  message: z.string().trim().min(1).max(AI_GRAMMAR_MESSAGE_MAX_CHARS),
  category: aiGrammarCategorySchema.catch("grammar"),
});

export const aiGrammarModelSchema = z.object({
  suggestions: z
    .preprocess(
      (value) => (value === null || value === undefined ? [] : value),
      z.array(aiGrammarModelSuggestionSchema),
    )
    .transform((items) => items.slice(0, AI_GRAMMAR_SUGGESTION_MAX))
    .default([]),
});
