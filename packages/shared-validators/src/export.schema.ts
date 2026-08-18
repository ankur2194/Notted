// Part 62 — export request contracts.
//
// `exportOptionsSchema` IS the `exports.options` jsonb contract: the service
// parses request input through it and stores the parsed (defaulted) object, so
// the column can never hold a shape the readers do not understand.

import { z } from "zod";

import { paginationQuerySchema, uuidSchema } from "./common.schema";

export const exportFormatSchema = z.enum(["pdf", "html", "markdown", "txt", "docx", "zip"]);

export const exportStatusSchema = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
  "cancelled",
]);

export const exportSourceSchema = z.enum(["note", "project", "workspace"]);

/** Header/footer are printed verbatim onto the artefact, so they stay short. */
const decorationTextSchema = z.string().trim().max(200);

/**
 * Page margins in whole millimetres for the paginated formats.
 *
 * The bound here is a SANITY bound, not the real limit: the true ceiling is
 * `MAX_PAGE_MARGINS`, which is derived from the sheet table in
 * `@notted/shared-types` and cannot be imported here (this package depends on
 * `zod` alone, by design). The renderer runs `clampMargins` on whatever
 * survives this, so the two layers together are what keep an unusable page off
 * the paper. `null` means "use the default" — see `ExportOptions.margins`.
 */
const pageMarginsSchema = z
  .object({
    x: z.number().int().min(0).max(500),
    y: z.number().int().min(0).max(500),
  })
  .strict();

export const exportOptionsSchema = z
  .object({
    includeAttachments: z.boolean().default(false),
    includeComments: z.boolean().default(false),
    includeVersionHistory: z.boolean().default(false),
    headerText: decorationTextSchema.nullable().default(null),
    footerText: decorationTextSchema.nullable().default(null),
    margins: pageMarginsSchema.nullable().default(null),
  })
  .strict();

export const exportCreateSchema = z
  .object({
    format: exportFormatSchema,
    sourceType: exportSourceSchema,
    /**
     * Required for `note`/`project`; must be absent for `workspace` (the
     * workspace itself is the source). The refinement below enforces both
     * directions so a stray id can never widen the scope of an export.
     */
    sourceId: uuidSchema.optional(),
    // `prefault`, not `default`: `default` supplies an OUTPUT value and would
    // have to restate all five fields, duplicating the per-field defaults above
    // and drifting from them. `prefault` feeds `{}` in as INPUT, so the field
    // defaults stay the single source of truth and an omitted `options` parses
    // to exactly what an explicit `{}` parses to.
    options: exportOptionsSchema.prefault({}),
  })
  .strict()
  .refine(
    ({ sourceType, sourceId }) =>
      sourceType === "workspace" ? sourceId === undefined : sourceId !== undefined,
    { path: ["sourceId"], message: "sourceId is required unless sourceType is workspace" },
  );

export const exportListQuerySchema = paginationQuerySchema
  .extend({ status: exportStatusSchema.optional() })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });

export type ExportCreateInput = z.input<typeof exportCreateSchema>;
export type ExportOptionsInput = z.input<typeof exportOptionsSchema>;
export type ExportOptionsOutput = z.output<typeof exportOptionsSchema>;
export type ExportListQueryInput = z.input<typeof exportListQuerySchema>;
