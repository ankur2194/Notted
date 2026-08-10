import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import type { NoteNavigationItem } from "@notted/shared-types";

import { NoteDetailView } from "@/components/notes/NoteDetailView";
import { projectNotePath } from "@/lib/notes/paths";
import {
  getServerFolders,
  getServerNoteDetail,
  getServerNoteNavigation,
} from "@/lib/notes/server-notes";
import { getServerTaskList } from "@/lib/tasks/server-tasks";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

export default async function StandaloneNotePage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly noteId: string }>;
}) {
  const { workspaceId, noteId } = await params;
  const [note, workspace, folders, navigation] = await Promise.all([
    getServerNoteDetail(workspaceId, noteId),
    getServerWorkspaceDetail(workspaceId),
    getServerFolders(workspaceId),
    getServerNoteNavigation(workspaceId),
  ]);
  if (
    note.status === "not-found" ||
    note.status === "unauthenticated" ||
    workspace.status === "not-found" ||
    workspace.status === "unauthenticated"
  )
    notFound();
  if (note.status === "unavailable" || workspace.status === "unavailable")
    return (
      <section role="alert" className="mx-auto max-w-4xl rounded-xl border p-6">
        <h1 className="text-3xl font-bold">Note unavailable</h1>
        <p className="mt-2">This note could not be loaded safely. Its content was not rendered.</p>
        <Link
          className="mt-4 inline-flex min-h-11 items-center rounded-md border px-4 text-sm"
          href={`/workspaces/${workspaceId}/notes/${noteId}`}
        >
          Retry
        </Link>
      </section>
    );
  if (note.data.projectId !== null)
    redirect(projectNotePath(workspaceId, note.data.projectId, note.data.id));
  const byId = new Map(
    navigation.status === "ready" ? navigation.data.items.map((item) => [item.id, item]) : [],
  );
  const ancestors: NoteNavigationItem[] = [];
  let parentId = note.data.parentId;
  const seen = new Set<string>();
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  const folderName =
    folders.status === "ready" && note.data.folderId !== null
      ? folders.data.items.find((folder) => folder.id === note.data.folderId)?.name
      : undefined;
  /*
   * Sequential rather than part of the parallel block above: the note's own
   * type decides whether a task list exists at all, so fetching it eagerly
   * would issue a request for every document in the workspace. An unavailable
   * task page degrades to a client fetch instead of failing the note.
   */
  const tasks =
    note.data.type === "task-list" ? await getServerTaskList(workspaceId, note.data.id) : null;
  return (
    <NoteDetailView
      note={note.data}
      workspaceName={workspace.data.name}
      folderName={folderName}
      ancestors={ancestors}
      initialTasks={tasks?.status === "ready" ? tasks.data : null}
    />
  );
}
