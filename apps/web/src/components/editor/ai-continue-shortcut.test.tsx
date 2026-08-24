import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  editorScopedNottedShortcuts,
  editorShortcutById,
  editorShortcutBinding,
} from "./keyboard-shortcuts";

import type { Editor } from "@tiptap/core";

import { setAiContinueHandler } from "@/lib/ai/continue-request";
import { renderEditor } from "@/test/editor-harness";

/*
 * Part 68. `Mod-Enter` is the one Notted binding that lands on a key StarterKit
 * already claims: `@tiptap/extension-hard-break` binds `Mod-Enter` to
 * `setHardBreak()`. Notted wins by EXTENSION ORDER — `ExtensionManager`'s
 * `get plugins()` reverses the extension array before building each `keymap()`
 * plugin, and `EditorShortcuts` is appended last in `TiptapEditor.tsx`, so its
 * keymap plugin is first in `state.plugins` and ProseMirror offers it the key
 * first. These tests pin BOTH halves of that: the win, and the fall-through
 * when no panel is registered.
 */

/*
 * The handler lives in a module-scoped store shared by every test in the
 * process, so it is returned to "no panel mounted" after each one — exactly what
 * the real panel does when it unmounts.
 */
afterEach(() => {
  act(() => {
    setAiContinueHandler(null);
  });
});

function hardBreakCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "hardBreak") count += 1;
  });
  return count;
}

describe("aiContinue shortcut registry", () => {
  it("declares Mod-Enter as an editor-scoped Notted binding", () => {
    const shortcut = editorShortcutById("aiContinue");
    expect(shortcut).toBeDefined();
    expect(shortcut?.binding).toBe("Mod-Enter");
    expect(shortcut?.scope).toBe("editor");
    expect(shortcut?.source).toBe("notted");
    expect(shortcut?.handler).toBe("requestAiContinue");
    expect(editorShortcutBinding("aiContinue")).toBe("Mod-Enter");
  });

  it("is registered on the Notted keymap rather than left as documentation", () => {
    const ids = editorScopedNottedShortcuts().map((shortcut) => shortcut.id);
    expect(ids).toContain("aiContinue");
  });
});

describe("Mod-Enter in the editor", () => {
  it("reaches the AI panel and inserts no hard break", async () => {
    const handler = vi.fn(() => true);
    const { editor, focusEditor, pressBinding } = await renderEditor();
    act(() => {
      setAiContinueHandler(handler);
    });

    const before: unknown = editor.getJSON();
    focusEditor();
    pressBinding("Mod-Enter");

    expect(handler).toHaveBeenCalledTimes(1);
    // The document is byte-identical: the Notted keymap ran first and reported
    // the key handled, so HardBreak's own `Mod-Enter` binding never saw it.
    expect(editor.getJSON()).toEqual(before);
    expect(hardBreakCount(editor)).toBe(0);
  });

  it("falls through to HardBreak when no panel is registered", async () => {
    const { editor, focusEditor, pressBinding } = await renderEditor();
    expect(hardBreakCount(editor)).toBe(0);

    focusEditor();
    pressBinding("Mod-Enter");

    // `requestAiContinue()` returned false with nothing registered, ProseMirror
    // treated the key as unhandled, and the next keymap plugin — StarterKit's
    // HardBreak — inserted the break exactly as it did before Part 68.
    expect(hardBreakCount(editor)).toBe(1);
  });

  /*
   * WHAT THIS DOES AND DOES NOT PROVE. It pins the user-visible guarantee — a
   * reader pressing Mod-Enter on a note they cannot edit neither generates nor
   * changes the document — and that guarantee holds through TWO independent
   * gates. The one that actually fires here is prosemirror-view's: it dispatches
   * `keydown` to the editor's handlers only while `view.editable` is true, so
   * the Notted keymap is never consulted at all.
   *
   * The `editableRef.current` check in `TiptapEditor`'s `requestAiContinue`
   * handler is therefore belt-and-braces, and deleting it would NOT fail this
   * test. It stays because the handler map is reachable from anything the host
   * wires into `resolveHandlers`, not only from a keypress on an editable view.
   */
  it("does not reach the AI panel while the note is read only", async () => {
    const handler = vi.fn(() => true);
    const { editor, focusEditor, pressBinding } = await renderEditor({ editable: false });
    act(() => {
      setAiContinueHandler(handler);
    });

    const before: unknown = editor.getJSON();
    focusEditor();
    pressBinding("Mod-Enter");

    expect(handler).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
    expect(hardBreakCount(editor)).toBe(0);
  });
});
