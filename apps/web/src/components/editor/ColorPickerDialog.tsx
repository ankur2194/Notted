"use client";

import { useDialogFocusRestore } from "./useDialogFocusRestore";

import type { EditorColorOption } from "./editor-colors";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ColorPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly options: readonly EditorColorOption[];
  readonly value: string | null;
  readonly clearLabel: string;
  readonly onSelect: (color: string) => void;
  readonly onClear: () => void;
}

/**
 * Bounded swatch picker. An unconstrained colour input could emit values the
 * shared document contract rejects, so only palette entries are offered and the
 * caller validates the chosen value again before applying it.
 */
export function ColorPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  options,
  value,
  clearLabel,
  onSelect,
  onClear,
}: ColorPickerDialogProps) {
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div role="group" aria-label={title} className="flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              title={option.label}
              aria-pressed={value === option.value}
              onClick={() => {
                onSelect(option.value);
                onOpenChange(false);
              }}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input hover:bg-accent aria-pressed:ring-2 aria-pressed:ring-ring"
            >
              <span
                aria-hidden="true"
                className="size-6 rounded-sm border border-black/10"
                style={{ backgroundColor: option.value }}
              />
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onClear();
              onOpenChange(false);
            }}
          >
            {clearLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
