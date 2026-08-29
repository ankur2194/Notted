import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  HEX_COLOR_PATTERN,
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  tagIdsSchema,
  uuidSchema,
} from "./common.schema";

/**
 * Every enum below mirrors a PostgreSQL enum in
 * `apps/api/src/database/schema/tasks.ts`. The database is the source of
 * truth, including the single-`l` `canceled` spelling.
 */
export const taskStatusSchema = z.enum(["todo", "in_progress", "done", "canceled"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const taskRecurrenceSchema = z.enum(["none", "daily", "weekly", "monthly", "custom"]);
export const taskSortFieldSchema = z.enum([
  "sortOrder",
  "createdAt",
  "updatedAt",
  "dueDate",
  "priority",
  "title",
]);
export const taskGroupingSchema = z.enum(["none", "status", "priority", "assignee", "dueDate"]);

/**
 * A custom status may not shadow a built-in one. The reserved set is derived
 * from the enum above rather than retyped, so adding a built-in status can
 * never leave a stale copy behind, and the comparison is case-insensitive
 * because "Done" and "done" render identically on a board.
 */
export const TASK_STATUS_RESERVED_NAMES: readonly string[] = taskStatusSchema.options;

/** Matches `varchar(50)` on `task_statuses.name`. */
export const taskStatusNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine(
    (value) => !TASK_STATUS_RESERVED_NAMES.includes(value.toLowerCase()),
    "This name is reserved for a built-in status",
  );

/** Matches `varchar(7)` on `task_statuses.color`. */
export const taskStatusColorSchema = z
  .string()
  .regex(HEX_COLOR_PATTERN, "Expected a six-digit hex color");

/** Matches `varchar(500)` on `tasks.title`. */
export const taskTitleSchema = z.string().trim().min(1).max(500);
/** `tasks.description` is `text` and holds plain text, never TipTap JSON. */
export const taskDescriptionSchema = z.string().trim().max(10_000).nullable();

/**
 * Shape only. The five-field grammar is validated server-side by cron-parser,
 * which already owns the ranges, step syntax and month/day-name aliases — a
 * regex here would only ever be a worse second opinion.
 */
export const taskCronSchema = z.string().trim().min(1).max(200);

/**
 * `recurrence: "custom"` and `recurrenceCron` are mutually required. Anything
 * else must leave the cron empty, otherwise a stale expression silently
 * survives a switch back to `weekly` and resurfaces on the next edit.
 */
function refineRecurrence(
  value: {
    recurrence?: "none" | "daily" | "weekly" | "monthly" | "custom";
    recurrenceCron?: string | null;
  },
  context: z.RefinementCtx,
): void {
  const hasCron = typeof value.recurrenceCron === "string" && value.recurrenceCron.length > 0;
  if (value.recurrence === undefined) {
    // A cron with no recurrence is rejected rather than ignored. The service
    // resolves the expression from the recurrence it is being set to, so an
    // accepted lone cron would be silently discarded and the caller would
    // believe the schedule changed.
    if (hasCron) {
      context.addIssue({
        code: "custom",
        path: ["recurrence"],
        message: "Set recurrence to custom when sending a cron expression",
      });
    }
    return;
  }
  if (value.recurrence === "custom" && !hasCron) {
    context.addIssue({
      code: "custom",
      path: ["recurrenceCron"],
      message: "A cron expression is required for custom recurrence",
    });
  }
  if (value.recurrence !== "custom" && hasCron) {
    context.addIssue({
      code: "custom",
      path: ["recurrenceCron"],
      message: "A cron expression is only allowed for custom recurrence",
    });
  }
}

export const createTaskSchema = z
  .object({
    projectId: uuidSchema.nullable().optional(),
    noteId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    title: taskTitleSchema,
    description: taskDescriptionSchema.optional(),
    status: taskStatusSchema.optional(),
    customStatusId: uuidSchema.nullable().optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueDate: isoTimestampSchema.nullable().optional(),
    /**
     * Placement is an anchor, never an absolute index: `sortOrder` is
     * `double precision` and the server computes the midpoint. `null` appends.
     */
    beforeTaskId: uuidSchema.nullable().optional(),
    tagIds: tagIdsSchema.optional(),
    recurrence: taskRecurrenceSchema.optional(),
    recurrenceCron: taskCronSchema.nullable().optional(),
  })
  .strict()
  .superRefine(refineRecurrence);
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.optional(),
    status: taskStatusSchema.optional(),
    customStatusId: uuidSchema.nullable().optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueDate: isoTimestampSchema.nullable().optional(),
    tagIds: tagIdsSchema.optional(),
    recurrence: taskRecurrenceSchema.optional(),
    recurrenceCron: taskCronSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one task field is required",
  })
  .superRefine(refineRecurrence);
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

/**
 * Reordering carries the destination group as well as the anchor: moving a
 * task between notes, projects or parents is the same operation as moving it
 * within one, and splitting them would let the two paths drift.
 */
export const reorderTaskSchema = z
  .object({
    beforeTaskId: uuidSchema.nullable(),
    noteId: uuidSchema.nullable().optional(),
    projectId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
  })
  .strict();
export type ReorderTaskInput = z.input<typeof reorderTaskSchema>;

const taskListQueryBase = z
  .object({
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    noteId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    parentId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    tagId: uuidSchema.optional(),
    dueFrom: isoTimestampSchema.optional(),
    dueTo: isoTimestampSchema.optional(),
    isCompleted: explicitBooleanQuerySchema.optional(),
    grouping: taskGroupingSchema.default("none"),
    sortBy: taskSortFieldSchema.default("sortOrder"),
    sortDirection: sortDirectionSchema.default("asc"),
  })
  .strict();

/** Both forms reject an inverted range identically; only `isCompleted` differs. */
const orderedDueRange = ({
  dueFrom,
  dueTo,
}: {
  readonly dueFrom?: string;
  readonly dueTo?: string;
}): boolean =>
  dueFrom === undefined || dueTo === undefined || Date.parse(dueFrom) <= Date.parse(dueTo);
const orderedDueRangeIssue = {
  message: "dueFrom must be earlier than or equal to dueTo",
  path: ["dueTo"],
};

/** The REST form: every selector arrives as a query-string token. */
export const taskListQuerySchema = taskListQueryBase.refine(orderedDueRange, orderedDueRangeIssue);
export type TaskListQueryInput = z.input<typeof taskListQuerySchema>;

/**
 * The tRPC form.
 *
 * tRPC carries JSON, so a caller writes `isCompleted: false` and means the
 * boolean. Reusing the REST schema would force it to send the STRING `"false"`
 * — a trap Part 48's board filter would walk straight into — while `"false"`
 * transformed to `false` still parses, so nothing that works today breaks.
 */
export const taskListInputSchema = taskListQueryBase
  .extend({ isCompleted: z.union([z.boolean(), explicitBooleanQuerySchema]).optional() })
  .refine(orderedDueRange, orderedDueRangeIssue);
export type TaskListInput = z.input<typeof taskListInputSchema>;

/** Bound shared with `TASK_BULK_MAX` in `apps/api/src/tasks/tasks.constants.ts`. */
export const TASK_BULK_MAX = 100;

export const bulkTaskSchema = z
  .object({
    taskIds: z
      .array(uuidSchema)
      .min(1)
      .max(TASK_BULK_MAX)
      .refine((items) => new Set(items).size === items.length, {
        message: "Task identifiers must be unique",
      }),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("status"), status: taskStatusSchema }).strict(),
      z.object({ kind: z.literal("assign"), assigneeId: uuidSchema.nullable() }).strict(),
      z.object({ kind: z.literal("priority"), priority: taskPrioritySchema }).strict(),
      z.object({ kind: z.literal("tag"), tagIds: tagIdsSchema }).strict(),
      z.object({ kind: z.literal("delete") }).strict(),
    ]),
  })
  .strict();
export type BulkTaskInput = z.input<typeof bulkTaskSchema>;

const nullableUuid = uuidSchema.nullable();

export const taskSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    projectId: nullableUuid,
    noteId: nullableUuid,
    parentId: nullableUuid,
    title: taskTitleSchema,
    status: taskStatusSchema,
    customStatusId: nullableUuid,
    statusLabel: z.string().trim().min(1).max(50).nullable(),
    priority: taskPrioritySchema,
    assigneeId: nullableUuid,
    dueDate: isoTimestampSchema.nullable(),
    completedAt: isoTimestampSchema.nullable(),
    // `double precision`: midpoint inserts produce fractions, so no `.int()`
    // and no lower bound.
    sortOrder: z.number().finite(),
    recurrence: taskRecurrenceSchema,
    recurrenceCron: taskCronSchema.nullable(),
    tagIds: z.array(uuidSchema).max(50).readonly(),
    // On the summary, not only the detail: the board needs "created by me" to
    // decide whether an editor may drag a card without refetching each task.
    createdById: uuidSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const taskDetailSchema = taskSummarySchema
  .extend({
    description: z.string().max(10_000).nullable(),
    updatedById: nullableUuid,
  })
  .strict();

export const taskPageSchema = z
  .object({
    items: z.array(taskSummarySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const taskCreateResultSchema = z.object({ task: taskDetailSchema }).strict();

export const taskUpdateResultSchema = z
  .object({ task: taskDetailSchema, spawned: taskSummarySchema.nullable() })
  .strict();

export const taskReorderResultSchema = z.object({ task: taskSummarySchema }).strict();

export const taskDeleteResultSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
    affected: z.number().int().min(0),
  })
  .strict();

export const taskBulkResultSchema = z
  .object({
    updated: z.array(uuidSchema).max(TASK_BULK_MAX).readonly(),
    skipped: z
      .array(z.object({ taskId: uuidSchema, reason: z.literal("unavailable") }).strict())
      .max(TASK_BULK_MAX)
      .readonly(),
    /** Includes subtasks removed by the `tasks` self-FK cascade on a delete. */
    affected: z.number().int().nonnegative(),
  })
  .strict();

// --------------------------------------------------------------------------- //
// Custom task statuses (board columns)
// --------------------------------------------------------------------------- //
// `taskStatusSchema` above is the built-in `task_status` enum and keeps that
// name. The stored row is a DIFFERENT thing — a workspace- or project-scoped
// column a workspace owner created — so it is named `customTaskStatus*`.

/** Route-scoped: the workspace comes from the path, never the query string. */
export const taskStatusListQuerySchema = z.object({ projectId: uuidSchema.optional() }).strict();
export type TaskStatusListQueryInput = z.input<typeof taskStatusListQuerySchema>;

export const createTaskStatusSchema = z
  .object({
    /** `null` (the default) is a workspace-wide status usable by every task. */
    projectId: uuidSchema.nullable().default(null),
    name: taskStatusNameSchema,
    color: taskStatusColorSchema.optional(),
  })
  .strict();
export type CreateTaskStatusInput = z.input<typeof createTaskStatusSchema>;

export const updateTaskStatusSchema = z
  .object({
    name: taskStatusNameSchema.optional(),
    color: taskStatusColorSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "At least one task status field is required",
  });
export type UpdateTaskStatusInput = z.input<typeof updateTaskStatusSchema>;

export const customTaskStatusSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    /** `null` = workspace-wide; otherwise the project the column belongs to. */
    projectId: nullableUuid,
    name: z.string().trim().min(1).max(50),
    color: taskStatusColorSchema,
    // `double precision`, like every other ordering column in the product.
    sortOrder: z.number().finite(),
    /** Seeded rows: renaming and deleting them is refused. */
    isBuiltIn: z.boolean(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

/**
 * Unpaginated on purpose: a workspace has a handful of board columns, and a
 * page cursor over a set that small is pure ceremony.
 */
export const customTaskStatusListSchema = z
  .object({ items: z.array(customTaskStatusSchema).max(200).readonly() })
  .strict();

/** One shape for create and update — both answer with the resulting row. */
export const taskStatusMutationResultSchema = z.object({ status: customTaskStatusSchema }).strict();

export const taskStatusDeleteResultSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
    /**
     * Tasks that were pointing at the removed status. They are not deleted and
     * not reassigned: `tasks.custom_status_id` is `ON DELETE SET NULL`, so each
     * falls back to the built-in `status` it never lost. The count exists so the
     * confirmation dialog can say how many cards will move.
     */
    affected: z.number().int().nonnegative(),
    /**
     * Notes using the removed status as their project-board column. These have
     * no equivalent fallback — `notes.board_column_id` is `ON DELETE SET NULL`
     * and nothing else records where the note sat — so the dialog states this
     * consequence separately rather than folding it into `affected`.
     */
    affectedNotes: z.number().int().nonnegative(),
  })
  .strict();
