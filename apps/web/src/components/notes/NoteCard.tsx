import { Archive, FileCheck2, FileText, Pin, Trash2 } from "lucide-react";
import Link from "next/link";

import type { NoteSummary, TagSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

import { noteDetailPath } from "@/lib/notes/paths";

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated time unavailable";
  return `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;
}

export function NoteCard({
  note,
  folderName,
  projectName,
  excerpt,
  controls,
  tagsById,
}: {
  readonly note: NoteSummary;
  readonly folderName?: string;
  readonly projectName?: string;
  readonly excerpt?: string;
  readonly controls?: ReactNode;
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
}) {
  /*
   * Unresolvable ids are dropped rather than rendered: a raw UUID is not a tag
   * name, and the caller may legitimately have no tag listing at all.
   */
  const tags = note.tagIds.flatMap((tagId) => {
    const tag = tagsById?.get(tagId);
    return tag === undefined ? [] : [tag];
  });
  const location =
    note.projectId !== null
      ? `Project: ${projectName ?? "Project note"}`
      : note.folderId !== null
        ? `Standalone folder: ${folderName ?? "Folder"}`
        : "Standalone · Unfiled";
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex min-w-0 items-start gap-3">
        {note.type === "task-list" ? (
          <FileCheck2 aria-hidden="true" className="mt-1 size-5 shrink-0 text-info" />
        ) : (
          <FileText aria-hidden="true" className="mt-1 size-5 shrink-0 text-info" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-semibold">
            <Link
              className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={noteDetailPath(note.workspaceId, note)}
            >
              {note.title}
            </Link>
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{location}</p>
        </div>
      </div>
      {excerpt !== undefined && excerpt.trim().length > 0 ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {excerpt}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Note state">
        <span className="rounded-full bg-muted px-2 py-1">
          {note.type === "task-list" ? "Task list" : "Document"}
        </span>
        {note.isPinned ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
            <Pin aria-hidden="true" className="size-3" />
            Pinned
          </span>
        ) : null}
        {note.isTemplate ? <span className="rounded-full bg-muted px-2 py-1">Template</span> : null}
        {note.isArchived ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
            <Archive aria-hidden="true" className="size-3" />
            Archived
          </span>
        ) : null}
        {note.isDeleted ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-destructive">
            <Trash2 aria-hidden="true" className="size-3" />
            Trash
          </span>
        ) : null}
      </div>
      {/*
       * The tag colour is a dot, never the chip background: a user-chosen
       * colour behind the name cannot be held to 4.5:1, and the name itself —
       * not the colour — is what carries the meaning.
       */}
      {tags.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Note tags">
          {tags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1"
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: tag.color }}
              />
              {tag.name}
            </span>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Updated {updatedLabel(note.updatedAt)}</p>
      {controls === undefined ? null : <div className="border-t pt-3">{controls}</div>}
    </article>
  );
}
