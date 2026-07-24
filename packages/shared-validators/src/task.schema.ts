import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

export const taskStatusSchema = z.enum(["todo", "in_progress", "done", "cancelled"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const taskRecurrenceSchema = z.enum(["daily", "weekly", "monthly"]);
export const taskSortFieldSchema = z.enum(["position", "createdAt", "updatedAt", "dueAt"]);

const taskTitleSchema = z.string().trim().min(1).max(500);
const taskDescriptionSchema = z.string().trim().max(10_000).nullable();

export const createTaskSchema = z
  .object({
    projectId: uuidSchema.nullable().optional(),
    noteId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    title: taskTitleSchema,
    description: taskDescriptionSchema.optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueAt: isoTimestampSchema.nullable().optional(),
    position: z.number().int().min(0),
    tagIds: z.array(uuidSchema).max(50).optional(),
    recurrence: taskRecurrenceSchema.nullable().optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    projectId: uuidSchema.nullable().optional(),
    noteId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
    dueAt: isoTimestampSchema.nullable().optional(),
    position: z.number().int().min(0).optional(),
    tagIds: z.array(uuidSchema).max(50).optional(),
    recurrence: taskRecurrenceSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one task field is required",
  });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskFilterSchema = z
  .object({
    workspaceId: uuidSchema,
    projectId: uuidSchema.optional(),
    noteId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueFrom: isoTimestampSchema.optional(),
    dueTo: isoTimestampSchema.optional(),
    isCompleted: explicitBooleanQuerySchema.optional(),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: taskSortFieldSchema.default("position"),
    sortDirection: sortDirectionSchema.default("asc"),
  })
  .strict()
  .refine(
    ({ dueFrom, dueTo }) =>
      dueFrom === undefined || dueTo === undefined || Date.parse(dueFrom) <= Date.parse(dueTo),
    {
      message: "dueFrom must be earlier than or equal to dueTo",
      path: ["dueTo"],
    },
  );
export type TaskFilterInput = z.input<typeof taskFilterSchema>;
