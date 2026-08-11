import Link from "next/link";
import { notFound } from "next/navigation";

import { TaskListView } from "@/components/tasks/TaskListView";
import { getServerShell } from "@/lib/shell/server-shell";
import { getServerTaskList } from "@/lib/tasks/server-tasks";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

/**
 * Every task in the workspace, not just the ones on one note.
 *
 * `noteId` is `null` here, which is the whole difference from the note-scoped
 * mount: the same client container then renders the list, board and calendar
 * views over one shared query.
 */
export default async function WorkspaceTasksPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [workspace, shell, tasks] = await Promise.all([
    getServerWorkspaceDetail(workspaceId),
    getServerShell(),
    getServerTaskList(workspaceId, null),
  ]);
  // 403 and 404 already collapsed to `not-found` upstream, so a workspace the
  // caller may not see is indistinguishable from one that does not exist.
  if (workspace.status === "not-found" || workspace.status === "unauthenticated") notFound();
  if (workspace.status === "unavailable") {
    return (
      <section className="mx-auto max-w-4xl rounded-xl border bg-card p-6" role="alert">
        <h1 className="text-3xl font-bold">Tasks unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          This workspace could not be loaded safely, so no task was rendered and nothing was
          changed.
        </p>
        <Link
          href={`/workspaces/${encodeURIComponent(workspaceId)}/tasks`}
          className="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }

  const role = workspace.data.currentUserRole;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Every task in {workspace.data.name}, including the ones that belong to a note. Switch
          between the list, board and calendar views without reloading.
        </p>
      </header>
      {/*
       * An unavailable task page is not fatal: the container retries the same
       * request from the browser and shows its own error and retry state.
       */}
      <TaskListView
        workspaceId={workspaceId}
        noteId={null}
        projectId={null}
        initialTasks={tasks.status === "ready" ? tasks.data : null}
        canEdit={role !== "viewer"}
        viewer={shell.status === "ready" ? { userId: shell.data.user.id, role } : null}
      />
    </div>
  );
}
