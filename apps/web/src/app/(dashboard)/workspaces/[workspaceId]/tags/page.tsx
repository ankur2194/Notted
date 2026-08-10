import Link from "next/link";
import { notFound } from "next/navigation";

import { TagManager } from "@/components/tags/TagManager";
import { getServerTags } from "@/lib/tags/server-tags";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

export default async function TagsPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [tags, workspace] = await Promise.all([
    getServerTags(workspaceId),
    getServerWorkspaceDetail(workspaceId),
  ]);
  // 403 and 404 already collapsed to `not-found` upstream, so a workspace the
  // caller may not see is indistinguishable from one that does not exist.
  if (
    tags.status === "not-found" ||
    tags.status === "unauthenticated" ||
    workspace.status === "not-found" ||
    workspace.status === "unauthenticated"
  )
    notFound();
  if (tags.status === "unavailable" || workspace.status === "unavailable") {
    return (
      <section className="mx-auto max-w-4xl rounded-xl border bg-card p-6" role="alert">
        <h1 className="text-3xl font-bold">Tags unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          The workspace or its tag list could not be loaded safely. No tag data was rendered.
        </p>
        <Link
          href={`/workspaces/${encodeURIComponent(workspaceId)}/tags`}
          className="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }
  const role = workspace.data.currentUserRole;
  return (
    <div className="mx-auto max-w-4xl">
      <TagManager
        workspaceId={workspaceId}
        initialTags={tags.data}
        canManage={role !== "viewer"}
        canDelete={role === "owner" || role === "admin"}
      />
    </div>
  );
}
