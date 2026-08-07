import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { WorkspaceSettings } from "@/components/workspaces/WorkspaceSettings";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

export default async function WorkspaceSettingsPage({
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
        <h1 className="text-2xl font-bold">Workspace settings unavailable</h1>
        <p>Settings could not be loaded safely. No changes were made.</p>
        <Link
          href={`/workspaces/${workspaceId}`}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Back to workspace
        </Link>
      </section>
    );
  }

  const workspace = result.data;
  // Display-only permission hints derived from the loaded membership role. The
  // backend re-authorizes every PATCH (settings.update = owner/admin) and
  // DELETE (workspace.delete = owner). Using the role from the detail (rather
  // than the shell's current-workspace flag) is correct for the workspace being
  // viewed, which may differ from the active workspace.
  const canManage = workspace.currentUserRole === "owner" || workspace.currentUserRole === "admin";
  const canDelete = workspace.currentUserRole === "owner";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Workspace breadcrumb">
        <Link
          href={`/workspaces/${workspace.id}`}
          className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {workspace.name}
        </Link>
      </nav>
      <header aria-labelledby="workspace-settings-heading">
        <h1 id="workspace-settings-heading" className="text-3xl font-bold tracking-tight">
          Workspace settings
        </h1>
        <p className="mt-2 text-muted-foreground">
          Manage identity, page defaults, and deletion for{" "}
          <span className="font-medium">{workspace.name}</span>. Storage usage is shown here; the
          storage limit and billing are read-only.
        </p>
      </header>
      <WorkspaceSettings
        key={workspace.updatedAt}
        workspace={workspace}
        canManage={canManage}
        canDelete={canDelete}
      />
    </div>
  );
}
