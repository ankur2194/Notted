"use client";

import { exactByteLabel, formatBinaryBytes } from "@notted/shared-validators";
import { useEffect, useState } from "react";

import { useDialogFocusRestore } from "./useDialogFocusRestore";

import type { AttachmentEventDetail } from "./extensions/CustomAttachment";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AttachmentDeleteDialogProps {
  /** The card that asked to be deleted, or `null` when the dialog is closed. */
  readonly target: AttachmentEventDetail | null;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Deletes the stored attachment. Resolves `true` only when the **server**
   * confirmed it; the node is removed by the caller afterwards and never before.
   */
  readonly onConfirm: (target: AttachmentEventDetail) => Promise<boolean>;
}

const FAILURE_MESSAGE =
  "This file could not be deleted, so it is still attached to the note. Check your connection or your permissions and try again.";

/**
 * Confirmation for deleting a generic file attachment (Part 44).
 *
 * ## Why a confirmation exists here and not for an image
 *
 * Deleting an image node removes a *reference*; the attachment row survives and
 * Part 45's sweep reclaims it. Deleting an attachment card destroys the **only
 * copy of a file the writer uploaded** — a contract, a spreadsheet, a photo of a
 * whiteboard — and undo cannot bring those bytes back, because the object is
 * gone from storage. An irreversible destruction of user data is exactly the
 * case a confirmation is for.
 *
 * ## Server first, then the node
 *
 * The order is the whole design. If the node were removed first and the DELETE
 * then failed, the writer would see the card vanish, autosave would persist a
 * document without it, and the file would sit in storage referenced by nothing —
 * silently costing quota against a workspace that believes it deleted the file.
 * Deleting server-side first makes the failure *visible and harmless*: the card
 * stays, the note is unchanged, and the message says so.
 *
 * The reverse residue — the row is deleted but the document write fails — is the
 * benign direction: the card repaints as unavailable on the next load, and
 * nothing is lost that the writer did not ask to lose.
 *
 * `alert-dialog` is not among the available primitives, so this is the ordinary
 * modal `Dialog` with the destructive action carrying the initial focus target's
 * *sibling* position — Cancel is first in the tab order and the dialog closes on
 * Escape, so no keyboard user can destroy a file without passing the confirm
 * button deliberately.
 */
export function AttachmentDeleteDialog({
  target,
  onOpenChange,
  onConfirm,
}: AttachmentDeleteDialogProps) {
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = target !== null;

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setError(null);
  }, [open]);

  if (target === null) return null;

  const handleConfirm = (): void => {
    if (pending) return;
    setPending(true);
    setError(null);
    void onConfirm(target).then(
      (deleted) => {
        setPending(false);
        if (deleted) {
          onOpenChange(false);
          return;
        }
        // The card is deliberately still there. Saying so is the point.
        setError(FAILURE_MESSAGE);
      },
      () => {
        setPending(false);
        setError(FAILURE_MESSAGE);
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // A delete in flight must not be dismissed out from under itself.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this file?</DialogTitle>
          <DialogDescription>
            {target.name} ({formatBinaryBytes(target.sizeBytes)}) will be permanently deleted from
            this workspace and removed from this note. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {/* The exact size for assistive technology, matching the card itself. */}
        <p className="sr-only">{exactByteLabel(target.sizeBytes)}</p>
        {error === null ? null : (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 p-3 text-sm"
            data-testid="attachment-delete-error"
          >
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Keep file
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            data-testid="attachment-delete-confirm"
            onClick={handleConfirm}
          >
            {pending ? "Deleting…" : "Delete file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
