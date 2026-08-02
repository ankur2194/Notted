"use client";

import { createNoteSchema } from "@notted/shared-validators";
import { useEffect, useRef, useState } from "react";

import type { NoteType } from "@notted/shared-types";
import type { CreateNoteInput } from "@notted/shared-validators";

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
import { ErrorSummary } from "@/components/ui/form-controls";

interface StableSubmission {
  readonly fingerprint: string;
  readonly key: string;
}

export function CreateNoteDialog({
  destination,
  templateByDefault = false,
  pinnedByDefault = false,
  disabled = false,
  onCreate,
}: {
  readonly destination: {
    readonly projectId: string | null;
    readonly folderId: string | null;
    readonly parentId: string | null;
  };
  readonly templateByDefault?: boolean;
  readonly pinnedByDefault?: boolean;
  readonly disabled?: boolean;
  readonly onCreate: (input: CreateNoteInput, idempotencyKey: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<NoteType>("document");
  const [isTemplate, setTemplate] = useState(templateByDefault);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<StableSubmission | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setTitle("");
    setType("document");
    setTemplate(templateByDefault);
    setError(null);
    setPending(false);
    submission.current = null;
  }, [open, templateByDefault]);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, [open]);

  const candidate = (): CreateNoteInput => ({
    title: title.trim(),
    type,
    isTemplate,
    isPinned: pinnedByDefault,
    projectId: destination.projectId,
    folderId: destination.folderId,
    parentId: destination.parentId,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>Create note</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create note</DialogTitle>
          <DialogDescription>
            The new note appears immediately and is reconciled with the saved server result.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = createNoteSchema.safeParse(candidate());
            if (!parsed.success) {
              setError("Enter a title and choose valid note options.");
              return;
            }
            const fingerprint = JSON.stringify(parsed.data);
            if (submission.current?.fingerprint !== fingerprint) {
              submission.current = { fingerprint, key: globalThis.crypto.randomUUID() };
            }
            setPending(true);
            setError(null);
            // The note appears immediately in the list, so the dialog closes
            // right away instead of blocking on the network result.
            setOpen(false);
            void onCreate(parsed.data, submission.current.key).then((ok) => {
              setPending(false);
              if (ok) {
                submission.current = null;
              } else
                setError(
                  "The note was not created. Your previous list was restored; review the status message and retry.",
                );
            });
          }}
        >
          <div className="space-y-2">
            <label htmlFor="create-note-title" className="text-sm font-medium">
              Title
            </label>
            <input
              id="create-note-title"
              ref={titleInputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={500}
              disabled={pending}
              className="min-h-11 w-full rounded-md border bg-background px-3"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="create-note-type" className="text-sm font-medium">
              Type
            </label>
            <select
              id="create-note-type"
              value={type}
              onChange={(event) => setType(event.target.value as NoteType)}
              disabled={pending}
              className="min-h-11 w-full rounded-md border bg-background px-3"
            >
              <option value="document">Document</option>
              <option value="task-list">Task list</option>
            </select>
          </div>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={isTemplate}
              onChange={(event) => setTemplate(event.target.checked)}
              disabled={pending}
            />{" "}
            Save as a template
          </label>
          {error === null ? null : <ErrorSummary message={error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={pending || !createNoteSchema.safeParse(candidate()).success}
            >
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
