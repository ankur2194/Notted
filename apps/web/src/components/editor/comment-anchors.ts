/**
 * Comment anchors (Part 60): turn a selection into something storable, and turn
 * something stored back into a live range.
 *
 * Pure functions over an editor/state. No network, no React, no I/O — the
 * comment UI owns fetching and this module owns positions.
 *
 * ## Why the `y-prosemirror` converters and not `Y.createRelativePositionFromTypeIndex`
 *
 * A ProseMirror position counts node boundaries; a Yjs type index does not. For
 * a document bound through `y-prosemirror` the two only line up inside a single
 * text run, so `Y.createRelativePositionFromTypeIndex(fragment, pmPos)` would
 * anchor at a silently different character in any document with more than one
 * block. `absolutePositionToRelativePosition` / `relativePositionToAbsolutePosition`
 * walk the binding's `mapping` (PM node ↔ Y type) and are the only correct
 * translation. They are re-exported by `y-prosemirror`, which is already a hard
 * peer of the TipTap collaboration extensions — no new dependency.
 *
 * ## The two schemes, honestly
 *
 * - `yrel:1` — collaborative mode. Relative positions survive concurrent edits,
 *   because a relative position names a *character*, not an offset.
 * - `pmabs:1` — solo mode. There is no Yjs binding, so there is no relative
 *   position to create. Absolute positions are stored and clamped on read; such
 *   an anchor does **not** survive concurrent edits and will drift if the note
 *   is edited elsewhere. That is the honest best a non-collaborative session can
 *   persist, and it is why the scheme is a discriminator rather than a guess.
 *
 * ## The stored anchor is never rewritten
 *
 * ponytail: an anchor is written once, at creation, and no server-side process
 * ever migrates it. Everything above happens in the browser, against a live
 * editor state — so the `from`/`to` offsets persisted on the comment row stay at
 * their creation-time values forever, and anything that reads the row WITHOUT an
 * editor (server-side rendering, print, export) sees offsets that describe the
 * document as it was when the comment was written, not as it is now. That is
 * why only the browser resolves anchors, and why `quote` is stored alongside
 * them: the quoted text is the one part of the anchor that stays meaningful
 * without a document to resolve against, and it is what the orphan list renders.
 * Ceiling: no export or printed page can highlight a commented range.
 * Upgrade path: rewrite the stored offsets in the note projection worker (it
 * already loads the document and runs after every collaborative save), or
 * resolve anchors server-side there and persist the resolved range next to the
 * relative position — either is a migration plus a worker change, and neither
 * buys anything until an export is asked to show comment highlights.
 *
 * ## Orphans
 *
 * A `yrel:1` anchor whose text was deleted resolves either to `null` (its
 * containing type is gone) or to a *collapsed* range — Yjs keeps a deleted
 * item's tombstone, so both endpoints slide to the deletion point. Both are
 * treated as orphaned and return `null`. Never falling back to `anchor.from`/
 * `anchor.to` here is the whole point: that would resurrect the comment on
 * whatever unrelated text happens to occupy those offsets now.
 */

import {
  COMMENT_ANCHOR_QUOTE_MAX_LENGTH,
  COMMENT_ANCHOR_SCHEMA_VERSION,
  COMMENT_ANCHOR_SCHEME_ABSOLUTE,
  COMMENT_ANCHOR_SCHEME_YJS,
  commentAnchorSchema,
} from "@notted/shared-validators";
import {
  absolutePositionToRelativePosition,
  ProsemirrorBinding,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";

import type { CommentAnchor } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

/** A live range in the current document. */
export interface CommentAnchorRange {
  readonly from: number;
  readonly to: number;
}

/**
 * `btoa`/`atob` with the URL-safe swap, because that is the whole job.
 *
 * The shared contract matches `/^[A-Za-z0-9_-]+$/`, so `=` padding is stripped;
 * the WHATWG forgiving-base64 decode that backs `atob` accepts unpadded input.
 * A relative position is tens of bytes, so the per-byte loop is not worth
 * replacing with anything cleverer.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The Yjs seam Part 58 deliberately left unwrapped.
 *
 * `Collaboration` installs `ySyncPlugin` under the default `ySyncPluginKey`, so
 * the binding is readable from any editor state. `getState` is typed `any` by
 * `y-prosemirror`, so the value is taken as `unknown` and narrowed against the
 * exported `ProsemirrorBinding` class rather than cast.
 */
function readBinding(state: EditorState): ProsemirrorBinding | null {
  const sync: unknown = ySyncPluginKey.getState(state);
  if (sync === null || typeof sync !== "object") return null;
  const binding: unknown = (sync as { readonly binding?: unknown }).binding;
  return binding instanceof ProsemirrorBinding ? binding : null;
}

/** Base64url of `Y.encodeRelativePosition` for one absolute position. */
function encodeRelative(binding: ProsemirrorBinding, position: number): string | null {
  try {
    const relative: unknown = absolutePositionToRelativePosition(
      position,
      binding.type,
      binding.mapping,
    );
    if (!(relative instanceof Y.RelativePosition)) return null;
    return toBase64Url(Y.encodeRelativePosition(relative));
  } catch {
    // `absolutePositionToRelativePosition` throws `unexpectedCase` when the
    // mapping and the document disagree (a transaction mid-flight). A comment
    // that cannot be anchored is better than one anchored at the wrong text.
    return null;
  }
}

/** Absolute position for a stored relative position, or `null` if it is gone. */
function decodeRelative(binding: ProsemirrorBinding, encoded: string): number | null {
  const bytes = fromBase64Url(encoded);
  if (bytes === null) return null;
  try {
    const relative = Y.decodeRelativePosition(bytes);
    return relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
  } catch {
    return null;
  }
}

function clamp(position: number, size: number): number {
  return Math.min(Math.max(Math.trunc(position), 0), size);
}

/**
 * Build a storable anchor for the given absolute range.
 *
 * Returns `null` — never throws — for a collapsed or out-of-bounds range, for a
 * document position the binding cannot translate, and for anything the shared
 * contract rejects. Validating here means a malformed anchor can never reach the
 * network, whatever the caller does with the result.
 */
export function createCommentAnchor(
  editor: Editor,
  from: number,
  to: number,
): CommentAnchor | null {
  const state = editor.state;
  const size = state.doc.content.size;
  const start = clamp(from, size);
  const end = clamp(to, size);
  // A collapsed anchor is a whole-note comment with extra steps; the contract
  // already models that as `anchor: null`, so it is rejected rather than stored.
  if (end <= start) return null;

  const quote = state.doc.textBetween(start, end, " ").slice(0, COMMENT_ANCHOR_QUOTE_MAX_LENGTH);
  const binding = readBinding(state);
  const relFrom = binding === null ? null : encodeRelative(binding, start);
  const relTo = binding === null ? null : encodeRelative(binding, end);

  const candidate: CommentAnchor =
    relFrom !== null && relTo !== null
      ? {
          scheme: COMMENT_ANCHOR_SCHEME_YJS,
          from: start,
          to: end,
          quote,
          relFrom,
          relTo,
          schemaVersion: COMMENT_ANCHOR_SCHEMA_VERSION,
        }
      : {
          // Solo mode: no binding, therefore no relative position exists to
          // create. This anchor is offset-based and does not survive concurrent
          // edits — see the module comment.
          scheme: COMMENT_ANCHOR_SCHEME_ABSOLUTE,
          from: start,
          to: end,
          quote,
          schemaVersion: COMMENT_ANCHOR_SCHEMA_VERSION,
        };

  return commentAnchorSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * Memoized on document identity, then on anchor identity.
 *
 * Four independent passes resolve the same anchors against the same state on a
 * single keystroke — the comment decorations (every transaction), the orphan
 * scan in `NoteComments` (every doc change), and the two grammar passes — and
 * each `yrel:1` resolve is a base64 decode plus a `y-prosemirror` mapping walk.
 * ProseMirror reuses the `doc` object whenever a transaction changes no content,
 * so a selection-only transaction hits the same entry as the keystroke before
 * it, and a doc edit gets a fresh one. Entries die with the document: both maps
 * are weak, so there is no invalidation, no eviction and no leak.
 *
 * Returning the identical range object for a repeat lookup is a second, free
 * win: callers that memoize on the result keep referential stability.
 *
 * ponytail: keyed on `state.doc` alone, not on the Yjs binding. A state whose
 * doc is unchanged but whose binding appeared would read a stale entry — in
 * practice `y-prosemirror`'s initial sync replaces the document, which mints a
 * new `doc` and a new entry, so the case does not arise. Upgrade path if it ever
 * does: key the outer map on the binding and the inner on the doc.
 */
const resolvedAnchors = new WeakMap<
  ProseMirrorNode,
  WeakMap<CommentAnchor, CommentAnchorRange | null>
>();

/**
 * Resolve a stored anchor against an editor state.
 *
 * `null` means "orphaned in this document" and is the signal the comment list
 * renders `quote` for. Never throws.
 */
export function resolveCommentAnchorInState(
  state: EditorState,
  anchor: CommentAnchor,
): CommentAnchorRange | null {
  let perDocument = resolvedAnchors.get(state.doc);
  if (perDocument === undefined) {
    perDocument = new WeakMap();
    resolvedAnchors.set(state.doc, perDocument);
  }
  // `undefined` is the miss; `null` is a cached orphan.
  const cached = perDocument.get(anchor);
  if (cached !== undefined) return cached;
  const resolved = computeAnchorRange(state, anchor);
  perDocument.set(anchor, resolved);
  return resolved;
}

function computeAnchorRange(state: EditorState, anchor: CommentAnchor): CommentAnchorRange | null {
  const size = state.doc.content.size;
  const binding = readBinding(state);

  if (anchor.scheme === COMMENT_ANCHOR_SCHEME_YJS && binding !== null) {
    if (anchor.relFrom === undefined || anchor.relTo === undefined) return null;
    const from = decodeRelative(binding, anchor.relFrom);
    const to = decodeRelative(binding, anchor.relTo);
    // Both endpoints collapsing onto one another is what a deleted range looks
    // like: Yjs slides a tombstoned item's position to the deletion point.
    if (from === null || to === null || to <= from) return null;
    return from <= size && to <= size ? { from, to } : null;
  }

  // `pmabs:1`, and a `yrel:1` anchor read without a binding (solo mode opening
  // a note that was commented on collaboratively). Absolute positions are the
  // only thing either case can use, so they are clamped to this document.
  const from = clamp(anchor.from, size);
  const to = clamp(anchor.to, size);
  return to <= from ? null : { from, to };
}

/** `resolveCommentAnchorInState` against the editor's current state. */
export function resolveCommentAnchor(
  editor: Editor,
  anchor: CommentAnchor,
): CommentAnchorRange | null {
  return resolveCommentAnchorInState(editor.state, anchor);
}
