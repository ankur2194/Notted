import Link from "next/link";

import { ConvertNoteTypeControl } from "./ConvertNoteTypeControl";
import { NoteEditorSurface } from "./NoteEditorSurface";
import { PageContainer } from "./PageContainer";
import { ShareModal } from "./ShareModal";

import type { TaskViewer } from "@/components/tasks/TaskListView";
import type { NoteDetail, NoteNavigationItem, TaskPage } from "@notted/shared-types";

import { TaskListView } from "@/components/tasks/TaskListView";
import { noteCollectionPath, noteDetailPath, projectNotePath } from "@/lib/notes/paths";
import { combineProgress, progressPercent } from "@/lib/notes/progress";

export function NoteDetailView({
  note,
  workspaceName,
  projectName,
  folderName,
  ancestors = [],
  initialTasks = null,
  viewer = null,
}: {
  readonly note: NoteDetail;
  readonly workspaceName: string;
  readonly projectName?: string;
  readonly folderName?: string;
  readonly ancestors?: readonly NoteNavigationItem[];
  /** Server-rendered first task page, present only for a task-list note. */
  readonly initialTasks?: TaskPage | null;
  /**
   * The current member and their workspace role, forwarded to the task list so
   * it can hide the controls an editor is always denied (Part 48.6). Omitted
   * leaves the task rows gated on note-level edit permission alone.
   */
  readonly viewer?: TaskViewer | null;
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
  /*
   * Part 48.4. `NoteCard` shows only the combined bar, because a card has room
   * for one number; the header can afford the split, so it names both halves in
   * words and keeps one bar over their sum. A note with neither an inline
   * checklist nor a task row renders nothing rather than an empty 0/0 bar.
   */
  const progress = combineProgress(note.progress.checklist, note.progress.tasks);
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
          <div className="flex flex-col items-start gap-2 sm:items-end">
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
            {canEdit ? (
              <ConvertNoteTypeControl
                workspaceId={note.workspaceId}
                noteId={note.id}
                noteTitle={note.title}
                type={note.type}
                version={note.version}
              />
            ) : null}
          </div>
        </div>
        {/*
         * The page-size badge moved into `PageContainer`, which owns the live
         * value: this header is server-rendered, so a badge here would still
         * claim the old size after a switch until the page was reloaded.
         */}
        {progress.total === 0 ? null : (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {progress.done}/{progress.total} done · {note.progress.checklist.done}/
              {note.progress.checklist.total} checklist items · {note.progress.tasks.done}/
              {note.progress.tasks.total} tasks
            </p>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={`Checklist and task progress for ${note.title}`}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${progressPercent(progress)}%` }}
              />
            </div>
          </div>
        )}
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
          initialDocument={note.content}
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
      {/*
       * Deliberate, user-recorded deviation from `Notted.md`.
       *
       * The brief specifies a "simplified editor (no rich text, just tasks)"
       * for a task-list note. The user overrode that: the task list is rendered
       * BELOW the paper editor, not instead of it, so `PageContainer` and
       * `NoteEditorSurface` above stay mounted exactly as they are for a
       * document. That also makes type conversion non-destructive in both
       * directions — nothing has to be hidden or migrated when a note changes
       * type, because both halves are always present for a task list.
       */}
      {note.type === "task-list" ? (
        <section aria-labelledby="note-tasks-heading" data-notted-print-hide>
          <h2 id="note-tasks-heading" className="text-xl font-semibold tracking-tight">
            Tasks
          </h2>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Tasks belong to this note and are stored separately from the page content above.
          </p>
          <TaskListView
            workspaceId={note.workspaceId}
            noteId={note.id}
            projectId={note.projectId}
            initialTasks={initialTasks}
            canEdit={canEdit}
            viewer={viewer}
          />
        </section>
      ) : null}
    </article>
  );
}
