/**
 * Inline comment highlights, drawn as ProseMirror **decorations** (Part 60).
 *
 * ## Why decorations and not a document mark
 *
 * This is the load-bearing decision of the slice, and it is a correctness and
 * migration decision rather than a stylistic one.
 *
 * A `comment` mark would have to be added to the mark types in
 * `packages/shared-validators/src/document.schema.ts`, which means bumping
 * `NOTE_DOCUMENT_SCHEMA_VERSION` and writing a migration path for every already
 * stored document — for something that is not content.
 *
 * It is worse than that in solo mode. `TiptapEditor.handleUpdate` runs
 * `safeParseNoteDocument(editor.getJSON())` on every transaction, so a mark the
 * contract does not know halts autosave and raises the `note-save-rejected`
 * alert (`SaveStatusIndicator.tsx:71-78`) — the writer is told saving stopped,
 * for a reason they cannot act on.
 *
 * A mark also puts comment identity *inside the CRDT*, where a concurrent edit
 * can split it, duplicate it across a paste, or drop it — and inside every
 * export, print, and search projection, all of which would then have to learn to
 * strip it.
 *
 * Decorations add zero nodes and zero marks. `getJSON()` is byte-identical
 * before and after a highlight appears, so autosave, the contract, the CRDT, and
 * every projection are untouched. They survive edits because the relative
 * positions in `comment-anchors.ts` do — the decoration is only a projection of
 * the anchor list, never the source of truth.
 *
 * ## Wiring
 *
 * The anchor list and the selected comment id arrive as *functions*, read at
 * plugin time. That lets the host pass ref-backed getters and keep the
 * `useMemo(…, [])` extension list in `TiptapEditor.tsx` on empty dependencies:
 * a re-render with a new comment list never rebuilds the editor. When the list
 * changes without the document changing, call `refreshCommentDecorations`.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { resolveCommentAnchorInState } from "../comment-anchors";

import type { CommentAnchor } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/** Base highlight. Styled in `styles/globals.css` — one source for the name. */
export const COMMENT_HIGHLIGHT_CLASS = "notted-comment-highlight";

/** Added for the thread the reader currently has open. */
export const COMMENT_HIGHLIGHT_ACTIVE_CLASS = "notted-comment-highlight-active";

/** Attribute the comment UI hit-tests when the reader clicks a highlight. */
export const COMMENT_ID_ATTRIBUTE = "data-comment-id";

/**
 * Meta key for "the anchor list changed, redraw" — and the plugin's identity.
 */
export const commentDecorationsPluginKey = new PluginKey<null>("nottedCommentDecorations");

/** One anchored comment thread, as far as the editor is concerned. */
export interface CommentAnchorTarget {
  readonly id: string;
  readonly anchor: CommentAnchor;
}

export interface CommentDecorationOptions {
  /** Anchored threads to highlight. Read on every redraw, never captured. */
  readonly resolveComments: () => readonly CommentAnchorTarget[];
  /** The open thread, or `null`. Read on every redraw, never captured. */
  readonly resolveActiveCommentId?: () => string | null;
}

function buildDecorations(
  state: EditorState,
  comments: readonly CommentAnchorTarget[],
  activeId: string | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const comment of comments) {
    const range = resolveCommentAnchorInState(state, comment.anchor);
    // `null` is the orphan signal: the anchored text is gone. The comment is
    // still listed by the UI under its quote; it simply has nothing to point at.
    if (range === null) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class:
          comment.id === activeId
            ? `${COMMENT_HIGHLIGHT_CLASS} ${COMMENT_HIGHLIGHT_ACTIVE_CLASS}`
            : COMMENT_HIGHLIGHT_CLASS,
        [COMMENT_ID_ATTRIBUTE]: comment.id,
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Redraw the highlights after the anchor list or the active thread changed.
 *
 * An empty, meta-tagged transaction: it carries no steps, so ProseMirror adds
 * nothing to history, Yjs broadcasts nothing, and TipTap's `onUpdate` (which
 * only fires on `docChanged`) never runs — autosave cannot see it.
 */
export function refreshCommentDecorations(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, null));
}

export function createCommentDecorations(options: CommentDecorationOptions): Extension {
  return Extension.create({
    name: "nottedCommentDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: commentDecorationsPluginKey,
          props: {
            /*
             * ponytail: the whole set is rebuilt from the anchor list on every
             * state update rather than mapped through `tr.mapping`. Ceiling: it
             * is O(comments) per update, which is nothing at the tens of
             * comments a note carries, and it is always correct because every
             * position is re-derived from the anchors. Upgrade path if it ever
             * measures badly: hold the `DecorationSet` in plugin state and
             * `set.map(tr.mapping, tr.doc)` on doc changes, rebuilding only when
             * the meta above says the list itself changed.
             */
            decorations: (state) =>
              buildDecorations(
                state,
                options.resolveComments(),
                options.resolveActiveCommentId?.() ?? null,
              ),
          },
        }),
      ];
    },
  });
}
