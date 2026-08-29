/**
 * The note document flattened to text: what search indexes, what an export
 * writes, and what a checklist counter reads.
 *
 * Split out of `document.schema.ts`. Nothing here validates — a document that
 * reaches these functions has already been parsed — so both walk defensively and
 * return an empty result rather than throwing on anything unexpected.
 */

import {
  MAX_WALK_DEPTH,
  attachmentPlainText,
  imageCaptionPlainText,
  imagePlainText,
  isRecord,
  mentionPlainText,
} from "./document-core";

export function extractNoteContentPlain(document: unknown): string {
  const blocks: string[] = [];

  const collectInline = (node: unknown, depth: number): string => {
    if (depth > MAX_WALK_DEPTH) return "";
    if (!isRecord(node)) return "";
    if (node.type === "text") return typeof node.text === "string" ? node.text : "";
    if (node.type === "hardBreak") return "\n";
    // A mention reads as `@Ada Lovelace` so search and exports see a name.
    if (node.type === "mention") return mentionPlainText(node);
    if (!Array.isArray(node.content)) return "";
    return node.content.map((child) => collectInline(child, depth + 1)).join("");
  };

  const visit = (node: unknown, sink: string[], depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (!isRecord(node)) return;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
      sink.push(collectInline(node, depth));
      return;
    }
    /*
     * An image contributes its alt text and then its caption, so search and
     * exports see every word the author wrote. Alt comes first because it
     * describes the image itself and a screen reader reaches it first; the
     * caption follows because it is the visible text printed beneath the figure.
     * Each is a block of its own, and each is omitted when empty — a decorative
     * image (`alt: ""`) with no caption still contributes nothing at all rather
     * than one or two empty lines.
     */
    if (node.type === "image") {
      const alt = imagePlainText(node);
      if (alt.length > 0) sink.push(alt);
      const caption = imageCaptionPlainText(node);
      if (caption.length > 0) sink.push(caption);
      return;
    }
    /*
     * An attachment contributes its filename and nothing else. The name is the
     * only human-readable thing the node carries, and it is exactly what a
     * reader searching for "the quarterly deck" would type — so search, export,
     * and the plain-text projection all see it. The MIME type and the byte count
     * are machine values and would be noise in prose.
     */
    if (node.type === "attachment") {
      const name = attachmentPlainText(node);
      if (name.length > 0) sink.push(name);
      return;
    }
    if (node.type === "tableRow") {
      const cells = (Array.isArray(node.content) ? node.content : []).map((cell) => {
        const cellBlocks: string[] = [];
        visit(cell, cellBlocks, depth + 1);
        return cellBlocks.join(" ");
      });
      sink.push(cells.join("\t"));
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child, sink, depth + 1);
    }
  };

  visit(document, blocks, 0);
  return blocks.join("\n");
}

/**
 * Count the `taskItem` nodes in a document and how many are checked.
 *
 * Inline checklists are validated document nodes, never rows, so this walk is
 * the only place the numbers can come from. It recurses through every node's
 * `content`, so a task list nested inside another task item counts too. A
 * `taskItem` whose `checked` attribute is missing or non-boolean counts toward
 * `total` and not toward `done` — the same "unchecked unless proven checked"
 * reading the editor gives it.
 */
export function countChecklist(document: unknown): {
  readonly done: number;
  readonly total: number;
} {
  let done = 0;
  let total = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (!isRecord(node)) return;
    if (node.type === "taskItem") {
      total += 1;
      if (isRecord(node.attrs) && node.attrs.checked === true) done += 1;
    }
    if (Array.isArray(node.content)) for (const child of node.content) visit(child, depth + 1);
  };
  visit(document, 0);
  return { done, total };
}
