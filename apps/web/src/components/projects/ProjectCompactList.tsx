import { ImageIcon } from "lucide-react";
import Link from "next/link";

import type { ProjectSummary } from "@notted/shared-types";

import { formatProjectDate } from "@/components/projects/ProjectCard";
import { projectDetailPath } from "@/lib/projects/paths";

export function ProjectCompactList({ projects }: { readonly projects: readonly ProjectSummary[] }) {
  return (
    <ul className="divide-y rounded-xl border bg-card" aria-label="Projects compact list">
      {projects.map((project) => (
        <li key={project.id}>
          <article className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <span
              className="size-3 shrink-0 rounded-full border"
              style={{ backgroundColor: project.color }}
              aria-label={`Project color ${project.color}`}
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold">
                <Link
                  href={projectDetailPath(project.workspaceId, project.id)}
                  className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {project.name}
                </Link>
              </h2>
              <p className="truncate text-sm text-muted-foreground">
                {project.description ?? "No description"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground sm:justify-end">
              {project.coverImageUrl !== null ? (
                <span className="inline-flex items-center gap-1">
                  <ImageIcon aria-hidden="true" className="size-4" /> Cover attached
                </span>
              ) : null}
              <span>{formatProjectDate(project.dueAt)}</span>
              <span className="rounded-full bg-muted px-2.5 py-1 capitalize">{project.status}</span>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}
