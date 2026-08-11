import Link from "next/link";
import { notFound } from "next/navigation";

import type { NoteNavigationItem } from "@notted/shared-types";

import { NoteDetailView } from "@/components/notes/NoteDetailView";
import { getServerNoteDetail, getServerNoteNavigation } from "@/lib/notes/server-notes";
import { getServerProjectDetail } from "@/lib/projects/server-projects";
import { getServerTaskList } from "@/lib/tasks/server-tasks";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

export default async function ProjectNotePage({
  params,
}: {
  readonly params: Promise<{
    readonly workspaceId: string;
    readonly projectId: string;
    readonly noteId: string;
  }>;
}) {
  const { workspaceId, projectId, noteId } = await params;
  const [note, project, workspace, navigation] = await Promise.all([
    getServerNoteDetail(workspaceId, noteId),
    getServerProjectDetail(workspaceId, projectId),
    getServerWorkspaceDetail(workspaceId),
    getServerNoteNavigation(workspaceId),
  ]);
  if (
    note.status === "not-found" ||
    note.status === "unauthenticated" ||
    project.status === "not-found" ||
    project.status === "unauthenticated" ||
    workspace.status === "not-found" ||
    workspace.status === "unauthenticated"
  )
    notFound();
  if (
    note.status === "unavailable" ||
    project.status === "unavailable" ||
    workspace.status === "unavailable"
  )
    return (
      <section role="alert" className="mx-auto max-w-4xl rounded-xl border p-6">
        <h1 className="text-3xl font-bold">Project note unavailable</h1>
        <p className="mt-2">
          The project and note could not be loaded together safely. No note content was rendered.
        </p>
        <Link
          className="mt-4 inline-flex min-h-11 items-center rounded-md border px-4 text-sm"
          href={`/workspaces/${workspaceId}/projects/${projectId}/notes/${noteId}`}
        >
          Retry
        </Link>
      </section>
    );
  if (note.data.projectId !== projectId) notFound();
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
  /*
   * Sequential rather than part of the parallel block above: the note's own
   * type decides whether a task list exists at all, so fetching it eagerly
   * would issue a request for every document in the project. An unavailable
   * task page degrades to a client fetch instead of failing the note.
   */
  const tasks =
    note.data.type === "task-list" ? await getServerTaskList(workspaceId, note.data.id) : null;
  return (
    <NoteDetailView
      note={note.data}
      workspaceName={workspace.data.name}
      projectName={project.data.name}
      ancestors={ancestors}
      initialTasks={tasks?.status === "ready" ? tasks.data : null}
      viewer={{ userId: note.data.currentActorId, role: workspace.data.currentUserRole }}
    />
  );
}
