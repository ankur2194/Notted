"use client";

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

export interface LinkDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialHref: string;
  readonly hasLink: boolean;
  /** Returns false when the URL was rejected by the shared sanitizer. */
  readonly onApply: (href: string) => boolean;
  readonly onRemove: () => void;
}

const REJECTION_MESSAGE =
  "That link was rejected. Use an http, https, mailto, or tel address without credentials.";

/**
 * Accessible replacement for `window.prompt`. The URL is only applied when the
 * shared contract's sanitizer accepts it; rejected values surface inline and
 * never reach the document.
 */
export function LinkDialog({
  open,
  onOpenChange,
  initialHref,
  hasLink,
  onApply,
  onRemove,
}: LinkDialogProps) {
  const fieldId = useId();
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();
  const [href, setHref] = useState(initialHref);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setHref(initialHref);
    setError(undefined);
  }, [open, initialHref]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{hasLink ? "Edit link" : "Insert link"}</DialogTitle>
          <DialogDescription>
            Links are stored with a safe rel and open in a new tab. Only http, https, mailto, and
            tel addresses are accepted.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!onApply(href)) {
              setError(REJECTION_MESSAGE);
              return;
            }
            setError(undefined);
            onOpenChange(false);
          }}
        >
          <FormField
            id={`${fieldId}-href`}
            label="Link address"
            type="text"
            inputMode="url"
            autoComplete="off"
            value={href}
            error={error}
            onChange={(event) => setHref(event.target.value)}
          />
          <DialogFooter className="gap-2">
            {hasLink ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onRemove();
                  onOpenChange(false);
                }}
              >
                Remove link
              </Button>
            ) : null}
            <Button type="submit">{hasLink ? "Update link" : "Add link"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
