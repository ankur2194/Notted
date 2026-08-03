import { safeParseNoteDocument, type NoteDocument } from "@notted/shared-validators";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NOTE_EDITOR_PLACEHOLDER } from "./extensions/note-editor-extensions";
import { applyCodeLanguage } from "./toolbar-commands";

import type { Editor } from "@tiptap/core";

import { renderEditor, userEventKeysFor, type EditorHarness } from "@/test/editor-harness";

const EMPTY_DOCUMENT: NoteDocument = { type: "doc", content: [{ type: "paragraph" }] };

function nodeTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
    return true;
  });
  return types;
}

function expectContractValid(editor: Editor): void {
  const result = safeParseNoteDocument(editor.getJSON());
  expect(result.success ? [] : result.errors).toEqual([]);
}

/**
 * `user-event` reads `{` and `[` as the start of a key descriptor, so a literal
 * one has to be doubled. Tests can then declare exactly the characters a person
 * would type.
 */
function typedKeys(text: string): string {
  return text.replace(/[{[]/gu, (character) => character.repeat(2));
}

/** Start from an empty note with the caret in the first paragraph. */
async function typeInEmptyNote(input: string): Promise<EditorHarness> {
  const harness = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
  harness.focusEditor();
  harness.editor.commands.setTextSelection(1);
  await harness.user.keyboard(typedKeys(input));
  return harness;
}

describe("documented markdown shortcuts", () => {
  it.each([
    ["# ", "heading", { level: 1 }],
    ["## ", "heading", { level: 2 }],
    ["### ", "heading", { level: 3 }],
    ["> ", "blockquote", undefined],
    ["- ", "bulletList", undefined],
    ["* ", "bulletList", undefined],
    ["1. ", "orderedList", undefined],
    ["[] ", "taskItem", { checked: false }],
    ["[ ] ", "taskItem", { checked: false }],
    ["[x] ", "taskItem", { checked: true }],
    ["``` ", "codeBlock", { language: null }],
  ] as const)("converts %j into %s", async (input, nodeName, attributes) => {
    const harness = await typeInEmptyNote(input);
    expect(harness.editor.isActive(nodeName, attributes)).toBe(true);
    expectContractValid(harness.editor);
    harness.unmount();
  });

  it.each([["---"], ["*** "]] as const)("converts %j into a horizontal rule", async (input) => {
    const harness = await typeInEmptyNote(input);
    expect(nodeTypes(harness.editor)).toContain("horizontalRule");
    expectContractValid(harness.editor);
    harness.unmount();
  });

  it("bolds text while typing with the ** shortcut", async () => {
    const harness = await typeInEmptyNote("**strong**");
    const first = harness.editor.state.doc.firstChild?.firstChild;
    expect(first?.text).toBe("strong");
    expect(first?.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
    expectContractValid(harness.editor);
  });

  it("creates a task item whose checkbox is exposed to assistive technology", async () => {
    const harness = await typeInEmptyNote("[] Buy milk");
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAccessibleName("Task item checkbox for Buy milk");
    expect(checkbox).not.toBeChecked();
    expectContractValid(harness.editor);
  });

  it("normalizes a fenced language to the registry and drops unknown ones", async () => {
    const aliased = await typeInEmptyNote("```ts ");
    expect(aliased.editor.getAttributes("codeBlock").language).toBe("typescript");
    expectContractValid(aliased.editor);
    aliased.unmount();

    const unknown = await typeInEmptyNote("```cobol ");
    expect(unknown.editor.isActive("codeBlock")).toBe(true);
    expect(unknown.editor.getAttributes("codeBlock").language).toBeNull();
    expectContractValid(unknown.editor);
  });
});

describe("markdown shortcuts leave ordinary text alone", () => {
  it.each([
    ["Step 1. Done", "orderedList"],
    ["a * b", "bulletList"],
    ["well-known ", "bulletList"],
    ["#hashtag", "heading"],
    ["**unclosed", "heading"],
    ["value > 3 ", "blockquote"],
    ["arr[] ", "taskItem"],
  ] as const)("keeps %j as a paragraph", async (input, unexpected) => {
    const harness = await typeInEmptyNote(input);
    expect(harness.editor.isActive("paragraph")).toBe(true);
    expect(nodeTypes(harness.editor)).not.toContain(unexpected);
    expect(harness.editor.state.doc.textContent).toBe(input);
    harness.unmount();
  });

  it("does not bold an unterminated ** sequence", async () => {
    const harness = await typeInEmptyNote("**unclosed");
    const first = harness.editor.state.doc.firstChild?.firstChild;
    expect(first?.marks).toHaveLength(0);
  });
});

describe("markdown shortcut history", () => {
  it("restores the literal typed text with Backspace right after a conversion", async () => {
    const harness = await typeInEmptyNote("# ");
    expect(harness.editor.isActive("heading")).toBe(true);

    await harness.user.keyboard("{Backspace}");
    expect(harness.editor.isActive("paragraph")).toBe(true);
    expect(harness.editor.state.doc.textContent).toBe("# ");
    expectContractValid(harness.editor);
  });

  it("undoes and redoes a converted block", async () => {
    const harness = await typeInEmptyNote("# Title");
    expect(harness.editor.isActive("heading", { level: 1 })).toBe(true);

    await harness.user.keyboard(userEventKeysFor("Mod-z"));
    expect(harness.editor.isActive("paragraph")).toBe(true);
    expect(harness.editor.state.doc.textContent).toBe("");

    await harness.user.keyboard(userEventKeysFor("Mod-Shift-z"));
    expect(harness.editor.isActive("heading", { level: 1 })).toBe(true);
    expect(harness.editor.state.doc.textContent).toBe("Title");
    expectContractValid(harness.editor);
  });
});

const NESTED_TASKS: NoteDocument = {
  type: "doc",
  content: [
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "parent" }] },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function checkedFlags(editor: Editor): boolean[] {
  const flags: boolean[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "taskItem") flags.push(node.attrs.checked === true);
    return true;
  });
  return flags;
}

describe("nested checklists", () => {
  it("toggles only the clicked item", async () => {
    const { editor, user } = await renderEditor({ initialDocument: NESTED_TASKS });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(checkedFlags(editor)).toEqual([false, false]);

    const child = boxes[1];
    if (child === undefined) throw new Error("nested checkbox missing");
    await user.click(child);
    expect(checkedFlags(editor)).toEqual([false, true]);
    expectContractValid(editor);
  });

  it("toggles a nested checkbox from the keyboard and gives it a name", async () => {
    const { editor, user } = await renderEditor({ initialDocument: NESTED_TASKS });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual([
      "Task item checkbox for parent",
      "Task item checkbox for child",
    ]);

    const child = boxes[1];
    if (child === undefined) throw new Error("nested checkbox missing");
    child.focus();
    expect(document.activeElement).toBe(child);
    await user.keyboard(" ");
    expect(checkedFlags(editor)).toEqual([false, true]);
    expectContractValid(editor);
  });

  it("undoes a checkbox toggle", async () => {
    const { editor, user } = await renderEditor({ initialDocument: NESTED_TASKS });
    const boxes = screen.getAllByRole("checkbox");
    const parent = boxes[0];
    if (parent === undefined) throw new Error("checkbox missing");
    await user.click(parent);
    expect(checkedFlags(editor)).toEqual([true, false]);

    await user.click(screen.getByRole("button", { name: /^Undo/u }));
    expect(checkedFlags(editor)).toEqual([false, false]);
  });

  it("keeps the checkbox inert while the note is read only", async () => {
    const { editor, user } = await renderEditor({
      initialDocument: NESTED_TASKS,
      editable: false,
    });
    const boxes = screen.getAllByRole("checkbox");
    const parent = boxes[0];
    if (parent === undefined) throw new Error("checkbox missing");
    await user.click(parent);
    expect(checkedFlags(editor)).toEqual([false, false]);
  });
});

describe("Tab and Shift+Tab outside tables", () => {
  it("indents and outdents a task item", async () => {
    const { editor, focusEditor, pressKey } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }],
              },
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }],
              },
            ],
          },
        ],
      },
    });
    focusEditor();
    // Caret inside the second task item.
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    expect(editor.state.selection.$from.parent.textContent).toBe("second");

    pressKey("Tab");
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(checkedFlags(editor)).toEqual([false, false]);
    expectContractValid(editor);

    pressKey("Tab", { shiftKey: true });
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expectContractValid(editor);
  });

  it("does not swallow Tab in a plain paragraph", async () => {
    const { user, focusEditor, editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }],
      },
    });
    focusEditor();
    expect(document.activeElement).toBe(editor.view.dom);

    await user.keyboard("{Tab}");
    expect(document.activeElement).not.toBe(editor.view.dom);
    expect(editor.state.doc.textContent).toBe("plain");
  });
});

describe("placeholder, gap cursor, and drop cursor", () => {
  it("shows the brief's placeholder only while the note is empty", async () => {
    const { editor, user, focusEditor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    const paragraph = editor.view.dom.querySelector("p");
    expect(paragraph).toHaveAttribute("data-placeholder", NOTE_EDITOR_PLACEHOLDER);
    expect(paragraph?.classList.contains("is-editor-empty")).toBe(true);

    focusEditor();
    editor.commands.setTextSelection(1);
    await user.keyboard("Now it has content");
    expect(editor.view.dom.querySelector("[data-placeholder]")).toBeNull();
  });

  it("registers the gap cursor and drop cursor extensions", async () => {
    const { editor } = await renderEditor();
    const names = editor.extensionManager.extensions.map((extension) => extension.name);
    expect(names).toContain("gapCursor");
    expect(names).toContain("dropCursor");
  });
});

describe("syntax-highlighted code blocks", () => {
  const CODE_DOCUMENT: NoteDocument = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [{ type: "text", text: "const a = 1;" }],
      },
    ],
  };

  it("highlights with decorations only, leaving the persisted JSON untouched", async () => {
    const { editor } = await renderEditor({ initialDocument: CODE_DOCUMENT });
    expect(editor.getJSON()).toEqual(CODE_DOCUMENT);
    expect(nodeTypes(editor)).toEqual(["codeBlock", "text"]);
    expect(editor.view.dom.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
    expectContractValid(editor);
  });

  it("applies a registry language from the toolbar and rejects anything else", async () => {
    const { editor, user } = await renderEditor({ initialDocument: CODE_DOCUMENT });
    const select = screen.getByRole("combobox", { name: "Code block language" });
    editor.commands.setTextSelection(2);

    await user.selectOptions(select, "python");
    expect(editor.getAttributes("codeBlock").language).toBe("python");
    expectContractValid(editor);

    expect(applyCodeLanguage(editor, "cobol")).toBe(false);
    expect(editor.getAttributes("codeBlock").language).toBe("python");

    await user.selectOptions(select, "");
    expect(editor.getAttributes("codeBlock").language).toBeNull();
    expectContractValid(editor);
  });

  it("refuses to set a language when the selection is not in a code block", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    expect(applyCodeLanguage(editor, "python")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Code block language" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("normalizes the language of a pasted code block", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.view.pasteHTML('<pre><code class="language-tsx">const a = 1;</code></pre>');
    expect(editor.getAttributes("codeBlock").language).toBe("typescript");
    expectContractValid(editor);

    const other = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    other.editor.view.pasteHTML('<pre><code class="language-cobol">IDENTIFICATION</code></pre>');
    expect(other.editor.getAttributes("codeBlock").language).toBeNull();
    expectContractValid(other.editor);
  });
});

describe("table toolbar control", () => {
  it("exposes the table menu as a keyboard-reachable dialog", async () => {
    const { user } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    const trigger = screen.getByRole("button", { name: /^Table/u });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");

    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Table" });
    expect(within(dialog).getByRole("group", { name: "Table actions" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Table" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
