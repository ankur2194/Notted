"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import type { NoteSummary } from "@notted/shared-types";

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

export function NoteLifecycleActions({
  note,
  pending,
  onTrash,
  onRestore,
  onPermanentDelete,
}: {
  readonly note: NoteSummary;
  readonly pending: boolean;
  readonly onTrash: () => void;
  readonly onRestore: () => void;
  readonly onPermanentDelete: () => void;
}) {
  const [trashOpen, setTrashOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmationTitle, setConfirmationTitle] = useState("");
  if (note.isDeleted) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRestore}>
          <RotateCcw aria-hidden="true" className="size-4" />
          {pending ? "Restoring…" : "Restore"}
        </Button>
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!pending) {
              setDeleteOpen(open);
              if (!open) setConfirmationTitle("");
            }
          }}
        >
          <DialogTrigger asChild>
            <Button type="button" size="sm" variant="destructive" disabled={pending}>
              <Trash2 aria-hidden="true" className="size-4" />
              Delete permanently
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Permanently delete “{note.title}”?</DialogTitle>
              <DialogDescription>
                This permanently removes only an entirely deleted subtree. It cannot be undone. Type
                the exact note title to confirm.
              </DialogDescription>
            </DialogHeader>
            <label className="space-y-2 text-sm">
              <span>Note title</span>
              <input
                value={confirmationTitle}
                onChange={(event) => setConfirmationTitle(event.target.value)}
                autoComplete="off"
                className="min-h-11 w-full rounded-md border bg-background px-3"
              />
            </label>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={pending || confirmationTitle !== note.title}
                onClick={onPermanentDelete}
              >
                {pending ? "Deleting…" : "Delete permanently"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }
  return (
    <Dialog open={trashOpen} onOpenChange={(open) => !pending && setTrashOpen(open)}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={pending}>
          <Trash2 aria-hidden="true" className="size-4" />
          Move to trash
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{note.title}” to trash?</DialogTitle>
          <DialogDescription>
            The note and its nested notes leave normal views. They can be restored from Trash.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={onTrash}>
            {pending ? "Moving…" : "Move to trash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
