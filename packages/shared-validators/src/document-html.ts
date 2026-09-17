/**
 * The note document rendered to HTML, for export and print.
 *
 * Split out of `document.schema.ts`. Every string that reaches the output passes
 * `escapeHtml` or `sanitizeDocumentUrl` — this module builds markup by
 * concatenation, so those two are the only thing standing between a pasted
 * document and an injection. Attribute VALUES are coerced by
 * `document-core.ts`, which refuses anything outside the contract's allow-lists
 * before it can reach a `style` attribute.
 */

import {
  MAX_WALK_DEPTH,
  NOTE_DOCUMENT_ATTACHMENT_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_META_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS,
  NOTE_DOCUMENT_IMAGE_CAPTION_CLASS,
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_IMAGE_FIGURE_CLASS,
  NOTE_DOCUMENT_MENTION_CLASS,
  NOTE_DOCUMENT_MENTION_PREFIX,
  NOTE_DOCUMENT_PAGE_BREAK_CLASS,
  PlainRecord,
  cellSpanOrNull,
  cellWidthOrNull,
  fontSizeOrNull,
  headingLevelOrNull,
  hexColorOrNull,
  isRecord,
  mentionPlainText,
  noteDocumentAttachmentAttrs,
  noteDocumentImageAttrs,
  noteDocumentMentionAttrs,
  orderedListStartOrNull,
  resolveNoteImageWrap,
  textAlignOrNull,
} from "./document-core";
import { sanitizeDocumentUrl, SAFE_LINK_REL } from "./document-url";
import { formatBinaryBytes } from "./format-bytes";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMark(mark: unknown): { open: string; close: string } | null {
  if (!isRecord(mark) || typeof mark.type !== "string") return null;
  const attrs = isRecord(mark.attrs) ? mark.attrs : undefined;

  switch (mark.type) {
    case "bold":
      return { open: "<strong>", close: "</strong>" };
    case "italic":
      return { open: "<em>", close: "</em>" };
    case "strike":
      return { open: "<s>", close: "</s>" };
    case "code":
      return { open: "<code>", close: "</code>" };
    case "underline":
      return { open: "<u>", close: "</u>" };
    case "subscript":
      return { open: "<sub>", close: "</sub>" };
    case "superscript":
      return { open: "<sup>", close: "</sup>" };
    case "link": {
      const href = sanitizeDocumentUrl(attrs?.href);
      return href === null
        ? null
        : {
            open: `<a href="${escapeHtml(href)}" rel="${SAFE_LINK_REL}" target="_blank">`,
            close: "</a>",
          };
    }
    case "textStyle": {
      const styles: string[] = [];
      const color = hexColorOrNull(attrs?.color);
      const fontSize = fontSizeOrNull(attrs?.fontSize);
      if (color !== null) styles.push(`color:${color}`);
      if (fontSize !== null) styles.push(`font-size:${fontSize}`);
      return styles.length === 0
        ? null
        : { open: `<span style="${styles.join(";")}">`, close: "</span>" };
    }
    case "highlight": {
      const color = hexColorOrNull(attrs?.color);
      return color === null
        ? { open: "<mark>", close: "</mark>" }
        : { open: `<mark style="background-color:${color}">`, close: "</mark>" };
    }
    default:
      return null;
  }
}

function renderTextWithMarks(text: string, marks: unknown): string {
  const escaped = escapeHtml(text);
  if (!Array.isArray(marks)) return escaped;
  let open = "";
  let close = "";
  for (const mark of marks) {
    const rendered = renderMark(mark);
    if (rendered === null) continue;
    open += rendered.open;
    close = rendered.close + close;
  }
  return open + escaped + close;
}

/**
 * Emit only the three reviewed cell attributes. `colspan`/`rowspan` are printed
 * as integers and omitted when they are the default `1`; `colwidth` becomes a
 * single bounded `width` declaration rather than a stored style string, so no
 * attacker-controlled CSS can reach the output.
 */
function cellAttributesHtml(attrs: unknown): string {
  if (!isRecord(attrs)) return "";
  const parts: string[] = [];
  const colspan = cellSpanOrNull(attrs.colspan);
  const rowspan = cellSpanOrNull(attrs.rowspan);
  if (colspan !== null && colspan > 1) parts.push(` colspan="${colspan}"`);
  if (rowspan !== null && rowspan > 1) parts.push(` rowspan="${rowspan}"`);
  const width = cellWidthOrNull(attrs);
  if (width !== null) parts.push(` style="width:${width}px"`);
  return parts.join("");
}

/**
 * A mention becomes a fixed `<span>` carrying one allow-listed class, the
 * escaped user id, and the escaped label. Nothing else from the stored node
 * reaches the output, and a node whose attributes do not validate degrades to
 * escaped `@label` text rather than disappearing.
 *
 * This projection is deliberately **one-way**, and deliberately does *not*
 * match the editor's `parseHTML` shape (`span[data-type="mention"]` with
 * `data-mention-label`). Contract JSON is the canonical persisted format; this
 * HTML is an export/preview surface only. Pasting it back into the editor
 * therefore degrades a mention to plain `@Label` text and drops the user id,
 * which is the intended, safe direction of loss: the alternative would be an
 * export surface whose attributes are trusted as editor input on the way back
 * in. See `renderDocumentHtml`.
 */
function renderMentionHtml(node: PlainRecord): string {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs === null) return escapeHtml(mentionPlainText(node));
  return (
    `<span class="${NOTE_DOCUMENT_MENTION_CLASS}" data-mention-id="${escapeHtml(attrs.id)}">` +
    `${escapeHtml(`${NOTE_DOCUMENT_MENTION_PREFIX}${attrs.label}`)}</span>`
  );
}

/**
 * An image becomes a fixed `<figure>` carrying one allow-listed class, three
 * enumerated layout data attributes, an `<img>` with the escaped attachment id
 * and alt text — **and deliberately no `src`** — plus a `<figcaption>` when the
 * author wrote one.
 *
 * This module knows neither the workspace the note belongs to nor the reader's
 * authorization context, and the bytes are only reachable through an endpoint
 * that re-checks both. Inventing a URL here would therefore either be wrong or
 * would smuggle an unauthorized guess into an export. Substituting a real
 * source (a proxied URL for a preview, an embedded data URI for a self-contained
 * export) is Part 63's job, keyed off `data-attachment-id`.
 *
 * Every emitted value is either a literal from this module or an escaped,
 * bounded, control-character-free author string: the classes are constants, the
 * layout attributes come from closed enumerations, and no class, style, or
 * attribute stored on the node is ever copied through. `data-wrap` carries the
 * **resolved** wrap (`resolveNoteImageWrap`), so print and export lay a
 * full-width figure out exactly the way the editor does.
 *
 * A node whose attributes do not validate renders as nothing: an image with no
 * resolvable attachment has no bytes and no meaning. Its alt and caption text
 * are still recovered by `extractNoteContentPlain`.
 */
function renderImageHtml(node: PlainRecord): string {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs === null) return "";
  const image =
    `<img class="${NOTE_DOCUMENT_IMAGE_CLASS}" ` +
    `data-attachment-id="${escapeHtml(attrs.attachmentId)}" ` +
    `alt="${escapeHtml(attrs.alt)}" loading="lazy" decoding="async">`;
  const caption =
    attrs.caption.length === 0
      ? ""
      : `<figcaption class="${NOTE_DOCUMENT_IMAGE_CAPTION_CLASS}">${escapeHtml(attrs.caption)}</figcaption>`;
  return (
    `<figure class="${NOTE_DOCUMENT_IMAGE_FIGURE_CLASS}" data-align="${attrs.align}" ` +
    `data-wrap="${resolveNoteImageWrap(attrs)}" data-full-width="${attrs.fullWidth ? "true" : "false"}">` +
    `${image}${caption}</figure>`
  );
}

/**
 * An attachment becomes a fixed `<figure>` carrying one allow-listed class, the
 * escaped attachment id, the escaped MIME type, the escaped filename, and a
 * human-readable size — **and deliberately no `href`, no `src`, and no download
 * control.**
 *
 * The reasoning is the same one `renderImageHtml` records: this module knows
 * neither the workspace the note belongs to nor the reader's authorization
 * context, and the bytes are only reachable through an endpoint that re-checks
 * both. Inventing a URL here would either be wrong or would smuggle an
 * unauthorized guess into an export. Substituting a real target — a proxied URL
 * for a preview, an embedded copy for a self-contained export — is Part 63's
 * job, keyed off `data-attachment-id`.
 *
 * Every emitted value is either a literal from this module or an escaped,
 * bounded, control-character-free string: the classes are constants, the size is
 * produced by `formatBinaryBytes` from a validated integer, and no class, style,
 * or attribute stored on the node is copied through.
 *
 * A node whose attributes do not validate renders as nothing — an attachment
 * with no resolvable id has no bytes and no meaning. Its filename is still
 * recovered by `extractNoteContentPlain`.
 */
function renderAttachmentHtml(node: PlainRecord): string {
  const attrs = noteDocumentAttachmentAttrs(node.attrs);
  if (attrs === null) return "";
  return (
    `<figure class="${NOTE_DOCUMENT_ATTACHMENT_CLASS}" ` +
    `data-attachment-id="${escapeHtml(attrs.attachmentId)}" ` +
    `data-mime-type="${escapeHtml(attrs.mimeType)}" ` +
    `data-size-bytes="${attrs.sizeBytes}">` +
    `<span class="${NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS}">${escapeHtml(attrs.name)}</span>` +
    `<span class="${NOTE_DOCUMENT_ATTACHMENT_META_CLASS}">` +
    `<span class="${NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS}">` +
    `${escapeHtml(formatBinaryBytes(attrs.sizeBytes))}</span></span></figure>`
  );
}

function renderNodeHtml(node: unknown, depth = 0): string {
  if (depth > MAX_WALK_DEPTH) return "";
  if (!isRecord(node)) return "";
  if (node.type === "text") {
    return typeof node.text === "string" ? renderTextWithMarks(node.text, node.marks) : "";
  }
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "horizontalRule") return "<hr>";
  // Exactly the markup `styles/print.css` and Part 63's export template style;
  // the class is the whole contract, so no attribute can be smuggled through.
  if (node.type === "pageBreak") return `<div class="${NOTE_DOCUMENT_PAGE_BREAK_CLASS}"></div>`;
  if (node.type === "mention") return renderMentionHtml(node);
  if (node.type === "image") return renderImageHtml(node);
  if (node.type === "attachment") return renderAttachmentHtml(node);

  const children = Array.isArray(node.content)
    ? node.content.map((child) => renderNodeHtml(child, depth + 1)).join("")
    : "";
  switch (node.type) {
    case "doc":
      return children;
    case "paragraph": {
      const align = textAlignOrNull(node.attrs);
      return `<p${align === null ? "" : ` style="text-align:${align}"`}>${children}</p>`;
    }
    case "heading": {
      const level = headingLevelOrNull(node.attrs) ?? 1;
      const align = textAlignOrNull(node.attrs);
      const style = align === null ? "" : ` style="text-align:${align}"`;
      return `<h${level}${style}>${children}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${children}</ul>`;
    case "orderedList": {
      const start = orderedListStartOrNull(node.attrs);
      return `<ol${start === null ? "" : ` start="${start}"`}>${children}</ol>`;
    }
    case "listItem":
      return `<li>${children}</li>`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${children}</code></pre>`;
    case "taskList":
      return `<ul class="task-list">${children}</ul>`;
    case "taskItem": {
      const checked = isRecord(node.attrs) && node.attrs.checked === true ? "true" : "false";
      return `<li class="task-item" data-checked="${checked}">${children}</li>`;
    }
    case "table":
      return `<table><tbody>${children}</tbody></table>`;
    case "tableRow":
      return `<tr>${children}</tr>`;
    case "tableHeader":
    case "tableCell": {
      const tag = node.type === "tableHeader" ? "th" : "td";
      return `<${tag}${cellAttributesHtml(node.attrs)}>${children}</${tag}>`;
    }
    default:
      return "";
  }
}

/**
 * Render only escaped text and the contract's fixed safe tag/attribute map.
 *
 * **One-way by design.** This is an export/preview projection, not a storage or
 * interchange format: the canonical persisted representation of a note is the
 * contract JSON validated by `parseNoteDocument`. The output is intentionally
 * not round-trippable — it carries no schema version, no editor `data-type`
 * hooks, and a deliberately narrower attribute set than the JSON it came from
 * (mentions in particular, see `renderMentionHtml`). Re-importing this HTML
 * into the editor is unsupported and lossy; import from the JSON instead.
 */
export function renderDocumentHtml(document: unknown): string {
  return renderNodeHtml(document);
}
