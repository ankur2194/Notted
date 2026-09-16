import { ConvertNoteTypeControl } from "./ConvertNoteTypeControl";
import { ExportNoteDialog } from "./ExportNoteDialog";
import { NOTE_COMMENTS_SLOT_ID } from "./note-comments-slot";
import { NoteEditorSurface } from "./NoteEditorSurface";
import { PageContainer } from "./PageContainer";
import { PRESENCE_BAR_SLOT_ID } from "./presence-bar-slot";
import { ShareModal } from "./ShareModal";

import type { TaskViewer } from "@/components/tasks/TaskListView";
import type { NoteDetail, TaskPage } from "@notted/shared-types";

import { TaskListView } from "@/components/tasks/TaskListView";
import { noteDetailPath, projectNotePath } from "@/lib/notes/paths";
import { combineProgress, progressPercent } from "@/lib/notes/progress";

export function NoteDetailView({
  note,
  projectName,
  initialTasks = null,
  viewer = null,
}: {
  readonly note: NoteDetail;
  readonly projectName?: string;
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
    <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-start">
      <article className="min-w-0 flex-1 space-y-3">
        {/*
         * Part 38: application chrome. Focus mode hides it so only the page and a
         * floating toolbar remain, and print hides it so a printed note carries
         * note content only.
         */}
        <header
          className="space-y-2 rounded-xl border bg-card px-4 py-3"
          data-notted-focus-hide
          data-notted-print-hide
        >
          <div className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <h1 className="truncate text-xl font-semibold tracking-tight">{note.title}</h1>
              {/*
               * No `version` here. Part 39 bumps it on every save, so a
               * server-rendered number is wrong within a second of typing — the
               * same reason the page-size badge moved out (below). Live save
               * state belongs to `SaveStatusIndicator` inside `PageContainer`,
               * and threading a client value into this Server Component would
               * only move the staleness rather than remove it.
               */}
              <p className="text-xs text-muted-foreground">
                {note.type === "task-list" ? "Task list" : "Document"} ·{" "}
                {note.projectId === null
                  ? note.folderId === null
                    ? "Standalone · Unfiled"
                    : "Standalone folder"
                  : `Project · ${projectName ?? "Project note"}`}
              </p>
            </div>
            <div className="flex flex-row flex-wrap items-center gap-2">
              {/*
               * `NoteEditorSurface` portals its collaboration status row
               * (`PresenceBar`, "Reconnecting"/"Reconnect") here instead of
               * rendering it inside the scaled paper — see
               * `PRESENCE_BAR_SLOT_ID`.
               */}
              <div id={PRESENCE_BAR_SLOT_ID} className="contents" />
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
              <ExportNoteDialog
                workspaceId={note.workspaceId}
                noteId={note.id}
                canExport={note.capabilities.canExport}
              />
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
              <span className="rounded-full bg-destructive/10 px-2 py-1 text-destructive">
                Trash
              </span>
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
              /*
               * Part 58. The identity of this editing session, taken from the
               * note's own authorized response rather than from anything the
               * client could choose. There is no display name to pass: the
               * session endpoint returns `userId` only, so the surface labels an
               * unnamed session neutrally.
               */
              userId={note.currentActorId}
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
      {/*
       * The comments panel's own DOM (`NoteComments`, mounted deep inside
       * `PageContainer`'s scaled paper) portals into this element so the
       * discussion sits beside the page instead of inline below the text. Print
       * and focus mode hide the whole column the same way they hide the rest of
       * the chrome around the paper.
       */}
      <aside
        className="w-full shrink-0 lg:w-80"
        aria-label="Comments"
        data-notted-focus-hide
        data-notted-print-hide
      >
        <div id={NOTE_COMMENTS_SLOT_ID} className="lg:sticky lg:top-6" />
      </aside>
    </div>
  );
}
