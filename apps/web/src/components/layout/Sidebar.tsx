import {
  Building2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Home,
  LockKeyhole,
  Settings,
} from "lucide-react";
import Link from "next/link";

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

import type { ShellBootstrap } from "@notted/shared-types";

import { Button } from "@/components/ui/button";

export function Sidebar({
  shell,
  collapsed,
  onToggle,
  mobile = false,
}: {
  readonly shell: ShellBootstrap;
  readonly collapsed: boolean;
  readonly onToggle?: () => void;
  readonly mobile?: boolean;
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
        <div
          className="flex min-h-11 items-center gap-3 rounded-md border border-dashed px-3 text-sm text-muted-foreground"
          aria-label={hideLabels ? "Note tree unavailable" : undefined}
        >
          <FileText aria-hidden="true" className="size-5 shrink-0" />
          {!hideLabels && <span>Note tree unavailable until Parts 31–32</span>}
        </div>
        {!hideLabels && (
          <ul
            className="mt-2 space-y-1 text-xs text-muted-foreground"
            aria-label="Unavailable nested note tree preview"
          >
            <li className="rounded px-3 py-1.5">
              <span aria-hidden="true">▱ </span>Note level placeholder (unavailable)
            </li>
            <li className="rounded py-1.5 pl-7 pr-3">
              <span aria-hidden="true">▱ </span>Nested note placeholder (unavailable)
            </li>
            <li className="rounded py-1.5 pl-11 pr-3">
              <span aria-hidden="true">▱ </span>Third-level placeholder (unavailable)
            </li>
          </ul>
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
