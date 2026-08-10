import "server-only";

import { TASK_API_PATHS } from "@notted/shared-types";
import { taskPageSchema, uuidSchema } from "@notted/shared-validators";

import type { ServerReadResult } from "@/lib/api/server-read";
import type { TaskPage } from "@notted/shared-types";

import { readJson } from "@/lib/api/server-read";

/**
 * The first page of one task-list note's tasks, for the initial server render.
 *
 * Always `sortOrder asc` with server grouping `none`: the list view groups on
 * the client so switching grouping never refetches, and manual ordering is only
 * meaningful in the unfiltered sort. 100 is the largest page `taskPageSchema`
 * allows; a longer list keeps paging through the client `requestTaskPage`.
 */
export function getServerTaskList(
  workspaceId: string,
  noteId: string,
): Promise<ServerReadResult<TaskPage>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  const note = uuidSchema.safeParse(noteId);
  if (!workspace.success || !note.success) return Promise.resolve({ status: "not-found" });
  const search = new URLSearchParams({
    page: "1",
    limit: "100",
    noteId: note.data,
    grouping: "none",
    sortBy: "sortOrder",
    sortDirection: "asc",
  });
  return readJson(`${TASK_API_PATHS.collection(workspace.data)}?${search.toString()}`, (value) =>
    taskPageSchema.safeParse(value),
  );
}
