import { FolderKanban } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CreateProjectModal } from "@/components/projects/CreateProjectModal";
import { ProjectCollection } from "@/components/projects/ProjectCollection";
import { projectListHref } from "@/lib/projects/paths";
import { getServerProjectList, type ProjectSearchParams } from "@/lib/projects/server-projects";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams?: Promise<ProjectSearchParams>;
}) {
  const { workspaceId } = await params;
  const rawSearch = searchParams === undefined ? {} : await searchParams;
  const [projectsResult, workspaceResult] = await Promise.all([
    getServerProjectList(workspaceId, rawSearch),
    getServerWorkspaceDetail(workspaceId),
  ]);

  if (
    projectsResult.status === "not-found" ||
    projectsResult.status === "unauthenticated" ||
    workspaceResult.status === "not-found" ||
    workspaceResult.status === "unauthenticated"
  ) {
    notFound();
  }
  if (projectsResult.status === "unavailable" || workspaceResult.status === "unavailable") {
    return (
      <section className="mx-auto max-w-6xl space-y-4" role="alert">
        <h1 className="text-3xl font-bold">Projects unavailable</h1>
        <p>Projects could not be loaded safely. No project data was rendered.</p>
        <Link
          href={projectListHref(workspaceId)}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }

  const { data, query } = projectsResult;
  const canCreate =
    workspaceResult.data.currentUserRole === "owner" ||
    workspaceResult.data.currentUserRole === "admin";
  const filtered = query.status !== undefined || query.name !== undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header
        className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        aria-labelledby="projects-heading"
      >
        <div>
          <h1 id="projects-heading" className="text-3xl font-bold tracking-tight">
            Projects
          </h1>
          <p className="mt-2 text-muted-foreground">
            Organize project notes and see truthful first-class task progress.
          </p>
        </div>
        {canCreate ? (
          <CreateProjectModal workspaceId={workspaceId} />
        ) : (
          <p
            className="max-w-sm rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
            role="note"
          >
            Creating projects requires owner or admin access. The server checks every attempted
            mutation.
          </p>
        )}
      </header>

      <form
        className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5"
        action={projectListHref(workspaceId)}
        method="get"
        aria-label="Project filters"
      >
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="project-name-filter" className="text-sm font-medium">
            Name
          </label>
          <input
            id="project-name-filter"
            name="name"
            defaultValue={query.name ?? ""}
            maxLength={255}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
            placeholder="Search project names"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="project-status-filter" className="text-sm font-medium">
            Status
          </label>
          <select
            id="project-status-filter"
            name="status"
            defaultValue={query.status ?? ""}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="project-sort-filter" className="text-sm font-medium">
            Sort by
          </label>
          <select
            id="project-sort-filter"
            name="sortBy"
            defaultValue={query.sortBy}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="updatedAt">Last updated</option>
            <option value="createdAt">Created</option>
            <option value="name">Name</option>
            <option value="dueAt">Due date</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="project-direction-filter" className="text-sm font-medium">
            Direction
          </label>
          <select
            id="project-direction-filter"
            name="sortDirection"
            defaultValue={query.sortDirection}
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Apply filters
          </button>
          <Link
            href={projectListHref(workspaceId)}
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            Clear
          </Link>
        </div>
      </form>

      {data.items.length > 0 ? (
        <ProjectCollection workspaceId={workspaceId} projects={data.items} />
      ) : data.page > 1 ? (
        <section
          className="space-y-3 rounded-xl border border-dashed p-8 text-center"
          aria-labelledby="past-project-page-heading"
        >
          <h2 id="past-project-page-heading" className="text-xl font-semibold">
            No projects on this page
          </h2>
          <p className="text-sm text-muted-foreground">
            This page is past the available authorized results.
          </p>
          <Link
            href={projectListHref(workspaceId, { ...query, page: 1 })}
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
          >
            Return to the first page
          </Link>
        </section>
      ) : (
        <section
          className="space-y-3 rounded-xl border border-dashed p-8 text-center"
          aria-labelledby="empty-projects-heading"
        >
          <FolderKanban aria-hidden="true" className="mx-auto size-10 text-muted-foreground" />
          <h2 id="empty-projects-heading" className="text-xl font-semibold">
            {filtered ? "No matching projects" : "No projects yet"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {filtered
              ? "Adjust or clear the URL-backed filters."
              : canCreate
                ? "Create the first project for this workspace."
                : "An owner or admin can create the first project."}
          </p>
        </section>
      )}

      {data.page > 1 || data.hasMore ? (
        <nav className="flex items-center justify-between gap-4" aria-label="Project pages">
          {data.page > 1 ? (
            <Link
              href={projectListHref(workspaceId, { ...query, page: data.page - 1 })}
              className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">Page {data.page}</span>
          {data.hasMore ? (
            <Link
              href={projectListHref(workspaceId, { ...query, page: data.page + 1 })}
              className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
