import { safeParseNoteDocument } from "@notted/shared-validators";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TiptapEditor } from "./TiptapEditor";

import type { NoteDocument } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";

import { HELLO_DOCUMENT, NOTE_ID, paragraphDocument, renderEditor } from "@/test/editor-harness";

function RemountHarness({
  initial,
  onEditor,
}: {
  readonly initial: NoteDocument;
  readonly onEditor: (editor: Editor | null) => void;
}) {
  const [document, setDocument] = useState<NoteDocument>(initial);
  const [mounted, setMounted] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle editor
      </button>
      {mounted ? (
        <TiptapEditor
          noteId={NOTE_ID}
          initialDocument={document}
          editable
          onDocumentChange={setDocument}
          onEditorReady={onEditor}
        />
      ) : null}
    </div>
  );
}

describe("TiptapEditor content lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores the original content after an unmount and remount", async () => {
    const user = userEvent.setup();
    const holder: { editor: Editor | null } = { editor: null };
    render(
      <RemountHarness
        initial={paragraphDocument("persisted paragraph")}
        onEditor={(editor) => {
          if (editor !== null) holder.editor = editor;
        }}
      />,
    );
    await waitFor(() => expect(holder.editor).not.toBeNull());
    expect(screen.getByRole("textbox")).toHaveTextContent("persisted paragraph");

    await user.click(screen.getByRole("button", { name: "Toggle editor" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle editor" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("persisted paragraph"),
    );
  });

  it("restores edits made before the unmount when the caller keeps the document", async () => {
    const user = userEvent.setup();
    const holder: { editor: Editor | null } = { editor: null };
    render(
      <RemountHarness
        initial={HELLO_DOCUMENT}
        onEditor={(editor) => {
          if (editor !== null) holder.editor = editor;
        }}
      />,
    );
    await waitFor(() => expect(holder.editor).not.toBeNull());
    const first = holder.editor;
    if (first === null) throw new Error("editor missing");

    first.commands.setTextSelection({ from: 1, to: 6 });
    first.commands.toggleBold();
    first.commands.insertContentAt(12, " and more");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("and more"));

    await user.click(screen.getByRole("button", { name: "Toggle editor" }));
    expect(first.isDestroyed).toBe(true);

    await user.click(screen.getByRole("button", { name: "Toggle editor" }));
    await waitFor(() => expect(holder.editor).not.toBe(first));
    const second = holder.editor;
    if (second === null) throw new Error("editor missing after remount");

    expect(second.getText()).toContain("and more");
    expect(second.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toContain(
      "bold",
    );
  });

  it("destroys the editor instance on unmount and reports the teardown", async () => {
    const seen: (Editor | null)[] = [];
    const { editor, unmount } = await renderEditor({
      onEditorReady: (instance) => seen.push(instance),
    });
    expect(editor.isDestroyed).toBe(false);
    unmount();
    await waitFor(() => expect(editor.isDestroyed).toBe(true));
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("adopts a genuinely different document without rebuilding the editor", async () => {
    const { editor, rerender } = await renderEditor({
      initialDocument: paragraphDocument("first version"),
    });
    rerender(
      <TiptapEditor
        noteId={NOTE_ID}
        initialDocument={paragraphDocument("second version")}
        editable
      />,
    );
    await waitFor(() => expect(editor.getText()).toBe("second version"));
    expect(editor.isDestroyed).toBe(false);
  });

  it("keeps the selection when an equivalent document arrives again", async () => {
    const { editor, rerender } = await renderEditor({
      initialDocument: paragraphDocument("stable content"),
    });
    editor.commands.setTextSelection({ from: 3, to: 7 });
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };

    rerender(
      <TiptapEditor
        noteId={NOTE_ID}
        initialDocument={paragraphDocument("stable content")}
        editable
      />,
    );
    await waitFor(() => expect(editor.getText()).toBe("stable content"));
    expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toEqual(before);
  });
});

describe("TiptapEditor document contract handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("emits only contract-valid documents and never contacts the server", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const emitted: NoteDocument[] = [];
    const { editor } = await renderEditor({ onDocumentChange: (doc) => emitted.push(doc) });

    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();
    editor.commands.setTextAlign("center");
    editor.commands.toggleBulletList();

    await waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(3));
    for (const document of emitted) expect(safeParseNoteDocument(document).success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repairs a historical document and says so without blocking editing", async () => {
    const { editor } = await renderEditor({
      initialDocument: {
        type: "doc",
        content: [{ type: "legacyCallout", content: [{ type: "text", text: "legacy text" }] }],
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/older content format/u);
    expect(editor.getText()).toContain("legacy text");
    expect(editor.isEditable).toBe(true);
  });

  it("shows a safe error state instead of throwing on unrecoverable content", () => {
    render(
      <TiptapEditor
        noteId={NOTE_ID}
        initialDocument={{
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(20_001) }] }],
        }}
        editable
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be validated/u);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("shows a safe error state when the input exceeds the contract nesting bound", () => {
    let nested: unknown = { type: "text", text: "deep" };
    for (let depth = 0; depth < 40; depth += 1) nested = { type: "paragraph", content: [nested] };
    render(
      <TiptapEditor
        noteId={NOTE_ID}
        initialDocument={{ type: "doc", content: [nested] }}
        editable
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be validated/u);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("recovers a non-document value into safe text instead of failing", async () => {
    const { editor } = await renderEditor({ initialDocument: "not a document" });
    expect(editor.getText()).toBe("not a document");
    expect(screen.getByRole("status")).toHaveTextContent(/older content format/u);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("exposes an accessible multi-line textbox with the supplied name", async () => {
    await renderEditor({ ariaLabel: "Note content: Quarterly notes" });
    const textbox = screen.getByRole("textbox", { name: "Note content: Quarterly notes" });
    expect(textbox).toHaveAttribute("aria-multiline", "true");
    expect(textbox).toHaveAttribute("contenteditable", "true");
  });
});
