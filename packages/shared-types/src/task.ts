import type {
  IsoTimestamp,
  NoteId,
  ProjectId,
  TagId,
  TaskId,
  TaskStatusId,
  UserId,
  WorkspaceId,
} from "./common";

export const TASK_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/tasks`,
  bulk: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/tasks/bulk`,
  detail: (workspaceId: string, taskId: string) =>
    `/api/v1/workspaces/${workspaceId}/tasks/${taskId}`,
  reorder: (workspaceId: string, taskId: string) =>
    `/api/v1/workspaces/${workspaceId}/tasks/${taskId}/reorder`,
} as const);

/**
 * Mirrors the `task_status` PostgreSQL enum in
 * `apps/api/src/database/schema/tasks.ts`. The database spelling is
 * `canceled` (one `l`); the wire contract matches it exactly so no translation
 * layer can drift.
 */
export type TaskStatus = "todo" | "in_progress" | "done" | "canceled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskRecurrence = "none" | "daily" | "weekly" | "monthly" | "custom";
export type TaskSortField =
  "sortOrder" | "createdAt" | "updatedAt" | "dueDate" | "priority" | "title";
export type TaskGrouping = "none" | "status" | "priority" | "assignee" | "dueDate";

export interface TaskSummary {
  readonly id: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId | null;
  readonly noteId: NoteId | null;
  readonly parentId: TaskId | null;
  readonly title: string;
  /**
   * Built-in lifecycle status. A task carrying a `customStatusId` keeps this
   * value: it alone drives `completedAt`, so the effective board column is
   * `customStatusId ?? status` while completion stays unambiguous.
   */
  readonly status: TaskStatus;
  readonly customStatusId: TaskStatusId | null;
  /** Custom status name when `customStatusId` is set, otherwise `null`. */
  readonly statusLabel: string | null;
  readonly priority: TaskPriority;
  readonly assigneeId: UserId | null;
  /**
   * Canonical UTC instant. Date and time are folded into one column: the
   * client composes a local date plus optional time into a full ISO instant,
   * and renders it back in the viewer's zone.
   */
  readonly dueDate: IsoTimestamp | null;
  readonly completedAt: IsoTimestamp | null;
  /**
   * `double precision` so midpoint inserts never need a table rewrite. Not an
   * integer and not bounded below.
   */
  readonly sortOrder: number;
  readonly recurrence: TaskRecurrence;
  /** Five-field cron expression, UTC fields. Non-null only for `custom`. */
  readonly recurrenceCron: string | null;
  readonly tagIds: readonly TagId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TaskDetail extends TaskSummary {
  /** Plain text, never TipTap JSON — the column is `text`. */
  readonly description: string | null;
  readonly createdById: UserId;
  readonly updatedById: UserId | null;
}

export interface TaskPage {
  readonly items: readonly TaskSummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface TaskListQuery {
  readonly page: number;
  readonly limit: number;
  readonly noteId?: NoteId;
  readonly projectId?: ProjectId;
  readonly parentId?: TaskId;
  readonly assigneeId?: UserId;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly tagId?: TagId;
  readonly dueFrom?: IsoTimestamp;
  readonly dueTo?: IsoTimestamp;
  readonly isCompleted?: boolean;
  readonly grouping: TaskGrouping;
  readonly sortBy: TaskSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface TaskCreateResult {
  readonly task: TaskDetail;
}

export interface TaskUpdateResult {
  readonly task: TaskDetail;
  /**
   * The next occurrence spawned when a recurring task was just completed, so
   * the client can insert it optimistically instead of refetching. `null`
   * whenever nothing recurred.
   */
  readonly spawned: TaskSummary | null;
}

export interface TaskReorderResult {
  readonly task: TaskSummary;
}

export interface TaskDeleteResult {
  readonly id: TaskId;
  readonly deleted: true;
  /** Rows removed including cascaded subtasks. Deletion is hard, not soft. */
  readonly affected: number;
}

/**
 * Denied and missing identifiers collapse to the same `unavailable` reason on
 * purpose: distinguishing "forbidden" from "not found" would leak the
 * existence of tasks in workspaces the caller cannot see.
 */
export type TaskBulkSkipReason = "unavailable";

export interface TaskBulkSkip {
  readonly taskId: TaskId;
  readonly reason: TaskBulkSkipReason;
}

export interface TaskBulkResult {
  readonly updated: readonly TaskId[];
  readonly skipped: readonly TaskBulkSkip[];
  /**
   * Rows this call actually wrote or destroyed.
   *
   * It exceeds `updated.length` for a delete, because `tasks` cascades through
   * its self-referencing parent FK: selecting three parents can destroy their
   * whole subtrees. Reporting only the named ids would understate what the user
   * just did. On an idempotent replay it is 0 — the batch had already landed,
   * so this call changed nothing — which matches `updated` being recomputed
   * from live authorization rather than replayed from a stored snapshot.
   */
  readonly affected: number;
}
