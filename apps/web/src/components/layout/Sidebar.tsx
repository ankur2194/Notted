import {
  Building2,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  FileText,
  Home,
  LockKeyhole,
  Settings,
  Clock3,
  Pin,
  LayoutTemplate,
  Tags,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

import type { NoteNavigationState } from "@/components/notes/NoteTree";
import type { TagNavigationState } from "@/components/tags/TagFilterList";
import type { ShellBootstrap } from "@notted/shared-types";

import { NoteTree } from "@/components/notes/NoteTree";
import { TagFilterList } from "@/components/tags/TagFilterList";
import { Button } from "@/components/ui/button";

export function Sidebar({
  shell,
  collapsed,
  onToggle,
  mobile = false,
  noteNavigation,
  tagNavigation,
}: {
  readonly shell: ShellBootstrap;
  readonly collapsed: boolean;
  readonly onToggle?: () => void;
  readonly mobile?: boolean;
  readonly noteNavigation: NoteNavigationState;
  readonly tagNavigation: TagNavigationState;
}) {
  const hideLabels = collapsed && !mobile;
  return (
    <aside
      aria-label={mobile ? "Mobile workspace navigation" : "Workspace navigation"}
      className="flex h-full min-h-0 flex-col bg-secondary/40"
    >
      <div className="border-b p-3">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 rounded-md px-2 text-lg font-bold"
          aria-label="Notted dashboard"
        >
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"
          >
            N
          </span>
          {!hideLabels && <span>Notted</span>}
        </Link>
        {!hideLabels && (
          <div className="mt-3">
            <WorkspaceSwitcher
              workspaces={shell.workspaces}
              currentWorkspace={shell.currentWorkspace}
              compact={mobile}
            />
          </div>
        )}
      </div>

      <nav aria-label="Primary" className="space-y-1 p-3">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent"
          aria-label={hideLabels ? "Dashboard" : undefined}
        >
          <Home aria-hidden="true" className="size-5 shrink-0" />
          {!hideLabels && "Dashboard"}
        </Link>
        <Link
          href="/workspaces"
          className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent"
          aria-label={hideLabels ? "Workspaces" : undefined}
        >
          <Building2 aria-hidden="true" className="size-5 shrink-0" />
          {!hideLabels && "Workspaces"}
        </Link>
        {shell.permissions.canViewSettings && (
          <Link
            href="/settings/security"
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent"
            aria-label={hideLabels ? "Security settings" : undefined}
          >
            <LockKeyhole aria-hidden="true" className="size-5 shrink-0" />
            {!hideLabels && "Security"}
          </Link>
        )}
        {shell.currentWorkspace === null ? (
          <span
            className="flex min-h-11 cursor-not-allowed items-center gap-3 rounded-md px-3 text-sm text-muted-foreground"
            aria-disabled="true"
            title="Choose or create a workspace to view projects"
          >
            <FolderKanban aria-hidden="true" className="size-5 shrink-0" />
            {!hideLabels && "Projects"}
          </span>
        ) : (
          <Link
            href={`/workspaces/${shell.currentWorkspace.workspaceId}/projects`}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent"
            aria-label={hideLabels ? "Projects" : undefined}
          >
            <FolderKanban aria-hidden="true" className="size-5 shrink-0" />
            {!hideLabels && "Projects"}
          </Link>
        )}
        {shell.currentWorkspace !== null && !hideLabels ? (
          <div className="grid grid-cols-2 gap-1 pt-1 text-xs">
            <Link
              className="col-span-2 flex min-h-9 items-center gap-1 rounded px-2 hover:bg-accent"
              href={`/workspaces/${shell.currentWorkspace.workspaceId}/notes`}
            >
              <FileText aria-hidden="true" className="size-3.5" />
              All notes
            </Link>
            <Link
              className="flex min-h-9 items-center gap-1 rounded px-2 hover:bg-accent"
              href={`/workspaces/${shell.currentWorkspace.workspaceId}/notes/recent`}
            >
              <Clock3 aria-hidden="true" className="size-3.5" />
              Recent
            </Link>
            <Link
              className="flex min-h-9 items-center gap-1 rounded px-2 hover:bg-accent"
              href={`/workspaces/${shell.currentWorkspace.workspaceId}/notes/pinned`}
            >
              <Pin aria-hidden="true" className="size-3.5" />
              Pinned
            </Link>
            <Link
              className="flex min-h-9 items-center gap-1 rounded px-2 hover:bg-accent"
              href={`/workspaces/${shell.currentWorkspace.workspaceId}/notes/templates`}
            >
              <LayoutTemplate aria-hidden="true" className="size-3.5" />
              Templates
            </Link>
            <Link
              className="flex min-h-9 items-center gap-1 rounded px-2 hover:bg-accent"
              href={`/workspaces/${shell.currentWorkspace.workspaceId}/notes/trash`}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Trash
            </Link>
          </div>
        ) : null}
        {shell.currentWorkspace === null ? (
          <span
            className="flex min-h-11 cursor-not-allowed items-center gap-3 rounded-md px-3 text-sm text-muted-foreground"
            aria-disabled="true"
            title="Choose or create a workspace to view its settings"
          >
            <Settings aria-hidden="true" className="size-5 shrink-0" />
            {!hideLabels && "Workspace settings"}
          </span>
        ) : (
          <Link
            href={`/workspaces/${shell.currentWorkspace.workspaceId}/settings`}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent"
            aria-label={hideLabels ? "Workspace settings" : undefined}
          >
            <Settings aria-hidden="true" className="size-5 shrink-0" />
            {!hideLabels && "Workspace settings"}
          </Link>
        )}
      </nav>

      <section
        aria-labelledby={hideLabels ? undefined : "note-tree-heading"}
        className="min-h-0 flex-1 border-t p-3"
      >
        {!hideLabels && (
          <h2
            id="note-tree-heading"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Notes
          </h2>
        )}
        {hideLabels ? (
          <span
            className="flex min-h-11 items-center justify-center text-xs text-muted-foreground"
            aria-label="Expand sidebar to browse notes"
          >
            Notes
          </span>
        ) : (
          <div className="h-full overflow-y-auto">
            <NoteTree
              workspaceId={shell.currentWorkspace?.workspaceId ?? null}
              state={noteNavigation}
            />
          </div>
        )}
      </section>

      <section
        aria-labelledby={hideLabels ? undefined : "tag-filter-heading"}
        className="border-t p-3"
      >
        {!hideLabels && (
          <h2
            id="tag-filter-heading"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Tags
          </h2>
        )}
        {hideLabels ? (
          <span
            className="flex min-h-11 items-center justify-center text-xs text-muted-foreground"
            aria-label="Expand sidebar to filter notes by tag"
          >
            Tags
          </span>
        ) : (
          <div className="space-y-2">
            {/*
             * `TagFilterList` reads the active tag from the live search params,
             * which Next.js wants behind a boundary so a statically prerendered
             * route does not opt its whole tree into client rendering.
             */}
            <div className="max-h-56 overflow-y-auto">
              <Suspense
                fallback={<p className="p-2 text-xs text-muted-foreground">Loading tags…</p>}
              >
                <TagFilterList
                  workspaceId={shell.currentWorkspace?.workspaceId ?? null}
                  state={tagNavigation}
                />
              </Suspense>
            </div>
            {shell.currentWorkspace === null ? null : (
              <Link
                href={`/workspaces/${shell.currentWorkspace.workspaceId}/tags`}
                className="flex min-h-11 items-center gap-2 rounded px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Tags aria-hidden="true" className="size-3.5 shrink-0" />
                Manage tags
              </Link>
            )}
          </div>
        )}
      </section>

      {!mobile && onToggle !== undefined && (
        <div className="border-t p-3">
          <Button
            variant="ghost"
            className="w-full"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
          >
            {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
            {!hideLabels && "Collapse sidebar"}
          </Button>
        </div>
      )}
    </aside>
  );
}
