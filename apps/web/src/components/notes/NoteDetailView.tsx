import Link from "next/link";

import { NoteEditorSurface } from "./NoteEditorSurface";
import { PageContainer } from "./PageContainer";
import { ShareModal } from "./ShareModal";

import type { NoteDetail, NoteNavigationItem } from "@notted/shared-types";

import { noteCollectionPath, noteDetailPath, projectNotePath } from "@/lib/notes/paths";

export function NoteDetailView({
  note,
  workspaceName,
  projectName,
  folderName,
  ancestors = [],
}: {
  readonly note: NoteDetail;
  readonly workspaceName: string;
  readonly projectName?: string;
  readonly folderName?: string;
  readonly ancestors?: readonly NoteNavigationItem[];
}) {
  const internalPath =
    note.projectId === null
      ? noteDetailPath(note.workspaceId, note)
      : projectNotePath(note.workspaceId, note.projectId, note.id);
  // Deny by default: an absent or unknown capability is treated as read only,
  // and a trashed note is never editable in place.
  const canEdit = note.capabilities.canUpdate === true && !note.isDeleted;
  const readOnlyReason = note.isDeleted
    ? "This note is in the trash. Restore it before editing."
    : "You can read this note, but you do not have permission to edit it.";
  return (
    <article className="mx-auto max-w-4xl space-y-6">
      {/*
       * Part 38: application chrome. Focus mode hides it so only the page and a
       * floating toolbar remain, and print hides it so a printed note carries
       * note content only.
       */}
      <nav
        aria-label="Note breadcrumbs"
        className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        data-notted-focus-hide
        data-notted-print-hide
      >
        <Link href={`/workspaces/${note.workspaceId}`}>{workspaceName}</Link>
        <span aria-hidden="true">/</span>
        {note.projectId !== null ? (
          <>
            <Link href={`/workspaces/${note.workspaceId}/projects/${note.projectId}`}>
              {projectName ?? "Project"}
            </Link>
            <span aria-hidden="true">/</span>
          </>
        ) : (
          <>
            <Link href={noteCollectionPath(note.workspaceId)}>Standalone notes</Link>
            <span aria-hidden="true">/</span>
            {note.folderId !== null ? (
              <>
                <Link
                  href={`${noteCollectionPath(note.workspaceId)}?folderId=${encodeURIComponent(note.folderId)}`}
                >
                  {folderName ?? "Folder"}
                </Link>
                <span aria-hidden="true">/</span>
              </>
            ) : null}
          </>
        )}
        {ancestors.map((ancestor) => (
          <span key={ancestor.id} className="contents">
            <Link href={noteDetailPath(note.workspaceId, ancestor)}>{ancestor.title}</Link>
            <span aria-hidden="true">/</span>
          </span>
        ))}
        <span aria-current="page">{note.title}</span>
      </nav>
      <header
        className="space-y-4 rounded-2xl border bg-card p-6 shadow-sm"
        data-notted-focus-hide
        data-notted-print-hide
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="break-words text-3xl font-bold tracking-tight">{note.title}</h1>
            {/*
             * No `version` here. Part 39 bumps it on every save, so a
             * server-rendered number is wrong within a second of typing — the
             * same reason the page-size badge moved out (below). Live save
             * state belongs to `SaveStatusIndicator` inside `PageContainer`,
             * and threading a client value into this Server Component would
             * only move the staleness rather than remove it.
             */}
            <p className="mt-2 text-sm text-muted-foreground">
              {note.type === "task-list" ? "Task list" : "Document"} ·{" "}
              {note.projectId === null
                ? note.folderId === null
                  ? "Standalone · Unfiled"
                  : "Standalone folder"
                : `Project · ${projectName ?? "Project note"}`}
            </p>
          </div>
          {note.isDeleted ? null : note.capabilities.canShare ? (
            <ShareModal
              workspaceId={note.workspaceId}
              noteId={note.id}
              internalPath={internalPath}
              currentActorId={note.currentActorId}
            />
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" role="note">
              You can view this note, but you do not have permission to manage sharing.
            </p>
          )}
        </div>
        {/*
         * The page-size badge moved into `PageContainer`, which owns the live
         * value: this header is server-rendered, so a badge here would still
         * claim the old size after a switch until the page was reloaded.
         */}
        <div className="flex flex-wrap gap-2 text-xs">
          {note.isPinned ? <span className="rounded-full bg-muted px-2 py-1">Pinned</span> : null}
          {note.isTemplate ? (
            <span className="rounded-full bg-muted px-2 py-1">Template</span>
          ) : null}
          {note.isArchived ? (
            <span className="rounded-full bg-muted px-2 py-1">Archived</span>
          ) : null}
          {note.isDeleted ? (
            <span className="rounded-full bg-destructive/10 px-2 py-1 text-destructive">Trash</span>
          ) : null}
        </div>
      </header>
      <section aria-labelledby="note-content-heading">
        <h2 id="note-content-heading" className="sr-only">
          Note content
        </h2>
        {/*
         * The paper itself, its margins, and zoom are owned by `PageContainer`
         * (Part 37); this section no longer fakes a page with card styling.
         */}
        <PageContainer
          workspaceId={note.workspaceId}
          noteId={note.id}
          initialPageSize={note.pageSize}
          initialVersion={note.version}
          canUpdate={canEdit}
        >
          <NoteEditorSurface
            workspaceId={note.workspaceId}
            noteId={note.id}
            initialDocument={note.content}
            editable={canEdit}
            ariaLabel={`Note content: ${note.title}`}
            readOnlyReason={readOnlyReason}
          />
        </PageContainer>
      </section>
    </article>
  );
}
