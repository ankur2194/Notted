// Part 64 — the `.md` converter.
//
// A HAND-WRITTEN WALKER OVER THE TYPED DOCUMENT, NOT AN HTML->MARKDOWN LIBRARY.
// Turndown (and every sibling) takes HTML, so using one here would mean
// `renderDocumentHtml` -> a DOM implementation in the API -> a rule engine that
// reverse-engineers the structure we already had in hand. That round trip
// discards exactly the things this format exists to preserve: a `taskItem`'s
// checked state, a `pageBreak` (which has no HTML tag, only a class), a
// `codeBlock`'s language, and a `mention`'s stable user id — all of which are
// attributes on the JSON and none of which survive as anything a generic HTML
// rule can recognise. This file walks the contract directly instead, and every
// node and mark type in the contract gets an explicit arm below.
//
// `content` is UNTRUSTED persisted TipTap JSON. It may predate any current
// schema version and it may never have passed `parseNoteDocument` at all, so
// every attribute is re-validated through the contract's own reviewed readers
// (`noteDocumentMentionAttrs`, `noteDocumentImageAttrs`,
// `noteDocumentAttachmentAttrs`, `sanitizeDocumentUrl`,
// `normalizeNoteDocumentCodeLanguage`) and nothing stored is ever emitted raw.
//
// `ExportSourceDocument.subject` (workspace/note/requester identifiers) is
// deliberately ignored: a `.md` artefact is a pure function of the title and
// the body, and it performs no authorized reads. Only `zip` needs the subject.

import {
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_MENTION_PREFIX,
  formatBinaryBytes,
  noteDocumentAttachmentAttrs,
  noteDocumentImageAttrs,
  noteDocumentMentionAttrs,
  normalizeNoteDocumentCodeLanguage,
  sanitizeDocumentUrl,
} from "@notted/shared-validators";

import { EXPORT_FORMAT_MEDIA } from "../export-renderers";

import type { ExportArtifact, ExportSourceDocument } from "../export-renderers";

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childNodes(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : [];
}

/**
 * The nesting cap, taken from the document contract's own `maxDepth` rather
 * than restated. Output length is linear in input length, so depth is the only
 * unbounded dimension a hostile document has left: a validated document can
 * never exceed this, and an unvalidated historical one is truncated here rather
 * than being allowed to recurse. Importing the limit (instead of copying `32`)
 * means the two can never drift apart.
 */
const MAX_DEPTH = NOTE_DOCUMENT_LIMITS.maxDepth;

/** C0/C1 controls, mirroring the contract's own recovery cleanup. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * The Markdown metacharacters that change meaning *wherever* they appear in
 * author text. Backslash comes first in the class so the replacement can never
 * double-escape a sequence it just produced.
 *
 * Deliberately narrow. `# > + - . ) =` are block markers only in the first
 * column, and `( ) { } !` are never inline metacharacters at all — `(`/`)`
 * matter solely inside a link destination, which `escapeHref` owns, and `!`
 * only ahead of a `[` that is escaped here anyway. Escaping them everywhere
 * turned ordinary prose into `Exported body paragraph\.` and
 * `export\-fixture\.txt`: valid Markdown that renders correctly, but unreadable
 * as source, which defeats the point of a Markdown export. `escapeLineStart`
 * covers the position where those characters really do change meaning.
 *
 * Never applied inside a `code` mark or a `codeBlock`: a fenced or backticked
 * span is literal by definition, so escaping there would emit the backslashes
 * as visible characters.
 */
const MARKDOWN_ESCAPE_PATTERN = /[\\`*_[\]<~|]/gu;

function escapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE_PATTERN, "\\$&");
}

/**
 * Neutralise a block marker that author text placed in the first column: an
 * ATX heading, a blockquote, a bullet, a setext underline, or the `1.` / `1)`
 * of an ordered list. Without this a paragraph beginning "- not a list" would
 * silently become one.
 *
 * Applied to a rendered *paragraph*, which is the only block whose first
 * character comes straight from author text. Headings, list items, blockquotes
 * and table cells all emit their own marker first, and their inner content is
 * itself a paragraph, so it arrives here already handled.
 *
 * The two patterns are mutually exclusive — a line cannot start with both a
 * punctuation marker and a digit — so chaining them cannot double-escape.
 */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([#>+\-=])/u, "$1\\$2").replace(/^(\s*)(\d+)([.)])/u, "$1$2\\$3");
}

/**
 * A link destination is emitted between literal parentheses, so an unescaped
 * `(`, `)`, `<` or `>` inside it would terminate or reopen the destination.
 * `sanitizeDocumentUrl` has already rejected whitespace and control characters,
 * so these four are all that remain.
 */
function escapeHref(href: string): string {
  return href.replace(/[()<>\\]/gu, "\\$&");
}

/** The contract's recovery cleanup for an untrusted cached display string. */
function cleanedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARACTER_PATTERN, " ").trim().slice(0, maxLength);
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A backtick run one longer than the longest run in the text, so the span can
 * always contain its own content. Padded with a space when the content starts
 * or ends with a backtick, which is what CommonMark requires to keep the fence
 * and the content from merging.
 */
function inlineCode(text: string): string {
  const runs = [...text.matchAll(/`+/gu)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * One arm per entry in `NOTE_DOCUMENT_MARK_TYPES`. The four that have no
 * Markdown syntax at all fall back to inline HTML, which every CommonMark and
 * GFM renderer passes through; `textStyle` is the one mark that is genuinely
 * dropped, because colour and font size have neither a Markdown syntax nor a
 * meaningful single tag.
 */
function applyMark(mark: unknown, text: string): string {
  if (!isRecord(mark) || typeof mark.type !== "string") return text;
  const attrs = isRecord(mark.attrs) ? mark.attrs : undefined;

  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `*${text}*`;
    case "strike":
      return `~~${text}~~`;
    case "code":
      return inlineCode(text);
    case "underline":
      // Markdown has no underline. `<u>` is the only faithful representation.
      return `<u>${text}</u>`;
    case "link": {
      const href = sanitizeDocumentUrl(attrs?.href);
      // A destination the contract refuses is not emitted in any form — the
      // text stands alone rather than becoming a link to something unreviewed.
      return href === null ? text : `[${text}](${escapeHref(href)})`;
    }
    case "textStyle":
      // DROPPED ON PURPOSE: colour and font size have no Markdown expression,
      // and wrapping every styled run in a `<span style=…>` would push
      // attacker-influenced CSS into a file readers open in an HTML-rendering
      // viewer. The text itself survives; only the styling is lost.
      return text;
    case "highlight":
      // The stored colour is dropped with `textStyle`'s reasoning; the fact of
      // the highlight is kept because it carries author intent.
      return `<mark>${text}</mark>`;
    case "subscript":
      return `<sub>${text}</sub>`;
    case "superscript":
      return `<sup>${text}</sup>`;
    default:
      return text;
  }
}

/**
 * Apply marks innermost-first, matching `renderTextWithMarks`: it emits
 * `open[0] open[1] text close[1] close[0]`, so `marks[0]` is the OUTERMOST
 * wrapper. Folding from the end of the array reproduces that nesting exactly,
 * which is what keeps the `html` and `markdown` exports agreeing about which
 * emphasis contains which.
 */
function renderTextNode(node: PlainRecord): string {
  if (typeof node.text !== "string") return "";
  const marks = childNodes(node.marks);
  const hasCode = marks.some((mark) => isRecord(mark) && mark.type === "code");
  let out = hasCode ? node.text : escapeMarkdown(node.text);
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    out = applyMark(marks[index], out);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Inline nodes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `@Label` linked to the STABLE USER ID, not just the display snapshot.
 *
 * The label is a cached display name that changes; the id does not. A plain
 * `@Label` would make the export unable to say *which* user was mentioned once
 * two people share a name, so the id travels in a `notted:` URI — a private
 * scheme, deliberately not a fetchable URL, because this module knows neither
 * the workspace nor the reader's authorization context (the same reasoning
 * `renderMentionHtml` records). The label is untrusted author-visible data and
 * is escaped.
 */
function renderMention(node: PlainRecord): string {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) {
    const label = escapeMarkdown(`${NOTE_DOCUMENT_MENTION_PREFIX}${attrs.label}`);
    return `[${label}](notted:user/${attrs.id})`;
  }
  // Mirrors `mentionPlainText`: a malformed historical mention cannot address a
  // user, so it degrades to readable text rather than vanishing.
  const label = cleanedText(
    isRecord(node.attrs) ? node.attrs.label : undefined,
    NOTE_DOCUMENT_LIMITS.maxMentionLabel,
  );
  return label === "" ? "" : escapeMarkdown(`${NOTE_DOCUMENT_MENTION_PREFIX}${label}`);
}

function renderInlineNode(node: unknown, depth: number): string {
  if (depth > MAX_DEPTH || !isRecord(node)) return "";
  switch (node.type) {
    case "text":
      return renderTextNode(node);
    case "hardBreak":
      // Two trailing spaces then a newline: the GFM hard break. A bare newline
      // would be collapsed into a space by every renderer.
      return "  \n";
    case "mention":
      return renderMention(node);
    case "image":
    case "attachment":
      // Both are block nodes in the contract; if one is stored inline anyway,
      // its block form is still the honest rendering.
      return renderBlock(node, depth);
    default:
      // An unknown (non-contract) node still contributes its inline text
      // instead of being dropped.
      return renderInline(node.content, depth);
  }
}

function renderInline(content: unknown, depth: number): string {
  return childNodes(content)
    .map((child) => renderInlineNode(child, depth + 1))
    .join("");
}

/* -------------------------------------------------------------------------- */
/* Attribute readers (narrow re-derivations of the contract's private helpers) */
/* -------------------------------------------------------------------------- */

function headingLevel(attrs: unknown): number {
  if (!isRecord(attrs)) return 1;
  const level = attrs.level;
  if (typeof level !== "number" || !Number.isInteger(level)) return 1;
  return Math.min(6, Math.max(1, level));
}

function orderedListStart(attrs: unknown): number {
  if (!isRecord(attrs)) return 1;
  const start = attrs.start;
  return typeof start === "number" && Number.isInteger(start) && start >= 1 ? start : 1;
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Continuation lines of a list item are indented two spaces so a nested block
 * stays inside the item rather than closing the list.
 */
const LIST_CONTINUATION_INDENT = "  ";

function listItemMarkdown(item: unknown, marker: string, depth: number): string {
  const body = renderBlocks(isRecord(item) ? item.content : undefined, depth).join("\n\n");
  if (body === "") return marker.trimEnd();
  return body
    .split("\n")
    .map((line, index) => {
      if (index === 0) return `${marker}${line}`;
      return line === "" ? "" : `${LIST_CONTINUATION_INDENT}${line}`;
    })
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A GFM cell is a single line, so newlines from nested blocks collapse to a
 * space. Author text has already been escaped (which covers `|`), so only a
 * STRUCTURAL pipe — one this converter itself emitted, i.e. a nested table —
 * still needs escaping; the lookbehind is what stops a `\|` becoming `\\|`.
 */
function collapseCell(text: string): string {
  return text
    .replace(/\s*\n\s*/gu, " ")
    .replace(/(?<!\\)\|/gu, "\\|")
    .trim();
}

function cellText(cell: unknown, depth: number): string {
  return collapseCell(renderBlocks(isRecord(cell) ? cell.content : undefined, depth).join(" "));
}

/**
 * `colspan`/`rowspan` ARE DELIBERATELY NOT READ. GFM has no span syntax, and
 * the two available fakes are both worse than collapsing: repeating the cell
 * duplicates its text, and padding with empties invents cells the author never
 * wrote. A spanning cell is therefore emitted exactly once, in its first
 * position, and the row is one column narrower than the HTML table would be.
 */
function tableRowCells(row: unknown, depth: number): readonly string[] {
  return childNodes(isRecord(row) ? row.content : undefined)
    .filter((cell) => isRecord(cell) && (cell.type === "tableHeader" || cell.type === "tableCell"))
    .map((cell) => cellText(cell, depth + 1));
}

function tableLine(cells: readonly string[]): string {
  return cells.length === 0 ? "|  |" : `| ${cells.join(" | ")} |`;
}

function renderTable(node: PlainRecord, depth: number): string {
  const rows = childNodes(node.content).filter(
    (row): row is PlainRecord => isRecord(row) && row.type === "tableRow",
  );
  if (rows.length === 0) return "";

  const cellRows = rows.map((row) => tableRowCells(row, depth));
  const firstRow = rows[0];
  const firstIsHeader = childNodes(firstRow?.content).some(
    (cell) => isRecord(cell) && cell.type === "tableHeader",
  );

  // GFM has no headerless table: the delimiter line is only valid directly
  // under a header row. A table whose first row is all body cells therefore
  // gets an EMPTY header of the right width rather than losing its first row.
  const columns = Math.max(1, ...cellRows.map((cells) => cells.length));
  const header = firstIsHeader ? (cellRows[0] ?? []) : new Array<string>(columns).fill("");
  const body = firstIsHeader ? cellRows.slice(1) : cellRows;
  const delimiter = new Array<string>(Math.max(1, header.length)).fill("---");

  return [tableLine(header), tableLine(delimiter), ...body.map(tableLine)].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Block nodes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Raw code text: no escaping and no marks, because everything inside a fence is
 * literal. A `hardBreak` inside a code block is the line break it looks like.
 */
function codeBlockText(node: PlainRecord): string {
  return childNodes(node.content)
    .map((child) => {
      if (!isRecord(child)) return "";
      if (child.type === "hardBreak") return "\n";
      return child.type === "text" && typeof child.text === "string" ? child.text : "";
    })
    .join("");
}

function renderCodeBlock(node: PlainRecord): string {
  const code = codeBlockText(node);
  const runs = [...code.matchAll(/`+/gu)].map((match) => match[0].length);
  // At least three backticks, and always longer than the longest run inside.
  const fence = "`".repeat(Math.max(2, ...runs) + 1);
  // The info string comes from the contract's closed language set, never from
  // free text, so a stored `language` can never inject anything into the fence.
  const language = normalizeNoteDocumentCodeLanguage(
    isRecord(node.attrs) ? node.attrs.language : undefined,
  );
  return `${fence}${language ?? ""}\n${code}\n${fence}`;
}

/**
 * `![alt](notted:attachment/<uuid>)`.
 *
 * THERE IS NO FETCHABLE URL FOR AN IMAGE IN A `.md` FILE. A Markdown artefact
 * is a single text file with no place to carry bytes, and this module knows
 * neither the workspace nor the reader's authorization context, so any real URL
 * it invented would either be wrong or would smuggle an unauthorized guess into
 * an export (the reasoning `renderImageHtml` records). The `notted:` scheme is
 * therefore an identifier, not a link: a reader who needs the bytes exports
 * `zip`, which bundles the attachment files next to the Markdown.
 */
function renderImage(node: PlainRecord): string {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs === null) {
    // Degrade rather than drop: an unresolvable image still contributes the alt
    // and caption text the author wrote, as `extractNoteContentPlain` does.
    const alt = cleanedText(
      isRecord(node.attrs) ? node.attrs.alt : undefined,
      NOTE_DOCUMENT_LIMITS.maxImageAlt,
    );
    const caption = cleanedText(
      isRecord(node.attrs) ? node.attrs.caption : undefined,
      NOTE_DOCUMENT_LIMITS.maxImageCaption,
    );
    return [alt, caption]
      .filter((part) => part !== "")
      .map(escapeMarkdown)
      .join("\n");
  }
  const image = `![${escapeMarkdown(attrs.alt)}](notted:attachment/${attrs.attachmentId})`;
  // The caption is a visible italic line directly beneath the image, which is
  // the closest Markdown has to a `<figcaption>`.
  return attrs.caption === "" ? image : `${image}\n*${escapeMarkdown(attrs.caption)}*`;
}

/** `[name](notted:attachment/<uuid>) — 1.2 KiB`, same `notted:` reasoning as the image. */
function renderAttachment(node: PlainRecord): string {
  const attrs = noteDocumentAttachmentAttrs(node.attrs);
  if (attrs === null) {
    const name = cleanedText(
      isRecord(node.attrs) ? node.attrs.name : undefined,
      NOTE_DOCUMENT_LIMITS.maxAttachmentName,
    );
    return name === "" ? "" : escapeMarkdown(name);
  }
  // `formatBinaryBytes` output is generated from a validated integer (digits, a
  // dot, a space, a unit), so it is not author text and is not escaped.
  const link = `[${escapeMarkdown(attrs.name)}](notted:attachment/${attrs.attachmentId})`;
  return `${link} — ${formatBinaryBytes(attrs.sizeBytes)}`;
}

function renderBlock(node: unknown, depth: number): string {
  if (depth > MAX_DEPTH || !isRecord(node)) return "";

  switch (node.type) {
    case "doc":
      return renderBlocks(node.content, depth).join("\n\n");
    case "paragraph":
      return escapeLineStart(renderInline(node.content, depth));
    case "heading":
      return `${"#".repeat(headingLevel(node.attrs))} ${renderInline(node.content, depth)}`;
    case "text":
    case "mention":
      // Inline nodes are block children only in a malformed document; their
      // inline rendering is still the right answer.
      return renderInlineNode(node, depth);
    case "hardBreak":
      // A line break BETWEEN blocks separates nothing — blocks are already
      // blank-line separated — so it contributes no text and loses none.
      return "";
    case "bulletList":
      return childNodes(node.content)
        .map((item) => listItemMarkdown(item, "- ", depth + 1))
        .filter((line) => line !== "")
        .join("\n");
    case "orderedList": {
      const start = orderedListStart(node.attrs);
      return childNodes(node.content)
        .map((item, index) => listItemMarkdown(item, `${start + index}. `, depth + 1))
        .filter((line) => line !== "")
        .join("\n");
    }
    case "listItem":
      // Reached outside a list only in a malformed document; the enclosing
      // list arm supplies the real marker in every well-formed one.
      return listItemMarkdown(node, "- ", depth);
    case "blockquote": {
      const inner = renderBlocks(node.content, depth).join("\n\n");
      return (
        inner
          .split("\n")
          // EVERY line carries the marker, blank ones included: an unmarked blank
          // line terminates the quote, which would drop the rest of it out.
          .map((line) => (line === "" ? ">" : `> ${line}`))
          .join("\n")
      );
    }
    case "codeBlock":
      return renderCodeBlock(node);
    case "horizontalRule":
      return "---";
    case "pageBreak":
      // AN HTML COMMENT, NOT `---`. A `---` on the line after a paragraph is a
      // setext H2 underline in CommonMark, so a page break following any text
      // would silently re-title that paragraph as a heading. There is no
      // Markdown syntax for a page break at all, so a comment is the only form
      // that is both lossless for a re-importer and invisible to a reader.
      return "<!-- notted:page-break -->";
    case "taskList":
      return childNodes(node.content)
        .map((item) => renderBlock(item, depth + 1))
        .filter((line) => line !== "")
        .join("\n");
    case "taskItem": {
      // "Unchecked unless proven checked", exactly as `countChecklist` reads it.
      const checked = isRecord(node.attrs) && node.attrs.checked === true;
      return listItemMarkdown(node, checked ? "- [x] " : "- [ ] ", depth);
    }
    case "table":
      return renderTable(node, depth);
    case "tableRow":
      // A row outside a table cannot carry a delimiter line, so it degrades to
      // its own pipe line rather than disappearing.
      return tableLine(tableRowCells(node, depth));
    case "tableHeader":
    case "tableCell":
      return cellText(node, depth);
    case "image":
      return renderImage(node);
    case "attachment":
      return renderAttachment(node);
    default:
      // UNKNOWN, NON-CONTRACT TYPE ONLY. Every contract type has an arm above,
      // so nothing reaching here is something we know how to shape — but it
      // still contributes its text instead of being silently dropped.
      return renderInline(node.content, depth);
  }
}

function renderBlocks(content: unknown, depth: number): string[] {
  const blocks: string[] = [];
  for (const child of childNodes(content)) {
    const block = renderBlock(child, depth + 1);
    if (block !== "") blocks.push(block);
  }
  return blocks;
}

/**
 * The BODY ONLY — no header, no title heading, no footer.
 *
 * Exported separately from `renderMarkdown` because the `zip` bundle renders
 * `note.md` and every historical version through this exact function: one
 * walker, so a version snapshot and the single-file export can never disagree
 * about what a document's Markdown is.
 *
 * `content` is untrusted persisted TipTap JSON. Never throws.
 */
export function documentToMarkdown(content: unknown): string {
  return renderBlock(content, 0);
}

/**
 * The full `.md` artefact.
 *
 * Block assembly is deliberately identical to `renderPlainText`'s — optional
 * header, title, body, optional footer; empty parts filtered; blank-line
 * separated; one trailing newline — so the `txt` and `markdown` exports of the
 * same note cannot drift into different shapes. The only difference is that the
 * title is a `#` heading and the body is Markdown.
 *
 * ponytail: `includeComments`/`includeVersionHistory` are stored and echoed
 * back but do nothing here, exactly as in `renderPlainText`. Ceiling: a
 * `markdown` export is title plus body. Upgrade path: `zip` is the format that
 * bundles comments and versions; adding `## Comments` sections here would need
 * authorized reads this pure function deliberately cannot make (it has no
 * database and ignores `source.subject`).
 */
export function renderMarkdown(source: ExportSourceDocument): ExportArtifact {
  const blocks = [
    // `headerText`/`footerText` are already length-capped and trimmed by
    // `exportOptionsSchema` and are written verbatim, as in `renderPlainText`:
    // escaping them would mangle Markdown an author typed on purpose, and a
    // `.md` file is text, not a rendering context.
    source.options.headerText,
    // `escapeLineStart` as well as `escapeMarkdown`: a title of "# Real" would
    // otherwise emit `# # Real`, which renders correctly but reads as a second
    // marker. The heading's own `# ` prefix means this is the one place a
    // non-paragraph block puts author text next to the start of a line.
    source.title === "" ? null : `# ${escapeLineStart(escapeMarkdown(source.title))}`,
    documentToMarkdown(source.content),
    source.options.footerText,
  ].filter((block): block is string => block !== null && block !== "");
  return Object.freeze({
    body: Buffer.from(`${blocks.join("\n\n")}\n`, "utf8"),
    ...EXPORT_FORMAT_MEDIA.markdown,
  });
}
