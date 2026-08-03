import { safeParseNoteDocument } from "@notted/shared-validators";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { firstTextMarkNames, renderEditor } from "@/test/editor-harness";

function toolbar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Note formatting" });
}

function toolbarItems(): readonly HTMLElement[] {
  return Array.from(toolbar().querySelectorAll<HTMLElement>("[data-toolbar-item]"));
}

function tabStops(): readonly HTMLElement[] {
  return toolbarItems().filter((element) => element.getAttribute("tabindex") === "0");
}

describe("editor toolbar commands", () => {
  it("toggles inline marks and reflects the active state", async () => {
    const { editor, user, select } = await renderEditor();
    const bold = screen.getByRole("button", { name: /^Bold/u });
    expect(bold).toHaveAttribute("aria-pressed", "false");

    select(1, 6);
    await user.click(bold);
    expect(firstTextMarkNames(editor)).toContain("bold");
    await waitFor(() => expect(bold).toHaveAttribute("aria-pressed", "true"));

    await user.click(bold);
    expect(firstTextMarkNames(editor)).not.toContain("bold");
    await waitFor(() => expect(bold).toHaveAttribute("aria-pressed", "false"));
  });

  it("applies every remaining mark command from the toolbar", async () => {
    for (const [name, mark] of [
      [/^Italic/u, "italic"],
      [/^Underline/u, "underline"],
      [/^Strikethrough/u, "strike"],
      [/^Inline code/u, "code"],
      [/^Subscript/u, "subscript"],
      [/^Superscript/u, "superscript"],
    ] as const) {
      const harness = await renderEditor();
      harness.select(1, 6);
      await harness.user.click(screen.getByRole("button", { name }));
      expect(firstTextMarkNames(harness.editor)).toContain(mark);
      harness.unmount();
    }
  });

  it("changes the block type through the accessible select", async () => {
    const { editor, user, select } = await renderEditor();
    const blockType = screen.getByRole("combobox", { name: "Block type" });
    expect(blockType).toHaveValue("paragraph");

    select(1, 6);
    await user.selectOptions(blockType, "heading2");
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
    await waitFor(() => expect(blockType).toHaveValue("heading2"));

    await user.selectOptions(blockType, "paragraph");
    expect(editor.isActive("paragraph")).toBe(true);
  });

  it("applies and clears an allowed font size", async () => {
    const { editor, user, select } = await renderEditor();
    const fontSize = screen.getByRole("combobox", { name: "Font size" });
    select(1, 6);

    await user.selectOptions(fontSize, "24px");
    expect(editor.getAttributes("textStyle").fontSize).toBe("24px");
    await waitFor(() => expect(fontSize).toHaveValue("24px"));

    await user.selectOptions(fontSize, "");
    expect(editor.getAttributes("textStyle").fontSize ?? null).toBeNull();
  });

  it("applies a palette text colour and removes it again", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);

    await user.click(screen.getByRole("button", { name: /^Text colour/u }));
    const dialog = await screen.findByRole("dialog", { name: "Text colour" });
    await user.click(within(dialog).getByRole("button", { name: "Blue" }));
    expect(editor.getAttributes("textStyle").color).toBe("#1d4ed8");

    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Text colour/u }));
    const reopened = await screen.findByRole("dialog", { name: "Text colour" });
    await user.click(within(reopened).getByRole("button", { name: "Remove text colour" }));
    expect(editor.getAttributes("textStyle").color ?? null).toBeNull();
  });

  it("applies a palette highlight colour", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);

    await user.click(screen.getByRole("button", { name: /^Highlight colour/u }));
    const dialog = await screen.findByRole("dialog", { name: "Highlight colour" });
    await user.click(within(dialog).getByRole("button", { name: "Yellow" }));
    expect(editor.getAttributes("highlight").color).toBe("#fef08a");
    expect(firstTextMarkNames(editor)).toContain("highlight");
  });

  it("applies each alignment and toggles it back off", async () => {
    const { editor, user, select } = await renderEditor();
    for (const [name, alignment] of [
      [/^Align left/u, "left"],
      [/^Align center/u, "center"],
      [/^Align right/u, "right"],
      [/^Justify/u, "justify"],
    ] as const) {
      select(1, 6);
      const button = screen.getByRole("button", { name });
      await user.click(button);
      expect(editor.isActive({ textAlign: alignment })).toBe(true);
      await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
      await user.click(button);
      expect(editor.isActive({ textAlign: alignment })).toBe(false);
    }
  });

  it("applies list, quote, code block, and horizontal rule commands", async () => {
    for (const [name, check] of [
      [/^Bulleted list/u, (isActive: (value: string) => boolean) => isActive("bulletList")],
      [/^Numbered list/u, (isActive: (value: string) => boolean) => isActive("orderedList")],
      [/^Task list/u, (isActive: (value: string) => boolean) => isActive("taskList")],
      [/^Blockquote/u, (isActive: (value: string) => boolean) => isActive("blockquote")],
      [/^Code block/u, (isActive: (value: string) => boolean) => isActive("codeBlock")],
    ] as const) {
      const harness = await renderEditor();
      harness.select(1, 6);
      await harness.user.click(screen.getByRole("button", { name }));
      expect(check((value) => harness.editor.isActive(value))).toBe(true);
      harness.unmount();
    }

    const harness = await renderEditor();
    harness.select(1, 6);
    await harness.user.click(screen.getByRole("button", { name: /^Horizontal rule/u }));
    const types: string[] = [];
    harness.editor.state.doc.descendants((node) => {
      types.push(node.type.name);
      return true;
    });
    expect(types).toContain("horizontalRule");
  });

  it("keeps every toolbar-produced document valid against the shared contract", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    for (const name of [
      /^Bold/u,
      /^Italic/u,
      /^Underline/u,
      /^Strikethrough/u,
      /^Superscript/u,
      /^Align center/u,
      /^Bulleted list/u,
      /^Blockquote/u,
    ]) {
      select(1, 6);
      await user.click(screen.getByRole("button", { name }));
    }
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });
});

describe("editor toolbar history controls", () => {
  it("marks undo and redo unavailable until there is history", async () => {
    const { user, select } = await renderEditor();
    const undo = screen.getByRole("button", { name: /^Undo/u });
    const redo = screen.getByRole("button", { name: /^Redo/u });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(redo).toHaveAttribute("aria-disabled", "true");

    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Bold/u }));
    await waitFor(() => expect(undo).not.toHaveAttribute("aria-disabled"));
    expect(redo).toHaveAttribute("aria-disabled", "true");
  });

  it("undoes and redoes toolbar changes", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Bold/u }));
    expect(firstTextMarkNames(editor)).toContain("bold");

    await user.click(screen.getByRole("button", { name: /^Undo/u }));
    expect(firstTextMarkNames(editor)).not.toContain("bold");

    await user.click(screen.getByRole("button", { name: /^Redo/u }));
    expect(firstTextMarkNames(editor)).toContain("bold");
  });

  it("does nothing when an unavailable history control is clicked", async () => {
    const { editor, user } = await renderEditor();
    const before = editor.getJSON();
    await user.click(screen.getByRole("button", { name: /^Undo/u }));
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("editor toolbar link control", () => {
  it("stores the sanitized href for an accepted URL", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Link/u }));

    const dialog = await screen.findByRole("dialog", { name: "Insert link" });
    await user.type(within(dialog).getByLabelText("Link address"), "https://example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Insert link" })).not.toBeInTheDocument(),
    );
    expect(firstTextMarkNames(editor)).toContain("link");
    expect(editor.getAttributes("link").href).toBe("https://example.com/");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("rejects a javascript: URL with a visible error and applies no mark", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Link/u }));

    const dialog = await screen.findByRole("dialog", { name: "Insert link" });
    const field = within(dialog).getByLabelText("Link address");
    await user.type(field, "javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));

    expect(await within(dialog).findByText(/That link was rejected/u)).toBeVisible();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "Insert link" })).toBeInTheDocument();
    expect(firstTextMarkNames(editor)).not.toContain("link");
  });

  it("rejects a data: URL with a visible error and applies no mark", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Link/u }));

    const dialog = await screen.findByRole("dialog", { name: "Insert link" });
    await user.type(
      within(dialog).getByLabelText("Link address"),
      "data:text/html;base64,PHNjcmlwdD4=",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));

    expect(await within(dialog).findByText(/That link was rejected/u)).toBeVisible();
    expect(firstTextMarkNames(editor)).not.toContain("link");
  });

  it("removes an existing link", async () => {
    const { editor, user, select } = await renderEditor();
    select(1, 6);
    await user.click(screen.getByRole("button", { name: /^Link/u }));
    let dialog = await screen.findByRole("dialog", { name: "Insert link" });
    await user.type(within(dialog).getByLabelText("Link address"), "https://example.com/a");
    await user.click(within(dialog).getByRole("button", { name: "Add link" }));
    expect(firstTextMarkNames(editor)).toContain("link");

    await user.click(screen.getByRole("button", { name: /^Edit link/u }));
    dialog = await screen.findByRole("dialog", { name: "Edit link" });
    await user.click(within(dialog).getByRole("button", { name: "Remove link" }));
    expect(firstTextMarkNames(editor)).not.toContain("link");
  });
});

describe("editor toolbar keyboard navigation", () => {
  it("exposes exactly one tab stop and moves focus with the arrow keys", async () => {
    const { user } = await renderEditor();
    const items = toolbarItems();
    expect(items.length).toBeGreaterThan(4);
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(items[0]);

    items[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(items[1]);
    expect(tabStops()).toEqual([items[1]]);

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(items[0]);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[items.length - 1]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
  });

  it("wraps around at both ends", async () => {
    const { user } = await renderEditor();
    const items = toolbarItems();
    items[0]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(items[items.length - 1]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(items[0]);
  });

  it("leaves the toolbar entirely on Tab", async () => {
    const { user } = await renderEditor();
    const items = toolbarItems();
    items[0]?.focus();
    await user.tab();
    expect(toolbar().contains(document.activeElement)).toBe(false);
  });

  it("does not change a select value while navigating with the arrow keys", async () => {
    const { user } = await renderEditor();
    const blockType = screen.getByRole("combobox", { name: "Block type" });
    blockType.focus();
    await user.keyboard("{ArrowRight}");
    expect(blockType).toHaveValue("paragraph");
    expect(document.activeElement).not.toBe(blockType);
  });
});

describe("read-only editor toolbar", () => {
  it("hides the formatting controls but keeps the shortcuts help reachable", async () => {
    const { editor } = await renderEditor({ editable: false });
    expect(screen.queryByRole("toolbar", { name: "Note formatting" })).not.toBeInTheDocument();
    const readOnlyToolbar = screen.getByRole("toolbar", {
      name: "Note editor actions (read only)",
    });
    expect(
      within(readOnlyToolbar).queryByRole("button", { name: /^Bold/u }),
    ).not.toBeInTheDocument();
    expect(
      within(readOnlyToolbar).getByRole("button", { name: /^Keyboard shortcuts/u }),
    ).toBeInTheDocument();
    expect(editor.isEditable).toBe(false);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
  });

  it("explains why editing is unavailable", async () => {
    await renderEditor({ editable: false, readOnlyReason: "This note is in the trash." });
    expect(screen.getByRole("note")).toHaveTextContent("This note is in the trash.");
  });
});
