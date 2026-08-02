"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { CreateNoteDialog } from "./CreateNoteDialog";
import { FolderControls } from "./FolderControls";
import { NoteLifecycleActions } from "./NoteLifecycleActions";
import { NoteList, type NoteMoveDestination } from "./NoteList";
import { RenameNoteControl } from "./RenameNoteControl";

import type { FolderPage, NoteListQuery, NotePage, NoteSummary } from "@notted/shared-types";
import type { CreateNoteInput } from "@notted/shared-validators";

import { Button } from "@/components/ui/button";
import { noteListHref, noteViewPath } from "@/lib/notes/paths";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import {
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
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState("");
  const [hasVersionConflict, setHasVersionConflict] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
      title: input.title,
      type: input.type ?? "document",
      pageSize: input.pageSize ?? "a4",
      sortOrder: page.items.length + 1,
      isTemplate: input.isTemplate ?? false,
      isPinned: input.isPinned ?? false,
      isArchived: input.isArchived ?? false,
      isDeleted: false,
      tagIds: input.tagIds ?? [],
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
    markPending(note.id, true);
    setPage({
      ...page,
      items: optimisticMove(
        page.items,
        note.id,
        moveDestination,
        moveDestination.beforeNoteId ?? null,
      ),
    });
    setStatus(`Moving ${note.title}…`);
    const result = await moveNote(workspaceId, note.id, {
      expectedVersion: note.version,
      projectId: moveDestination.projectId,
      folderId: moveDestination.folderId,
      parentId: moveDestination.parentId,
      beforeNoteId: moveDestination.beforeNoteId ?? null,
    });
    markPending(note.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setHasVersionConflict(result.kind === "version-conflict");
      setStatus(failureMessage("Move", result.kind));
      return;
    }
    setStatus(`Moved ${note.title}. Order is being reconciled.`);
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
      {page.items.length === 0 ? (
        <section className="rounded-xl border border-dashed p-8 text-center">
          <h2 className="font-semibold">No notes in this view</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Try another note view or create a note if your role allows it.
          </p>
        </section>
      ) : (
        <NoteList
          notes={page.items}
          folders={folders.items}
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
