import { FileText, FolderKanban, Sparkles } from "lucide-react";
import Link from "next/link";

import { NoteBrowser } from "@/components/notes/NoteBrowser";
import { MyTasksWidget } from "@/components/tasks/MyTasksWidget";
import { getServerFolders, getServerNoteList } from "@/lib/notes/server-notes";
import { getServerShell } from "@/lib/shell/server-shell";

export default async function DashboardPage() {
  const shell = await getServerShell();
  const current = shell.status === "ready" ? shell.data.currentWorkspace : null;
  // Read only once a workspace is actually selected: with no tenant to scope a
  // task query to there is nobody to be the assignee either.
  const viewerId = shell.status === "ready" && current !== null ? shell.data.user.id : null;
  // Independent reads, so they overlap. Awaited one after the other, the page
  // paid both round trips end to end for data neither call needs from the
  // other; `tasks/page.tsx` already reads its two in parallel.
  const [recent, folders] =
    current === null
      ? [null, null]
      : await Promise.all([
          getServerNoteList(current.workspaceId, {}, { view: "recent" }),
          getServerFolders(current.workspaceId),
        ]);
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section
        aria-labelledby="dashboard-heading"
        className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8"
      >
        <p className="text-sm font-medium text-info">Workspace overview</p>
        <h1 id="dashboard-heading" className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Welcome back
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Your authenticated workspace shell is ready. Recent notes from the selected workspace
          appear below.
        </p>
      </section>

      {/*
       * Mounted only once there is a workspace. The widget guards the same
       * case itself, but a client component still needs the shell's
       * `ReactQueryProvider` above it to run its hooks at all, so there is no
       * value in mounting one that can only render nothing.
       */}
      {current === null ? null : (
        <MyTasksWidget
          workspaceId={current.workspaceId}
          assigneeId={viewerId}
          canEdit={current.role !== "viewer"}
        />
      )}

      <section aria-labelledby="workspace-content-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="workspace-content-heading" className="text-xl font-semibold">
              Workspace content
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Feature areas are shown without fabricated records.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <article className="rounded-xl border bg-card p-5">
            <FolderKanban className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Projects</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Browse authorized projects and their note collections.
            </p>
            {current === null ? (
              <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
                Choose a workspace
              </span>
            ) : (
              <Link
                href={`/workspaces/${current.workspaceId}/projects`}
                className="mt-4 inline-flex min-h-11 items-center text-sm font-medium underline"
              >
                Open projects
              </Link>
            )}
          </article>
          <article className="rounded-xl border bg-card p-5">
            <FileText className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Notes</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Browse standalone notes, folders, pinned notes, templates, and trash.
            </p>
            {current === null ? (
              <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
                Choose a workspace
              </span>
            ) : (
              <Link
                href={`/workspaces/${current.workspaceId}/notes`}
                className="mt-4 inline-flex min-h-11 items-center text-sm font-medium underline"
              >
                Open notes
              </Link>
            )}
          </article>
          <article className="rounded-xl border bg-card p-5">
            <Sparkles className="size-5 text-info" aria-hidden="true" />
            <h3 className="mt-4 font-semibold">Search</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Press Ctrl/Cmd+K to search notes by title or content. Semantic and hybrid search
              arrive in Parts 53–54.
            </p>
            <span className="mt-4 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Full-text available
            </span>
          </article>
        </div>
      </section>
      {current !== null ? (
        <section aria-label="Selected workspace recent notes">
          {recent?.status === "ready" && folders?.status === "ready" ? (
            <NoteBrowser
              workspaceId={current.workspaceId}
              initialPage={recent.data.page}
              initialFolders={folders.data}
              query={recent.data.query}
              canCreate={shell.status === "ready" && shell.data.permissions.canCreateContent}
              canDelete={current.role === "owner" || current.role === "admin"}
              title="Recent notes"
              description={`Recently updated standalone notes in ${current.name}.`}
              embedded
            />
          ) : (
            <div role="alert" className="rounded-xl border p-5">
              <h2 className="text-xl font-semibold">Recent notes unavailable</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                The dashboard remains available, but recent note data could not be loaded safely.
              </p>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
