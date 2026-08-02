import type { ProjectSummary } from "@notted/shared-types";

import { ProjectCard } from "@/components/projects/ProjectCard";

export function ProjectGrid({ projects }: { readonly projects: readonly ProjectSummary[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects grid">
      {projects.map((project) => (
        <li key={project.id} className="min-w-0">
          <ProjectCard project={project} />
        </li>
      ))}
    </ul>
  );
}
