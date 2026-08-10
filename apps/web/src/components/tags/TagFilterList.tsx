"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import type { TagSummary } from "@notted/shared-types";

import { noteListHref } from "@/lib/notes/paths";

export type TagNavigationState =
  | {
      readonly status: "ready";
      readonly tags: readonly TagSummary[];
      readonly truncated: boolean;
    }
  | { readonly status: "no-workspace" }
  | { readonly status: "unavailable" };

/**
 * Sidebar tag filter.
 *
 * `activeTagId` is read from the live search params rather than passed down:
 * the dashboard layout that builds `state` renders once per navigation, not
 * per search-param change, so a threaded prop would stick on the first tag the
 * user opened.
 */
export function TagFilterList({
  workspaceId,
  state,
}: {
  readonly workspaceId: string | null;
  readonly state: TagNavigationState;
}) {
  const searchParams = useSearchParams();
  const activeTagId = searchParams?.get("tagId") ?? null;

  if (state.status === "no-workspace" || workspaceId === null) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Choose or create a workspace to filter by tag.
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" role="note">
        Tag navigation is temporarily unavailable. Notes remain browsable without a tag filter.
      </p>
    );
  }
  if (state.tags.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        No tags yet. Create one from Manage tags to filter notes by tag.
      </p>
    );
  }

  return (
    <nav aria-label="Tags" className="space-y-2 text-sm">
      <ul className="space-y-1">
        {state.tags.map((tag) => (
          <li key={tag.id}>
            <Link
              href={noteListHref(workspaceId, { tagId: tag.id })}
              aria-current={tag.id === activeTagId ? "page" : undefined}
              aria-label={`${tag.name}, ${tag.noteCount} notes, ${tag.taskCount} tasks`}
              className="flex min-h-11 items-center gap-2 rounded px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-semibold"
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: tag.color }}
                className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
              />
              <span className="truncate">{tag.name}</span>
              <span aria-hidden="true" className="ms-auto shrink-0 text-muted-foreground">
                {tag.noteCount} · {tag.taskCount}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="px-2 text-xs text-muted-foreground">Counts show notes · tasks.</p>
      {activeTagId === null ? null : (
        <Link
          href={noteListHref(workspaceId)}
          className="flex min-h-11 items-center rounded px-2 text-xs font-medium underline hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Clear tag filter
        </Link>
      )}
      {state.truncated ? (
        <p className="rounded-md bg-muted p-2 text-xs" role="note">
          The tag list is truncated. Open Manage tags to see every tag.
        </p>
      ) : null}
    </nav>
  );
}
