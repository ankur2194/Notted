import { CalendarDays, ImageIcon } from "lucide-react";
import Link from "next/link";

import type { ProjectSummary } from "@notted/shared-types";

import { projectDetailPath } from "@/lib/projects/paths";

export function formatProjectDate(value: string | null): string {
  if (value === null) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function ProjectCard({ project }: { readonly project: ProjectSummary }) {
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="h-2" style={{ backgroundColor: project.color }} aria-hidden="true" />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">
              <Link
                href={projectDetailPath(project.workspaceId, project.id)}
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {project.name}
              </Link>
            </h2>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {project.description ?? "No description"}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium capitalize">
            {project.status}
          </span>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays aria-hidden="true" className="size-4" />
            {formatProjectDate(project.dueAt)}
          </span>
          {project.coverImageUrl !== null ? (
            <span
              className="inline-flex items-center gap-1.5"
              title="Cover download is not available yet"
            >
              <ImageIcon aria-hidden="true" className="size-4" />
              Cover attached
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
