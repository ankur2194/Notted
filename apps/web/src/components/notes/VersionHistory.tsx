"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoteEditorSurface } from "./NoteEditorSurface";

import type { NoteDocument, NoteVersionSummary } from "@notted/shared-types";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import { requestNoteVersion, requestNoteVersions, restoreNoteVersion } from "@/lib/notes/requests";
import { diffVersionDocuments, type VersionDiffSegment } from "@/lib/notes/version-diff";

function failureCopy(kind: string): string {
  return kind === "forbidden-or-not-found"
    ? "Version history is unavailable or you no longer have permission to view it."
    : "Version history could not be loaded.";
}

function historyErrorKind(error: unknown): string {
  return error instanceof Error ? error.message : "unavailable";
}

function DiffColumn({
  heading,
  segments,
}: {
  readonly heading: string;
  readonly segments: readonly VersionDiffSegment[];
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={heading}>
      <h3 className="font-semibold">{heading}</h3>
      <ol className="space-y-1 text-sm">
        {segments.map((segment, index) => (
          <li
            key={`${index}-${segment.text}`}
            className={
              segment.kind === "added"
                ? "border-l-4 border-emerald-700 bg-emerald-50 px-2 py-1 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50"
                : segment.kind === "deleted"
                  ? "border-l-4 border-red-700 bg-red-50 px-2 py-1 text-red-950 line-through dark:bg-red-950 dark:text-red-50"
                  : "border-l-4 border-transparent px-2 py-1"
            }
          >
            <span className="sr-only">
              {segment.kind === "added"
                ? "Added: "
                : segment.kind === "deleted"
                  ? "Deleted: "
                  : "Unchanged: "}
            </span>
            {segment.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function VersionHistory({
  workspaceId,
  noteId,
  currentVersion,
  currentDocument,
  canRestore,
  saveStatus = "idle",
  hasUnsavedWork = false,
}: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly currentVersion: number;
  readonly currentDocument: NoteDocument;
  readonly canRestore: boolean;
  readonly saveStatus?:
    "idle" | "dirty" | "saving" | "saved" | "retrying" | "error" | "conflict" | "offline";
  readonly hasUnsavedWork?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const history = useQuery({
    queryKey: noteQueryKeys.versions(workspaceId, noteId),
    queryFn: async () => {
      const result = await requestNoteVersions(workspaceId, noteId);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
    enabled: open,
  });
  const errorKind = historyErrorKind(history.error);
  const selected = useQuery({
    queryKey:
      selectedId === null
        ? [...noteQueryKeys.versions(workspaceId, noteId), "none"]
        : noteQueryKeys.version(workspaceId, noteId, selectedId),
    queryFn: async () => {
      if (selectedId === null) throw new Error("No version selected");
      const result = await requestNoteVersion(workspaceId, noteId, selectedId);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
    enabled: open && selectedId !== null,
  });
  const diff = useMemo(
    () =>
      selected.data === undefined
        ? null
        : diffVersionDocuments(selected.data.content, currentDocument),
    [selected.data, currentDocument],
  );
  const blocked =
    hasUnsavedWork || ["dirty", "saving", "retrying", "offline", "conflict"].includes(saveStatus);

  async function restoreVersion(version: NoteVersionSummary): Promise<void> {
    if (
      !canRestore ||
      blocked ||
      version.isCurrent ||
      !window.confirm(
        `Restore version ${version.version}? The note title and content will become a new current version. History is not deleted.`,
      )
    )
      return;
    setRestoring(true);
    const result = await restoreNoteVersion(workspaceId, noteId, version.id, {
      expectedVersion: currentVersion,
    });
    setRestoring(false);
    if (!result.ok) {
      setAnnouncement(
        result.kind === "conflict"
          ? "Restore conflicted with a newer save. Refresh and try again."
          : "The version could not be restored.",
      );
      return;
    }
    setAnnouncement(
      `Version ${version.version} was restored as new version ${result.data.note.version}.`,
    );
    setSelectedId(null);
    await queryClient.invalidateQueries({ queryKey: noteQueryKeys.all(workspaceId) });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelectedId(null);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="min-h-11 rounded-md border px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Version history
        </button>
      </DialogTrigger>
      <DialogContent className="h-[min(90dvh,56rem)] max-w-6xl overflow-hidden p-0 motion-reduce:transition-none">
        <DialogHeader className="border-b p-5 pr-12">
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Select an immutable checkpoint to preview or compare. Restoring creates a new version.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[18rem_minmax(0,1fr)] lg:overflow-hidden">
          <aside
            className="border-b p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r"
            aria-label="Note versions"
          >
            {history.isLoading ? <p role="status">Loading versions…</p> : null}
            {history.isError ? (
              <div role="alert">
                <p>{failureCopy(errorKind)}</p>
                <button
                  type="button"
                  className="mt-2 underline"
                  onClick={() => void history.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {history.data?.items.length === 0 ? (
              <p>No retained versions are available. Older checkpoints may have been purged.</p>
            ) : null}
            <ol className="space-y-2">
              {history.data?.items.map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    className="min-h-11 w-full rounded-md border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-pressed={selectedId === version.id}
                    onClick={() => setSelectedId(version.id)}
                  >
                    <span className="block font-medium">
                      Version {version.version}
                      {version.isCurrent ? " · Current" : ""}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {version.author.name} ·{" "}
                      <time dateTime={version.createdAt}>
                        {new Date(version.createdAt).toLocaleString()}
                      </time>
                    </span>
                    <span className="block truncate text-sm">{version.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
          <main className="min-w-0 overflow-y-auto p-4">
            {selectedId === null ? (
              <p>Select a version to preview its semantic comparison.</p>
            ) : null}
            {selected.isLoading ? <p role="status">Loading preview…</p> : null}
            {selected.isError ? (
              <div role="alert">
                <p>This checkpoint is malformed, purged, or unavailable.</p>
                <button type="button" className="underline" onClick={() => void selected.refetch()}>
                  Retry preview
                </button>
              </div>
            ) : null}
            {selected.data !== undefined && diff !== null ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold">
                    Version {selected.data.version}: {selected.data.title}
                  </h2>
                  {canRestore && !selected.data.isCurrent ? (
                    <button
                      type="button"
                      className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
                      disabled={blocked || restoring}
                      onClick={() => void restoreVersion(selected.data)}
                      aria-describedby="restore-safety"
                    >
                      {restoring ? "Restoring…" : "Restore this version"}
                    </button>
                  ) : null}
                </div>
                <p id="restore-safety" className="text-sm text-muted-foreground">
                  {!canRestore
                    ? "Edit permission is required to restore."
                    : blocked
                      ? "Finish or resolve autosave before restoring."
                      : selected.data.isCurrent
                        ? "The current checkpoint cannot be restored."
                        : "Restoring changes the title and content by creating a new current version."}
                </p>
                {diff.tooLarge ? (
                  <p role="status">
                    This comparison is too large to display safely. The read-only checkpoint remains
                    available by selecting a smaller comparison.
                  </p>
                ) : (
                  <>
                    <p className="sr-only" aria-live="polite">
                      Comparison contains {diff.additions} additions and {diff.deletions} deletions.
                    </p>
                    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
                      <DiffColumn heading="Before — selected version" segments={diff.before} />
                      <DiffColumn heading="After — current version" segments={diff.after} />
                    </div>
                  </>
                )}
                <section
                  aria-labelledby="historical-preview-heading"
                  className="rounded-md border p-3"
                >
                  <h3 id="historical-preview-heading" className="mb-3 font-semibold">
                    Read-only historical preview
                  </h3>
                  <NoteEditorSurface
                    workspaceId={workspaceId}
                    noteId={noteId}
                    initialDocument={selected.data.content}
                    editable={false}
                    bindToNoteSave={false}
                    ariaLabel={`Historical preview of version ${selected.data.version}`}
                    readOnlyReason="Historical previews are read-only. Restore creates a new current version."
                  />
                </section>
                <p role="note" className="text-sm text-muted-foreground">
                  Historical attachments use the existing authorized resolver. If retained metadata
                  references missing bytes, the preview reports them as unavailable.
                </p>
              </div>
            ) : null}
          </main>
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      </DialogContent>
    </Dialog>
  );
}
