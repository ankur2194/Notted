import { safeParseNoteDocument } from "@notted/shared-validators";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { editorShortcutBinding } from "./keyboard-shortcuts";
import { EDITOR_TOOLBAR_GROUPS, FOCUS_TOOLBAR_GROUPS } from "./toolbar-commands";

import type { Editor } from "@tiptap/core";

import { PAGE_BREAK_CLASS, PAGE_BREAK_NODE_NAME } from "@/components/editor/extensions/page-break";
import { FOCUS_MODE_ATTRIBUTE, isFocusModeEnabled, setFocusMode } from "@/lib/notes/focus-mode";
import { paragraphDocument, renderEditor, userEventKeysFor } from "@/test/editor-harness";

afterEach(() => {
  setFocusMode(false);
});

function nodeTypes(editor: Editor): readonly string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
    return true;
  });
  return types;
}

function breakCount(editor: Editor): number {
  return nodeTypes(editor).filter((type) => type === PAGE_BREAK_NODE_NAME).length;
}

describe("page break node", () => {
  it("inserts a contract-valid, attribute-free leaf from the declared binding", async () => {
    const { editor, user, focusEditor } = await renderEditor({
      initialDocument: paragraphDocument("hello world"),
    });
    editor.commands.setTextSelection(6);
    focusEditor();
    await user.keyboard(userEventKeysFor(editorShortcutBinding("pageBreak")));

    expect(breakCount(editor)).toBe(1);
    const json = editor.getJSON();
    const parsed = safeParseNoteDocument(json);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(json)).toContain('{"type":"pageBreak"}');
  });

  it("splits the block it is inserted into without losing text", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    editor.commands.setTextSelection(6);
    expect(editor.chain().focus().setPageBreak().run()).toBe(true);

    expect(nodeTypes(editor).filter((type) => type !== "text")).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
    expect(editor.state.doc.textContent).toBe("hello world");
  });

  it("keeps a block to type into when the break lands at the end of the document", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphDocument("tail") });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.chain().focus().setPageBreak().run();

    // A document that ends on an atom has nowhere to put the caret.
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("leaves the caret past the break so the next keystroke cannot replace it", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphDocument("before") });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.chain().focus().setPageBreak().run();

    // A selectable atom is left *selected* by `insertContent`, so without an
    // explicit caret move the next typed character replaces the break the writer
    // just asked for. Found in Chromium, where the character is actually typed;
    // this is the regression guard.
    expect(editor.state.selection.empty).toBe(true);

    editor.commands.insertContent("after");

    const types: string[] = [];
    editor.state.doc.forEach((child) => types.push(child.type.name));
    expect(types).toContain(PAGE_BREAK_NODE_NAME);
    expect(editor.getText()).toContain("before");
    expect(editor.getText()).toContain("after");
  });

  it("round-trips through the shared contract and back into the editor unchanged", async () => {
    const stored = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Cover" }] },
        { type: "pageBreak" },
        { type: "paragraph", content: [{ type: "text", text: "Appendix" }] },
      ],
    };
    const { editor } = await renderEditor({ initialDocument: stored });

    expect(breakCount(editor)).toBe(1);
    const output = editor.getJSON();
    expect(safeParseNoteDocument(output).success).toBe(true);
    // The paragraphs come back carrying the editor's declared `textAlign`
    // default; the break itself must survive as the bare leaf the contract
    // accepts, with no attributes invented on the way through.
    const roundTripped = editor.state.doc.child(1);
    expect(roundTripped.type.name).toBe(PAGE_BREAK_NODE_NAME);
    expect(roundTripped.toJSON()).toEqual({ type: "pageBreak" });
    expect(editor.state.doc.textContent).toBe("CoverAppendix");
  });

  it("undoes and redoes as a single step", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    editor.commands.setTextSelection(6);
    editor.chain().focus().setPageBreak().run();
    expect(breakCount(editor)).toBe(1);

    editor.commands.undo();
    expect(breakCount(editor)).toBe(0);
    expect(editor.state.doc.textContent).toBe("hello world");

    editor.commands.redo();
    expect(breakCount(editor)).toBe(1);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("renders a named separator distinguishable from a horizontal rule", async () => {
    const { container } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "paragraph" }, { type: "pageBreak" }, { type: "horizontalRule" }],
      },
    });

    const element = container.querySelector(`.${PAGE_BREAK_CLASS}`);
    expect(element).not.toBeNull();
    expect(element?.tagName).toBe("DIV");
    expect(element).toHaveAttribute("role", "separator");
    expect(element).toHaveAttribute("aria-label", "Page break");
    // Never an `hr`: `break-after: page` on a block box is unambiguous, and the
    // divider already owns the thematic-separator semantic.
    expect(container.querySelector("hr")).not.toHaveClass(PAGE_BREAK_CLASS);
  });

  it("is never inserted into a read-only note", async () => {
    const { editor, user, focusEditor } = await renderEditor({
      editable: false,
      initialDocument: paragraphDocument("read only note"),
    });
    focusEditor();
    await user.keyboard(userEventKeysFor(editorShortcutBinding("pageBreak")));
    expect(breakCount(editor)).toBe(0);
  });
});

describe("focus mode from the editor", () => {
  it("toggles the document attribute with the declared binding", async () => {
    const { user, focusEditor } = await renderEditor();
    const keys = userEventKeysFor(editorShortcutBinding("focusMode"));

    focusEditor();
    await user.keyboard(keys);
    expect(isFocusModeEnabled()).toBe(true);
    expect(document.documentElement.getAttribute(FOCUS_MODE_ATTRIBUTE)).toBe("true");

    await user.keyboard(keys);
    expect(isFocusModeEnabled()).toBe(false);
    expect(document.documentElement.getAttribute(FOCUS_MODE_ATTRIBUTE)).toBeNull();
  });

  it("is not reachable through the editor keymap on a read-only note", async () => {
    // ProseMirror only runs its edit handlers — `keydown` among them — while the
    // view is editable, so no editor-scoped binding fires on a read-only note.
    // Focus mode stays available there through `PageContainer`'s toggle button,
    // which is covered in `page-container.test.tsx`.
    const { user, focusEditor } = await renderEditor({
      editable: false,
      initialDocument: paragraphDocument("read only note"),
    });
    focusEditor();
    await user.keyboard(userEventKeysFor(editorShortcutBinding("focusMode")));
    expect(isFocusModeEnabled()).toBe(false);
  });

  it("swaps the full toolbar for the derived minimal one without forking it", async () => {
    const { user, focusEditor } = await renderEditor();
    const toolbar = screen.getByRole("toolbar", { name: "Note formatting" });
    const fullGroups = within(toolbar).getAllByRole("group").length;
    expect(fullGroups).toBe(EDITOR_TOOLBAR_GROUPS.length);

    focusEditor();
    await user.keyboard(userEventKeysFor(editorShortcutBinding("focusMode")));

    const focusToolbar = screen.getByRole("toolbar", { name: "Note formatting" });
    expect(within(focusToolbar).getAllByRole("group")).toHaveLength(FOCUS_TOOLBAR_GROUPS.length);
    expect(FOCUS_TOOLBAR_GROUPS.length).toBeLessThan(EDITOR_TOOLBAR_GROUPS.length);
    expect(focusToolbar.parentElement).toHaveClass("notted-focus-toolbar");
    // Every retained command is the same object the full table declares, so a
    // change there can never diverge from the focus bar.
    for (const group of FOCUS_TOOLBAR_GROUPS) {
      const source = EDITOR_TOOLBAR_GROUPS.find((candidate) => candidate.id === group.id);
      expect(source).toBeDefined();
      for (const item of group.items) {
        expect(source?.items).toContain(item);
      }
    }
  });
});
