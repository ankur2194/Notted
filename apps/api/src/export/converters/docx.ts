// Part 64 — the `.docx` artefact.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `export-renderers.ts`. Every other pure
// renderer there is one expression over `renderDocumentHtml` /
// `extractNoteContentPlain`. DOCX is not a string format: it is a ZIP of XML
// parts that `docx` builds from a typed object tree, so the node walk has to be
// written out rather than delegated. It is still a PURE function of its input —
// no DI, no I/O, no service locator — which is why it stays a plain exported
// function the generation service calls, exactly like `renderStandaloneHtml`.
//
// `docx` needs NO dynamic-import boundary: `apps/api` compiles to CommonJS with
// Node10 resolution and `docx` publishes `main: dist/index.umd.cjs` plus
// top-level types, so a plain `import` requires cleanly.
//
// WHAT DOCX CARRIES THAT NO OTHER EXPORT FORMAT DOES. `pageBreak` becomes a real
// `<w:br w:type="page"/>`; `colspan`/`rowspan` become real `gridSpan`/`vMerge`
// rather than a flattened grid; `underline`, `color` and font `size` survive
// natively instead of degrading. Those four are the reason this format is worth
// its own walk. Everything else it cannot represent is degraded EXPLICITLY, with
// a `ponytail:` comment naming the ceiling — never dropped silently.
//
// `source.content` is UNTRUSTED `unknown`: it is persisted TipTap JSON that may
// predate any current schema version, so every node, attribute and mark is
// re-validated here through the shared contract helpers, never assumed.

import { pageDimensionsMm } from "@notted/shared-types";
import {
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_MENTION_PREFIX,
  formatBinaryBytes,
  normalizeNoteDocumentCodeLanguage,
  noteDocumentAttachmentAttrs,
  noteDocumentImageAttrs,
  noteDocumentMentionAttrs,
  sanitizeDocumentUrl,
} from "@notted/shared-validators";
import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from "docx";

import { EXPORT_FORMAT_MEDIA, resolveExportMargins } from "../export-renderers";

import type { ExportArtifact, ExportSourceDocument } from "../export-renderers";
import type { ILevelsOptions, IParagraphOptions, IRunOptions, ParagraphChild } from "docx";

/* -------------------------------------------------------------------------- */
/* Bounds and house constants                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recursion ceiling for the whole walk.
 *
 * Reused from the document contract rather than invented here: a document that
 * nests deeper than `NOTE_DOCUMENT_LIMITS.maxDepth` is one `parseNoteDocument`
 * already refuses, so honouring the same number means the renderer and the
 * validator can never disagree about what "too deep" is. It is enforced *again*
 * here rather than assumed, because the renderer reads raw persisted JSON that
 * may predate the validator — a hostile or ancient document must exhaust a
 * counter, not the call stack.
 */
const MAX_WALK_DEPTH = NOTE_DOCUMENT_LIMITS.maxDepth;

/** Word's numbering model has nine levels (0-8); deeper nesting reuses the last. */
const MAX_LIST_LEVEL = 8;

/** Word's default list indent step and hanging indent, in twips. */
const LIST_INDENT_TWIP = 720;
const LIST_HANGING_TWIP = 360;

/** Per-level indent of a quoted block, and the depth past which it stops growing. */
const QUOTE_INDENT_TWIP = 480;
const MAX_QUOTE_INDENT_LEVELS = 6;

const CODE_FONT = "Courier New";
/** 8pt, in half-points — the language label sits visibly below body text. */
const CODE_LABEL_HALF_POINTS = 16;
const CODE_SHADING_FILL = "F1F5F9";
const TABLE_HEADER_FILL = "E2E8F0";
const RULE_COLOR = "94A3B8";

/** CSS `px` -> DOCX half-points. CSS defines 1px as 0.75pt, so 1px = 1.5 half-points. */
const HALF_POINTS_PER_PX = 1.5;
/** Rejects a `fontSize` outside anything the contract's closed list can hold. */
const MAX_FONT_SIZE_PX = 200;

/**
 * The only highlight `docx` accepts without a colour: a named Word highlight.
 *
 * Typed off `IRunOptions` rather than as a bare `string`, so the name is checked
 * against the library's own closed list of the seventeen OOXML highlight names.
 * Word silently drops an unrecognised one, which would be a formatting bug no
 * test that only inspects our own output could catch.
 */
type DocxHighlight = NonNullable<IRunOptions["highlight"]>;
const DEFAULT_HIGHLIGHT: DocxHighlight = "yellow";

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

/** C0/C1 control characters, stripped from a malformed mention's recovered label. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * Bookmark-name prefix for a mention's stable user id.
 *
 * OOXML bookmark names are limited to 40 characters and to `[A-Za-z0-9_]`
 * starting with a letter, so the UUID's hyphens are stripped: `mn_` (3) + 32 hex
 * + `_` + an occurrence counter stays under the bound for every document the
 * contract admits (at most `NOTE_DOCUMENT_LIMITS.maxMentions` = 200, so three
 * digits). The counter is what keeps repeated mentions of the same person from
 * emitting duplicate bookmark names, which Word treats as malformed.
 */
const MENTION_BOOKMARK_PREFIX = "mn_";

const HEADING_STYLES = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const ALIGNMENTS: Readonly<Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]>> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

/** `☐`/`☑`. See `taskItemBlocks` for why these are glyphs and not content controls. */
const TASK_GLYPHS = { checked: "☑ ", unchecked: "☐ " } as const;

/* -------------------------------------------------------------------------- */
/* Untrusted-input helpers                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attrsOf(node: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(node.attrs) ? node.attrs : undefined;
}

function childrenOf(node: Record<string, unknown>): readonly unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

/** `#aabbcc` -> `AABBCC`. DOCX colours are bare hex, uppercase by convention. */
function hexColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.slice(1).toUpperCase()
    : null;
}

/**
 * The contract stores `fontSize` as a `px` string from a closed list. DOCX wants
 * half-points, which is the one unit conversion that lets an author's chosen size
 * survive a `.docx` round trip — every other export format loses it entirely.
 */
function halfPoints(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const px = Number.parseFloat(value);
  if (!Number.isFinite(px) || px <= 0 || px > MAX_FONT_SIZE_PX) return null;
  return Math.round(px * HALF_POINTS_PER_PX);
}

function alignmentOf(node: Record<string, unknown>): IParagraphOptions["alignment"] {
  const align = attrsOf(node)?.textAlign;
  return typeof align === "string" ? ALIGNMENTS[align] : undefined;
}

function headingLevel(node: Record<string, unknown>): (typeof HEADING_STYLES)[number] {
  const level = attrsOf(node)?.level;
  const clamped =
    typeof level === "number" && Number.isInteger(level) ? Math.min(Math.max(level, 1), 6) : 1;
  return HEADING_STYLES[clamped - 1] ?? HeadingLevel.HEADING_1;
}

/** `colspan`/`rowspan`: an integer inside the contract's own span bound, or `null`. */
function cellSpan(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 1 &&
    value <= NOTE_DOCUMENT_LIMITS.maxTableCellSpan
    ? value
    : null;
}

/* -------------------------------------------------------------------------- */
/* Walk state                                                                   */
/* -------------------------------------------------------------------------- */

type ListMarker =
  | { readonly kind: "bullet" }
  | { readonly kind: "number"; readonly reference: string }
  /** Task items draw their own glyph, so this only records "we are inside a list". */
  | { readonly kind: "task" };

interface WalkContext {
  readonly depth: number;
  readonly listLevel: number;
  readonly marker: ListMarker | null;
  readonly quoteDepth: number;
  /** Set inside a `tableHeader` cell: DOCX has no "header cell" text style of its own. */
  readonly bold: boolean;
}

interface NumberingConfig {
  readonly reference: string;
  readonly levels: readonly ILevelsOptions[];
}

/**
 * The two things a walk accumulates that a `Document` needs up front.
 *
 * `numbering` has to exist before `new Document(...)`, which is why the body is
 * built first and the document constructed from the result — not the other way
 * around. Mutable on purpose: threading two accumulators through every return
 * value would be a monad wearing a trench coat.
 */
interface RenderState {
  readonly numbering: NumberingConfig[];
  readonly mentionUses: Map<string, number>;
}

/**
 * Declare one numbering definition per `orderedList` node.
 *
 * Word's `start` lives on the numbering *definition*, not on the paragraph, so
 * two ordered lists with different `start` values genuinely need two
 * definitions — sharing one would silently rewrite the second list's first
 * number. Each definition is only ever used at a single nesting level, so
 * `start` is applied to every level of it.
 */
function declareOrderedList(state: RenderState, start: number): string {
  const reference = `notted-ol-${state.numbering.length + 1}`;
  const levels: ILevelsOptions[] = [];
  for (let level = 0; level <= MAX_LIST_LEVEL; level += 1) {
    levels.push({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      start,
      style: {
        paragraph: {
          indent: { left: LIST_INDENT_TWIP * (level + 1), hanging: LIST_HANGING_TWIP },
        },
      },
    });
  }
  state.numbering.push({ reference, levels });
  return reference;
}

/** `attrs.start`, honoured when it is a usable positive integer. */
function orderedListStart(node: Record<string, unknown>): number {
  const start = attrsOf(node)?.start;
  return typeof start === "number" && Number.isInteger(start) && start >= 1 ? start : 1;
}

/**
 * The paragraph properties every block inherits from where it sits.
 *
 * DOCX has no nesting: a "quoted paragraph inside a list" is one flat paragraph
 * carrying both decorations, so they are computed here once rather than
 * re-derived at each of the twenty-odd call sites.
 */
function decoration(ctx: WalkContext): Omit<IParagraphOptions, "children"> {
  const level = Math.min(ctx.listLevel, MAX_LIST_LEVEL);
  const marker = ctx.marker;
  return {
    ...(marker?.kind === "bullet" ? { bullet: { level } } : {}),
    ...(marker?.kind === "number" ? { numbering: { reference: marker.reference, level } } : {}),
    // ponytail: DOCX has no blockquote element at all — the only faithful
    // representations are a paragraph style defined in styles.xml or this
    // indent+left-border pair. The pair is chosen because it survives into
    // Google Docs and LibreOffice unchanged, whereas a custom named style is
    // silently dropped by importers that do not know it. Ceiling: a reader
    // cannot select "the quote" as a unit. Upgrade path: register a real
    // `Quote` paragraph style on the `Document` and reference it here.
    ...(ctx.quoteDepth > 0
      ? {
          indent: {
            left: QUOTE_INDENT_TWIP * Math.min(ctx.quoteDepth, MAX_QUOTE_INDENT_LEVELS),
          },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: RULE_COLOR, space: 8 },
          },
        }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Marks -> run properties                                                      */
/* -------------------------------------------------------------------------- */

interface MarkFormatting {
  bold: boolean;
  italics: boolean;
  strike: boolean;
  underline: boolean;
  subScript: boolean;
  superScript: boolean;
  code: boolean;
  color: string | null;
  /** Half-points. */
  size: number | null;
  /** A named Word highlight, used when `highlight` carries no colour. */
  highlight: DocxHighlight | null;
  /** A hex fill, used when `highlight` or `code` needs a specific background. */
  shading: string | null;
  href: string | null;
}

/**
 * Fold the contract's ten mark types onto DOCX run properties.
 *
 * Every one of the ten has an explicit arm; `default` is reached only by a mark
 * type that is not in the contract at all, and degrades to unformatted text
 * rather than dropping the run. This mirrors `renderMark` in
 * `document.schema.ts` — same inputs, same validators, different output medium.
 */
function collectMarks(marks: unknown, ctx: WalkContext): MarkFormatting {
  const format: MarkFormatting = {
    bold: ctx.bold,
    italics: false,
    strike: false,
    underline: false,
    subScript: false,
    superScript: false,
    code: false,
    color: null,
    size: null,
    highlight: null,
    shading: null,
    href: null,
  };
  if (!Array.isArray(marks)) return format;

  for (const mark of marks.slice(0, NOTE_DOCUMENT_LIMITS.maxMarks)) {
    if (!isRecord(mark) || typeof mark.type !== "string") continue;
    const attrs = isRecord(mark.attrs) ? mark.attrs : undefined;
    switch (mark.type) {
      case "bold":
        format.bold = true;
        break;
      case "italic":
        format.italics = true;
        break;
      case "strike":
        format.strike = true;
        break;
      case "underline":
        // Native, unlike Markdown — DOCX has a real `w:u` run property.
        format.underline = true;
        break;
      case "code":
        format.code = true;
        break;
      case "subscript":
        format.subScript = true;
        break;
      case "superscript":
        format.superScript = true;
        break;
      case "link":
        // A URL the shared sanitizer refuses yields `null`, and the run is then
        // emitted plain: a rejected link must never become a live hyperlink.
        format.href = sanitizeDocumentUrl(attrs?.href);
        break;
      case "textStyle":
        // The one export format that carries author colour and font size intact.
        format.color = hexColor(attrs?.color) ?? format.color;
        format.size = halfPoints(attrs?.fontSize) ?? format.size;
        break;
      case "highlight": {
        const fill = hexColor(attrs?.color);
        if (fill === null) format.highlight = DEFAULT_HIGHLIGHT;
        else format.shading = fill;
        break;
      }
      default:
        // Not a contract mark type. The text survives; the unknown mark does not.
        break;
    }
  }
  return format;
}

function runOptions(text: string, format: MarkFormatting): IRunOptions {
  const shading = format.shading ?? (format.code ? CODE_SHADING_FILL : null);
  return {
    text,
    ...(format.bold ? { bold: true } : {}),
    ...(format.italics ? { italics: true } : {}),
    ...(format.strike ? { strike: true } : {}),
    ...(format.underline ? { underline: {} } : {}),
    ...(format.subScript ? { subScript: true } : {}),
    ...(format.superScript ? { superScript: true } : {}),
    ...(format.code ? { font: CODE_FONT } : {}),
    ...(format.color === null ? {} : { color: format.color }),
    ...(format.size === null ? {} : { size: format.size }),
    ...(format.highlight === null ? {} : { highlight: format.highlight }),
    ...(shading === null ? {} : { shading: { type: ShadingType.CLEAR, fill: shading } }),
  };
}

function textChildren(text: string, marks: unknown, ctx: WalkContext): ParagraphChild[] {
  const format = collectMarks(marks, ctx);
  const options = runOptions(text, format);
  if (format.href === null) return [new TextRun(options)];
  return [
    new ExternalHyperlink({
      link: format.href,
      children: [new TextRun({ ...options, style: "Hyperlink" })],
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Mentions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A mention becomes visible `@Label` text whose STABLE USER ID survives as the
 * name of a bookmark wrapped around that text.
 *
 * DOCX offers no non-visual attribute on a run — there is no `data-*` and no
 * anchor a plain run can carry. The three real carriers are a bookmark name, a
 * comment, and a custom document property; a bookmark is the only one of the
 * three that stays attached to *this* run rather than to the file. It emits
 * `<w:bookmarkStart w:name="mn_<uuid-without-hyphens>_<n>"/>`, which Word,
 * Google Docs and LibreOffice all round-trip, so `@Ada Lovelace` in an exported
 * note can still be resolved back to the user it addressed.
 *
 * A malformed mention degrades to its recoverable label as plain text, exactly
 * as `renderMentionHtml` and `extractNoteContentPlain` do: a node with no stable
 * UUID cannot address a user, so it must not pretend to.
 */
function mentionChildren(node: Record<string, unknown>, state: RenderState): ParagraphChild[] {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) {
    const uses = (state.mentionUses.get(attrs.id) ?? 0) + 1;
    state.mentionUses.set(attrs.id, uses);
    return [
      new Bookmark({
        id: `${MENTION_BOOKMARK_PREFIX}${attrs.id.replace(/-/gu, "")}_${uses}`,
        children: [new TextRun(`${NOTE_DOCUMENT_MENTION_PREFIX}${attrs.label}`)],
      }),
    ];
  }
  const rawLabel = attrsOf(node)?.label;
  if (typeof rawLabel !== "string") return [];
  const cleaned = rawLabel
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxMentionLabel);
  return cleaned.length === 0 ? [] : [new TextRun(`${NOTE_DOCUMENT_MENTION_PREFIX}${cleaned}`)];
}

/* -------------------------------------------------------------------------- */
/* Inline walk                                                                  */
/* -------------------------------------------------------------------------- */

function inlineChildren(
  content: readonly unknown[],
  ctx: WalkContext,
  state: RenderState,
): ParagraphChild[] {
  if (ctx.depth > MAX_WALK_DEPTH) return [];
  const next = { ...ctx, depth: ctx.depth + 1 };
  const children: ParagraphChild[] = [];
  for (const node of content.slice(0, NOTE_DOCUMENT_LIMITS.maxChildren)) {
    if (!isRecord(node)) continue;
    if (node.type === "text") {
      if (typeof node.text === "string") children.push(...textChildren(node.text, node.marks, ctx));
      continue;
    }
    if (node.type === "hardBreak") {
      children.push(new TextRun({ break: 1 }));
      continue;
    }
    if (node.type === "mention") {
      children.push(...mentionChildren(node, state));
      continue;
    }
    // Anything else nested inside a text block contributes its own inline text.
    children.push(...inlineChildren(childrenOf(node), next, state));
  }
  return children;
}

/** Code content is literal: marks are meaningless inside a `<pre>`, so only text is read. */
function plainText(content: readonly unknown[], depth: number): string {
  if (depth > MAX_WALK_DEPTH) return "";
  let text = "";
  for (const node of content.slice(0, NOTE_DOCUMENT_LIMITS.maxChildren)) {
    if (!isRecord(node)) continue;
    if (node.type === "text") text += typeof node.text === "string" ? node.text : "";
    else if (node.type === "hardBreak") text += "\n";
    else text += plainText(childrenOf(node), depth + 1);
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Block walk                                                                   */
/* -------------------------------------------------------------------------- */

type Block = Paragraph | Table;

function blocksForAll(content: readonly unknown[], ctx: WalkContext, state: RenderState): Block[] {
  const blocks: Block[] = [];
  for (const child of content.slice(0, NOTE_DOCUMENT_LIMITS.maxChildren)) {
    blocks.push(...blocksFor(child, ctx, state));
  }
  return blocks;
}

/**
 * A list nested inside another list steps one level in; an outermost list starts
 * at 0. `ctx.marker` is the only reliable "am I already in a list" signal,
 * because `listItem` passes it through untouched.
 */
function nestedListLevel(ctx: WalkContext): number {
  return ctx.marker === null ? 0 : Math.min(ctx.listLevel + 1, MAX_LIST_LEVEL);
}

/**
 * `codeBlock` becomes one monospace, shaded paragraph PER SOURCE LINE.
 *
 * A single paragraph containing newlines is not an option: DOCX paragraphs have
 * no literal line breaks, so the lines have to be real paragraphs or the whole
 * block collapses onto one line.
 *
 * THE LANGUAGE SURVIVES AS A SMALL ITALIC LABEL LINE above the block, not as a
 * paragraph style name. A style name would be invisible to every reader and
 * silently discarded by importers that do not know it; the label is the only
 * form in which "this is TypeScript" reaches a human opening the `.docx`. It is
 * emitted only when `normalizeNoteDocumentCodeLanguage` recognises the stored
 * value, so free text can never reach the output.
 */
function codeBlockBlocks(node: Record<string, unknown>, ctx: WalkContext): Block[] {
  // A code block inside a list item is not itself a bullet, so the marker is dropped.
  const props = decoration({ ...ctx, marker: null });
  const language = normalizeNoteDocumentCodeLanguage(attrsOf(node)?.language);
  const blocks: Block[] = [];
  if (language !== null) {
    blocks.push(
      new Paragraph({
        ...props,
        children: [
          new TextRun({
            text: language,
            italics: true,
            font: CODE_FONT,
            size: CODE_LABEL_HALF_POINTS,
            color: RULE_COLOR,
          }),
        ],
      }),
    );
  }
  for (const line of plainText(childrenOf(node), ctx.depth).split("\n")) {
    blocks.push(
      new Paragraph({
        ...props,
        children: [
          new TextRun({
            text: line,
            font: CODE_FONT,
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING_FILL },
          }),
        ],
      }),
    );
  }
  return blocks;
}

/**
 * `taskItem` becomes a `☐ `/`☑ `-prefixed, indented paragraph.
 *
 * ponytail: the "real" DOCX answer is an SDT content control — `docx` even
 * exports a `CheckBox` run for it — which Word renders as a clickable box. It is
 * deliberately NOT used: a content control is interactive state in an artefact
 * that is a point-in-time snapshot, so a reader ticking a box in their download
 * would produce a document that disagrees with the note and can never sync back.
 * Ceiling: the checked state is visual only and cannot be toggled meaningfully.
 * Upgrade path: swap the glyph run for `new CheckBox({ checked })` if exports
 * ever become a round-trippable editing surface.
 *
 * No `bullet:` is applied on top of the glyph — Word would then draw its own
 * bullet next to the box, which reads as two markers for one item.
 */
function taskItemBlocks(
  node: Record<string, unknown>,
  ctx: WalkContext,
  state: RenderState,
): Block[] {
  const checked = attrsOf(node)?.checked === true;
  const level = Math.min(ctx.listLevel, MAX_LIST_LEVEL);
  const props = {
    ...decoration({ ...ctx, marker: null }),
    indent: { left: LIST_INDENT_TWIP * (level + 1), hanging: LIST_HANGING_TWIP },
  };
  const glyph = new TextRun(checked ? TASK_GLYPHS.checked : TASK_GLYPHS.unchecked);
  const next = { ...ctx, depth: ctx.depth + 1 };

  const blocks: Block[] = [];
  let glyphPending = true;
  for (const child of childrenOf(node).slice(0, NOTE_DOCUMENT_LIMITS.maxChildren)) {
    if (isRecord(child) && child.type === "paragraph" && glyphPending) {
      glyphPending = false;
      blocks.push(
        new Paragraph({
          ...props,
          alignment: alignmentOf(child),
          children: [glyph, ...inlineChildren(childrenOf(child), next, state)],
        }),
      );
      continue;
    }
    blocks.push(...blocksFor(child, { ...next, listLevel: nestedListLevel(ctx) }, state));
  }
  // An item with no paragraph of its own still shows its box rather than vanishing.
  if (glyphPending) blocks.unshift(new Paragraph({ ...props, children: [glyph] }));
  return blocks;
}

/**
 * `image` contributes its ALT TEXT and CAPTION as paragraphs, never bytes.
 *
 * There are no attachment bytes in this converter's inputs and there cannot be:
 * `ExportSourceDocument` carries the note's JSON and nothing else, and the
 * document contract structurally forbids an image node from holding a `src`,
 * `dataUri` or URL. Resolving `attachmentId` to bytes needs an authorized,
 * workspace-scoped read — which is exactly what the `zip` converter does and
 * what this pure function must not.
 *
 * ponytail: embedding is a real upgrade, not a wish — `docx` supports it through
 * `ImageRun`. Ceiling: a `.docx` export shows what the image *said*, not what it
 * looked like. Upgrade path: hand `renderDocx` a resolved
 * `attachmentId -> Buffer` map from the worker (which already holds the
 * authorized reader) and emit `ImageRun` when the id resolves.
 */
function imageBlocks(node: Record<string, unknown>): Block[] {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs === null) return [];
  const blocks: Block[] = [];
  if (attrs.alt.length > 0) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: attrs.alt, italics: true })] }));
  }
  if (attrs.caption.length > 0) {
    blocks.push(new Paragraph({ children: [new TextRun({ text: attrs.caption, italics: true })] }));
  }
  return blocks;
}

/** `attachment` becomes one paragraph: the filename and a human-readable size. */
function attachmentBlocks(node: Record<string, unknown>): Block[] {
  const attrs = noteDocumentAttachmentAttrs(node.attrs);
  if (attrs === null) return [];
  return [
    new Paragraph({
      children: [
        new TextRun({ text: attrs.name, bold: true }),
        new TextRun(` (${formatBinaryBytes(attrs.sizeBytes)})`),
      ],
    }),
  ];
}

/**
 * `table` becomes a real `Table`, and `colspan`/`rowspan` become real
 * `gridSpan`/`vMerge` — DOCX supports both natively, so nothing is collapsed.
 *
 * `docx` throws on a table with no rows and on a cell with no children, so both
 * are guarded: a degenerate stored table is skipped rather than turned into a
 * job failure.
 */
function tableBlocks(node: Record<string, unknown>, ctx: WalkContext, state: RenderState): Block[] {
  const rows: TableRow[] = [];
  for (const rowNode of childrenOf(node).slice(0, NOTE_DOCUMENT_LIMITS.maxTableRows)) {
    const row = tableRow(rowNode, ctx, state);
    if (row !== null) rows.push(row);
  }
  if (rows.length === 0) return [];
  return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })];
}

function tableRow(node: unknown, ctx: WalkContext, state: RenderState): TableRow | null {
  if (!isRecord(node)) return null;
  const cellNodes = childrenOf(node).slice(0, NOTE_DOCUMENT_LIMITS.maxTableColumns);
  const cells: TableCell[] = [];
  for (const cellNode of cellNodes) {
    const cell = tableCell(cellNode, ctx, state);
    if (cell !== null) cells.push(cell);
  }
  if (cells.length === 0) return null;
  // `tableHeader: true` repeats the row on every page — correct only when the
  // whole row is header cells, which is the only shape prosemirror-tables makes.
  const isHeaderRow = cellNodes.every((cell) => isRecord(cell) && cell.type === "tableHeader");
  return new TableRow({ children: cells, ...(isHeaderRow ? { tableHeader: true } : {}) });
}

function tableCell(node: unknown, ctx: WalkContext, state: RenderState): TableCell | null {
  if (!isRecord(node)) return null;
  const header = node.type === "tableHeader";
  const attrs = attrsOf(node);
  const columnSpan = cellSpan(attrs?.colspan);
  const rowSpan = cellSpan(attrs?.rowspan);
  const inner = blocksForAll(
    childrenOf(node),
    { depth: ctx.depth + 1, listLevel: 0, marker: null, quoteDepth: 0, bold: header },
    state,
  );
  return new TableCell({
    ...(columnSpan === null ? {} : { columnSpan }),
    ...(rowSpan === null ? {} : { rowSpan }),
    ...(header ? { shading: { type: ShadingType.CLEAR, fill: TABLE_HEADER_FILL } } : {}),
    // `docx` refuses an empty cell; an empty paragraph is the faithful rendering.
    children: inner.length > 0 ? inner : [new Paragraph({})],
  });
}

/**
 * The one switch. EVERY one of the contract's 21 node types is named here.
 *
 * `default` is reached only by a type that is not in the contract at all — a
 * document written by a future schema version, say — and it degrades to whatever
 * text the node carries rather than dropping it. A silent drop is how an export
 * loses a paragraph nobody notices for six months.
 */
function blocksFor(node: unknown, ctx: WalkContext, state: RenderState): Block[] {
  if (ctx.depth > MAX_WALK_DEPTH || !isRecord(node)) return [];
  const next: WalkContext = { ...ctx, depth: ctx.depth + 1 };

  switch (node.type) {
    case "doc":
      return blocksForAll(childrenOf(node), { ...next, marker: null }, state);

    case "paragraph":
      return [
        new Paragraph({
          ...decoration(ctx),
          alignment: alignmentOf(node),
          children: inlineChildren(childrenOf(node), next, state),
        }),
      ];

    case "heading":
      return [
        new Paragraph({
          ...decoration(ctx),
          heading: headingLevel(node),
          alignment: alignmentOf(node),
          children: inlineChildren(childrenOf(node), next, state),
        }),
      ];

    // A bare inline node found where a block belongs still contributes its text.
    case "text":
    case "mention":
      return [new Paragraph({ ...decoration(ctx), children: inlineChildren([node], next, state) })];

    case "bulletList":
      return blocksForAll(
        childrenOf(node),
        { ...next, marker: { kind: "bullet" }, listLevel: nestedListLevel(ctx) },
        state,
      );

    case "orderedList":
      return blocksForAll(
        childrenOf(node),
        {
          ...next,
          marker: { kind: "number", reference: declareOrderedList(state, orderedListStart(node)) },
          listLevel: nestedListLevel(ctx),
        },
        state,
      );

    case "taskList":
      return blocksForAll(
        childrenOf(node),
        { ...next, marker: { kind: "task" }, listLevel: nestedListLevel(ctx) },
        state,
      );

    // Items keep their list's marker and level; a list nested inside one steps in.
    case "listItem":
      return blocksForAll(childrenOf(node), next, state);

    case "taskItem":
      return taskItemBlocks(node, ctx, state);

    case "blockquote":
      return blocksForAll(
        childrenOf(node),
        { ...next, quoteDepth: ctx.quoteDepth + 1, marker: null },
        state,
      );

    case "codeBlock":
      return codeBlockBlocks(node, next);

    // A stray inline break between blocks becomes an empty line, not nothing.
    case "hardBreak":
      return [new Paragraph({ ...decoration(ctx), children: [new TextRun({ break: 1 })] })];

    case "horizontalRule":
      return [
        new Paragraph({
          ...decoration(ctx),
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR, space: 1 } },
        }),
      ];

    // The one node DOCX represents natively and better than every other export
    // format: a real `<w:br w:type="page"/>`, not a CSS hint or a row of dashes.
    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];

    case "table":
      return tableBlocks(node, next, state);

    // Rows and cells outside a table are structurally impossible in the contract,
    // but a historical document is not the contract: render their content flat.
    case "tableRow":
    case "tableHeader":
    case "tableCell":
      return blocksForAll(childrenOf(node), next, state);

    case "image":
      return imageBlocks(node);

    case "attachment":
      return attachmentBlocks(node);

    default: {
      const nested = blocksForAll(childrenOf(node), next, state);
      if (nested.length > 0) return nested;
      const text = typeof node.text === "string" ? node.text : "";
      return text.length === 0
        ? []
        : [new Paragraph({ ...decoration(ctx), children: [new TextRun(text)] })];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

/** The `.docx` artefact. Async because `Packer.toBuffer` is. */
export async function renderDocx(source: ExportSourceDocument): Promise<ExportArtifact> {
  // `pageSize` is authoritative server state; `options.margins` came out of
  // someone's `localStorage`, so it is clamped before it can reach the section.
  const sheet = pageDimensionsMm(source.pageSize);
  const margins = resolveExportMargins(source.options);
  // `docx`'s own converter, not a hand-rolled 56.6929 constant: one source of
  // truth for the unit, and it is the one the package's own tests cover.
  const twip = convertMillimetersToTwip;

  const state: RenderState = { numbering: [], mentionUses: new Map() };
  const body = blocksFor(
    source.content,
    {
      depth: 0,
      listLevel: 0,
      marker: null,
      quoteDepth: 0,
      bold: false,
    },
    state,
  );

  // `headerText`/`footerText` are already trimmed and length-capped by
  // `exportOptionsSchema`, so they are written verbatim — `docx` escapes the XML.
  const { headerText, footerText } = source.options;

  const document = new Document({
    title: source.title,
    numbering: { config: state.numbering },
    sections: [
      {
        properties: {
          page: {
            size: { width: twip(sheet.width), height: twip(sheet.height) },
            margin: {
              top: twip(margins.y),
              bottom: twip(margins.y),
              left: twip(margins.x),
              right: twip(margins.x),
            },
          },
        },
        ...(headerText === null || headerText === ""
          ? {}
          : { headers: { default: new Header({ children: [new Paragraph(headerText)] }) } }),
        ...(footerText === null || footerText === ""
          ? {}
          : { footers: { default: new Footer({ children: [new Paragraph(footerText)] }) } }),
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(source.title)] }),
          ...body,
        ],
      },
    ],
  });

  return Object.freeze({
    body: Buffer.from(await Packer.toBuffer(document)),
    ...EXPORT_FORMAT_MEDIA.docx,
  });
}
