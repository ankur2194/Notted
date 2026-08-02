"use client";

import { Grid2X2, List } from "lucide-react";
import { useEffect, useState } from "react";

import type { ProjectSummary } from "@notted/shared-types";

import { ProjectCompactList } from "@/components/projects/ProjectCompactList";
import { ProjectGrid } from "@/components/projects/ProjectGrid";
import { Button } from "@/components/ui/button";
import {
  readProjectViewPreference,
  writeProjectViewPreference,
  type ProjectViewPreference,
} from "@/lib/projects/view-preference";

export function ProjectCollection({
  workspaceId,
  projects,
}: {
  readonly workspaceId: string;
  readonly projects: readonly ProjectSummary[];
}) {
  const [view, setView] = useState<ProjectViewPreference>("grid");

  useEffect(() => {
    setView(readProjectViewPreference(window.localStorage, workspaceId));
  }, [workspaceId]);

  function selectView(next: ProjectViewPreference): void {
    setView(next);
    writeProjectViewPreference(window.localStorage, workspaceId, next);
  }

  return (
    <section className="space-y-4" aria-labelledby="project-results-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="project-results-heading" className="text-lg font-semibold">
          Project results
        </h2>
        <div className="flex rounded-md border p-1" role="group" aria-label="Project view">
          <Button
            type="button"
            size="sm"
            variant={view === "grid" ? "secondary" : "ghost"}
            aria-pressed={view === "grid"}
            onClick={() => selectView("grid")}
          >
            <Grid2X2 aria-hidden="true" /> Grid
          </Button>
          <Button
            type="button"
            size="sm"
            variant={view === "list" ? "secondary" : "ghost"}
            aria-pressed={view === "list"}
            onClick={() => selectView("list")}
          >
            <List aria-hidden="true" /> List
          </Button>
        </div>
      </div>
      {view === "grid" ? (
        <ProjectGrid projects={projects} />
      ) : (
        <ProjectCompactList projects={projects} />
      )}
    </section>
  );
}
