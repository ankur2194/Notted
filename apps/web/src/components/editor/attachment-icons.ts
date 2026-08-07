/**
 * File-type icons for the attachment card (Part 44).
 *
 * ## Why these are hand-authored SVG paths rather than lucide components
 *
 * `lucide-react` is already a dependency and is used for every icon in the
 * React surfaces — the toolbar button, the slash-command entry, the dialogs.
 * It cannot be used *here*, because the attachment card is a **plain-DOM
 * ProseMirror node view**, exactly as `CustomImage.ts` is and for the same
 * reasons (`ignoreMutation: () => true` plus a directory subscription is what
 * keeps ProseMirror from reading the subtree back as document content). A lucide
 * icon is a React component; rendering one into that subtree would mean mounting
 * a React root per card.
 *
 * The shapes below are therefore authored here as simple geometry — a sheet, a
 * sheet with a fold, a box, angle brackets, a grid — built with `createElementNS`
 * rather than `innerHTML`, so no markup string is ever parsed and there is no
 * path by which an icon could carry content.
 *
 * The icon is decorative: the card always states the file's kind in text as
 * well, and every icon element carries `aria-hidden="true"`.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The categories the card distinguishes. Deliberately few. */
export type AttachmentIconKind = "pdf" | "document" | "spreadsheet" | "archive" | "code" | "text";

/**
 * Which icon a stored MIME type gets.
 *
 * The mapping is intentionally coarse: a reader needs to tell "a document" from
 * "an archive" at a glance, not to identify RAR versus 7-Zip. Everything text
 * lands on `text` or `code`, distinguished by the *filename extension* rather
 * than the MIME type, because every code file is stored as `text/plain` (see
 * `ATTACHMENT_TEXT_MIME_TYPE`) and the extension is the only surviving hint.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".ts",
  ".html",
  ".htm",
  ".css",
  ".py",
  ".json",
  ".xml",
]);

const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([".csv"]);

export function attachmentIconKind(mimeType: string, name: string): AttachmentIconKind {
  const type = mimeType.toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.includes("spreadsheetml")) return "spreadsheet";
  if (type.includes("wordprocessingml") || type === "application/rtf") return "document";
  if (
    type === "application/zip" ||
    type === "application/vnd.rar" ||
    type === "application/x-7z-compressed" ||
    type === "application/x-tar" ||
    type === "application/gzip"
  ) {
    return "archive";
  }

  const extension = /\.[a-z0-9]{1,10}$/iu.exec(name)?.[0]?.toLowerCase() ?? "";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  return "text";
}

/** `d` attributes for each icon, drawn on a 24×24 grid. */
const ICON_PATHS: Readonly<Record<AttachmentIconKind, readonly string[]>> = Object.freeze({
  // A sheet with a folded corner, plus a bold horizontal bar for "PDF".
  pdf: Object.freeze([
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M8 15h8",
  ]),
  // The same sheet with text lines.
  document: Object.freeze([
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M8 13h8",
    "M8 17h5",
  ]),
  // A sheet with a grid.
  spreadsheet: Object.freeze([
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M8 12h9",
    "M8 16h9",
    "M12 12v6",
  ]),
  // A box with a lid seam and a clasp.
  archive: Object.freeze([
    "M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
    "M3 4h18v4H3z",
    "M11 12h2v3h-2z",
  ]),
  // Angle brackets.
  code: Object.freeze([
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M10 12l-2 2 2 2",
    "M14 12l2 2-2 2",
  ]),
  // A plain sheet with text lines.
  text: Object.freeze([
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M8 13h4",
    "M8 17h6",
  ]),
});

/**
 * Build one decorative icon element.
 *
 * `createElementNS` and `setAttribute` only — never `innerHTML` — so nothing
 * here parses a markup string and no stored value reaches the DOM as markup.
 */
export function createAttachmentIcon(kind: AttachmentIconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const definition of ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", definition);
    svg.append(path);
  }
  return svg;
}

/** Short human label for the icon's category, used in the card's own text. */
export const ATTACHMENT_KIND_LABELS: Readonly<Record<AttachmentIconKind, string>> = Object.freeze({
  pdf: "PDF document",
  document: "Document",
  spreadsheet: "Spreadsheet",
  archive: "Archive",
  code: "Code file",
  text: "Text file",
});
