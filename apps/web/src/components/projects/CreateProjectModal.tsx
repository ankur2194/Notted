"use client";

import { createProjectSchema } from "@notted/shared-validators";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ProjectStatus } from "@notted/shared-types";

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
import { createProject } from "@/lib/projects/requests";

interface PendingSubmission {
  readonly fingerprint: string;
  readonly key: string;
}

export function CreateProjectModal({ workspaceId }: { readonly workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<PendingSubmission | null>(null);

  useEffect(() => {
    if (open) return;
    setName("");
    setDescription("");
    setColor("#3b82f6");
    setDueDate("");
    setStatus("active");
    setSubmitting(false);
    setError(null);
    pending.current = null;
  }, [open]);

  function candidate() {
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
    const parsed = createProjectSchema.safeParse(candidate());
    if (!parsed.success) {
      setError("Check the project name, color, status, and due date, then try again.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const fingerprint = JSON.stringify(parsed.data);
    if (pending.current?.fingerprint !== fingerprint) {
      pending.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    }
    const result = await createProject(workspaceId, parsed.data, pending.current.key);
    setSubmitting(false);
    if (!result.ok) {
      setError(
        result.kind === "forbidden-or-not-found"
          ? "Creation was denied. Your workspace access may have changed."
          : result.kind === "conflict"
            ? "This request conflicts with a recent project change. Review it and retry."
            : result.kind === "invalid"
              ? "The project details were not accepted. Review the fields and retry."
              : "The project could not be created. Check your connection and retry.",
      );
      return;
    }
    pending.current = null;
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
      <DialogTrigger asChild>
        <Button>Create project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a project</DialogTitle>
          <DialogDescription>
            Create a workspace project. Cover uploads are not available yet; its color is the
            reliable cover.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => void submit(event)}
          noValidate
          aria-busy={submitting}
        >
          <ProjectFields
            prefix="create-project"
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
          {submitting ? <FormStatus>Creating project…</FormStatus> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={submitting || !createProjectSchema.safeParse(candidate()).success}
            >
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
