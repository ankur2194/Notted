import { describe, expect, it } from "vitest";

import { blockInsertPos } from "./insert-position";

import { paragraphDocument, renderEditor } from "@/test/editor-harness";

describe("blockInsertPos", () => {
  it("resolves to after the containing block, so block inserts never split a paragraph", async () => {
    const { editor } = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    editor.commands.setTextSelection({ from: 6, to: 6 });

    const at = blockInsertPos(editor);
    editor
      .chain()
      .insertContentAt(at, [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Attendees" }] },
        { type: "paragraph", content: [{ type: "text", text: "Sam" }] },
      ])
      .run();

    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
    expect(text).toBe("hello world\nAttendees\nSam");
  });
});
