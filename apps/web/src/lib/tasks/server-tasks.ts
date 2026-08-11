import "server-only";

import { TASK_API_PATHS } from "@notted/shared-types";
import { taskPageSchema, uuidSchema } from "@notted/shared-validators";

import type { ServerReadResult } from "@/lib/api/server-read";
import type { TaskPage } from "@notted/shared-types";

import { readJson } from "@/lib/api/server-read";

/**
 * The first page of a task list, for the initial server render.
 *
 * `noteId` is the note whose tasks these are, or `null` for the workspace-wide
 * task page — where the parameter is omitted entirely rather than sent empty,
 * because the query contract accepts a uuid or nothing.
 *
 * Always `sortOrder asc` with server grouping `none`: the list view groups on
 * the client so switching grouping never refetches, and manual ordering is only
 * meaningful in the unfiltered sort. 100 is the largest page `taskPageSchema`
 * allows; a longer list keeps paging through the client `requestTaskPage`.
 */
export function getServerTaskList(
  workspaceId: string,
  noteId: string | null,
): Promise<ServerReadResult<TaskPage>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  if (!workspace.success) return Promise.resolve({ status: "not-found" });
  const note = noteId === null ? null : uuidSchema.safeParse(noteId);
  if (note !== null && !note.success) return Promise.resolve({ status: "not-found" });
  const search = new URLSearchParams({
    page: "1",
    limit: "100",
    grouping: "none",
    sortBy: "sortOrder",
    sortDirection: "asc",
  });
  if (note !== null && note.success) search.set("noteId", note.data);
  return readJson(`${TASK_API_PATHS.collection(workspace.data)}?${search.toString()}`, (value) =>
    taskPageSchema.safeParse(value),
  );
}
