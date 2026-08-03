"use client";

import { TABLE_ACTIONS } from "./toolbar-commands";
import { useDialogFocusRestore } from "./useDialogFocusRestore";

import type { Editor } from "@tiptap/core";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface TableMenuDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly editor: Editor | null;
}

/**
 * Table operations as a dialog rather than a dozen toolbar buttons.
 *
 * A single toolbar control keeps the toolbar from overflowing on narrow
 * screens, and every operation stays a real button — reachable with Tab and
 * announced with its own name — instead of a hover-only affordance. Operations
 * that cannot apply to the current selection are disabled rather than removed
 * so their position never shifts under the keyboard focus.
 *
 * Choosing an action closes the dialog and returns focus to the toolbar button,
 * matching the colour and link dialogs; a sequence of table edits therefore
 * reopens the menu each time rather than leaving a modal over the document.
 */
export function TableMenuDialog({ open, onOpenChange, editor }: TableMenuDialogProps) {
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Table</DialogTitle>
          <DialogDescription>
            Insert a table, or change the rows, columns, cells, and column width of the table
            containing the cursor.
          </DialogDescription>
        </DialogHeader>
        <div role="group" aria-label="Table actions" className="grid grid-cols-2 gap-2">
          {/*
           * Only probe availability while the dialog is open. `EditorToolbar`
           * re-renders on every transaction, and each probe runs a dry-run
           * command — five of them walk the whole document to count cells — so
           * evaluating this list on every keystroke is pure waste.
           */}
          {!open
            ? null
            : TABLE_ACTIONS.map((action) => {
                const unavailable = editor === null || !action.isAvailable(editor);
                return (
                  <button
                    key={action.id}
                    type="button"
                    data-table-action={action.id}
                    disabled={unavailable}
                    onClick={() => {
                      if (editor === null || unavailable) return;
                      action.run(editor);
                      onOpenChange(false);
                    }}
                    className="min-h-11 rounded-md border border-input px-3 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {action.label}
                  </button>
                );
              })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
