import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import type { MemberFilterOption, ProjectFilterOption } from "@/components/search/SearchFilters";

import { SearchContainer } from "@/components/search/SearchContainer";
import { getServerWorkspaceMembers } from "@/lib/notes/server-notes";
import { getServerProjectList } from "@/lib/projects/server-projects";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

/**
 * Part 52.4 full search route.
 *
 * The Server Component establishes membership (workspace detail) and loads the
 * filter-option sources (projects and members) once, server-side. The actual
 * search results are fetched client-side by `SearchContainer` through TanStack
 * Query, because they depend on the debounced query and the bookmarkable URL
 * filters. A 403/404 on any of the three reads collapses to `notFound()`: a
 * workspace the caller may not see is indistinguishable from one that does not
 * exist. An unavailable read for projects or members degrades the filters to
 * empty option lists rather than failing the whole page — search still works.
 */
export default async function WorkspaceSearchPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [workspace, projectsResult, membersResult] = await Promise.all([
    getServerWorkspaceDetail(workspaceId),
    getServerProjectList(workspaceId),
    getServerWorkspaceMembers(workspaceId),
  ]);

  if (workspace.status === "not-found" || workspace.status === "unauthenticated") notFound();

  if (workspace.status === "unavailable") {
    return (
      <section className="mx-auto max-w-4xl rounded-xl border bg-card p-6" role="alert">
        <h1 className="text-3xl font-bold">Search unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          This workspace could not be loaded safely, so no search was run and nothing was changed.
        </p>
        <Link
          href={`/workspaces/${encodeURIComponent(workspaceId)}/search`}
          className="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }

  const projects: readonly ProjectFilterOption[] =
    projectsResult.status === "ready"
      ? projectsResult.data.items.map((project) => ({ id: project.id, name: project.name }))
      : [];
  const members: readonly MemberFilterOption[] =
    membersResult.status === "ready"
      ? membersResult.data.items.map((member) => ({ userId: member.userId, name: member.name }))
      : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Search</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Find notes in {workspace.data.name} by title or content. Filter by project, author, date,
          or attachments, and open any result to keep editing.
        </p>
      </header>
      {/*
       * `SearchContainer` reads `useSearchParams`, which Next.js wants inside a
       * Suspense boundary so the page can render its shell while the
       * filter-driven client query hydrates. The fallback mirrors the
       * container's own loading state.
       */}
      <Suspense
        fallback={
          <p
            className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground"
            role="status"
          >
            Loading search…
          </p>
        }
      >
        <SearchContainer workspaceId={workspaceId} projects={projects} members={members} />
      </Suspense>
    </div>
  );
}
