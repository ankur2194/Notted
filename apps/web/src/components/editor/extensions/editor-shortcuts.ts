import { Extension } from "@tiptap/core";

import { editorScopedNottedShortcuts, type EditorShortcutHandlerId } from "../keyboard-shortcuts";

/** Handlers the host component supplies for bindings that drive React UI. */
export type EditorShortcutHandlerMap = Partial<Record<EditorShortcutHandlerId, () => boolean>>;

export interface EditorShortcutsOptions {
  /**
   * Resolved at keypress time rather than captured at construction time so
   * React state changes never require rebuilding the editor instance.
   */
  readonly resolveHandlers: () => EditorShortcutHandlerMap;
}

/**
 * Registers the editor-scoped bindings TipTap does not provide by default.
 * The binding strings come from `keyboard-shortcuts.ts`, so the help dialog and
 * the live keymap always describe the same keys.
 *
 * Part 35/36 seam: declare the new shortcut in `EDITOR_SHORTCUTS` with
 * `source: "notted"` and a `handler` id, then supply that handler through
 * `resolveHandlers`.
 */
export const EditorShortcuts = Extension.create<EditorShortcutsOptions>({
  name: "nottedEditorShortcuts",

  addOptions() {
    return { resolveHandlers: (): EditorShortcutHandlerMap => ({}) };
  },

  addKeyboardShortcuts() {
    const bindings: Record<string, () => boolean> = {};
    for (const shortcut of editorScopedNottedShortcuts()) {
      const handlerId = shortcut.handler;
      if (handlerId === null) continue;
      bindings[shortcut.binding] = (): boolean => {
        const handler = this.options.resolveHandlers()[handlerId];
        return handler === undefined ? false : handler();
      };
    }
    return bindings;
  },
});
