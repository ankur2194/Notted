/**
 * Attribute writes for an image node, and the selection queries they need.
 *
 * Split out of `CustomImage.ts`. Every function here goes through the ordinary
 * command pipeline, so each change is a normal transaction: it lands in the undo
 * stack, fires `onUpdate`, and reaches autosave. That property is the reason
 * these are commands rather than direct `setNodeMarkup` calls, and it is why
 * they are worth reading in one place.
 */

import { noteDocumentImageAttrs } from "@notted/shared-validators";
import { NodeSelection } from "@tiptap/pm/state";

import { displayImageWidth, type ImageResizeBounds, type ImageSize } from "../image-resize";

import { IMAGE_EXTENSION_NAME, IMAGE_FRAME_CLASS } from "./image-constants";

import type { NoteDocumentImageAttrs } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/* -------------------------------------------------------------------------- */
/* Attribute writes — every one of them participates in editor history          */
/* -------------------------------------------------------------------------- */

export type ImageAttributePatch = Partial<Omit<NoteDocumentImageAttrs, "attachmentId">>;

/**
 * Update the image the selection is on.
 *
 * `updateAttributes` runs through the ordinary command pipeline, so the change
 * is an ordinary transaction: it lands in the undo stack, `onUpdate` fires, and
 * Part 39's autosave sees it exactly as it sees a typed character. It must never
 * copy the upload placeholder's `addToHistory: false` — that is for decorations,
 * which are not document changes at all.
 */
export function updateSelectedImage(editor: Editor, patch: ImageAttributePatch): boolean {
  return editor.chain().updateAttributes(IMAGE_EXTENSION_NAME, patch).run();
}

/**
 * Update the image at a known position **without moving the selection**.
 *
 * The caption field needs this: `setNodeSelection` would move the editor
 * selection, and ProseMirror would then sync the DOM selection and blur the
 * input the author is typing into. It is still one ordinary transaction in the
 * undo stack — the only difference from `updateSelectedImage` is that it names
 * its target by position instead of by selection.
 */
export function updateImageAt(editor: Editor, pos: number, patch: ImageAttributePatch): boolean {
  return editor
    .chain()
    .command(({ tr, state }) => {
      const node = state.doc.nodeAt(pos);
      if (node === null || node.type.name !== IMAGE_EXTENSION_NAME) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
      return true;
    })
    .run();
}

/** The image a `NodeSelection` is on, with its position, or `null`. */
export function selectedImage(
  editor: Editor,
): { readonly node: ProseMirrorNode; readonly pos: number } | null {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== IMAGE_EXTENSION_NAME) return null;
  return { node: selection.node, pos: selection.from };
}

/**
 * The box a resize starts from.
 *
 * Preference order: what the frame actually measures, then the stored width
 * clamped to the page, then the width of the printable column.
 *
 * The measurement comes **first** on purpose. A Part 42 image stores its
 * intrinsic width, which is routinely far wider than the page, and it is drawn
 * clamped; starting a drag or a keypress from the stored 4000 would make the
 * figure jump to something it was never showing. The last fallback is the column
 * width because a figure with no stored width *is* displayed at full column
 * width, so that genuinely is its current size.
 */
export function currentSize(
  node: ProseMirrorNode,
  frame: HTMLElement | null,
  bounds: ImageResizeBounds,
): ImageSize {
  const attrs = noteDocumentImageAttrs(node.attrs);
  const measured = frame === null ? 0 : frame.offsetWidth;
  const stored = displayImageWidth(attrs?.width ?? null, bounds) ?? bounds.maxWidth;
  return { width: measured > 0 ? measured : stored, height: attrs?.height ?? null };
}

/** `currentSize` from the node's whole figure element. */
export function currentSizeOfFigure(
  node: ProseMirrorNode,
  figure: HTMLElement | null,
  bounds: ImageResizeBounds,
): ImageSize {
  const frame = figure?.querySelector<HTMLElement>(`.${IMAGE_FRAME_CLASS}`) ?? null;
  return currentSize(node, frame, bounds);
}
