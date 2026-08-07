import { fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

import type { AttachmentFilePickerRequest } from "@/components/editor/extensions/CustomAttachment";
import type { ImageFilePickerRequest } from "@/components/editor/extensions/CustomImage";
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
  readonly pressKey: (key: string, options?: ShortcutModifiers) => void;
  /**
   * Dispatch a whole declared binding straight at the ProseMirror surface.
   *
   * Same reasoning as `pressKey`, and required for anything that needs a
   * `NodeSelection` to survive until the key lands: `userEvent.keyboard`'s focus
   * bookkeeping makes jsdom emit a `selectionchange`, ProseMirror reads it back,
   * and a programmatically selected node becomes a collapsed text selection
   * before the shortcut ever runs. Part 43's image resize bindings are exactly
   * that case.
   */
  readonly pressBinding: (binding: string) => void;
  /**
   * Every file-picker request the editor made (Part 42), newest last.
   *
   * The harness always supplies an `onRequestImageFiles` handler, because the
   * `/image` command and the "Insert image" toolbar button are *only* observable
   * through it: they deliberately insert nothing into the document, so without
   * this spy a test could not tell "asked the host to open the picker" apart
   * from "did nothing at all". A caller's own handler still runs afterwards.
   */
  readonly imageFileRequests: readonly ImageFilePickerRequest[];
  /**
   * Every generic-file picker request the editor made (Part 44), newest last.
   *
   * The exact counterpart of `imageFileRequests`, and it exists for the exact
   * same reason: `/attachment` and the "Attach file" toolbar button insert
   * nothing into the document by design, so without this spy a test cannot tell
   * "asked the host to open the picker" apart from "did nothing at all".
   */
  readonly attachmentFileRequests: readonly AttachmentFilePickerRequest[];
}

/** Render the real editor and wait for the deferred ProseMirror instance. */
export async function renderEditor(props: Partial<TiptapEditorProps> = {}): Promise<EditorHarness> {
  const holder: { instance: Editor | null } = { instance: null };
  const user = userEvent.setup();
  const imageFileRequests: ImageFilePickerRequest[] = [];
  const attachmentFileRequests: AttachmentFilePickerRequest[] = [];
  const { onEditorReady, onRequestImageFiles, onRequestAttachmentFiles, ...rest } = props;
  const utils = render(
    <TiptapEditor
      noteId={NOTE_ID}
      initialDocument={HELLO_DOCUMENT}
      editable
      {...rest}
      onRequestImageFiles={(request) => {
        imageFileRequests.push(request);
        onRequestImageFiles?.(request);
      }}
      onRequestAttachmentFiles={(request) => {
        attachmentFileRequests.push(request);
        onRequestAttachmentFiles?.(request);
      }}
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
    imageFileRequests,
    attachmentFileRequests,
    focusEditor: () => {
      (editor.view.dom as HTMLElement).focus();
    },
    select: (from: number, to: number) => {
      editor.commands.setTextSelection({ from, to });
    },
    pressKey: (key: string, options?: ShortcutModifiers) => {
      fireEvent.keyDown(editor.view.dom, {
        key,
        shiftKey: options?.shiftKey ?? false,
        ctrlKey: options?.ctrlKey ?? false,
        metaKey: options?.metaKey ?? false,
        altKey: options?.altKey ?? false,
      });
    },
    pressBinding: (binding: string) => {
      const tokens = splitShortcutBinding(binding);
      const key = tokens[tokens.length - 1];
      if (key === undefined) throw new Error(`empty binding: ${binding}`);
      const modifiers = new Set(tokens.slice(0, -1));
      fireEvent.keyDown(editor.view.dom, {
        key,
        shiftKey: modifiers.has("Shift"),
        // jsdom reports a non-Apple platform, so ProseMirror resolves `Mod` to
        // Control — the same assumption `MODIFIER_KEY_NAMES` encodes.
        ctrlKey: modifiers.has("Mod") || modifiers.has("Ctrl") || modifiers.has("Control"),
        metaKey: modifiers.has("Cmd") || modifiers.has("Meta"),
        altKey: modifiers.has("Alt"),
      });
    },
  };
}

export interface ShortcutModifiers {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
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

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  // Part 43's image resize bindings end in an arrow key. Without these,
  // `userEvent.keyboard` would type the literal text "ArrowRight".
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

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
