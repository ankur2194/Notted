import { safeParseNoteDocument } from "@notted/shared-validators";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EDITOR_SHORTCUTS } from "./keyboard-shortcuts";

import type { Editor } from "@tiptap/core";

import { FOCUS_MODE_ATTRIBUTE, isFocusModeEnabled, setFocusMode } from "@/lib/notes/focus-mode";
import {
  firstTextMarkNames,
  paragraphDocument,
  renderEditor,
  userEventKeysFor,
  type EditorHarness,
} from "@/test/editor-harness";

// Focus mode is a page-wide viewing mode held in one client-only store, so it
// has to be returned to its default between tests the way the real page does on
// unmount.
afterEach(() => {
  setFocusMode(false);
});

interface ShortcutCase {
  /** Runs before the key press; the default selects the word "hello". */
  readonly setup?: (editor: Editor) => void;
  /**
   * Overrides how the binding is delivered. Only needed when the shortcut
   * depends on a `NodeSelection` surviving until the key lands — see
   * `pressBinding` in the harness for why `userEvent.keyboard` destroys one.
   */
  readonly press?: (harness: EditorHarness, binding: string) => void | Promise<void>;
  readonly assert: (editor: Editor) => void | Promise<void>;
}

const IMAGE_ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";

/** A note whose second block is a 400x200 image, with that image selected. */
function selectImage(editor: Editor): void {
  editor.commands.setContent(
    {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        {
          type: "image",
          attrs: { attachmentId: IMAGE_ATTACHMENT_ID, alt: "Chart", width: 400, height: 200 },
        },
      ],
    },
    false,
  );
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.type.name === "image") target = pos;
    return target === -1;
  });
  if (target === -1) throw new Error("the image node was not inserted");
  editor.commands.setNodeSelection(target);
}

function expectImageSize(width: number, height: number) {
  return (editor: Editor): void => {
    const found: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") found.push({ ...node.attrs });
      return true;
    });
    expect(found[0]).toMatchObject({ width, height });
    // The clamp and the ratio lock must never produce something the contract
    // refuses, or autosave would stop for the session.
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  };
}

function selectHello(editor: Editor): void {
  editor.commands.setTextSelection({ from: 1, to: 6 });
}

function expectMark(name: string) {
  return (editor: Editor): void => {
    expect(firstTextMarkNames(editor)).toContain(name);
  };
}

function expectActive(nodeName: string, attributes?: Record<string, unknown>) {
  return (editor: Editor): void => {
    expect(editor.isActive(nodeName, attributes)).toBe(true);
  };
}

function bulletListDocument(nested: boolean) {
  const second = {
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }],
  };
  const first = {
    type: "listItem",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      ...(nested ? [{ type: "bulletList", content: [second] }] : []),
    ],
  };
  return {
    type: "doc",
    content: [{ type: "bulletList", content: nested ? [first] : [first, second] }],
  };
}

/** Put the caret immediately after the first occurrence of `needle`. */
function caretAfter(editor: Editor, needle: string): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target !== -1) return false;
    const text = node.isText ? node.text : undefined;
    if (text !== undefined && text.includes(needle)) {
      target = pos + text.indexOf(needle) + needle.length;
    }
    return target === -1;
  });
  if (target === -1) throw new Error(`text not found in document: ${needle}`);
  editor.commands.setTextSelection(target);
}

/** Number of `listItem` children directly under the outermost bullet list. */
function topLevelListItems(editor: Editor): number {
  const list = editor.state.doc.firstChild;
  return list === null || list.type.name !== "bulletList" ? 0 : list.childCount;
}

function hasNestedBulletList(editor: Editor): boolean {
  let nested = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "listItem") {
      node.forEach((child) => {
        if (child.type.name === "bulletList") nested = true;
      });
    }
    return true;
  });
  return nested;
}

/**
 * Every editor-scoped shortcut declared in `keyboard-shortcuts.ts` must appear
 * here. The completeness test below fails when a shortcut is added without a
 * matching behavioural expectation, so the help dialog can never advertise a
 * binding that was never proven to work.
 */
const EDITOR_CASES: Readonly<Record<string, ShortcutCase>> = {
  bold: { assert: expectMark("bold") },
  italic: { assert: expectMark("italic") },
  underline: { assert: expectMark("underline") },
  strike: { assert: expectMark("strike") },
  code: { assert: expectMark("code") },
  subscript: { assert: expectMark("subscript") },
  superscript: { assert: expectMark("superscript") },
  link: {
    assert: async () => {
      await waitFor(() =>
        expect(screen.getByRole("dialog", { name: "Insert link" })).toBeInTheDocument(),
      );
    },
  },
  mentionMember: {
    // The trigger is typed into the caret, so the selection must be collapsed.
    setup: (editor) => {
      editor.commands.setTextSelection(12);
    },
    assert: async (editor) => {
      await waitFor(() =>
        expect(screen.getByRole("listbox", { name: "Workspace members" })).toBeInTheDocument(),
      );
      // A space is inserted before `@` because the caret followed a word.
      expect(editor.getText()).toBe("hello world @");
    },
  },
  paragraph: {
    setup: (editor) => {
      selectHello(editor);
      editor.commands.setHeading({ level: 3 });
    },
    assert: expectActive("paragraph"),
  },
  insertBlockMenu: {
    setup: (editor) => {
      editor.commands.setTextSelection(12);
    },
    assert: async (editor) => {
      await waitFor(() =>
        expect(screen.getByRole("listbox", { name: "Block commands" })).toBeInTheDocument(),
      );
      // A new block is started so the trigger lands at a valid position.
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.textContent).toBe("/");
    },
  },
  pageBreak: {
    setup: (editor) => {
      editor.commands.setTextSelection(6);
    },
    assert: (editor) => {
      const types: string[] = [];
      editor.state.doc.descendants((node) => {
        types.push(node.type.name);
        return true;
      });
      expect(types).toContain("pageBreak");
      // The break splits the block it was inserted into rather than replacing
      // anything, and the contract accepts the result unchanged.
      expect(editor.getText().replaceAll("\n", "")).toBe("hello world");
      expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    },
  },
  focusMode: {
    assert: () => {
      // The binding drives a page-wide viewing mode through the same
      // `resolveHandlers` seam `Mod-k` uses; `PageContainer` owns the toggle
      // button and the announcement.
      expect(document.documentElement.getAttribute(FOCUS_MODE_ATTRIBUTE)).toBe("true");
      expect(isFocusModeEnabled()).toBe(true);
    },
  },
  heading1: { assert: expectActive("heading", { level: 1 }) },
  heading2: { assert: expectActive("heading", { level: 2 }) },
  heading3: { assert: expectActive("heading", { level: 3 }) },
  heading4: { assert: expectActive("heading", { level: 4 }) },
  heading5: { assert: expectActive("heading", { level: 5 }) },
  heading6: { assert: expectActive("heading", { level: 6 }) },
  blockquote: { assert: expectActive("blockquote") },
  codeBlock: { assert: expectActive("codeBlock") },
  hardBreak: {
    setup: (editor) => {
      editor.commands.setTextSelection({ from: 6, to: 6 });
    },
    assert: (editor) => {
      const types: string[] = [];
      editor.state.doc.descendants((node) => {
        types.push(node.type.name);
        return true;
      });
      expect(types).toContain("hardBreak");
    },
  },
  bulletList: { assert: expectActive("bulletList") },
  orderedList: { assert: expectActive("orderedList") },
  taskList: { assert: expectActive("taskList") },
  indentBlock: {
    setup: (editor) => {
      editor.commands.setContent(bulletListDocument(false), false);
      caretAfter(editor, "second");
      expect(topLevelListItems(editor)).toBe(2);
    },
    assert: (editor) => {
      expect(topLevelListItems(editor)).toBe(1);
      expect(hasNestedBulletList(editor)).toBe(true);
    },
  },
  outdentBlock: {
    setup: (editor) => {
      editor.commands.setContent(bulletListDocument(true), false);
      caretAfter(editor, "second");
      expect(hasNestedBulletList(editor)).toBe(true);
    },
    assert: (editor) => {
      expect(hasNestedBulletList(editor)).toBe(false);
      expect(topLevelListItems(editor)).toBe(2);
    },
  },
  alignLeft: { assert: expectActive("paragraph", { textAlign: "left" }) },
  alignCenter: { assert: expectActive("paragraph", { textAlign: "center" }) },
  alignRight: { assert: expectActive("paragraph", { textAlign: "right" }) },
  alignJustify: { assert: expectActive("paragraph", { textAlign: "justify" }) },
  imageWiden: {
    // The selection is re-asserted inside `press`, after `focusEditor`, because
    // focusing the surface is itself enough to let jsdom's selection readback
    // collapse a `NodeSelection`.
    press: (harness, binding) => {
      selectImage(harness.editor);
      harness.pressBinding(binding);
    },
    // 400 + 32, with the 2:1 ratio preserved. jsdom has no page paper, so the
    // clamp falls back to the contract bound and 432 passes it unchanged.
    assert: expectImageSize(432, 216),
  },
  imageNarrow: {
    press: (harness, binding) => {
      selectImage(harness.editor);
      harness.pressBinding(binding);
    },
    assert: expectImageSize(368, 184),
  },
  undo: {
    setup: (editor) => {
      selectHello(editor);
      editor.commands.toggleBold();
    },
    assert: (editor) => {
      expect(firstTextMarkNames(editor)).not.toContain("bold");
    },
  },
  redo: {
    setup: (editor) => {
      selectHello(editor);
      editor.commands.toggleBold();
      editor.commands.undo();
      expect(firstTextMarkNames(editor)).not.toContain("bold");
    },
    assert: expectMark("bold"),
  },
  redoAlternate: {
    setup: (editor) => {
      selectHello(editor);
      editor.commands.toggleBold();
      editor.commands.undo();
      expect(firstTextMarkNames(editor)).not.toContain("bold");
    },
    assert: expectMark("bold"),
  },
};

const GLOBAL_CASE_IDS = ["shortcutsHelp", "shortcutsHelpAlternate"] as const;

describe("declared keyboard shortcuts", () => {
  it("covers every declared shortcut with an executable expectation", () => {
    const declared = EDITOR_SHORTCUTS.map((shortcut) => shortcut.id).sort();
    const covered = [...Object.keys(EDITOR_CASES), ...GLOBAL_CASE_IDS].sort();
    expect(covered).toEqual(declared);
  });

  for (const shortcut of EDITOR_SHORTCUTS.filter((entry) => entry.scope === "editor")) {
    it(`applies "${shortcut.description}" with ${shortcut.binding}`, async () => {
      const testCase = EDITOR_CASES[shortcut.id];
      expect(testCase).toBeDefined();
      if (testCase === undefined) return;

      const harness = await renderEditor();
      const { editor, user, focusEditor } = harness;
      if (testCase.setup === undefined) selectHello(editor);
      else testCase.setup(editor);

      focusEditor();
      if (testCase.press === undefined) await user.keyboard(userEventKeysFor(shortcut.binding));
      else await testCase.press(harness, shortcut.binding);
      await testCase.assert(editor);
    });
  }

  it("opens the shortcuts dialog with Ctrl+/ pressed inside the editor", async () => {
    const { user, focusEditor } = await renderEditor();
    focusEditor();
    await user.keyboard(userEventKeysFor("Mod-/"));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("opens the shortcuts dialog with ? outside any text field", async () => {
    const { user } = await renderEditor();
    document.body.focus();
    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does not open the shortcuts dialog when ? is typed inside the editor", async () => {
    const { user, focusEditor } = await renderEditor();
    focusEditor();
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("does not open the shortcuts dialog when ? is typed inside a plain input", async () => {
    const { user } = await renderEditor();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    input.remove();
  });

  it("ignores the link shortcut when the note is read only", async () => {
    const { user, focusEditor } = await renderEditor({
      editable: false,
      initialDocument: paragraphDocument("read only note"),
    });
    focusEditor();
    await user.keyboard(userEventKeysFor("Mod-k"));
    expect(screen.queryByRole("dialog", { name: /link/iu })).not.toBeInTheDocument();
  });
});
