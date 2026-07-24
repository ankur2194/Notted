import type { IsoTimestamp, NoteId, ProjectId, TagId, TaskId, UserId, WorkspaceId } from "./common";

export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskRecurrence = "daily" | "weekly" | "monthly";

export interface TaskSummary {
  id: TaskId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  noteId: NoteId | null;
  parentId: TaskId | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: UserId | null;
  dueAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  position: number;
  updatedAt: IsoTimestamp;
}

export interface TaskDetail extends TaskSummary {
  description: string | null;
  tagIds: TagId[];
  recurrence: TaskRecurrence | null;
  createdById: UserId;
  createdAt: IsoTimestamp;
}
