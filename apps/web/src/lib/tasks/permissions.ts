/**
 * What the task list may OFFER a viewer — never what it may do.
 *
 * Split out of `TaskListView.tsx`, where these were three closures over `canEdit`
 * and `viewer` in the middle of a 933-line component. They mirror
 * `authorization-policy.service.ts`: an editor may change only the tasks they
 * created, is denied `task.delete` outright, and can never clear an assignee
 * because that branch requires an active target.
 *
 * THE SERVER STAYS AUTHORITATIVE. Nothing here is a permission check — it only
 * stops the surface offering controls that would be refused, so a `null` viewer
 * (a surface that could not establish a role) falls back to `canEdit` alone and
 * lets the backend answer.
 */

import type { TaskSummary } from "@notted/shared-types";

/** Who is looking, for affordance gating only. */
export interface TaskViewerFacts {
  readonly userId: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
}

export function canEditTask(
  canEdit: boolean,
  viewer: TaskViewerFacts | null,
  task: TaskSummary,
): boolean {
  return (
    canEdit &&
    (viewer === null ||
      (viewer.role !== "viewer" &&
        (viewer.role !== "editor" || task.createdById === viewer.userId)))
  );
}

export function canDeleteTasks(canEdit: boolean, viewer: TaskViewerFacts | null): boolean {
  return canEdit && (viewer === null || viewer.role === "owner" || viewer.role === "admin");
}

export function canUnassign(viewer: TaskViewerFacts | null): boolean {
  return viewer === null || viewer.role !== "editor";
}
