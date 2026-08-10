"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { NoteType } from "@notted/shared-types";

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
import { updateNote } from "@/lib/notes/requests";

/**
 * Switches a note between `document` and `task-list`, in both directions.
 *
 * The conversion is a metadata flip and nothing else: TipTap content stays on
 * the row untouched, so the confirmation says so plainly rather than using the
 * usual destructive-action wording. `expectedVersion` means a conversion racing
 * an autosave loses instead of overwriting it.
 */
export function ConvertNoteTypeControl({
  workspaceId,
  noteId,
  noteTitle,
  type,
  version,
}: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly noteTitle: string;
  readonly type: NoteType;
  readonly version: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const next: NoteType = type === "task-list" ? "document" : "task-list";
  const action = next === "task-list" ? "Convert to task list" : "Convert to document";

  async function convert(): Promise<void> {
    setPending(true);
    setError(null);
    setStatus(`Converting ${noteTitle}…`);
    const result = await updateNote(workspaceId, noteId, { expectedVersion: version, type: next });
    setPending(false);
    if (!result.ok) {
      setStatus("");
      setError(
        result.kind === "version-conflict"
          ? "This note was saved by someone else while the dialog was open. Nothing was converted or lost; reload and retry."
          : result.kind === "forbidden-or-not-found"
            ? "Converting was denied or the note is no longer available. Nothing was changed."
            : "The conversion could not reach Notted. Nothing was changed; check your connection and retry.",
      );
      return;
    }
    setOpen(false);
    setStatus(
      next === "task-list"
        ? `${noteTitle} is now a task list. Its page content is unchanged.`
        : `${noteTitle} is now a document. Its tasks are kept and reappear if it is converted back.`,
    );
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Dialog open={open} onOpenChange={(value) => !pending && setOpen(value)}>
        <DialogTrigger asChild>
          <Button type="button" size="sm" variant="outline">
            {action}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action}</DialogTitle>
            <DialogDescription>
              Nothing is deleted. The page editor and everything written in it stay exactly as they
              are, and any tasks already attached to this note are kept.{" "}
              {next === "task-list"
                ? "A task list is added below the page."
                : "The task list is hidden below the page; converting back shows the same tasks again."}{" "}
              You can convert back at any time.
            </DialogDescription>
          </DialogHeader>
          {error === null ? null : <ErrorSummary message={error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" disabled={pending} onClick={() => void convert()}>
              {pending ? "Converting…" : action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
