import { ArrowLeft, Settings } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { WorkspaceAvatar } from "@/components/workspaces/WorkspaceAvatar";
import { WorkspaceStorageLimit } from "@/components/workspaces/WorkspaceStorageLimit";
import { WorkspaceStorageUsage } from "@/components/workspaces/WorkspaceStorageUsage";
import {
  getServerWorkspaceDetail,
  getServerWorkspaceStorageUsage,
} from "@/lib/workspaces/server-workspaces";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export default async function WorkspaceOverviewPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const result = await getServerWorkspaceDetail(workspaceId);

  if (result.status === "not-found") notFound();
  if (result.status === "unauthenticated") notFound();
  if (result.status === "unavailable") {
    return (
      <section className="mx-auto max-w-3xl space-y-4" role="alert">
        <h1 className="text-2xl font-bold">Workspace unavailable</h1>
        <p>This workspace could not be loaded safely. No content was rendered.</p>
        <Link
          href="/workspaces"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Back to workspaces
        </Link>
      </section>
    );
  }

  const workspace = result.data;
  const canManage = workspace.currentUserRole === "owner" || workspace.currentUserRole === "admin";
  // Part 45. Fetched only after the detail read proved membership, and allowed
  // to fail without taking the page with it — the storage card degrades alone.
  const storage = await getServerWorkspaceStorageUsage(workspace.id);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <nav aria-label="Workspace breadcrumb">
        <Link
          href="/workspaces"
          className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All workspaces
        </Link>
      </nav>

      <header
        className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-sm sm:flex-row sm:items-center"
        aria-labelledby="workspace-overview-heading"
      >
        <WorkspaceAvatar name={workspace.name} logoUrl={workspace.logoUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 id="workspace-overview-heading" className="text-3xl font-bold tracking-tight">
            {workspace.name}
          </h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">{workspace.slug}</p>
          {workspace.description !== null && workspace.description.length > 0 ? (
            <p className="mt-3 text-muted-foreground">{workspace.description}</p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No description set.</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <Link
            href={`/workspaces/${workspace.id}/settings`}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Settings aria-hidden="true" className="size-4" />
            {canManage ? "Workspace settings" : "View settings"}
          </Link>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2" aria-labelledby="workspace-facts-heading">
        <h2 id="workspace-facts-heading" className="sr-only">
          Workspace details
        </h2>
        <dl className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Plan</dt>
            <dd className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium capitalize text-primary">
              {workspace.plan}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Your role</dt>
            <dd className="font-medium capitalize">{workspace.currentUserRole}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Custom domain</dt>
            <dd className="break-all text-right text-sm">{workspace.domain ?? "Not configured"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Created</dt>
            <dd className="text-sm">{formatDate(workspace.createdAt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Last updated</dt>
            <dd className="text-sm">{formatDate(workspace.updatedAt)}</dd>
          </div>
        </dl>

        <div className="space-y-4 rounded-xl border bg-card p-5 shadow-sm">
          <h3 className="font-semibold">Storage</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Storage limit override</dt>
              <dd className="font-medium">
                <WorkspaceStorageLimit bytes={workspace.storageLimitBytes} />
              </dd>
            </div>
          </dl>
          {storage.status === "ready" ? (
            <WorkspaceStorageUsage usage={storage.data} />
          ) : storage.status === "forbidden" ? (
            <p className="text-sm text-muted-foreground" role="note">
              Storage usage is not available for your access to this workspace.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" role="note">
              Storage usage could not be loaded. Open workspace settings to try again.
            </p>
          )}
        </div>
      </section>

      <section
        className="space-y-3 rounded-xl border bg-card p-5 shadow-sm"
        aria-labelledby="page-defaults-heading"
      >
        <h2 id="page-defaults-heading" className="text-xl font-semibold">
          Page defaults
        </h2>
        <p className="text-sm text-muted-foreground">
          New notes use this workspace default unless a note specifies another paper size.
        </p>
        <dl className="rounded-md border bg-muted/20 p-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Default page size</dt>
            <dd className="font-medium">
              {workspace.settings.defaultPageSize === "a4" ? "A4" : "Letter"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
