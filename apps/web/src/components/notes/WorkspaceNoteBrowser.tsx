import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteBrowser } from "./NoteBrowser";

import type { NoteListView } from "@notted/shared-types";

import { noteCollectionPath } from "@/lib/notes/paths";
import {
  getServerFolders,
  getServerNoteList,
  getServerNoteNavigation,
  type NoteSearchParams,
} from "@/lib/notes/server-notes";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

const viewCopy: Record<NoteListView, { readonly title: string; readonly description: string }> = {
  normal: { title: "Notes", description: "Browse standalone notes and folders in this workspace." },
  recent: {
    title: "Recent notes",
    description: "Recently updated standalone notes, ordered by latest activity.",
  },
  pinned: { title: "Pinned notes", description: "Standalone notes pinned for quick access." },
  templates: {
    title: "Templates",
    description: "Reusable standalone note templates in this workspace.",
  },
  trash: {
    title: "Trash",
    description: "Restore deleted notes or permanently delete them after confirmation.",
  },
};

export async function WorkspaceNoteBrowser({
  workspaceId,
  searchParams,
  view = "normal",
}: {
  readonly workspaceId: string;
  readonly searchParams?: NoteSearchParams;
  readonly view?: NoteListView;
}) {
  const [notes, folders, workspace, navigation] = await Promise.all([
    getServerNoteList(workspaceId, searchParams, { view }),
    getServerFolders(workspaceId),
    getServerWorkspaceDetail(workspaceId),
    getServerNoteNavigation(workspaceId),
  ]);
  if (
    notes.status === "not-found" ||
    notes.status === "unauthenticated" ||
    workspace.status === "not-found" ||
    workspace.status === "unauthenticated"
  )
    notFound();
  if (
    notes.status === "unavailable" ||
    folders.status !== "ready" ||
    workspace.status === "unavailable"
  ) {
    return (
      <section className="mx-auto max-w-5xl rounded-xl border bg-card p-6" role="alert">
        <h1 className="text-3xl font-bold">Notes unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          The workspace, note list, or folder destinations could not be loaded safely. No note data
          was rendered.
        </p>
        <Link
          href={noteCollectionPath(workspaceId)}
          className="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }
  const role = workspace.data.currentUserRole;
  const projectIds =
    navigation.status === "ready"
      ? [
          ...new Set(
            navigation.data.items.flatMap((item) =>
              item.projectId === null ? [] : [item.projectId],
            ),
          ),
        ]
      : [];
  return (
    <div className="mx-auto max-w-6xl">
      <NoteBrowser
        workspaceId={workspaceId}
        initialPage={notes.data.page}
        initialFolders={folders.data}
        query={notes.data.query}
        canCreate={role !== "viewer"}
        canDelete={role === "owner" || role === "admin"}
        title={viewCopy[view].title}
        description={viewCopy[view].description}
        projectIds={projectIds}
      />
    </div>
  );
}
