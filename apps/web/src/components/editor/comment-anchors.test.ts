/**
 * Anchors, proven against a real `Y.Doc` and the real `y-prosemirror` binding.
 *
 * No server, no socket, no mocks: the whole claim of Part 60's anchor model is
 * that a relative position survives edits, and only the actual CRDT can settle
 * that. The editor is built through the shared harness in collaborative mode,
 * which installs `ySyncPlugin` under the default key exactly as production does.
 *
 * Document under test: `hello brave new world` in one paragraph, so ProseMirror
 * positions run 1..22 and the word "brave" occupies [7, 12).
 */

import { commentAnchorSchema } from "@notted/shared-validators";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createCommentAnchor, resolveCommentAnchor } from "./comment-anchors";

import type { CommentAnchor } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";

import { paragraphDocument, renderEditor } from "@/test/editor-harness";

const TEXT = "hello brave new world";
const BRAVE_FROM = 7;
const BRAVE_TO = 12;

/** Fail loudly instead of asserting non-null, so a broken anchor names itself. */
function requireAnchor(anchor: CommentAnchor | null): CommentAnchor {
  if (anchor === null) throw new Error("createCommentAnchor returned null");
  return anchor;
}

async function collaborativeEditor(): Promise<Editor> {
  const document = new Y.Doc();
  const { editor } = await renderEditor({
    collaboration: {
      document,
      awareness: new Awareness(document),
      user: { name: "Ada Lovelace", color: "#2563eb" },
    },
  });
  // Collaborative mode never seeds `initialDocument` into the shared type, so
  // the content is written through the editor — which is what puts it in the
  // Y.Doc and builds the binding's mapping.
  editor.commands.setContent(paragraphDocument(TEXT), true);
  await waitFor(() => expect(editor.getText()).toContain("brave"));
  return editor;
}

describe("createCommentAnchor in collaborative mode", () => {
  it("stores relative positions and the quoted text", async () => {
    const editor = await collaborativeEditor();

    const anchor = requireAnchor(createCommentAnchor(editor, BRAVE_FROM, BRAVE_TO));

    expect(anchor.scheme).toBe("yrel:1");
    expect(anchor.quote).toBe("brave");
    expect(anchor.from).toBe(BRAVE_FROM);
    expect(anchor.to).toBe(BRAVE_TO);
    expect(anchor.relFrom).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(anchor.relTo).toMatch(/^[A-Za-z0-9_-]+$/u);
    // Never trust the helper's own shape: this is the contract the API enforces.
    expect(commentAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(resolveCommentAnchor(editor, anchor)).toEqual({
      from: BRAVE_FROM,
      to: BRAVE_TO,
    });
  });

  it("rejects a collapsed range", async () => {
    const editor = await collaborativeEditor();
    expect(createCommentAnchor(editor, BRAVE_FROM, BRAVE_FROM)).toBeNull();
  });
});

describe("resolveCommentAnchor after edits", () => {
  it("shifts by the length of text inserted before it", async () => {
    const editor = await collaborativeEditor();
    const anchor = requireAnchor(createCommentAnchor(editor, BRAVE_FROM, BRAVE_TO));

    // Three characters at the very start of the paragraph.
    editor.commands.insertContentAt(1, { type: "text", text: "XY!" });

    await waitFor(() =>
      expect(resolveCommentAnchor(editor, anchor)).toEqual({
        from: BRAVE_FROM + 3,
        to: BRAVE_TO + 3,
      }),
    );
  });

  it("does not move when text after it is deleted", async () => {
    const editor = await collaborativeEditor();
    const anchor = requireAnchor(createCommentAnchor(editor, BRAVE_FROM, BRAVE_TO));

    // " world" — the last six characters, entirely after the anchored word.
    editor.commands.deleteRange({ from: 16, to: 22 });

    await waitFor(() =>
      expect(resolveCommentAnchor(editor, anchor)).toEqual({
        from: BRAVE_FROM,
        to: BRAVE_TO,
      }),
    );
  });

  it("orphans the comment when the anchored text is deleted", async () => {
    const editor = await collaborativeEditor();
    const anchor = requireAnchor(createCommentAnchor(editor, BRAVE_FROM, BRAVE_TO));

    editor.commands.deleteRange({ from: BRAVE_FROM, to: BRAVE_TO });

    // `null` is the orphan signal, and it must never fall back to the stored
    // absolute range: positions 7..12 now hold unrelated text.
    await waitFor(() => expect(resolveCommentAnchor(editor, anchor)).toBeNull());
    expect(anchor.quote).toBe("brave");
  });
});

describe("resolution memo", () => {
  it("resolves an anchor once per document and re-resolves after an edit", async () => {
    const editor = await collaborativeEditor();
    const anchor = requireAnchor(createCommentAnchor(editor, BRAVE_FROM, BRAVE_TO));

    const first = resolveCommentAnchor(editor, anchor);
    const second = resolveCommentAnchor(editor, anchor);

    // Identity, not equality: a second base64 decode plus mapping walk would
    // build a new object. Four passes resolve the same anchors per keystroke.
    expect(second).toBe(first);

    // A selection-only transaction reuses the same `doc`, so it is still a hit.
    editor.commands.setTextSelection({ from: 1, to: 2 });
    expect(resolveCommentAnchor(editor, anchor)).toBe(first);

    // A document edit mints a new `doc`, so the memo cannot serve a stale range.
    editor.commands.insertContentAt(1, "oh ");
    await waitFor(() => {
      const moved = resolveCommentAnchor(editor, anchor);
      expect(moved).not.toBe(first);
      expect(moved).toEqual({ from: BRAVE_FROM + 3, to: BRAVE_TO + 3 });
    });
  });
});

describe("solo mode", () => {
  it("falls back to absolute positions the contract accepts", async () => {
    // No `collaboration` prop, so there is no binding and no relative position
    // can exist. The harness seeds "hello world".
    const { editor } = await renderEditor();

    const anchor = requireAnchor(createCommentAnchor(editor, 1, 6));

    expect(anchor.scheme).toBe("pmabs:1");
    expect(anchor.relFrom).toBeUndefined();
    expect(anchor.relTo).toBeUndefined();
    expect(anchor.quote).toBe("hello");
    expect(commentAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(resolveCommentAnchor(editor, anchor)).toEqual({ from: 1, to: 6 });
  });

  it("clamps an out-of-bounds absolute anchor instead of throwing", async () => {
    const { editor } = await renderEditor();
    const size = editor.state.doc.content.size;

    const stored: CommentAnchor = {
      scheme: "pmabs:1",
      from: 1,
      to: size + 500,
      quote: "hello world",
      schemaVersion: 1,
    };

    expect(resolveCommentAnchor(editor, stored)).toEqual({ from: 1, to: size });
  });

  it("returns null for a stored range that clamps to nothing", async () => {
    const { editor } = await renderEditor();
    const size = editor.state.doc.content.size;

    const stored: CommentAnchor = {
      scheme: "pmabs:1",
      from: size + 10,
      to: size + 20,
      quote: "gone",
      schemaVersion: 1,
    };

    expect(resolveCommentAnchor(editor, stored)).toBeNull();
  });
});
