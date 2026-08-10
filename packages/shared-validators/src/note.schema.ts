import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  tagIdsSchema,
  uuidSchema,
} from "./common.schema";
import { NOTE_DOCUMENT_LIMITS, noteDocumentSchema } from "./document.schema";

// Shared with tasks (Part 47); the rule now lives in `common.schema`.
export { tagIdsSchema } from "./common.schema";

export {
  NOTE_DOCUMENT_CODE_LANGUAGES,
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_MARK_TYPES,
  NOTE_DOCUMENT_MENTION_CLASS,
  NOTE_DOCUMENT_MENTION_PREFIX,
  NOTE_DOCUMENT_NODE_TYPES,
  NOTE_DOCUMENT_PAGE_BREAK_CLASS,
  NOTE_DOCUMENT_SCHEMA_VERSION,
  type NoteDocument,
  type NoteDocumentCodeLanguage,
  type NoteDocumentJson,
  type NoteDocumentMarkType,
  type NoteDocumentMentionAttrs,
  type NoteDocumentMigrationResult,
  type NoteDocumentNodeType,
  type NoteDocumentSafeParseResult,
  NoteDocumentMigrationError,
  extractNoteContentPlain,
  migrateNoteDocument,
  normalizeNoteDocumentCodeLanguage,
  normalizeUnsupportedNodes,
  noteDocumentMentionAttrs,
  noteDocumentSchema,
  parseNoteDocument,
  renderDocumentHtml,
  safeParseNoteDocument,
  sanitizeDocumentUrl,
} from "./document.schema";

export const noteTypeSchema = z.enum(["document", "task-list"]);
export const pageSizeSchema = z.enum(["a4", "letter"]);
export const noteLocationSchema = z.enum(["workspace-root", "project"]);
export const noteListViewSchema = z.enum(["normal", "recent", "pinned", "templates", "trash"]);
export const noteSortFieldSchema = z.enum([
  "title",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "sortOrder",
]);
export const noteSharePermissionSchema = z.enum(["view", "comment", "edit"]);
export const noteShareMutationPermissionSchema = z.enum(["view", "edit"]);
const titleSchema = z.string().trim().min(1).max(500);
const folderNameSchema = z.string().trim().min(1).max(255);
const versionSchema = z.number().int().min(1).max(2_147_483_647);

export const createNoteSchema = z
  .object({
    title: titleSchema,
    projectId: uuidSchema.nullable().optional(),
    folderId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    type: noteTypeSchema.default("document"),
    pageSize: pageSizeSchema.default("a4"),
    isTemplate: z.boolean().default(false),
    isPinned: z.boolean().default(false),
    isArchived: z.boolean().default(false),
    tagIds: tagIdsSchema.default([]),
    content: noteDocumentSchema.optional(),
  })
  .strict();
export type CreateNoteInput = z.input<typeof createNoteSchema>;

export const updateNoteSchema = z
  .object({
    expectedVersion: versionSchema,
    title: titleSchema.optional(),
    type: noteTypeSchema.optional(),
    pageSize: pageSizeSchema.optional(),
    isTemplate: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    tagIds: tagIdsSchema.optional(),
    content: noteDocumentSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
    message: "At least one mutable note field is required",
  });
export type UpdateNoteInput = z.input<typeof updateNoteSchema>;

export const noteListQuerySchema = z
  .object({
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    scope: noteLocationSchema.default("workspace-root"),
    projectId: uuidSchema.optional(),
    folderId: uuidSchema.optional(),
    rootFolder: explicitBooleanQuerySchema.optional(),
    parentId: uuidSchema.optional(),
    rootParent: explicitBooleanQuerySchema.optional(),
    type: noteTypeSchema.optional(),
    view: noteListViewSchema.default("normal"),
    isTemplate: explicitBooleanQuerySchema.optional(),
    isPinned: explicitBooleanQuerySchema.optional(),
    isArchived: explicitBooleanQuerySchema.optional(),
    tagId: uuidSchema.optional(),
    sortBy: noteSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "project" && value.projectId === undefined) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "projectId is required" });
    }
    if (value.scope === "workspace-root" && value.projectId !== undefined) {
      context.addIssue({ code: "custom", path: ["projectId"], message: "projectId is forbidden" });
    }
    if (value.folderId !== undefined && value.rootFolder === true) {
      context.addIssue({
        code: "custom",
        path: ["folderId"],
        message: "Choose one folder selector",
      });
    }
    if (value.parentId !== undefined && value.rootParent === true) {
      context.addIssue({
        code: "custom",
        path: ["parentId"],
        message: "Choose one parent selector",
      });
    }
  });
export type NoteListQueryInput = z.input<typeof noteListQuerySchema>;

export const moveNoteSchema = z
  .object({
    expectedVersion: versionSchema,
    projectId: uuidSchema.nullable(),
    folderId: uuidSchema.nullable(),
    parentId: uuidSchema.nullable(),
    beforeNoteId: uuidSchema.nullable().optional(),
  })
  .strict();
export type MoveNoteInput = z.input<typeof moveNoteSchema>;

// One schema serves both directions: `asTemplate: true` is "Save as template",
// `asTemplate: false` on a template row is "Create from template". There is
// deliberately no source-link field — the absence of a link is the "no
// accidental live link between copy and original" guarantee.
export const copyNoteSchema = z
  .object({
    asTemplate: z.boolean().default(false),
    title: titleSchema.optional(),
    projectId: uuidSchema.nullable().optional(),
    folderId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    includeTags: z.boolean().default(true),
  })
  .strict();
export type CopyNoteInput = z.input<typeof copyNoteSchema>;

export const deleteNoteSchema = z.object({ expectedVersion: versionSchema }).strict();
export const restoreNoteSchema = z.object({ expectedVersion: versionSchema }).strict();
export const permanentDeleteNoteSchema = z
  .object({
    expectedVersion: versionSchema,
    confirm: z.literal(true),
    expectedTitle: titleSchema,
  })
  .strict();
export type DeleteNoteInput = z.input<typeof deleteNoteSchema>;
export type RestoreNoteInput = z.input<typeof restoreNoteSchema>;
export type PermanentDeleteNoteInput = z.input<typeof permanentDeleteNoteSchema>;

export const noteNavigationQuerySchema = z
  .object({
    limit: z
      .union([
        z.number().int(),
        z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(1_000))
      .default(500),
    includeArchived: explicitBooleanQuerySchema.default(false),
    projectId: uuidSchema.optional(),
  })
  .strict();
export type NoteNavigationQueryInput = z.input<typeof noteNavigationQuerySchema>;

export const createFolderSchema = z
  .object({ name: folderNameSchema, parentId: uuidSchema.nullable().optional() })
  .strict();
export const folderListQuerySchema = z
  .object({
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    parentId: uuidSchema.optional(),
    root: explicitBooleanQuerySchema.optional(),
  })
  .strict()
  .refine((value) => value.parentId === undefined || value.root !== true, {
    message: "Choose one parent selector",
  });
export const updateFolderSchema = z
  .object({ name: folderNameSchema.optional(), parentId: uuidSchema.nullable().optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.parentId !== undefined, {
    message: "At least one folder field is required",
  });
export const deleteFolderSchema = z.object({ confirm: z.literal(true) }).strict();
export type CreateFolderInput = z.input<typeof createFolderSchema>;
export type FolderListQueryInput = z.input<typeof folderListQuerySchema>;
export type UpdateFolderInput = z.input<typeof updateFolderSchema>;
export type DeleteFolderInput = z.input<typeof deleteFolderSchema>;

const timestampSchema = isoTimestampSchema;
const nullableUuid = uuidSchema.nullable();
export const noteSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    location: noteLocationSchema,
    projectId: nullableUuid,
    folderId: nullableUuid,
    parentId: nullableUuid,
    title: titleSchema,
    type: noteTypeSchema,
    pageSize: pageSizeSchema,
    sortOrder: z.number().finite(),
    isTemplate: z.boolean(),
    isPinned: z.boolean(),
    isArchived: z.boolean(),
    isDeleted: z.boolean(),
    tagIds: z.array(uuidSchema).max(50).readonly(),
    version: versionSchema,
    deletedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const noteDetailSchema = noteSummarySchema
  .extend({
    content: noteDocumentSchema,
    contentPlain: z.string().max(NOTE_DOCUMENT_LIMITS.maxTotalText),
    createdById: uuidSchema,
    updatedById: nullableUuid,
    currentActorId: uuidSchema,
    capabilities: z
      .object({
        canUpdate: z.boolean(),
        canDelete: z.boolean(),
        canShare: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const notePageSchema = z
  .object({
    items: z.array(noteSummarySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();
export const noteNavigationItemSchema = noteSummarySchema
  .pick({
    id: true,
    projectId: true,
    folderId: true,
    parentId: true,
    title: true,
    type: true,
    sortOrder: true,
    isTemplate: true,
    isPinned: true,
    isArchived: true,
    version: true,
    updatedAt: true,
  })
  .strict();
export const noteNavigationSchema = z
  .object({
    items: z.array(noteNavigationItemSchema).max(1_000).readonly(),
    limit: z.number().int().min(1).max(1_000),
    returned: z.number().int().min(0).max(1_000),
    truncated: z.boolean(),
  })
  .strict();
export const noteCreateResultSchema = z.object({ note: noteDetailSchema }).strict();
export const noteUpdateResultSchema = z.object({ note: noteDetailSchema }).strict();
export const noteMoveResultSchema = z.object({ note: noteSummarySchema }).strict();
export const noteDeleteResultSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
    affected: z.number().int().min(1),
    version: versionSchema,
    deletedAt: timestampSchema,
  })
  .strict();
export const noteRestoreResultSchema = z
  .object({
    id: uuidSchema,
    restored: z.literal(true),
    affected: z.number().int().min(1),
    version: versionSchema,
  })
  .strict();
export const notePermanentDeleteResultSchema = z
  .object({ id: uuidSchema, permanentlyDeleted: z.literal(true) })
  .strict();

export const folderSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    parentId: nullableUuid,
    name: folderNameSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const folderPageSchema = z
  .object({
    items: z.array(folderSummarySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();
export const folderCreateResultSchema = z.object({ folder: folderSummarySchema }).strict();
export const folderUpdateResultSchema = z.object({ folder: folderSummarySchema }).strict();
export const folderDeleteResultSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
    removedFolders: z.number().int().min(1),
    unfiledNotes: z.number().int().min(0),
  })
  .strict();

export const upsertNoteShareSchema = z
  .object({ permission: noteShareMutationPermissionSchema })
  .strict();
export type UpsertNoteShareInput = z.input<typeof upsertNoteShareSchema>;

export const noteShareGrantSchema = z
  .object({
    id: uuidSchema,
    noteId: uuidSchema,
    userId: uuidSchema,
    permission: noteSharePermissionSchema,
    createdAt: timestampSchema,
  })
  .strict();
export const noteShareListSchema = z
  .object({
    items: z.array(noteShareGrantSchema).max(1_000).readonly(),
    limit: z.literal(1_000),
    returned: z.number().int().min(0).max(1_000),
    truncated: z.boolean(),
  })
  .strict();
export const noteShareUpsertResultSchema = z.object({ share: noteShareGrantSchema }).strict();
export const noteShareDeleteResultSchema = z
  .object({ noteId: uuidSchema, userId: uuidSchema, revoked: z.literal(true) })
  .strict();

// Compatibility aliases retained for earlier consumers; location mutation is intentionally removed.
export const createNoteMetadataSchema = createNoteSchema;
export const updateNoteMetadataSchema = updateNoteSchema;
export const noteMetadataFilterSchema = noteListQuerySchema;
export type CreateNoteMetadataInput = CreateNoteInput;
export type UpdateNoteMetadataInput = UpdateNoteInput;
export type NoteMetadataFilterInput = NoteListQueryInput;
