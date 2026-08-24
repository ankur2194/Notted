import type { Editor } from "@tiptap/core";

/**
 * Where BLOCK content may be inserted without splitting the author's paragraph:
 * after the top-level block holding the selection end. `insertContentAt` at an
 * inline position splits the containing node, so a cursor inside "hello world"
 * would leave "hello" / the draft / " world" — three paragraphs out of one.
 * Inline content (a single-block continuation) still belongs at the cursor.
 *
 * Shared by every AI feature that writes block nodes (summary, multi-paragraph
 * continuation, meeting extraction) so the rule cannot drift per call site.
 *
 * ponytail: `after(1)` is the top-level ancestor, so a caret inside a list item
 * or table cell lands the content after the whole list/table. Nothing is lost;
 * upgrade to the innermost block-accepting depth if placement matters there.
 */
export function blockInsertPos(editor: Editor): number {
  const $to = editor.state.doc.resolve(editor.state.selection.to);
  return $to.depth === 0 ? $to.pos : $to.after(1);
}
