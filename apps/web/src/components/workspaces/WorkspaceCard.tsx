"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { WorkspaceSummary } from "@notted/shared-types";

import { WorkspaceAvatar } from "@/components/workspaces/WorkspaceAvatar";
import { selectWorkspace } from "@/lib/shell/requests";

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/**
 * A workspace membership card. The data is server-provided (read in a Server
 * Component); this client boundary only owns the click interaction: selecting
 * the workspace via the existing `selectWorkspace` cookie helper (shared with
 * the sidebar switcher — no duplicated switch logic), then navigating to the
 * overview and refreshing so the shell reflects the new current workspace.
 *
 * A failed selection leaves the user on the list with an actionable message;
 * navigating while the shell still points at another workspace would make the
 * active-tenant context ambiguous.
 */
export function WorkspaceCard({
  workspace,
  currentWorkspaceId,
}: {
  readonly workspace: WorkspaceSummary;
  readonly currentWorkspaceId?: string;
}) {
  const router = useRouter();
  const [selecting, setSelecting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const href = `/workspaces/${workspace.id}`;
  const isCurrent = workspace.id === currentWorkspaceId;

  async function open(event: React.MouseEvent<HTMLAnchorElement>): Promise<void> {
    // Let modifier-click / middle-click open a new tab natively.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    if (selecting) return;
    setWarning(null);
    if (!isCurrent) {
      setSelecting(true);
      const result = await selectWorkspace(workspace.id);
      setSelecting(false);
      if (!result.ok) {
        setWarning("Could not switch workspaces. Check your access or connection, then try again.");
        return;
      }
    }
    router.push(href);
    router.refresh();
  }

  return (
    <a
      href={href}
      onClick={(event) => void open(event)}
      aria-busy={selecting}
      aria-label={`Open ${workspace.name} workspace`}
      className="group flex min-h-11 items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <WorkspaceAvatar name={workspace.name} logoUrl={workspace.logoUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold">{workspace.name}</p>
          {isCurrent ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Current
            </span>
          ) : null}
        </div>
        <p className="truncate text-sm text-muted-foreground">{workspace.slug}</p>
        {workspace.description !== null && workspace.description.length > 0 ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{workspace.description}</p>
        ) : null}
        <p className="mt-2 text-xs capitalize text-muted-foreground sm:hidden">
          {workspace.plan} plan · {workspace.currentUserRole}
        </p>
        {warning !== null ? (
          <p className="mt-1 text-xs text-destructive" role="status">
            {warning}
          </p>
        ) : null}
      </div>
      <dl className="hidden shrink-0 gap-4 text-right text-xs text-muted-foreground sm:flex">
        <div>
          <dt className="sr-only">Plan</dt>
          <dd className="font-medium capitalize text-foreground">{workspace.plan}</dd>
        </div>
        <div>
          <dt className="sr-only">Your role</dt>
          <dd className="font-medium capitalize text-foreground">{workspace.currentUserRole}</dd>
        </div>
        <div>
          <dt className="sr-only">Last updated</dt>
          <dd>
            <time dateTime={workspace.updatedAt}>{formatRelativeDate(workspace.updatedAt)}</time>
          </dd>
        </div>
      </dl>
    </a>
  );
}
