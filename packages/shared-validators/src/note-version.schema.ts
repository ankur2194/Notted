import { z } from "zod";

import { isoTimestampSchema, uuidSchema } from "./common.schema";
import { noteDocumentSchema } from "./document.schema";
import { noteDetailSchema } from "./note.schema";

const versionNumberSchema = z.number().int().min(1).max(2_147_483_647);
const versionTitleSchema = z.string().min(1).max(500);

export const noteVersionCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const noteVersionListQuerySchema = z
  .object({
    limit: z
      .union([
        z.number().int(),
        z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(50))
      .default(20),
    cursor: noteVersionCursorSchema.optional(),
  })
  .strict();

export const restoreNoteVersionSchema = z.object({ expectedVersion: versionNumberSchema }).strict();

export const noteVersionSummarySchema = z
  .object({
    id: uuidSchema,
    version: versionNumberSchema,
    title: versionTitleSchema,
    author: z.object({ id: uuidSchema, name: z.string().min(1).max(255) }).strict(),
    createdAt: isoTimestampSchema,
    isCurrent: z.boolean(),
  })
  .strict();

export const noteVersionPageSchema = z
  .object({
    items: z.array(noteVersionSummarySchema).max(50),
    nextCursor: noteVersionCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const noteVersionDetailSchema = noteVersionSummarySchema
  .extend({ content: noteDocumentSchema })
  .strict();

export const noteVersionRestoreResultSchema = z
  .object({
    note: noteDetailSchema,
    restoredFrom: noteVersionSummarySchema,
    createdVersion: noteVersionSummarySchema,
  })
  .strict();

export type NoteVersionListQueryInput = z.input<typeof noteVersionListQuerySchema>;
export type RestoreNoteVersionInput = z.input<typeof restoreNoteVersionSchema>;
