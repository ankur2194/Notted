import {
  COMMENT_ANCHOR_SCHEMA_VERSION,
  COMMENT_ANCHOR_SCHEME_ABSOLUTE,
  safeParseNoteDocument,
} from "@notted/shared-validators";
import { waitFor } from "@testing-library/react";
import { undoDepth } from "@tiptap/pm/history";
import { describe, expect, it } from "vitest";

import {
  GRAMMAR_CATEGORY_CLASSES,
  GRAMMAR_SUGGESTION_CLASS,
  GRAMMAR_SUGGESTION_ID_ATTRIBUTE,
  refreshGrammarDecorations,
} from "./grammar-decorations";

import type { GrammarSuggestionTarget } from "./grammar-decorations";
import type { CommentAnchor } from "@notted/shared-types";
import type { NoteDocument } from "@notted/shared-validators";

import { paragraphDocument, renderEditor } from "@/test/editor-harness";

/*
 * `teh quick brown fox` in one paragraph. ProseMirror positions: the paragraph
 * opens at 0 and its text starts at 1, so "teh" is 1..4 and "quick" is 5..10.
 */
const SENTENCE = "teh quick brown fox";
const DOCUMENT: NoteDocument = paragraphDocument(SENTENCE);

/**
 * A `pmabs:1` anchor, which is what a solo (non-collaborative) editor stores.
 * The scheme is irrelevant to this module — it hands every anchor to Part 60's
 * `resolveCommentAnchorInState` — but absolute positions are the pair that can
 * be written by hand in a test without a Y.Doc binding.
 */
function anchorAt(from: number, to: number, quote: string): CommentAnchor {
  return {
    scheme: COMMENT_ANCHOR_SCHEME_ABSOLUTE,
    from,
    to,
    quote,
    schemaVersion: COMMENT_ANCHOR_SCHEMA_VERSION,
  };
}

function target(overrides: Partial<GrammarSuggestionTarget> = {}): GrammarSuggestionTarget {
  return {
    id: "g1",
    anchor: anchorAt(1, 4, "teh"),
    originalText: "teh",
    category: "spelling",
    ...overrides,
  };
}

function suggestionSpan(root: Element, id: string): Element | null {
  return root.querySelector(`[${GRAMMAR_SUGGESTION_ID_ATTRIBUTE}="${id}"]`);
}

describe("grammar decorations", () => {
  it("underlines the anchored range with the category class and the suggestion id", async () => {
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      resolveGrammarSuggestions: () => [target()],
    });

    const span = suggestionSpan(editor.view.dom, "g1");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("teh");
    expect(span?.classList.contains(GRAMMAR_SUGGESTION_CLASS)).toBe(true);
    expect(span?.classList.contains(GRAMMAR_CATEGORY_CLASSES.spelling)).toBe(true);
  });

  it("draws each category with its own class", async () => {
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      resolveGrammarSuggestions: () => [
        target(),
        target({
          id: "g2",
          anchor: anchorAt(5, 10, "quick"),
          originalText: "quick",
          category: "style",
        }),
      ],
    });

    expect(
      suggestionSpan(editor.view.dom, "g2")?.classList.contains(GRAMMAR_CATEGORY_CLASSES.style),
    ).toBe(true);
    expect(
      suggestionSpan(editor.view.dom, "g2")?.classList.contains(GRAMMAR_CATEGORY_CLASSES.spelling),
    ).toBe(false);
  });

  it("draws nothing once the anchored text has changed", async () => {
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      resolveGrammarSuggestions: () => [target()],
    });
    expect(suggestionSpan(editor.view.dom, "g1")).not.toBeNull();

    // The range still resolves — it is the same three characters wide — but it
    // no longer holds the word the suggestion was computed against. A stale
    // suggestion must vanish rather than underline the corrected spelling.
    editor.commands.insertContentAt({ from: 1, to: 4 }, "the");
    refreshGrammarDecorations(editor);

    await waitFor(() => {
      expect(suggestionSpan(editor.view.dom, "g1")).toBeNull();
    });
    expect(editor.state.doc.textBetween(1, 4)).toBe("the");
  });

  it("draws nothing for an anchor that cannot be resolved", async () => {
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      resolveGrammarSuggestions: () => [
        // Past the end of this document: clamping collapses it, which is Part
        // 60's orphan signal.
        target({ id: "orphan", anchor: anchorAt(500, 600, "teh") }),
      ],
    });

    expect(suggestionSpan(editor.view.dom, "orphan")).toBeNull();
  });

  it("leaves the document byte-identical and contract-valid while a suggestion shows", async () => {
    let targets: readonly GrammarSuggestionTarget[] = [];
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      resolveGrammarSuggestions: () => targets,
    });

    const before: unknown = editor.getJSON();
    expect(suggestionSpan(editor.view.dom, "g1")).toBeNull();

    targets = [target()];
    refreshGrammarDecorations(editor);
    await waitFor(() => {
      expect(suggestionSpan(editor.view.dom, "g1")).not.toBeNull();
    });

    // A decoration adds no node and no mark, so the JSON the autosave path
    // parses must be unchanged — otherwise `handleUpdate` would reject it and
    // saving would stop.
    const after: unknown = editor.getJSON();
    expect(after).toEqual(before);
    expect(safeParseNoteDocument(after).success).toBe(true);
  });

  it("redraws without touching history or reporting a document change", async () => {
    const changes: unknown[] = [];
    let targets: readonly GrammarSuggestionTarget[] = [];
    const { editor } = await renderEditor({
      initialDocument: DOCUMENT,
      onDocumentChange: (document) => changes.push(document),
      resolveGrammarSuggestions: () => targets,
    });

    // One real edit, so "history is unchanged" is measured against a non-empty
    // undo stack rather than against nothing at all.
    editor.commands.insertContentAt(1, "X");
    await waitFor(() => {
      expect(changes.length).toBeGreaterThan(0);
    });
    const depth = undoDepth(editor.state);
    const changeCount = changes.length;
    expect(depth).toBeGreaterThan(0);
    expect(editor.can().undo()).toBe(true);

    targets = [target({ id: "g3", anchor: anchorAt(1, 5, "Xteh"), originalText: "Xteh" })];
    refreshGrammarDecorations(editor);

    // The redraw really happened…
    await waitFor(() => {
      expect(suggestionSpan(editor.view.dom, "g3")).not.toBeNull();
    });
    // …and it carried no steps: nothing entered history, and `onUpdate` — the
    // only thing autosave listens to — never fired.
    expect(undoDepth(editor.state)).toBe(depth);
    expect(editor.can().undo()).toBe(true);
    expect(changes.length).toBe(changeCount);
  });
});
