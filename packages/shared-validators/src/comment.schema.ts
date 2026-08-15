// Part 60 — inline comment contracts shared by tRPC, REST, and the browser.
//
// ANCHOR MODEL. The four pre-existing `comments` columns carry everything a
// robust anchor needs, so Part 60 adds no column and no migration:
//
//   anchor_key       the ENCODING SCHEME discriminator ("yrel:1" / "pmabs:1").
//                    A future scheme is a new VALUE, never a new column.
//                    NULL = whole-note comment (the documented convention in
//                    `apps/api/src/database/schema/comments.ts`).
//   anchor_from/to   ProseMirror ABSOLUTE positions AT CREATION TIME. The
//                    fallback, and the only thing a non-collaborative reader
//                    (print, export, SSR preview) can use.
//   anchor_metadata  { relFrom, relTo, quote, schemaVersion } — the Yjs
//                    relative positions that actually survive edits, plus the
//                    quoted text used to render an orphaned comment.
//
// THE SERVER NEVER REMAPS. It stores what the client sends and validates shape
// and size. Re-deriving anchors server-side would be a second implementation of
// `y-prosemirror`'s mapping algorithm for no benefit: only a client holding the
// live Y.Doc can resolve a relative position, and it already does so to draw the
// decoration.
//
// ORPHANED COMMENTS are not a stored flag. `relativePositionToAbsolutePosition`
// returns `null` when the anchored content was deleted, so the client that holds
// the document derives orphan-ness for free and lists the comment under
// "Orphaned" using `quote`. A server-side flag would be a guess: the API has no
// document positions to resolve against. Orphaned comments are NEVER deleted and
// NEVER re-guessed.

import { z } from "zod";

import { isoTimestampSchema, uuidSchema } from "./common.schema";
import { NOTE_DOCUMENT_SCHEMA_VERSION } from "./document.schema";

/** Comment bodies are short plain text/markdown — never TipTap JSON. */
export const COMMENT_CONTENT_MAX_LENGTH = 4_000;

/** Quoted excerpt stored with an anchor so an orphan still reads as something. */
export const COMMENT_ANCHOR_QUOTE_MAX_LENGTH = 120;

/**
 * Base64url of `Y.encodeRelativePosition(...)`. A relative position is a short
 * binary struct (client id + clock + type path); 512 chars is generous headroom
 * for a deeply nested node path while keeping a forged value from becoming a
 * jsonb bomb.
 */
export const COMMENT_ANCHOR_RELATIVE_MAX_LENGTH = 512;

/**
 * ProseMirror positions are bounded by document size, which the document
 * contract already caps far below this. The ceiling exists to reject nonsense,
 * not to express a real document limit.
 */
export const COMMENT_ANCHOR_POSITION_MAX = 5_000_000;

/**
 * Yjs relative positions, resolved through the `y-prosemirror` binding. Used
 * whenever the editor is in COLLABORATIVE mode.
 */
export const COMMENT_ANCHOR_SCHEME_YJS = "yrel:1" as const;

/**
 * Absolute ProseMirror positions only. Used in SOLO mode, where there is no Yjs
 * binding and therefore no relative position to create. Such an anchor does not
 * survive concurrent edits — it is the honest best a non-collaborative session
 * can persist.
 */
export const COMMENT_ANCHOR_SCHEME_ABSOLUTE = "pmabs:1" as const;

export const commentAnchorSchemeSchema = z.enum([
  COMMENT_ANCHOR_SCHEME_YJS,
  COMMENT_ANCHOR_SCHEME_ABSOLUTE,
]);

const relativePositionSchema = z
  .string()
  .min(1)
  .max(COMMENT_ANCHOR_RELATIVE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected base64url");

export const commentAnchorSchema = z
  .object({
    scheme: commentAnchorSchemeSchema,
    /** ProseMirror absolute positions at creation time. */
    from: z.number().int().nonnegative().max(COMMENT_ANCHOR_POSITION_MAX),
    to: z.number().int().nonnegative().max(COMMENT_ANCHOR_POSITION_MAX),
    /** Anchored text, for orphan display. Empty is valid (a collapsed anchor). */
    quote: z.string().max(COMMENT_ANCHOR_QUOTE_MAX_LENGTH),
    /** Base64url `Y.encodeRelativePosition`. Present only for `yrel:1`. */
    relFrom: relativePositionSchema.optional(),
    relTo: relativePositionSchema.optional(),
    schemaVersion: z.number().int().positive(),
  })
  .strict()
  .refine((anchor) => anchor.to >= anchor.from, {
    message: "Anchor end must not precede its start",
    path: ["to"],
  })
  .refine(
    (anchor) =>
      anchor.scheme !== COMMENT_ANCHOR_SCHEME_YJS ||
      (anchor.relFrom !== undefined && anchor.relTo !== undefined),
    {
      message: "A yrel:1 anchor must carry both relative positions",
      path: ["relFrom"],
    },
  )
  .refine(
    (anchor) =>
      anchor.scheme !== COMMENT_ANCHOR_SCHEME_ABSOLUTE ||
      (anchor.relFrom === undefined && anchor.relTo === undefined),
    {
      message: "A pmabs:1 anchor must not carry relative positions",
      path: ["relFrom"],
    },
  );
export type CommentAnchorInput = z.input<typeof commentAnchorSchema>;

/** The document schema version an anchor was created against. */
export const COMMENT_ANCHOR_SCHEMA_VERSION = NOTE_DOCUMENT_SCHEMA_VERSION;

export const commentContentSchema = z.string().trim().min(1).max(COMMENT_CONTENT_MAX_LENGTH);

export const createCommentSchema = z
  .object({
    content: commentContentSchema,
    /** `null`/absent = a new top-level thread. */
    parentId: uuidSchema.nullish(),
    /** `null`/absent = a whole-note comment with no selection. */
    anchor: commentAnchorSchema.nullish(),
  })
  .strict();
export type CreateCommentInput = z.input<typeof createCommentSchema>;

export const updateCommentSchema = z.object({ content: commentContentSchema }).strict();
export type UpdateCommentInput = z.input<typeof updateCommentSchema>;

/**
 * ONE route, not two. `POST /:commentId/resolution` with the desired state is a
 * single idempotent transition; separate resolve/unresolve routes would double
 * the authorization surface for one boolean.
 */
export const commentResolutionSchema = z.object({ isResolved: z.boolean() }).strict();
export type CommentResolutionInput = z.input<typeof commentResolutionSchema>;

export const commentAuthorSchema = z.object({ id: uuidSchema, name: z.string().max(200) }).strict();

export const commentSummarySchema = z
  .object({
    id: uuidSchema,
    noteId: uuidSchema,
    parentId: uuidSchema.nullable(),
    content: z.string(),
    createdBy: commentAuthorSchema,
    isResolved: z.boolean(),
    resolvedAt: isoTimestampSchema.nullable(),
    resolvedBy: commentAuthorSchema.nullable(),
    anchor: commentAnchorSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const commentThreadSchema = commentSummarySchema
  .extend({ replies: z.array(commentSummarySchema) })
  .strict();

export const commentPageSchema = z
  .object({
    items: z.array(commentThreadSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    hasMore: z.boolean(),
    openCount: z.number().int().nonnegative(),
  })
  .strict();

export const commentStatusFilterSchema = z.enum(["all", "open", "resolved"]);

export const commentListQuerySchema = z
  .object({
    page: z
      .union([
        z.number().int(),
        z
          .string()
          .regex(/^(0|[1-9]\d*)$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1))
      .default(1),
    limit: z
      .union([
        z.number().int(),
        z
          .string()
          .regex(/^(0|[1-9]\d*)$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(100))
      .default(50),
    status: commentStatusFilterSchema.default("all"),
  })
  .strict();
export type CommentListQueryInput = z.input<typeof commentListQuerySchema>;

export const commentMutationResultSchema = z.object({ comment: commentSummarySchema }).strict();

export const commentDeleteResultSchema = z
  .object({ id: uuidSchema, deletedCount: z.number().int().positive() })
  .strict();
