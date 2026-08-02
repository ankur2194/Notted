"use client";

import { updateProjectSchema } from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ProjectDetail, ProjectStatus } from "@notted/shared-types";

import { ProjectFields } from "@/components/projects/ProjectFields";
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
import { ErrorSummary, FormStatus } from "@/components/ui/form-controls";
import { updateProject } from "@/lib/projects/requests";

export function EditProjectModal({ project }: { readonly project: ProjectDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState(project.color);
  const [dueDate, setDueDate] = useState(project.dueAt?.slice(0, 10) ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch() {
    return {
      name: name.trim(),
      description: description.trim().length === 0 ? null : description.trim(),
      color,
      status,
      dueAt: dueDate.length === 0 ? null : `${dueDate}T00:00:00.000Z`,
    };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = updateProjectSchema.safeParse(patch());
    if (!parsed.success) {
      setError("Check the project fields and try again.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await updateProject(project.workspaceId, project.id, parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setError(
        result.kind === "forbidden-or-not-found"
          ? "The update was denied. Your project access may have changed."
          : result.kind === "conflict"
            ? "The project changed while you were editing. Refresh and retry."
            : result.kind === "invalid"
              ? "The changes were not accepted. Review the fields and retry."
              : "The project could not be updated. Check your connection and retry.",
      );
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Edit project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>
            Update project details. The API rechecks your access when you save.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => void submit(event)}
          noValidate
          aria-busy={submitting}
        >
          <ProjectFields
            prefix="edit-project"
            name={name}
            description={description}
            color={color}
            dueDate={dueDate}
            status={status}
            disabled={submitting}
            onName={setName}
            onDescription={setDescription}
            onColor={setColor}
            onDueDate={setDueDate}
            onStatus={setStatus}
          />
          {error !== null ? <ErrorSummary message={error} /> : null}
          {submitting ? <FormStatus>Saving project…</FormStatus> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={submitting || !updateProjectSchema.safeParse(patch()).success}
            >
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
