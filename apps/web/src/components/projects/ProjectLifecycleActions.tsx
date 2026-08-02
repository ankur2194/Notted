"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import type { ProjectDetail } from "@notted/shared-types";

import { EditProjectModal } from "@/components/projects/EditProjectModal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ErrorSummary, FormField, FormStatus } from "@/components/ui/form-controls";
import { projectCollectionPath } from "@/lib/projects/paths";
import { deleteProject, transitionProject } from "@/lib/projects/requests";

export function ProjectLifecycleActions({
  project,
  canManage,
}: {
  readonly project: ProjectDetail;
  readonly canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const deleteTrigger = useRef<HTMLButtonElement>(null);

  if (!canManage) {
    return (
      <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground" role="note">
        Project controls are not shown for your workspace role. The server remains authoritative if
        your access changes.
      </p>
    );
  }

  async function transition(action: "archive" | "complete" | "restore"): Promise<void> {
    setBusy(action);
    setError(null);
    const result = await transitionProject(project.workspaceId, project.id, action);
    setBusy(null);
    if (!result.ok) {
      setError(
        result.kind === "forbidden-or-not-found"
          ? "The action was denied or the project is no longer available."
          : result.kind === "conflict"
            ? "The project changed before this action completed. Refresh and retry."
            : result.kind === "invalid"
              ? "The action was not accepted."
              : "The action could not be completed. Check your connection and retry.",
      );
      return;
    }
    router.refresh();
  }

  async function remove(): Promise<void> {
    if (confirmation !== project.name) return;
    setBusy("delete");
    setError(null);
    const result = await deleteProject(project.workspaceId, project.id);
    setBusy(null);
    if (!result.ok) {
      setError(
        result.kind === "forbidden-or-not-found"
          ? "Deletion was denied or the project is no longer available."
          : result.kind === "conflict"
            ? "The project changed while deletion was being confirmed."
            : result.kind === "invalid"
              ? "The deletion request was not accepted."
              : "The project could not be deleted. Check your connection and retry.",
      );
      return;
    }
    router.replace(projectCollectionPath(project.workspaceId));
    router.refresh();
  }

  const disabled = busy !== null;
  return (
    <div className="space-y-3">
      {error !== null ? <ErrorSummary message={error} /> : null}
      {busy !== null ? <FormStatus>Updating project…</FormStatus> : null}
      <div className="flex flex-wrap gap-2" aria-label="Project controls">
        <EditProjectModal project={project} />
        {project.status === "active" ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void transition("complete")}
            >
              Complete
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void transition("archive")}
            >
              Archive
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void transition("restore")}
          >
            Restore
          </Button>
        )}
        <Dialog open={deleteOpen} onOpenChange={(next) => !disabled && setDeleteOpen(next)}>
          <DialogTrigger asChild>
            <Button ref={deleteTrigger} type="button" variant="destructive" disabled={disabled}>
              Delete project
            </Button>
          </DialogTrigger>
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              deleteTrigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete project?</DialogTitle>
              <DialogDescription>
                Notes and tasks are preserved as standalone workspace items, but the project itself
                is permanently removed.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void remove();
              }}
              className="space-y-4"
            >
              <FormField
                id="delete-project-confirmation"
                label={`Type ${project.name} to confirm`}
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                disabled={disabled}
                autoComplete="off"
              />
              {error !== null ? <ErrorSummary message={error} /> : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={disabled}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={disabled || confirmation !== project.name}
                >
                  {busy === "delete" ? "Deleting…" : "Permanently delete"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
