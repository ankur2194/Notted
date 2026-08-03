import { fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

import type { NoteDocument } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";

import { splitShortcutBinding } from "@/components/editor/keyboard-shortcuts";
import { TiptapEditor, type TiptapEditorProps } from "@/components/editor/TiptapEditor";

export const NOTE_ID = "30000000-0000-4000-8000-000000000009";

export const HELLO_DOCUMENT: NoteDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
};

export function paragraphDocument(text: string): NoteDocument {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

export interface EditorHarness extends RenderResult {
  readonly editor: Editor;
  readonly user: ReturnType<typeof userEvent.setup>;
  /** Focus the ProseMirror surface so real key events reach the keymap. */
  readonly focusEditor: () => void;
  readonly select: (from: number, to: number) => void;
  /**
   * Dispatch a keydown straight at the ProseMirror surface.
   *
   * `userEvent.keyboard` performs its own focus bookkeeping between key
   * presses, which makes jsdom emit a `selectionchange` that ProseMirror reads
   * back — collapsing a programmatically placed caret to the document start.
   * That is harmless inside a single text block but destroys a caret placed in
   * a specific table cell, so tests that need an exact starting selection
   * dispatch the key event directly. It is still a real DOM keydown running the
   * real keymap; only user-event's focus emulation is bypassed.
   */
  readonly pressKey: (key: string, options?: { readonly shiftKey?: boolean }) => void;
}

/** Render the real editor and wait for the deferred ProseMirror instance. */
export async function renderEditor(props: Partial<TiptapEditorProps> = {}): Promise<EditorHarness> {
  const holder: { instance: Editor | null } = { instance: null };
  const user = userEvent.setup();
  const { onEditorReady, ...rest } = props;
  const utils = render(
    <TiptapEditor
      noteId={NOTE_ID}
      initialDocument={HELLO_DOCUMENT}
      editable
      {...rest}
      onEditorReady={(instance) => {
        if (instance !== null) holder.instance = instance;
        onEditorReady?.(instance);
      }}
    />,
  );
  await waitFor(() => expect(holder.instance).not.toBeNull());
  const editor = holder.instance;
  if (editor === null) throw new Error("editor was not created");
  return {
    ...utils,
    editor,
    user,
    focusEditor: () => {
      (editor.view.dom as HTMLElement).focus();
    },
    select: (from: number, to: number) => {
      editor.commands.setTextSelection({ from, to });
    },
    pressKey: (key: string, options?: { readonly shiftKey?: boolean }) => {
      fireEvent.keyDown(editor.view.dom, { key, shiftKey: options?.shiftKey ?? false });
    },
  };
}

const MODIFIER_KEY_NAMES: Readonly<Record<string, string>> = {
  // jsdom reports a non-Apple platform, so ProseMirror resolves `Mod` to Control.
  Mod: "Control",
  Ctrl: "Control",
  Control: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Cmd: "Meta",
  Meta: "Meta",
};

const NAMED_KEYS: ReadonlySet<string> = new Set(["Enter", "Tab", "Escape", "Backspace"]);

/**
 * Translate a declared binding into a `userEvent.keyboard` sequence so tests
 * press exactly the keys the shortcut table advertises.
 */
export function userEventKeysFor(binding: string): string {
  const tokens = splitShortcutBinding(binding);
  const key = tokens[tokens.length - 1];
  if (key === undefined) throw new Error(`empty binding: ${binding}`);
  const modifiers = tokens.slice(0, -1).map((token) => MODIFIER_KEY_NAMES[token] ?? token);
  const open = modifiers.map((name) => `{${name}>}`).join("");
  const close = [...modifiers]
    .reverse()
    .map((name) => `{/${name}}`)
    .join("");
  const pressed = NAMED_KEYS.has(key) ? `{${key}}` : key;
  return `${open}${pressed}${close}`;
}

/** Mark type names on the first text node of the document. */
export function firstTextMarkNames(editor: Editor): readonly string[] {
  const first = editor.state.doc.firstChild?.firstChild;
  return first === null || first === undefined ? [] : first.marks.map((mark) => mark.type.name);
}
