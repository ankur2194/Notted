"use client";

import { useEffect, useMemo } from "react";

import {
  EDITOR_SHORTCUT_GROUPS,
  describeShortcutKeys,
  editorShortcutsForGroup,
  formatShortcutKeys,
  globalShortcuts,
  isApplePlatform,
  isBareKeyBinding,
  matchesShortcutBinding,
} from "./keyboard-shortcuts";
import { useDialogFocusRestore } from "./useDialogFocusRestore";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  return target.closest('[contenteditable="true"], [contenteditable=""]') !== null;
}

export interface KeyboardShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Renders every binding declared in `keyboard-shortcuts.ts` and owns the
 * document-level listeners for the `scope: "global"` bindings, so the dialog
 * can be opened from anywhere on the page — including from inside the editor
 * for the modifier-based binding.
 */
export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  const apple = useMemo(() => isApplePlatform(), []);
  const { contentRef, onCloseAutoFocus } = useDialogFocusRestore();

  useEffect(() => {
    const bindings = globalShortcuts();
    const handleKeyDown = (event: KeyboardEvent): void => {
      for (const shortcut of bindings) {
        // A bare key such as `?` must never steal a keystroke from a field the
        // user is typing in, including the editor's contenteditable surface.
        if (isBareKeyBinding(shortcut.binding) && isTextEntryTarget(event.target)) continue;
        if (!matchesShortcutBinding(shortcut.binding, event, apple)) continue;
        event.preventDefault();
        onOpenChange(true);
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [apple, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={contentRef} onCloseAutoFocus={onCloseAutoFocus} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every binding the note editor responds to. Press Escape to close.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          {EDITOR_SHORTCUT_GROUPS.map((group) => {
            const shortcuts = editorShortcutsForGroup(group.id);
            if (shortcuts.length === 0) return null;
            return (
              <section key={group.id} aria-labelledby={`shortcut-group-${group.id}`}>
                <h3 id={`shortcut-group-${group.id}`} className="mb-2 font-medium">
                  {group.label}
                </h3>
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                      data-shortcut-id={shortcut.id}
                    >
                      <dt>{shortcut.description}</dt>
                      <dd className="shrink-0">
                        <span className="sr-only">
                          {describeShortcutKeys(shortcut.binding, apple)}
                        </span>
                        <span aria-hidden="true" className="flex items-center gap-1">
                          {formatShortcutKeys(shortcut.binding, apple).map((token, index) => (
                            <kbd
                              key={`${shortcut.id}-${String(index)}`}
                              className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
                            >
                              {token}
                            </kbd>
                          ))}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
