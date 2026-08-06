import { safeParseNoteDocument } from "@notted/shared-validators";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SLASH_COMMANDS } from "./slash-commands";

import type { Editor } from "@tiptap/core";

import { renderEditor } from "@/test/editor-harness";

const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };

function paragraphs(...texts: readonly string[]) {
  return {
    type: "doc",
    content: texts.map((text) => ({
      type: "paragraph",
      ...(text.length === 0 ? {} : { content: [{ type: "text", text }] }),
    })),
  };
}

/** Type `text` at `position` the way the suggestion plugin sees real typing. */
function typeAt(editor: Editor, position: number, text: string): void {
  editor.commands.setTextSelection(position);
  editor.commands.insertContent(text);
}

function key(editor: Editor, init: KeyboardEventInit): void {
  fireEvent.keyDown(editor.view.dom, init);
}

function slashMenu(): HTMLElement | null {
  return screen.queryByRole("listbox", { name: "Block commands" });
}

async function openSlashMenu(editor: Editor, position: number, query = ""): Promise<HTMLElement> {
  typeAt(editor, position, `/${query}`);
  await waitFor(() => expect(slashMenu()).not.toBeNull());
  const menu = slashMenu();
  if (menu === null) throw new Error("slash menu did not open");
  return menu;
}

/**
 * Options inside the slash menu only. A plain `getAllByRole("option")` would
 * also match the toolbar's native `<select>` options.
 */
function menuOptions(): readonly HTMLElement[] {
  const menu = slashMenu();
  return menu === null ? [] : within(menu).queryAllByRole("option");
}

function activeOptionIndex(): number {
  return menuOptions().findIndex((option) => option.getAttribute("aria-selected") === "true");
}

function optionLabelled(prefix: string): HTMLElement {
  const option = menuOptions().find((element) => element.textContent?.startsWith(prefix) === true);
  if (option === undefined) throw new Error(`no slash option starting with: ${prefix}`);
  return option;
}

function nodeTypes(editor: Editor): readonly string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
    return true;
  });
  return types;
}

describe("slash menu trigger positions", () => {
  it("opens when / is the first character of an empty paragraph", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    expect(menuOptions()).toHaveLength(SLASH_COMMANDS.length);
  });

  it("opens at the start of a paragraph that already has trailing text", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("existing text") });
    await openSlashMenu(editor, 1);
  });

  it("does not open mid-word", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("hello") });
    typeAt(editor, 6, "/");
    await waitFor(() => expect(editor.getText()).toBe("hello/"));
    expect(slashMenu()).toBeNull();
  });

  it("does not open when / is part of a typed URL path", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("See https:/") });
    typeAt(editor, 12, "/example.test");
    await waitFor(() => expect(editor.getText()).toBe("See https://example.test"));
    expect(slashMenu()).toBeNull();
  });

  it("does not open inside a code block", async () => {
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "codeBlock", attrs: { language: null } }],
      },
    });
    typeAt(editor, 1, "/");
    await waitFor(() => expect(editor.getText()).toBe("/"));
    expect(editor.isActive("codeBlock")).toBe(true);
    expect(slashMenu()).toBeNull();
  });

  it("opens at the start of a paragraph inside a table cell", async () => {
    // Documented ruling: a cell holds ordinary paragraphs, and headings, lists,
    // and code blocks are all legitimate inside one.
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const cell = editor.state.doc.resolve(editor.state.selection.from);
    await openSlashMenu(editor, cell.pos);
  });

  it("closes again once the caret leaves the trigger", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    editor.commands.insertContent(" done");
    await waitFor(() => expect(slashMenu()).toBeNull());
  });
});

describe("slash menu filtering", () => {
  it("filters by label", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "heading");
    const labels = menuOptions().map((option) => option.textContent ?? "");
    expect(labels).toHaveLength(3);
    expect(labels.every((label) => label.startsWith("Heading"))).toBe(true);
  });

  it("filters by the Notted.md keyword spellings", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "bullet-list");
    expect(menuOptions()).toHaveLength(1);
    expect(optionLabelled("Bulleted list")).toBeInTheDocument();
  });

  it("shows a no-results state instead of an empty menu", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "zzz");
    expect(menuOptions()).toHaveLength(0);
    const popover = screen.getByTestId("notted-slash-command-menu");
    expect(within(popover).getByText(/No commands match/u)).toBeInTheDocument();
  });
});

/**
 * Everything a command's expectation is allowed to look at.
 *
 * `/image` (Part 42) is the reason this is a context object rather than the bare
 * editor: it deliberately inserts *nothing*, so the only observable effect is
 * the request it makes of the host's file picker. `imageFileRequests` is the
 * harness's spy on exactly that.
 */
interface CommandContext {
  readonly editor: Editor;
  readonly imageFileRequests: readonly { readonly insertAt: number }[];
}

/**
 * Every command in `SLASH_COMMANDS` must appear here. The completeness test
 * fails when one is added without a proven expectation, so the menu can never
 * offer something that was never shown to work.
 */
const COMMAND_EXPECTATIONS: Readonly<Record<string, (context: CommandContext) => void>> = {
  heading1: ({ editor }) => expect(editor.isActive("heading", { level: 1 })).toBe(true),
  heading2: ({ editor }) => expect(editor.isActive("heading", { level: 2 })).toBe(true),
  heading3: ({ editor }) => expect(editor.isActive("heading", { level: 3 })).toBe(true),
  paragraph: ({ editor }) => expect(editor.isActive("paragraph")).toBe(true),
  bulletList: ({ editor }) => expect(editor.isActive("bulletList")).toBe(true),
  orderedList: ({ editor }) => expect(editor.isActive("orderedList")).toBe(true),
  taskList: ({ editor }) => expect(editor.isActive("taskList")).toBe(true),
  table: ({ editor }) => expect(nodeTypes(editor)).toContain("tableHeader"),
  blockquote: ({ editor }) => expect(editor.isActive("blockquote")).toBe(true),
  codeBlock: ({ editor }) => expect(editor.isActive("codeBlock")).toBe(true),
  divider: ({ editor }) => expect(nodeTypes(editor)).toContain("horizontalRule"),
  pageBreak: ({ editor }) => {
    expect(nodeTypes(editor)).toContain("pageBreak");
    // A stateless leaf atom: the contract accepts `{ "type": "pageBreak" }` and
    // nothing else, so the inserted node must carry no attributes or children.
    const inserted = editor.state.doc.child(0);
    expect(inserted.type.name).toBe("pageBreak");
    expect(inserted.toJSON()).toEqual({ type: "pageBreak" });
    // A document may never end on an atom, or there is nowhere to type next.
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  },
  image: ({ editor, imageFileRequests }) => {
    // The behaviour, stated fully: exactly one request to open the picker, at
    // the position the trigger text used to occupy, and NO node of any kind
    // added to the document. An image node appears only once real bytes have a
    // permanent attachment id, which is what keeps a temporary source out of
    // the saved document by construction.
    expect(imageFileRequests).toHaveLength(1);
    expect(imageFileRequests[0]?.insertAt).toBe(1);
    expect(nodeTypes(editor)).not.toContain("image");
    expect(editor.state.doc.toJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph", attrs: { textAlign: null } }],
    });
  },
};

describe("slash menu commands", () => {
  it("covers every declared command with an executable expectation", () => {
    expect(Object.keys(COMMAND_EXPECTATIONS).sort()).toEqual(
      SLASH_COMMANDS.map((command) => command.id).sort(),
    );
  });

  for (const command of SLASH_COMMANDS) {
    it(`inserts a contract-valid document for "${command.label}"`, async () => {
      const { editor, imageFileRequests } = await renderEditor({
        initialDocument: EMPTY_DOCUMENT,
      });
      await openSlashMenu(editor, 1);
      fireEvent.click(optionLabelled(command.label));

      await waitFor(() => expect(slashMenu()).toBeNull());
      COMMAND_EXPECTATIONS[command.id]?.({ editor, imageFileRequests });
      expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
      // The trigger text is always consumed, never left behind as content.
      expect(editor.getText()).not.toContain("/");
    });
  }
});

describe("slash menu range handling", () => {
  it("removes only the trigger when the query is empty", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("", "keep me") });
    await openSlashMenu(editor, 1);
    fireEvent.click(optionLabelled("Heading 1"));

    await waitFor(() => expect(editor.isActive("heading", { level: 1 })).toBe(true));
    expect(editor.getText()).toBe("\n\nkeep me");
  });

  it("removes only the typed query, including after backspacing", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "headingxx");
    await waitFor(() => expect(menuOptions()).toHaveLength(0));

    // Backspace twice through the real keymap, back to a matching query.
    key(editor, { key: "Backspace" });
    editor.commands.deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from,
    });
    editor.commands.deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from,
    });
    await waitFor(() => expect(menuOptions()).toHaveLength(3));

    fireEvent.click(optionLabelled("Heading 2"));
    await waitFor(() => expect(editor.isActive("heading", { level: 2 })).toBe(true));
    expect(editor.getText()).toBe("");
  });

  it("keeps the text that follows the caret in the same paragraph", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("tail text") });
    await openSlashMenu(editor, 1, "quote");
    fireEvent.click(optionLabelled("Blockquote"));

    await waitFor(() => expect(editor.isActive("blockquote")).toBe(true));
    expect(editor.state.doc.textContent).toBe("tail text");
  });

  it("applies to the new block when the menu is opened at the end of a document", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphs("first", "") });
    const last = editor.state.doc.content.size - 1;
    await openSlashMenu(editor, last, "divider");
    fireEvent.click(optionLabelled("Divider"));

    await waitFor(() => expect(nodeTypes(editor)).toContain("horizontalRule"));
    expect(editor.getText()).toContain("first");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });
});

describe("slash menu keyboard and pointer behaviour", () => {
  it("moves the active option with the arrow keys and wraps", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    const total = SLASH_COMMANDS.length;

    expect(activeOptionIndex()).toBe(0);

    key(editor, { key: "ArrowDown" });
    await waitFor(() => expect(activeOptionIndex()).toBe(1));
    key(editor, { key: "ArrowUp" });
    await waitFor(() => expect(activeOptionIndex()).toBe(0));
    key(editor, { key: "ArrowUp" });
    await waitFor(() => expect(activeOptionIndex()).toBe(total - 1));
  });

  it("also accepts Ctrl+N and Ctrl+P", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    key(editor, { key: "n", ctrlKey: true });
    await waitFor(() => expect(activeOptionIndex()).toBe(1));
    key(editor, { key: "p", ctrlKey: true });
    await waitFor(() => expect(activeOptionIndex()).toBe(0));
  });

  it("selects the active option with Enter", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "task");
    key(editor, { key: "Enter" });
    await waitFor(() => expect(editor.isActive("taskList")).toBe(true));
    expect(slashMenu()).toBeNull();
  });

  it("selects the active option with Tab instead of indenting the block", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "quote");
    key(editor, { key: "Tab" });
    await waitFor(() => expect(editor.isActive("blockquote")).toBe(true));
  });

  it("closes on Escape and leaves the typed text untouched", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1, "head");
    key(editor, { key: "Escape" });

    await waitFor(() => expect(slashMenu()).toBeNull());
    expect(editor.getText()).toBe("/head");
    // Dismissal survives further typing within the same trigger.
    editor.commands.insertContent("i");
    await waitFor(() => expect(editor.getText()).toBe("/headi"));
    expect(slashMenu()).toBeNull();
  });

  it("closes when a pointer press lands outside the menu", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(slashMenu()).toBeNull());
    expect(editor.getText()).toBe("/");
  });

  it("removes its document listeners when the editor unmounts", async () => {
    const { editor, unmount } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    await openSlashMenu(editor, 1);
    unmount();
    // A press after teardown must not reach a stale handler.
    expect(() => fireEvent.pointerDown(document.body)).not.toThrow();
    expect(slashMenu()).toBeNull();
  });
});

describe("slash menu accessibility", () => {
  it("wires the editing surface as the listbox's combobox", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    const surface = screen.getByRole("textbox");
    expect(surface).not.toHaveAttribute("aria-controls");

    await openSlashMenu(editor, 1);
    const menu = screen.getByRole("listbox", { name: "Block commands" });
    expect(surface).toHaveAttribute("aria-controls", menu.id);
    expect(surface).toHaveAttribute("aria-autocomplete", "list");
    expect(surface).toHaveAttribute("aria-haspopup", "listbox");
    // ARIA 1.2 does not permit `aria-expanded` on `role="textbox"`; the polite
    // live region conveys open-ness instead.
    expect(surface).not.toHaveAttribute("aria-expanded");

    await waitFor(() =>
      expect(surface.getAttribute("aria-activedescendant")).toBe(menuOptions()[0]?.id),
    );
    const options = menuOptions();
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");

    key(editor, { key: "ArrowDown" });
    await waitFor(() =>
      expect(surface.getAttribute("aria-activedescendant")).toBe(menuOptions()[1]?.id),
    );

    key(editor, { key: "Escape" });
    await waitFor(() => expect(surface).not.toHaveAttribute("aria-controls"));
    expect(surface).not.toHaveAttribute("aria-activedescendant");
    expect(surface).not.toHaveAttribute("aria-autocomplete");
    expect(surface).not.toHaveAttribute("aria-haspopup");
  });

  it("announces the result count politely as the query changes", async () => {
    const { editor } = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
    const region = screen.getByTestId("notted-slash-command-menu-announcement");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");

    await openSlashMenu(editor, 1);
    await waitFor(() =>
      expect(region).toHaveTextContent(`${SLASH_COMMANDS.length} commands available.`),
    );

    editor.commands.insertContent("bullet");
    await waitFor(() => expect(region).toHaveTextContent("1 command available."));

    editor.commands.insertContent("zzz");
    await waitFor(() => expect(region).toHaveTextContent("No commands match bulletzzz."));
  });
});
