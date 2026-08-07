"use client";

import { NOTE_DOCUMENT_LIMITS } from "@notted/shared-validators";
import { useEffect, useId, useState } from "react";

import { useDialogFocusRestore } from "./useDialogFocusRestore";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-controls";

export interface ImageAltTextDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Alt text currently stored on the selected image. */
  readonly initialAlt: string;
  /** Returns false when the value was rejected; the dialog then stays open. */
  readonly onApply: (alt: string) => boolean;
}

const REJECTION_MESSAGE =
  "That alternative text could not be saved. Remove any line breaks or control characters and try again.";

/**
 * Editor for an image's text alternative — the deliverable Part 42 carried
 * forward, and the largest accessibility gap it left open.
 *
 * Part 42 seeds `alt` from the uploaded filename, which is a weak alternative
 * but at least author-supplied text about that image; defaulting to `""` instead
 * would have marked every uploaded image *decorative* and failed WCAG 1.1.1
 * outright. This dialog is the remedy, and it is why it must make the two
 * choices genuinely equal:
 *
 * - a description, for an image that carries information; or
 * - an **empty** value, which is the correct and standards-blessed way to mark a
 *   purely decorative image (`alt=""`). The shared contract stores `""`
 *   verbatim, so clearing the field is a real, durable decision — not a missing
 *   value the next save will helpfully re-fill.
 *
 * Nothing here forces a non-empty value, and the copy says so.
 */
export function ImageAltTextDialog({
  open,
  onOpenChange,
  initialAlt,
  onApply,
}: ImageAltTextDialogProps) {
  const fieldId = useId();
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();
  const [alt, setAlt] = useState(initialAlt);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setAlt(initialAlt);
    setError(undefined);
  }, [open, initialAlt]);

  const remaining = NOTE_DOCUMENT_LIMITS.maxImageAlt - alt.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Image alternative text</DialogTitle>
          <DialogDescription>
            Describe what the image shows, for readers who cannot see it. If the image is purely
            decorative and adds no information, leave this empty — that is a valid choice and it
            tells screen readers to skip the image.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!onApply(alt)) {
              setError(REJECTION_MESSAGE);
              return;
            }
            setError(undefined);
            onOpenChange(false);
          }}
        >
          <FormField
            id={`${fieldId}-alt`}
            label="Alternative text"
            type="text"
            autoComplete="off"
            maxLength={NOTE_DOCUMENT_LIMITS.maxImageAlt}
            value={alt}
            error={error}
            hint={`${remaining} characters remaining. Leave empty to mark the image decorative.`}
            onChange={(event) => setAlt(event.target.value)}
          />
          <DialogFooter className="gap-2">
            {alt.length === 0 ? null : (
              <Button type="button" variant="outline" onClick={() => setAlt("")}>
                Mark as decorative
              </Button>
            )}
            <Button type="submit">Save alternative text</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
