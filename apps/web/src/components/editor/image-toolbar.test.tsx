import { safeParseNoteDocument } from "@notted/shared-validators";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IMAGE_TOOLBAR_LABEL } from "./ImageToolbar";

import type { Editor } from "@tiptap/core";

import { renderEditor } from "@/test/editor-harness";

const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";

function imageDocument(attrs: Record<string, unknown> = {}) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      {
        type: "image",
        attrs: { attachmentId: ATTACHMENT_ID, alt: "A chart", width: 400, height: 200, ...attrs },
      },
    ],
  };
}

function imageAttrs(editor: Editor): Record<string, unknown> {
  // Collected into an array rather than a nullable local: TypeScript does not
  // track assignments made inside a callback, so a `let x: T | null = null`
  // would still read as `null` after `descendants` returned.
  const found: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") found.push({ ...node.attrs });
    return true;
  });
  const attrs = found[0];
  if (attrs === undefined) throw new Error("no image node in the document");
  return attrs;
}

function selectImage(editor: Editor): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.type.name === "image") target = pos;
    return target === -1;
  });
  if (target === -1) throw new Error("no image node in the document");
  act(() => {
    editor.commands.setNodeSelection(target);
  });
}

async function openToolbar(attrs: Record<string, unknown> = {}) {
  const harness = await renderEditor({ initialDocument: imageDocument(attrs) });
  selectImage(harness.editor);
  const toolbar = await screen.findByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL });
  return { ...harness, toolbar };
}

describe("image toolbar", () => {
  it("appears only while an image node is selected", async () => {
    const { editor } = await renderEditor({ initialDocument: imageDocument() });
    expect(screen.queryByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).not.toBeInTheDocument();

    selectImage(editor);
    expect(await screen.findByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).toBeInTheDocument();

    act(() => {
      editor.commands.setTextSelection(2);
    });
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).not.toBeInTheDocument(),
    );
  });

  // Regression guard. The toolbar mounts hidden and only renders its element once
  // an image is selected, so `openToolbar` reproduces the real mount order. An
  // earlier version bound the roving-navigation listener from an effect that saw
  // a null ref on its only pass, leaving the arrow keys dead in the browser while
  // every existing unit test stayed green. Do not rewrite this to render an
  // already-selected editor — that variant passes against the broken code.
  it("moves focus between controls with the arrow keys, Home, and End", async () => {
    const { toolbar, user } = await openToolbar();
    const button = (name: string) => within(toolbar).getByRole("button", { name });

    const left = button("Align image left");
    act(() => left.focus());
    expect(left).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(button("Align image center")).toHaveFocus();
    // The toolbar is one tab stop: focus moves, the tabbable control moves with it.
    expect(button("Align image center")).toHaveAttribute("tabindex", "0");
    expect(button("Align image left")).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowRight}");
    expect(button("Align image right")).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(button("Align image center")).toHaveFocus();

    await user.keyboard("{End}");
    expect(button("Remove image")).toHaveFocus();

    await user.keyboard("{Home}");
    expect(button("Align image left")).toHaveFocus();

    // Wraps at the ends rather than dead-ending.
    await user.keyboard("{ArrowLeft}");
    expect(button("Remove image")).toHaveFocus();
  });

  it("renders every control as a named button that reports its own state", async () => {
    const { toolbar } = await openToolbar();
    const named = [
      "Align image left",
      "Align image center",
      "Align image right",
      "Break text around the image",
      "Wrap text beside the image",
      "Full width image",
      "Edit image alternative text",
      "Remove image",
    ];
    for (const name of named) {
      expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    }
    // Defaults: centred, text broken around the figure, not full width.
    expect(within(toolbar).getByRole("button", { name: "Align image center" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(toolbar).getByRole("button", { name: "Align image left" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(toolbar).getByRole("button", { name: "Break text around the image" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).getByRole("button", { name: "Full width image" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("is one tab stop with a roving tab index", async () => {
    const { toolbar } = await openToolbar();
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(buttons[0]?.tabIndex).toBe(0);
  });

  it("never renders for a read-only note", async () => {
    const { editor } = await renderEditor({
      initialDocument: imageDocument(),
      editable: false,
    });
    selectImage(editor);
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).not.toBeInTheDocument(),
    );
  });

  it("changes alignment through editor history, so it can be undone", async () => {
    const { editor, user, toolbar } = await openToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Align image right" }));

    expect(imageAttrs(editor).align).toBe("right");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    await waitFor(() =>
      expect(within(toolbar).getByRole("button", { name: "Align image right" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    act(() => {
      editor.commands.undo();
    });
    expect(imageAttrs(editor).align).toBe("center");
  });

  it("writes the wrap/full-width pair together so the document is never ambiguous", async () => {
    const { editor, user, toolbar } = await openToolbar({ fullWidth: true });
    await user.click(within(toolbar).getByRole("button", { name: "Wrap text beside the image" }));
    // A floated figure cannot span the whole column; one transaction sets both.
    expect(imageAttrs(editor)).toMatchObject({ wrap: "inline", fullWidth: false });

    await user.click(within(toolbar).getByRole("button", { name: "Full width image" }));
    expect(imageAttrs(editor)).toMatchObject({ wrap: "block", fullWidth: true });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("toggles full width off again", async () => {
    const { editor, user, toolbar } = await openToolbar({ fullWidth: true });
    await user.click(within(toolbar).getByRole("button", { name: "Full width image" }));
    expect(imageAttrs(editor).fullWidth).toBe(false);
  });

  it("removes the image without touching the attachment", async () => {
    const { editor, user, toolbar } = await openToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Remove image" }));
    let images = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") images += 1;
      return true;
    });
    expect(images).toBe(0);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("moves focus into the toolbar on the keyboard shortcut, and never before it", async () => {
    const { editor, pressBinding, toolbar } = await openToolbar();
    const first = within(toolbar).getByRole("button", { name: "Align image left" });
    const before = JSON.stringify(editor.getJSON());

    // Selecting an image must NOT steal focus: clicking or arrowing onto one
    // while typing would yank the caret out of the document.
    expect(first).not.toHaveFocus();

    act(() => pressBinding("Mod-Alt-o"));

    // The toolbar is portalled to `document.body`, so without this the only
    // route to alt text is an arbitrarily long tab journey — SC 2.4.3.
    await waitFor(() => expect(first).toHaveFocus());
    // Reaching chrome is a view action, never an edit.
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it("brings a dismissed toolbar back on the shortcut", async () => {
    const { user, pressBinding, toolbar } = await openToolbar();
    within(toolbar).getByRole("button", { name: "Align image left" }).focus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).not.toBeInTheDocument(),
    );

    act(() => pressBinding("Mod-Alt-o"));

    const reopened = await screen.findByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL });
    await waitFor(() =>
      expect(within(reopened).getByRole("button", { name: "Align image left" })).toHaveFocus(),
    );
  });

  it("hides itself on Escape without changing the document", async () => {
    const { editor, user, toolbar } = await openToolbar();
    within(toolbar).getByRole("button", { name: "Align image left" }).focus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: IMAGE_TOOLBAR_LABEL })).not.toBeInTheDocument(),
    );
    // Dismissing chrome is a view action, never an edit.
    expect(imageAttrs(editor).align).toBe("center");
  });
});

describe("alt text dialog", () => {
  it("edits the text alternative and stores it", async () => {
    const { editor, user, toolbar } = await openToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Edit image alternative text" }));

    const dialog = await screen.findByRole("dialog", { name: "Image alternative text" });
    const field = within(dialog).getByLabelText("Alternative text");
    expect(field).toHaveValue("A chart");

    await user.clear(field);
    await user.type(field, "Quarterly revenue by region");
    await user.click(within(dialog).getByRole("button", { name: "Save alternative text" }));

    expect(imageAttrs(editor).alt).toBe("Quarterly revenue by region");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("treats an empty value as a real choice, because that is how decorative is marked", async () => {
    const { editor, user, toolbar } = await openToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Edit image alternative text" }));
    const dialog = await screen.findByRole("dialog", { name: "Image alternative text" });

    // The contract stores `""` verbatim, so clearing the field is durable and
    // the next save will not helpfully re-fill it from a filename.
    await user.click(within(dialog).getByRole("button", { name: "Mark as decorative" }));
    await user.click(within(dialog).getByRole("button", { name: "Save alternative text" }));

    expect(imageAttrs(editor).alt).toBe("");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });
});
