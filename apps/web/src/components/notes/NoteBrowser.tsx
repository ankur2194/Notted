"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { CreateNoteDialog } from "./CreateNoteDialog";
import { FolderControls } from "./FolderControls";
import { NoteBoard } from "./NoteBoard";
import { NoteGrid } from "./NoteGrid";
import { NoteLifecycleActions } from "./NoteLifecycleActions";
import { NoteList, type NoteMoveDestination } from "./NoteList";
import { NoteTimeline } from "./NoteTimeline";
import { RenameNoteControl } from "./RenameNoteControl";

import type {
  FolderPage,
  NoteListQuery,
  NotePage,
  NoteSummary,
  TagListQuery,
  TagSummary,
} from "@notted/shared-types";
import type { CreateNoteInput } from "@notted/shared-validators";

import { TagPicker } from "@/components/tags/TagPicker";
import { Button } from "@/components/ui/button";
import { noteListHref, noteViewPath } from "@/lib/notes/paths";
import { noteQueryKeys, tagQueryKeys, taskQueryKeys } from "@/lib/notes/query-keys";
import {
  copyNote,
  createNote,
  moveNote,
  permanentlyDeleteNote,
  requestFolders,
  requestNotePage,
  restoreNote,
  trashNote,
  updateNote,
  type NoteRequestFailureKind,
} from "@/lib/notes/requests";
import { cloneNotePageItems, optimisticMove } from "@/lib/notes/tree";
import {
  readNoteViewPreference,
  writeNoteViewPreference,
  type NoteViewMode,
} from "@/lib/notes/view-preference";
import { requestTagPage } from "@/lib/tags/requests";
import { requestTaskStatuses } from "@/lib/tasks/requests";

/**
 * The whole workspace tag listing, which `tagPageSchema` caps at 100. Frozen
 * at module scope so it is a stable `tagQueryKeys.list` key rather than a new
 * object identity on every render.
 */
const TAG_LIST_QUERY = {
  page: 1,
  limit: 100,
  sortBy: "name",
  sortDirection: "asc",
} as const satisfies TagListQuery;

const VIEW_MODES: readonly { readonly value: NoteViewMode; readonly label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "timeline", label: "Timeline" },
];

function failureMessage(
  action: string,
  kind: NoteRequestFailureKind,
  restoredSubject: "state" | "list" = "state",
): string {
  const restored = `The previous ${restoredSubject} was restored`;
  if (kind === "forbidden-or-not-found")
    return `${action} was denied or the note is no longer available. ${restored}.`;
  if (kind === "version-conflict")
    return `${action} conflicted with a newer saved version. The exact previous title, version, location, and order were restored. Reload before retrying.`;
  if (kind === "conflict")
    return `${action} conflicted with a recent change. ${restored}; reload and retry.`;
  if (kind === "invalid") return `${action} was not accepted. ${restored}.`;
  return `${action} could not reach Notted. ${restored}; check your connection and retry.`;
}

export function NoteBrowser({
  workspaceId,
  initialPage,
  initialFolders,
  query,
  canCreate,
  canDelete = false,
  title,
  description,
  embedded = false,
  projectIds = [],
  project,
}: {
  readonly workspaceId: string;
  readonly initialPage: NotePage;
  readonly initialFolders: FolderPage;
  readonly query: NoteListQuery;
  readonly canCreate: boolean;
  readonly canDelete?: boolean;
  readonly title: string;
  readonly description: string;
  readonly embedded?: boolean;
  readonly projectIds?: readonly string[];
  /**
   * Present only on the project detail mount. Board and timeline are projections
   * of one project's columns and dates, so they are offered only here.
   */
  readonly project?: {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly dueAt: string | null;
  };
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState("");
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const [view, setView] = useState<NoteViewMode>("list");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const projectId = project?.id ?? null;
  // Board and timeline need exactly one project's columns and dates. Anywhere
  // else — the workspace root, a multi-project listing — they are not offered
  // at all, and a persisted preference naming one falls back to the list.
  const projectScoped = project !== undefined && projectIds.length === 1;

  /*
   * Read after mount, never as the initial state: the server has no access to
   * `localStorage`, so seeding state from it would render one view on the
   * server and another on the client and produce a hydration mismatch.
   */
  useEffect(() => {
    const stored = readNoteViewPreference(window.localStorage, workspaceId, projectId);
    setView(!projectScoped && (stored === "board" || stored === "timeline") ? "list" : stored);
  }, [workspaceId, projectId, projectScoped]);

  function selectView(next: NoteViewMode): void {
    setView(next);
    writeNoteViewPreference(window.localStorage, workspaceId, projectId, next);
  }

  const notesQuery = useQuery({
    queryKey: noteQueryKeys.list(workspaceId, query),
    initialData: initialPage,
    queryFn: async () => {
      const result = await requestNotePage(workspaceId, query);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });
  const foldersQuery = useQuery({
    queryKey: noteQueryKeys.folders(workspaceId),
    initialData: initialFolders,
    queryFn: async () => {
      const result = await requestFolders(workspaceId);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });
  /**
   * Tag names and colours for the chips and the active-filter label.
   *
   * The query function never rejects: a workspace whose tags cannot be read
   * still has readable notes, so an unavailable tag listing degrades to an
   * empty map — the chips disappear and the filter falls back to the raw id —
   * instead of joining the note/folder error gate and blanking the page.
   */
  const tagsQuery = useQuery({
    queryKey: tagQueryKeys.list(workspaceId, TAG_LIST_QUERY),
    queryFn: async () => {
      const result = await requestTagPage(workspaceId, TAG_LIST_QUERY);
      return result.ok ? result.data.items : [];
    },
  });
  /*
   * The board's columns, fetched once here rather than inside a view: the board
   * and the timeline are two projections of one column list, and a second cache
   * entry is exactly how two views start disagreeing after a mutation.
   */
  const statusesQuery = useQuery({
    queryKey: taskQueryKeys.statuses(workspaceId, projectId),
    queryFn: async () => {
      const result = await requestTaskStatuses(
        workspaceId,
        projectId === null ? {} : { projectId },
      );
      if (!result.ok) throw new Error(result.kind);
      return result.data.items;
    },
    enabled: project !== undefined,
    retry: false,
  });
  const tagOptions: readonly TagSummary[] = tagsQuery.data ?? [];
  const tagsById: ReadonlyMap<string, TagSummary> = new Map(tagOptions.map((tag) => [tag.id, tag]));
  const activeTag = query.tagId === undefined ? undefined : tagsById.get(query.tagId);
  const page = notesQuery.data;
  const folders = foldersQuery.data;
  const operationPending = pendingIds.size > 0;
  const hasCompleteSiblingProjection =
    query.view === "normal" &&
    query.sortBy === "sortOrder" &&
    query.sortDirection === "asc" &&
    page.page === 1 &&
    !page.hasMore;
  const disabledIds = operationPending ? new Set(page.items.map((note) => note.id)) : pendingIds;
  const activeView: NoteViewMode =
    !projectScoped && (view === "board" || view === "timeline") ? "list" : view;
  const destination = {
    projectId: query.scope === "project" ? (query.projectId ?? null) : null,
    folderId: query.folderId ?? null,
    parentId: null,
  };

  function setPage(next: NotePage): void {
    queryClient.setQueryData(noteQueryKeys.list(workspaceId, query), next);
  }

  function markPending(noteId: string, pending: boolean): void {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(noteId);
      else next.delete(noteId);
      return next;
    });
  }

  async function reconcile(): Promise<void> {
    await Promise.all([notesQuery.refetch(), foldersQuery.refetch()]);
    router.refresh();
  }

  async function create(input: CreateNoteInput, idempotencyKey: string): Promise<boolean> {
    const snapshot = { ...page, items: cloneNotePageItems(page.items) };
    const now = new Date().toISOString();
    const temporaryId = globalThis.crypto.randomUUID();
    const temporary: NoteSummary = {
      id: temporaryId,
      workspaceId,
      location:
        input.projectId === null || input.projectId === undefined ? "workspace-root" : "project",
      projectId: input.projectId ?? null,
      folderId: input.folderId ?? null,
      parentId: input.parentId ?? null,
      boardColumnId: null,
      title: input.title,
      type: input.type ?? "document",
      pageSize: input.pageSize ?? "a4",
      sortOrder: page.items.length + 1,
      isTemplate: input.isTemplate ?? false,
      isPinned: input.isPinned ?? false,
      isArchived: input.isArchived ?? false,
      isDeleted: false,
      tagIds: input.tagIds ?? [],
      progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
      version: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    setPage({ ...page, items: [temporary, ...page.items] });
    markPending(temporaryId, true);
    setStatus(`Creating ${temporary.title}…`);
    const result = await createNote(workspaceId, input, idempotencyKey);
    markPending(temporaryId, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Note creation", result.kind, "list"));
      return false;
    }
    setPage({ ...snapshot, items: [result.data.note, ...snapshot.items] });
    setStatus(`Created ${result.data.note.title}.`);
    await reconcile();
    return true;
  }

  /**
   * "Save as template" (`asTemplate`) and "Create from template" (`!asTemplate`)
   * are the same copy-by-value call with the flag flipped, so they share one
   * optimistic path. The temporary row is the source note with the flag and the
   * identity fields replaced: a copy inherits title, type, page size and — with
   * `includeTags` — its tags, so anything else would render a row the server is
   * about to contradict.
   */
  async function copyAs(note: NoteSummary, asTemplate: boolean): Promise<void> {
    if (operationPending) return;
    const snapshot = { ...page, items: cloneNotePageItems(page.items) };
    const now = new Date().toISOString();
    const temporaryId = globalThis.crypto.randomUUID();
    const temporary: NoteSummary = {
      ...note,
      id: temporaryId,
      isTemplate: asTemplate,
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      // A copy carries the source document, so `notes.checklist_*` is copied
      // with it; task rows stay attached to the source note and are not.
      progress: { checklist: note.progress.checklist, tasks: { done: 0, total: 0 } },
      sortOrder: page.items.length + 1,
      version: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    setPage({ ...page, items: [temporary, ...page.items] });
    markPending(temporaryId, true);
    setStatus(
      asTemplate ? `Saving ${note.title} as a template…` : `Creating a note from ${note.title}…`,
    );
    /*
     * The copy is anchored to the SOURCE's container, not to the browser's
     * current destination. Omitting these three would default the copy to the
     * unfiled workspace root, which would quietly lift a template out of the
     * project whose visibility rules were protecting it — and would make the
     * optimistic row above a lie about where the note landed.
     */
    const result = await copyNote(
      workspaceId,
      note.id,
      {
        asTemplate,
        includeTags: true,
        projectId: note.projectId,
        folderId: note.folderId,
        parentId: note.parentId,
      },
      globalThis.crypto.randomUUID(),
    );
    markPending(temporaryId, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(
        failureMessage(
          asTemplate ? "Saving as a template" : "Creating from a template",
          result.kind,
          "list",
        ),
      );
      return;
    }
    setPage({ ...snapshot, items: [result.data.note, ...snapshot.items] });
    setStatus(
      asTemplate
        ? `Saved ${result.data.note.title} as a template.`
        : `Created ${result.data.note.title} from the template.`,
    );
    await reconcile();
  }

  /**
   * Assignment and removal are one full-replace `PATCH { expectedVersion,
   * tagIds }` — the server has no per-edge route on purpose, so the picker
   * hands back the whole next selection and this writes it in one optimistic
   * step. `expectedVersion` means a concurrent edit loses here rather than
   * silently clobbering the other writer's tags.
   */
  async function assignTags(note: NoteSummary, tagIds: readonly string[]): Promise<void> {
    if (operationPending) return;
    const previous = { tagIds: note.tagIds, version: note.version };
    markPending(note.id, true);
    setPage({
      ...page,
      items: page.items.map((item) =>
        item.id === note.id ? { ...item, tagIds: [...tagIds] } : item,
      ),
    });
    setStatus(`Updating tags on ${note.title}…`);
    const result = await updateNote(workspaceId, note.id, {
      expectedVersion: previous.version,
      tagIds: [...tagIds],
    });
    markPending(note.id, false);
    if (!result.ok) {
      setPage({
        ...page,
        items: page.items.map((item) =>
          item.id === note.id
            ? { ...item, tagIds: previous.tagIds, version: previous.version }
            : item,
        ),
      });
      setHasVersionConflict(result.kind === "version-conflict");
      setStatus(failureMessage("Tag update", result.kind));
      return;
    }
    setPage({
      ...page,
      items: page.items.map((item) => (item.id === note.id ? result.data.note : item)),
    });
    setHasVersionConflict(false);
    setStatus(`Updated tags on ${result.data.note.title}.`);
    await reconcile();
  }

  async function rename(note: NoteSummary, title: string): Promise<boolean> {
    const nextTitle = title.trim();
    if (nextTitle.length === 0 || nextTitle === note.title) return nextTitle === note.title;
    const previous = { title: note.title, version: note.version };
    markPending(note.id, true);
    setPage({
      ...page,
      items: page.items.map((item) => (item.id === note.id ? { ...item, title: nextTitle } : item)),
    });
    setStatus(`Renaming ${previous.title}…`);
    const result = await updateNote(workspaceId, note.id, {
      expectedVersion: previous.version,
      title: nextTitle,
    });
    markPending(note.id, false);
    if (!result.ok) {
      setPage({
        ...page,
        items: page.items.map((item) =>
          item.id === note.id
            ? { ...item, title: previous.title, version: previous.version }
            : item,
        ),
      });
      setHasVersionConflict(result.kind === "version-conflict");
      setStatus(failureMessage("Rename", result.kind));
      return false;
    }
    setPage({
      ...page,
      items: page.items.map((item) => (item.id === note.id ? result.data.note : item)),
    });
    setHasVersionConflict(false);
    setStatus(`Renamed note to ${result.data.note.title}.`);
    await reconcile();
    return true;
  }

  async function move(note: NoteSummary, moveDestination: NoteMoveDestination): Promise<void> {
    if (query.view === "trash" || operationPending) return;
    const snapshot = { ...page, items: cloneNotePageItems(page.items) };
    // Hoisted so the narrowing survives into the closure below. `undefined`
    // means "keep the current column" and must never be sent as `null`, which
    // would clear the column on an ordinary reorder.
    const nextColumn = moveDestination.boardColumnId;
    markPending(note.id, true);
    const moved = optimisticMove(
      page.items,
      note.id,
      moveDestination,
      moveDestination.beforeNoteId ?? null,
    );
    setPage({
      ...page,
      items:
        nextColumn === undefined
          ? moved
          : moved.map((item) =>
              item.id === note.id ? { ...item, boardColumnId: nextColumn } : item,
            ),
    });
    setStatus(`Moving ${note.title}…`);
    const result = await moveNote(workspaceId, note.id, {
      expectedVersion: note.version,
      projectId: moveDestination.projectId,
      folderId: moveDestination.folderId,
      parentId: moveDestination.parentId,
      beforeNoteId: moveDestination.beforeNoteId ?? null,
      ...(nextColumn === undefined ? {} : { boardColumnId: nextColumn }),
    });
    markPending(note.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setHasVersionConflict(result.kind === "version-conflict");
      setStatus(failureMessage("Move", result.kind));
      return;
    }
    setHasVersionConflict(false);
    // A project-scoped column cannot survive a move into another project, so the
    // server clears it rather than refusing the move. Say so once, here.
    const columnCleared =
      nextColumn !== undefined && nextColumn !== null && result.data.note.boardColumnId === null;
    setStatus(
      columnCleared
        ? `Moved ${note.title}. Its board column was cleared because that column belongs to another project.`
        : `Moved ${note.title}. Order is being reconciled.`,
    );
    await reconcile();
  }

  async function lifecycle(
    note: NoteSummary,
    action: "trash" | "restore" | "permanent",
  ): Promise<void> {
    const snapshot = { ...page, items: cloneNotePageItems(page.items) };
    markPending(note.id, true);
    setStatus(`${action === "restore" ? "Restoring" : "Removing"} ${note.title}…`);
    const result =
      action === "trash"
        ? await trashNote(workspaceId, note.id, { expectedVersion: note.version })
        : action === "restore"
          ? await restoreNote(workspaceId, note.id, { expectedVersion: note.version })
          : await permanentlyDeleteNote(workspaceId, note.id, {
              expectedVersion: note.version,
              confirm: true,
              expectedTitle: note.title,
            });
    markPending(note.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setHasVersionConflict(result.kind === "version-conflict");
      setStatus(failureMessage(action === "restore" ? "Restore" : "Deletion", result.kind));
      return;
    }
    setPage({ ...page, items: page.items.filter((item) => item.id !== note.id) });
    setStatus(
      action === "trash"
        ? `${note.title} moved to trash.`
        : action === "restore"
          ? `${note.title} restored.`
          : `${note.title} permanently deleted.`,
    );
    requestAnimationFrame(() => headingRef.current?.focus());
    await reconcile();
  }

  function controls(note: NoteSummary) {
    if (!canCreate) return <span className="text-xs text-muted-foreground">Read-only access</span>;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {note.isDeleted ? null : (
          <RenameNoteControl
            note={note}
            pending={operationPending}
            onRename={(titleValue) => rename(note, titleValue)}
          />
        )}
        {note.isDeleted ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={operationPending}
            onClick={() => void copyAs(note, !note.isTemplate)}
          >
            {note.isTemplate ? "Create from template" : "Save as template"}
          </Button>
        )}
        {/*
         * A native <details> disclosure rather than a custom popover: it is
         * keyboard operable, screen-reader announced, and works before
         * hydration, none of which a hand-rolled toggle gets for free.
         */}
        {note.isDeleted ? null : (
          <details className="w-full">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Tags ({note.tagIds.length})
            </summary>
            <div className="pt-2">
              <TagPicker
                tags={tagOptions}
                value={note.tagIds}
                onChange={(next) => void assignTags(note, next)}
                disabled={operationPending}
                legend={`Tags for ${note.title}`}
                idPrefix={`note-tags-${note.id}`}
              />
            </div>
          </details>
        )}
        {canDelete ? (
          <NoteLifecycleActions
            note={note}
            pending={operationPending}
            onTrash={() => void lifecycle(note, "trash")}
            onRestore={() => void lifecycle(note, "restore")}
            onPermanentDelete={() => void lifecycle(note, "permanent")}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            Delete actions require an owner or admin.
          </span>
        )}
      </div>
    );
  }

  if (notesQuery.isError || foldersQuery.isError) {
    return (
      <section className="rounded-xl border bg-card p-6" role="alert">
        <h2 className="text-xl font-semibold">Notes unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The note list or folder destinations could not be refreshed safely.
        </p>
        <Button className="mt-4" onClick={() => void reconcile()}>
          Retry
        </Button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {embedded ? (
            <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight">
              {title}
            </h2>
          ) : (
            <h1 ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tight">
              {title}
            </h1>
          )}
          <p className="mt-2 max-w-2xl text-muted-foreground">{description}</p>
        </div>
        {query.view === "trash" ? null : (
          <CreateNoteDialog
            destination={destination}
            templateByDefault={query.view === "templates"}
            pinnedByDefault={query.view === "pinned"}
            disabled={!canCreate || operationPending}
            onCreate={create}
          />
        )}
      </header>
      {!canCreate && query.view !== "trash" ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm" role="note">
          Your current role can browse these notes but cannot create content here. Backend
          authorization remains authoritative.
        </p>
      ) : null}
      <nav aria-label="Note views" className="flex flex-wrap gap-2">
        <Link
          className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
          href={noteListHref(workspaceId)}
        >
          All notes
        </Link>
        {(["recent", "pinned", "templates", "trash"] as const).map((view) => (
          <Link
            key={view}
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm capitalize"
            href={noteViewPath(workspaceId, view)}
          >
            {view}
          </Link>
        ))}
      </nav>
      {query.tagId === undefined ? null : (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-2 text-sm"
          aria-label="Active tag filter"
        >
          <span className="inline-flex min-w-0 items-center gap-2 break-words">
            {activeTag === undefined ? null : (
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: activeTag.color }}
              />
            )}
            Filtered by tag: {activeTag?.name ?? query.tagId}
          </span>
          <Link
            className="inline-flex min-h-11 items-center rounded-md border bg-background px-3"
            href={noteListHref(workspaceId, { ...query, tagId: undefined, page: 1 })}
          >
            Clear tag filter
          </Link>
        </div>
      )}
      {query.scope === "workspace-root" && query.view === "normal" && canCreate ? (
        <FolderControls
          workspaceId={workspaceId}
          folders={folders.items}
          canDelete={canDelete}
          onStatus={setStatus}
        />
      ) : null}
      {folders.hasMore ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          Folder destinations are truncated at 100. No omitted folder is treated as unavailable or
          deleted; use a shallower folder page after pagination support is added.
        </p>
      ) : null}
      <div aria-live="polite" aria-atomic="true" className="min-h-6 text-sm text-muted-foreground">
        {status}
        {hasVersionConflict ? (
          <Button type="button" size="sm" variant="link" onClick={() => void reconcile()}>
            Reload latest notes
          </Button>
        ) : null}
      </div>
      {/*
       * Switching view repartitions rows already in hand: all four read the one
       * `noteQueryKeys.list` entry above, so no view change costs a request and
       * every optimistic edit is visible in all of them.
       */}
      <div className="flex w-fit rounded-md border p-1" role="group" aria-label="Note view">
        {VIEW_MODES.filter(
          (entry) => projectScoped || (entry.value !== "board" && entry.value !== "timeline"),
        ).map((entry) => (
          <Button
            key={entry.value}
            type="button"
            size="sm"
            variant={activeView === entry.value ? "secondary" : "ghost"}
            aria-pressed={activeView === entry.value}
            onClick={() => selectView(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {/*
       * The card views have nothing to draw without notes. The board and the
       * timeline do: the board still owes the reader its columns, and the
       * timeline still frames the project and its tasks. Blanking those two on
       * an empty note page would hide records that exist.
       */}
      {page.items.length === 0 && activeView !== "board" && activeView !== "timeline" ? (
        <section className="rounded-xl border border-dashed p-8 text-center">
          <h2 className="font-semibold">No notes in this view</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Try another note view or create a note if your role allows it.
          </p>
        </section>
      ) : activeView === "grid" ? (
        <NoteGrid notes={page.items} tagsById={tagsById} controlsFor={controls} />
      ) : activeView === "board" && project !== undefined ? (
        <NoteBoard
          notes={page.items}
          columns={statusesQuery.data ?? []}
          projectDueAt={project.dueAt}
          canEdit={canCreate && query.view !== "trash"}
          pendingIds={disabledIds}
          onMove={move}
          controlsFor={controls}
          tagsById={tagsById}
          hasMore={page.hasMore}
          orderingDisabled={!hasCompleteSiblingProjection}
          columnsLoading={statusesQuery.isPending}
          columnsUnavailable={statusesQuery.isError}
        />
      ) : activeView === "timeline" && project !== undefined ? (
        <NoteTimeline
          workspaceId={workspaceId}
          projectId={project.id}
          projectName={project.name}
          projectCreatedAt={project.createdAt}
          projectDueAt={project.dueAt}
          notes={page.items}
          notesHasMore={page.hasMore}
        />
      ) : (
        <NoteList
          notes={page.items}
          folders={folders.items}
          tagsById={tagsById}
          pendingIds={disabledIds}
          controlsFor={controls}
          onMove={move}
          projectIds={projectIds}
          movementDisabled={query.view === "trash" || !canCreate}
          relativeOrderingDisabled={!hasCompleteSiblingProjection}
        />
      )}
      <nav aria-label="Note pages" className="flex items-center justify-between">
        {page.page > 1 ? (
          <Link
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
            href={noteListHref(workspaceId, { ...query, page: page.page - 1 })}
          >
            Previous
          </Link>
        ) : (
          <span />
        )}
        {page.hasMore ? (
          <Link
            className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
            href={noteListHref(workspaceId, { ...query, page: page.page + 1 })}
          >
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
