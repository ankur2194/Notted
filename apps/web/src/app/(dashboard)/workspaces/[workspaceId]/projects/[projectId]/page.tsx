import { ImageIcon, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteBrowser } from "@/components/notes/NoteBrowser";
import { formatProjectDate } from "@/components/projects/ProjectCard";
import { ProjectLifecycleActions } from "@/components/projects/ProjectLifecycleActions";
import { getServerFolders, getServerNoteList } from "@/lib/notes/server-notes";
import { projectCollectionPath, projectDetailPath } from "@/lib/projects/paths";
import { getServerProjectDetail } from "@/lib/projects/server-projects";
import { getServerWorkspaceDetail } from "@/lib/workspaces/server-workspaces";

function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return (
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date) + " UTC"
  );
}

export default async function ProjectDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const [projectResult, workspaceResult, notesResult, foldersResult] = await Promise.all([
    getServerProjectDetail(workspaceId, projectId),
    getServerWorkspaceDetail(workspaceId),
    getServerNoteList(workspaceId, {}, { projectId }),
    getServerFolders(workspaceId),
  ]);
  if (
    projectResult.status === "not-found" ||
    projectResult.status === "unauthenticated" ||
    workspaceResult.status === "not-found" ||
    workspaceResult.status === "unauthenticated"
  )
    notFound();
  if (projectResult.status === "unavailable" || workspaceResult.status === "unavailable") {
    return (
      <section className="mx-auto max-w-5xl space-y-4" role="alert">
        <h1 className="text-3xl font-bold">Project unavailable</h1>
        <p>This project could not be loaded safely. No project data was rendered.</p>
        <Link
          href={projectDetailPath(workspaceId, projectId)}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry
        </Link>
      </section>
    );
  }

  const project = projectResult.data;
  const canManage =
    workspaceResult.data.currentUserRole === "owner" ||
    workspaceResult.data.currentUserRole === "admin";
  const percent =
    project.taskProgress.total === 0
      ? 0
      : Math.round((project.taskProgress.completed / project.taskProgress.total) * 100);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        href={projectCollectionPath(workspaceId)}
        className="inline-flex min-h-11 items-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        ← All projects
      </Link>
      <header className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="h-3" style={{ backgroundColor: project.color }} aria-hidden="true" />
        <div className="space-y-5 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{project.name}</h1>
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                {project.description ?? "No description"}
              </p>
            </div>
            <span className="w-fit rounded-full bg-muted px-3 py-1 text-sm font-medium capitalize">
              {project.status}
            </span>
          </div>
          {project.coverImageUrl !== null ? (
            <p
              className="inline-flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm"
              role="note"
            >
              <ImageIcon aria-hidden="true" className="size-4" /> Cover attached. Download and image
              rendering arrive with the attachment parts.
            </p>
          ) : null}
          <ProjectLifecycleActions project={project} canManage={canManage} />
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Project facts">
        <dl className="space-y-3 rounded-xl border bg-card p-5">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Due date</dt>
            <dd>{formatProjectDate(project.dueAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Created</dt>
            <dd className="text-right">{formatActivity(project.createdAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Last activity</dt>
            <dd className="text-right">{formatActivity(project.lastActivityAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Color</dt>
            <dd className="font-mono">{project.color}</dd>
          </div>
        </dl>
        <section
          className="space-y-3 rounded-xl border bg-card p-5"
          aria-labelledby="task-progress-heading"
        >
          <h2 id="task-progress-heading" className="text-lg font-semibold">
            Task progress
          </h2>
          <p className="text-3xl font-bold">
            {project.taskProgress.completed}/{project.taskProgress.total}
          </p>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Standalone task progress"
            aria-valuemin={0}
            aria-valuemax={project.taskProgress.total}
            aria-valuenow={project.taskProgress.completed}
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-sm text-muted-foreground">
            Counts non-canceled first-class tasks; only built-in done tasks count as completed.
            Inline checklist items are not included.
          </p>
        </section>
      </section>

      <section
        className="space-y-4 rounded-xl border bg-card p-5"
        aria-labelledby="project-members-heading"
      >
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" className="size-5" />
          <h2 id="project-members-heading" className="text-xl font-semibold">
            Project members
          </h2>
        </div>
        {project.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active authorized members were returned.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {project.members.map((member) => (
              <li key={member.userId} className="rounded-lg border p-3">
                <p className="font-medium">{member.name}</p>
                <p className="text-sm capitalize text-muted-foreground">
                  {member.projectRole ?? member.workspaceRole} ·{" "}
                  {member.accessSource.replace("-", " ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="min-h-48 space-y-3 rounded-xl border bg-card p-5"
        aria-label="Project notes"
      >
        {notesResult.status === "ready" && foldersResult.status === "ready" ? (
          <NoteBrowser
            workspaceId={workspaceId}
            initialPage={notesResult.data.page}
            initialFolders={foldersResult.data}
            query={notesResult.data.query}
            canCreate={workspaceResult.data.currentUserRole !== "viewer"}
            canDelete={
              workspaceResult.data.currentUserRole === "owner" ||
              workspaceResult.data.currentUserRole === "admin"
            }
            title="Project notes"
            description={`Notes organized inside ${project.name}.`}
            embedded
            projectIds={[projectId]}
          />
        ) : (
          <div role="alert">
            <h3 className="text-xl font-semibold">Project notes unavailable</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              The project remains available, but its authorized note list could not be loaded
              safely.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
