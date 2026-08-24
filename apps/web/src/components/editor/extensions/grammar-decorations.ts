/**
 * Grammar and style suggestion underlines, drawn as ProseMirror **decorations**
 * (Part 70).
 *
 * ## Why decorations and not a document mark
 *
 * Same conclusion as Part 60's comment highlights, reached for a sharper reason:
 * a grammar suggestion is *never* content. It is a machine's opinion about
 * content, it is discarded the moment the paragraph under it changes, and it
 * must leave no trace in the note whatsoever.
 *
 * A `grammarSuggestion` mark would have to join the mark types in
 * `packages/shared-validators/src/document.schema.ts`, which means bumping
 * `NOTE_DOCUMENT_SCHEMA_VERSION` and migrating every stored document — to
 * persist an underline that a model produced and nobody accepted.
 *
 * Worse, `TiptapEditor.handleUpdate` runs `safeParseNoteDocument(editor.getJSON())`
 * on every transaction: a mark the contract does not know halts autosave and
 * raises the `note-save-rejected` alert. The writer would be told that saving
 * stopped — because a grammar check ran. Marks would also be broadcast through
 * Yjs to every peer, land in exports and print, and survive a copy-paste into
 * another note where the suggestion means nothing.
 *
 * Decorations add zero nodes and zero marks. `getJSON()` is byte-identical with
 * and without a suggestion showing, so autosave, the contract, the CRDT, and
 * every projection are untouched. Accepting a suggestion is what changes the
 * document, and that is an ordinary editor transaction owned by the popover.
 *
 * ## Why the text-equality guard lives here
 *
 * A suggestion is computed against a snapshot of one block's text and can be
 * several keystrokes old by the time it is drawn. `resolveCommentAnchorInState`
 * finds *a* range; only comparing that range's current text against the text the
 * suggestion was computed from proves it is still the same words. Without the
 * comparison a stale suggestion underlines — and offers to rewrite — whatever
 * text has since slid under those positions. Putting the guard in the accept
 * path alone is not enough: by then the writer has already been shown a
 * correction for text they did not write. Stale suggestions are invisible here,
 * which is the only safe failure mode.
 *
 * ## Wiring
 *
 * The suggestion list arrives as a *function*, read at plugin time. That lets
 * the host pass a ref-backed getter and keep the `useMemo(…, [])` extension list
 * in `TiptapEditor.tsx` on empty dependencies: a re-render with new suggestions
 * never rebuilds the editor. When the list changes without the document
 * changing, call `refreshGrammarDecorations`.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { resolveCommentAnchorInState } from "../comment-anchors";

import type { CommentAnchor, GrammarCategory } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/** Base underline. Styled in `styles/globals.css` — one source for the name. */
export const GRAMMAR_SUGGESTION_CLASS = "notted-grammar-suggestion";

/**
 * Per-category modifier, so the colour says which kind of correction this is.
 * Colour is never the only signal — the popover names the category in words.
 */
export const GRAMMAR_CATEGORY_CLASSES: Readonly<Record<GrammarCategory, string>> = {
  grammar: "notted-grammar-suggestion-grammar",
  style: "notted-grammar-suggestion-style",
  spelling: "notted-grammar-suggestion-spelling",
};

/** Attribute the popover hit-tests when the writer clicks an underline. */
export const GRAMMAR_SUGGESTION_ID_ATTRIBUTE = "data-grammar-id";

/**
 * Meta key for "the suggestion list changed, redraw" — and the plugin's
 * identity.
 */
export const grammarDecorationsPluginKey = new PluginKey<null>("nottedGrammarDecorations");

/** One anchored suggestion, as far as the editor is concerned. */
export interface GrammarSuggestionTarget {
  readonly id: string;
  /** Part 60's anchor, reused verbatim — one anchoring scheme for this editor. */
  readonly anchor: CommentAnchor;
  /** Exactly `state.doc.textBetween(from, to)` at creation time. */
  readonly originalText: string;
  readonly category: GrammarCategory;
}

export interface GrammarDecorationOptions {
  /** Read on every redraw, never captured. */
  readonly resolveGrammarSuggestions: () => readonly GrammarSuggestionTarget[];
}

function buildDecorations(
  state: EditorState,
  targets: readonly GrammarSuggestionTarget[],
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const target of targets) {
    const range = resolveCommentAnchorInState(state, target.anchor);
    // The anchored text is gone. Nothing to underline; the suggestion is simply
    // not shown, and the check hook drops it on its next pass.
    if (range === null) continue;
    // The range still exists, but does it still hold the words the model was
    // asked about? See "Why the text-equality guard lives here" above.
    if (state.doc.textBetween(range.from, range.to) !== target.originalText) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: `${GRAMMAR_SUGGESTION_CLASS} ${GRAMMAR_CATEGORY_CLASSES[target.category]}`,
        [GRAMMAR_SUGGESTION_ID_ATTRIBUTE]: target.id,
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Redraw the underlines after the suggestion list changed.
 *
 * An empty, meta-tagged transaction: it carries no steps, so ProseMirror adds
 * nothing to history, Yjs broadcasts nothing, and TipTap's `onUpdate` (which
 * only fires on `docChanged`) never runs — autosave cannot see it.
 */
export function refreshGrammarDecorations(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(grammarDecorationsPluginKey, null));
}

export function createGrammarDecorations(options: GrammarDecorationOptions): Extension {
  return Extension.create({
    name: "nottedGrammarDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: grammarDecorationsPluginKey,
          props: {
            /*
             * ponytail: the whole set is rebuilt from the suggestion list on
             * every state update rather than mapped through `tr.mapping`.
             * Ceiling: O(suggestions) per update plus one `textBetween` each,
             * bounded by `GRAMMAR_SUGGESTION_MAX` (200), which is nothing at a
             * keystroke's budget — and it is always correct, because every
             * position and every text comparison is re-derived from the live
             * document. Upgrade path if it ever measures badly: hold the
             * `DecorationSet` in plugin state and `set.map(tr.mapping, tr.doc)`
             * on doc changes, rebuilding only when the meta above fires — but
             * note that mapping alone would skip the staleness guard, so the
             * text comparison would have to be re-run on the mapped ranges.
             */
            decorations: (state) => buildDecorations(state, options.resolveGrammarSuggestions()),
          },
        }),
      ];
    },
  });
}
