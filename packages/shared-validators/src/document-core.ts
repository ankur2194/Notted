/**
 * The note document's VOCABULARY: its limits, its node and mark names, the
 * per-node attribute parsers, and the plain-text projections built from them.
 *
 * Split out of `document.schema.ts`, which was 2 815 lines. This module answers
 * "what is a valid image attribute set?"; `document.schema.ts` answers "is this
 * whole document valid?", `document-html.ts` renders one, `document-text.ts`
 * flattens one, and `document-migrate.ts` repairs one. All four need this
 * vocabulary, and none of them needs each other — which is why this is the leaf
 * and not a slice of the middle.
 *
 * IT IMPORTS NOTHING FROM THE SCHEMA, deliberately. That is what keeps the split
 * acyclic: `document.schema.ts` re-exports this module, so every existing
 * importer is untouched, and an edge in the other direction would make that
 * re-export a cycle.
 *
 * Every attribute parser here returns `null` rather than throwing, and every one
 * of them is the SECOND check — the wire schema ran first. They exist because a
 * document that has been through a migration, an old client, or a hand-edited
 * paste can be shaped correctly and still carry a value no renderer should
 * touch.
 */

import { HEX_COLOR_PATTERN } from "./common.schema";

/** Any JSON object, before anything has proved what kind of node it is. */
export type PlainRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Contract-only version. Part 33 adds no database column; a persisted version
 * and reviewed backfill are required only before an incompatible contract is
 * introduced.
 *
 * **Still 1 after Part 42's `image` node**, for the same reason Part 38's
 * `pageBreak` left it at 1: the change is purely *additive and forward-only*.
 * A new node type widens what the contract accepts, so every document already
 * stored as v1 is still valid v1, `migrateNoteDocument` has nothing to do, and
 * no reader anywhere branches on the number — there is no persisted version
 * column, so bumping it would change a constant nothing reads while implying a
 * migration that does not exist.
 *
 * **Trigger for the first real bump.** The first *incompatible* change — one
 * that removes a node/mark/attribute, narrows an accepted value, or changes the
 * meaning of a stored attribute so an old document would be rejected or
 * silently misread — must, in the same part: bump this constant, add the
 * persisted `content_schema_version` column to `notes`, and ship a reviewed
 * backfill plus a read-path migration keyed off that column. Adding a node type
 * is not that change; renaming or re-typing one is.
 */
export const NOTE_DOCUMENT_SCHEMA_VERSION = 1 as const;

/**
 * Bounds retained from the Part 31 transitional safety envelope, plus the
 * explicit table bounds added in Part 35 and the mention bounds added in
 * Part 36. `maxNodes`/`maxChildren` alone would still admit a single
 * pathological table, so rows, columns, total cells, cell spans, and stored
 * column widths are each capped on their own. A mention is likewise capped
 * twice: `maxMentionLabel` bounds a single cached display name far below the
 * generic `maxString`, and `maxMentions` bounds how many a document may carry
 * so a later notification fan-out can never be unbounded.
 *
 * Part 42's image bounds follow the same shape. `maxImages` bounds how many
 * attachment references one note may carry, so opening a note can never fan out
 * into an unbounded number of authorized content requests; `maxImageAlt` bounds
 * the one free-text field an image stores; and `maxImageDimension` bounds the
 * *stored* intrinsic size, which is only ever a layout hint — the authoritative
 * pixel budget is enforced server-side by the Part 41 pipeline.
 *
 * Part 43 adds `maxImageCaption`. A caption is the second free-text field an
 * image stores and, unlike alt, it is *rendered visibly* in the note, in the
 * print sheet, and in every export — so it is bounded on its own rather than
 * left to the generic `maxString`. It is set higher than `maxImageAlt` because a
 * caption is prose meant to be read, while an alternative text is a short
 * description, but it is still two orders of magnitude below `maxString` so a
 * hundred captions cannot dominate a note's serialized size.
 *
 * Part 44 adds the three `attachment` bounds, shaped exactly like the image
 * ones. `maxAttachments` bounds how many generic files one note may reference,
 * for the same reason `maxImages` does — opening a note must never fan out into
 * an unbounded number of authorized metadata or content requests.
 * `maxAttachmentName` matches the `attachments.filename` column bound (255) so a
 * name the API can store is always a name the document can carry.
 * `maxAttachmentSizeBytes` matches `MAX_UPLOAD_SIZE_BYTES`' own hard maximum
 * (2 GiB), which is the largest value any operator can configure; the *stored*
 * number is only a display hint, and the authoritative size is the
 * `attachments.size_bytes` column the server measured.
 */
export const NOTE_DOCUMENT_LIMITS = Object.freeze({
  serializedBytes: 512_000,
  maxDepth: 32,
  maxNodes: 2_000,
  maxChildren: 200,
  /*
   * The ROOT's child count, deliberately separate from `maxChildren`.
   *
   * `maxChildren: 200` is a per-node fan-out guard, and applying it to the
   * document root turned it into a cap on how many top-level blocks a whole
   * note may contain: 201 paragraphs is about 21 KB, roughly four pages, and it
   * was refused while the note was nominally allowed 2 000 nodes and 512 KB.
   * `Notted.md` promises no document size limit at all, and the Part 77
   * benchmark's own 380-paragraph fixture was being rejected by it.
   *
   * 2 000 matches `maxNodes` so this can never bind BEFORE the node budget —
   * a paragraph costs two nodes, so real headroom is around 1 000 blocks, and
   * `maxTotalText` and `serializedBytes` bound it further. This removes an
   * artificially low second ceiling; it does not add one.
   */
  maxRootChildren: 2_000,
  maxMarks: 20,
  maxAttributes: 32,
  maxAttributeDepth: 6,
  maxAttributeArray: 50,
  maxString: 20_000,
  maxTotalText: 200_000,
  maxTableRows: 100,
  maxTableColumns: 32,
  maxTableCells: 600,
  maxTableCellSpan: 100,
  maxTableColumnWidth: 2_000,
  /**
   * `orderedList.start` had a floor of 1 and no ceiling, so
   * `Number.MAX_SAFE_INTEGER` validated and rendered
   * `<ol start="9007199254740991">`. 10 000 is far above any list a person
   * writes and far below the range where the number stops being a list
   * position and starts being a payload; `maxRootChildren` (2 000) is the real
   * bound on how many items can follow it.
   */
  maxOrderedListStart: 10_000,
  maxMentions: 200,
  maxMentionLabel: 200,
  maxImages: 100,
  maxImageAlt: 500,
  maxImageCaption: 1_000,
  maxImageDimension: 10_000,
  maxAttachments: 100,
  maxAttachmentName: 255,
  maxAttachmentSizeBytes: 2 * 1_024 * 1_024 * 1_024,
} as const);

export const NOTE_DOCUMENT_NODE_TYPES = Object.freeze([
  "doc",
  "paragraph",
  "heading",
  "text",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
  "pageBreak",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "mention",
  "image",
  "attachment",
] as const);
export type NoteDocumentNodeType = (typeof NOTE_DOCUMENT_NODE_TYPES)[number];

/** Rendered before a mention's cached label, in HTML and in plain text alike. */
export const NOTE_DOCUMENT_MENTION_PREFIX = "@" as const;

/** Sole class emitted for a mention; the renderer never copies stored classes. */
export const NOTE_DOCUMENT_MENTION_CLASS = "notted-mention" as const;

/**
 * Sole class emitted for an explicit page break (Part 38).
 *
 * The editor's own `renderHTML`, the screen stylesheet, `styles/print.css`
 * (`break-after: page`), and Part 63's server-side Puppeteer template all key
 * off this one class, so the printed pagination of an exported note matches what
 * the editor showed. A `div` is used rather than an `hr` because `break-after`
 * on a block box is unambiguous in every engine, while `hr` carries a separator
 * semantic the node does not mean.
 */
export const NOTE_DOCUMENT_PAGE_BREAK_CLASS = "notted-page-break" as const;

/**
 * Sole class emitted for an embedded image (Part 42).
 *
 * The editor's own `renderHTML`, the node view, the screen stylesheet, and
 * Part 63's export template all key off this one class, exactly as they do for
 * `NOTE_DOCUMENT_MENTION_CLASS`. Stored classes are never copied through.
 */
export const NOTE_DOCUMENT_IMAGE_CLASS = "notted-image" as const;

/**
 * The figure wrapper and caption emitted around an image (Part 43).
 *
 * The wrapper is what carries alignment, wrap mode, and full width, so the same
 * three data attributes drive the editor's node view, `styles/globals.css`,
 * `styles/print.css`, and Part 63's standalone export — one markup contract, no
 * per-surface rules.
 */
export const NOTE_DOCUMENT_IMAGE_FIGURE_CLASS = "notted-image-figure" as const;
export const NOTE_DOCUMENT_IMAGE_CAPTION_CLASS = "notted-image-caption" as const;

/**
 * The classes emitted for a generic file attachment card (Part 44).
 *
 * Same contract shape as the image classes: the editor's node view, the screen
 * stylesheet, `styles/print.css`, and Part 63's export template all key off
 * these four and nothing else. No class, style, or attribute stored on the node
 * is ever copied through to the output.
 */
export const NOTE_DOCUMENT_ATTACHMENT_CLASS = "notted-attachment" as const;
export const NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS = "notted-attachment-name" as const;
export const NOTE_DOCUMENT_ATTACHMENT_META_CLASS = "notted-attachment-meta" as const;
export const NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS = "notted-attachment-size" as const;

export interface NoteDocumentMentionAttrs {
  /** Stable user id. Display names change; this never does. */
  readonly id: string;
  /** Display-name snapshot taken when the mention was inserted. Untrusted. */
  readonly label: string;
}

/**
 * Text that must never survive into a name a human reads.
 *
 * C0 controls (including NUL), DEL/C1, the zero-width characters, and the
 * Unicode bidirectional overrides and isolates. U+202E is the one that matters
 * most: `photo<RLO>gnp.exe` renders to a reader as `photoexe.png`, so a name
 * that passes review can execute as something else. The zero-width characters
 * are the quieter half — they break search and make two visually identical
 * names distinct.
 *
 * THIS TABLE IS THE SINGLE COPY. `apps/api/src/attachments/filename.ts` used to
 * carry its own, correct and wider, list while this one covered only C0/C1 —
 * so the upload sanitiser stripped `U+202E` and the document contract happily
 * accepted it in an attachment name, an image alt, a caption, and a cached
 * mention label. Two copies of a security table drift, and nothing fails when
 * they do; per ADR 0001 the shared fact lives in the package and the app reads
 * it, never the reverse.
 *
 * NO `g` FLAG. A global regex carries mutable `lastIndex` across `.test()`
 * calls, which is why every caller below used to need a `lastIndex = 0` reset;
 * exporting a global regex would make that footgun cross-package.
 */
export const UNSAFE_TEXT_PATTERN =
  // eslint-disable-next-line no-control-regex -- matching them is the point.
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/** The same table as a global regex, for the replace-based salvage paths. */
export const UNSAFE_TEXT_PATTERN_GLOBAL = new RegExp(UNSAFE_TEXT_PATTERN.source, "gu");

/** Remove every unsafe character. Used where rejecting would strand a caller. */
export function stripUnsafeText(value: string): string {
  return value.replace(UNSAFE_TEXT_PATTERN_GLOBAL, "");
}

/**
 * A cached display name is untrusted text that is echoed back to every reader,
 * so it is bounded and stripped of control characters here — before it can
 * reach the renderer or the plain-text projection — rather than only escaped at
 * the point of use. Keeping the label single-line also keeps the plain-text
 * projection's one-line-per-block shape intact.
 */
export function isUsableMentionLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > NOTE_DOCUMENT_LIMITS.maxMentionLabel) return false;
  return !UNSAFE_TEXT_PATTERN.test(value);
}

/**
 * The same rule `uuidSchema` enforces, as a plain regex.
 *
 * This ran `uuidSchema.safeParse` per UUID attribute, from `validateNodeAttrs`,
 * the three attribute readers, and every render path — and
 * `TiptapEditor.handleUpdate` calls `safeParseNoteDocument(editor.getJSON())` on
 * EVERY editor transaction, i.e. every keystroke. Building a Zod result object
 * per attribute per keystroke is the wrong shape for this position; the file
 * already prefers module-level regexes for every other hot predicate
 * (`UNSAFE_TEXT_PATTERN`, `URL_SCHEME_PATTERN`, `HTTP_HOST_LABEL_PATTERN`), and
 * this was the lone Zod holdout among them.
 *
 * Version-agnostic: the shape it enforces is "36 hex characters in 8-4-4-4-12",
 * not "RFC 4122 v4". `uuidSchema` is stricter — zod's `uuid()` also checks the
 * version and variant nibbles — and that asymmetry is safe rather than drift:
 * every id that reaches a document attribute was already validated at the API
 * boundary by `uuidSchema`, so this predicate guards the shape of stored
 * content, not the trust boundary.
 *
 * The leading lookahead is the part the two DO share. It refuses the nil and
 * max UUIDs, the two well-formed UUIDs that can never name a row —
 * `gen_random_uuid()` cannot emit either — so a `mention.id` carrying one
 * addresses nobody, and this predicate feeds `collectNoteDocumentMentionIds`,
 * which is documented as the single source of truth for who gets notified.
 */
export const UUID_VALUE_PATTERN =
  /^(?!(?:0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuidValue(value: unknown): value is string {
  return typeof value === "string" && UUID_VALUE_PATTERN.test(value);
}

export function isMentionId(value: unknown): value is string {
  return isUuidValue(value);
}

/**
 * Return the two reviewed mention attributes, or `null` when the node does not
 * carry a stable user id and a usable label. Never throws.
 */
export function noteDocumentMentionAttrs(attrs: unknown): NoteDocumentMentionAttrs | null {
  if (!isRecord(attrs)) return null;
  const { id, label } = attrs;
  return isMentionId(id) && isUsableMentionLabel(label) ? { id, label } : null;
}

/** `@Ada Lovelace` for a usable mention, or an empty string when unusable. */
export function mentionPlainText(node: PlainRecord): string {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) return `${NOTE_DOCUMENT_MENTION_PREFIX}${attrs.label}`;
  // A malformed historical mention still contributes whatever readable label it
  // stored, so recovery degrades to text rather than silently dropping it.
  const rawLabel = isRecord(node.attrs) ? node.attrs.label : undefined;
  if (typeof rawLabel !== "string") return "";
  const cleaned = rawLabel
    .replace(UNSAFE_TEXT_PATTERN_GLOBAL, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxMentionLabel);
  return cleaned.length === 0 ? "" : `${NOTE_DOCUMENT_MENTION_PREFIX}${cleaned}`;
}

/**
 * Part 60 — every distinct, well-formed mention user id in a document, in
 * first-seen order.
 *
 * ONE walker, both sides. `MentionNotificationProducer` diffs the previous and
 * next document with it to derive the mentions a save ADDED; the editor uses the
 * same function so the two can never disagree about what counts as a mention.
 *
 * A malformed mention (no stable UUID id, or an unusable label) is SKIPPED for
 * the same reason `mentionPlainText` degrades it to text: it cannot address a
 * user, so it must never become a notification recipient. Filtering here rather
 * than at the producer keeps the "what is a mention" rule in the one file that
 * already owns the node contract.
 */
/*
 * DEPTH GUARD, shared by the five walkers below.
 *
 * These read RAW PERSISTED JSON. Every write path validates first — and
 * `validateNode` refuses anything past `maxDepth` — so no document written
 * today can reach them over-deep. That makes this defence in depth, not a live
 * crash: it is here because `export-renderers.ts` and `export-html.ts` both
 * already CLAIM these walkers "walk defensively" and they did not, and because
 * a restore, a hand-written migration, or a future lowering of `maxDepth` would
 * make the claim load-bearing overnight. A stack overflow in the export worker
 * is a crashed process, not a failed-export record.
 *
 * Truncate, never throw, and never diverge between a collector and a renderer:
 * a collector that throws fails a save, and a renderer that throws turns a
 * degraded export into no export. Both export converters
 * (`converters/docx.ts`, `converters/markdown.ts`) already settled on exactly
 * this, importing the same constant rather than copying 32 — see their headers.
 */
export const MAX_WALK_DEPTH = NOTE_DOCUMENT_LIMITS.maxDepth;

export function collectNoteDocumentMentionIds(document: unknown): readonly string[] {
  const ids = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      // An array is a `content` list, not a nesting level: descending into it
      // must NOT cost depth, or this walker would count every level twice and
      // truncate documents `validateNode` accepts.
      for (const child of node) visit(child, depth);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "mention") {
      const attrs = noteDocumentMentionAttrs(node.attrs);
      if (attrs !== null) ids.add(attrs.id);
      // A mention is an atom: no content to descend into.
      return;
    }
    visit(node.content, depth + 1);
  };
  visit(document, 0);
  return Object.freeze([...ids]);
}

/** How an image sits in the content column (Part 43). */
export const NOTE_DOCUMENT_IMAGE_ALIGNMENTS = Object.freeze(["left", "center", "right"] as const);
export type NoteDocumentImageAlign = (typeof NOTE_DOCUMENT_IMAGE_ALIGNMENTS)[number];

/**
 * `block` breaks the text around the figure; `inline` floats it so following
 * text flows beside it (`Notted.md`: "Wrap Text: Inline or break text").
 */
export const NOTE_DOCUMENT_IMAGE_WRAP_MODES = Object.freeze(["block", "inline"] as const);
export type NoteDocumentImageWrap = (typeof NOTE_DOCUMENT_IMAGE_WRAP_MODES)[number];

export const IMAGE_ALIGN_VALUES: ReadonlySet<string> = new Set(NOTE_DOCUMENT_IMAGE_ALIGNMENTS);
export const IMAGE_WRAP_VALUES: ReadonlySet<string> = new Set(NOTE_DOCUMENT_IMAGE_WRAP_MODES);

export const NOTE_DOCUMENT_IMAGE_ALIGN_DEFAULT: NoteDocumentImageAlign = "center";
export const NOTE_DOCUMENT_IMAGE_WRAP_DEFAULT: NoteDocumentImageWrap = "block";

/**
 * The eight attributes an embedded image stores (Part 42, widened by Part 43).
 *
 * **There is deliberately no `src`, `url`, `previewUrl`, or `dataUri` field, and
 * `NODE_ALLOWED_ATTRS.image` rejects one.** That absence is the structural
 * guarantee behind the Part 42 criterion "the saved document never relies on
 * temporary blob or base64 URLs": a `blob:` preview or a `data:` placeholder has
 * nowhere in the contract to live, so no code path — not a bug, not a future
 * refactor, not a hostile client — can persist one. A reader resolves bytes by
 * asking the authorized content endpoint for `attachmentId`, which re-checks
 * workspace membership on every request; the blur placeholder travels in the
 * attachment metadata projection instead, never in the document.
 *
 * `width`/`height` are the pixel box the figure occupies. Part 42 recorded the
 * *intrinsic* size at insertion so a renderer could reserve layout space; Part 43
 * lets an author resize the figure and stores the result in the same two fields.
 * That is deliberately **not** a re-typing of a stored attribute (which would
 * force a schema-version bump, see `NOTE_DOCUMENT_SCHEMA_VERSION`): the accepted
 * values are unchanged, `null` is still always allowed, and a historical value is
 * still read as "how wide this figure's box is" — exactly what the Part 42
 * renderer already used it for. They remain advisory: a renderer clamps them to
 * the printable column, and nothing trusts them for anything but layout.
 *
 * The four Part 43 additions are all *additive with defaults*, so every document
 * stored before Part 43 is still valid and still means what it meant: an absent
 * `align` is `center`, an absent `wrap` is `block`, an absent `fullWidth` is
 * `false`, and an absent `caption` is `""` — which is precisely how a Part 42
 * image already rendered.
 */
export interface NoteDocumentImageAttrs {
  /** Stable attachment UUID. The only handle on the bytes. */
  readonly attachmentId: string;
  /** Text alternative. `""` means *decorative* and is an explicit, valid value. */
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Horizontal placement of the figure inside the content column. */
  readonly align: NoteDocumentImageAlign;
  /** `inline` floats the figure so following text wraps around it. */
  readonly wrap: NoteDocumentImageWrap;
  /**
   * Span the whole printable column, ignoring `width`. Mutually exclusive with
   * `wrap: "inline"` in *rendering* — see `resolveNoteImageWrap`, which is the
   * single place that conflict is resolved.
   */
  readonly fullWidth: boolean;
  /** Visible caption rendered in a `<figcaption>`. `""` means no caption. */
  readonly caption: string;
}

/**
 * A full-width figure occupies the entire content column, so there is no room
 * beside it for text to flow: `fullWidth` therefore **wins** over
 * `wrap: "inline"`, and this function is the one place that rule lives.
 *
 * It is resolved at *render* time rather than at validation time on purpose.
 * Rejecting the combination would let the editor produce a document
 * `safeParseNoteDocument` refuses — which silently and permanently stops autosave
 * for that session (Part 39) — and silently rewriting a stored attribute during
 * validation would make a round trip lossy. Both values are stored verbatim; the
 * renderer, the print sheet, and `normalizeImageNode` all agree by calling this.
 */
export function resolveNoteImageWrap(attrs: {
  readonly wrap: NoteDocumentImageWrap;
  readonly fullWidth: boolean;
}): NoteDocumentImageWrap {
  return attrs.fullWidth ? "block" : attrs.wrap;
}

/**
 * Alt text is untrusted author input echoed to every reader, so it is bounded
 * and stripped of control characters here rather than only escaped at the point
 * of use — the same treatment a mention's cached label gets. Empty is valid and
 * means the image is decorative (WAI `alt=""`).
 */
export function isUsableImageAlt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > NOTE_DOCUMENT_LIMITS.maxImageAlt) return false;
  return !UNSAFE_TEXT_PATTERN.test(value);
}

/**
 * A caption gets the identical treatment to alt at its own, larger bound. It is
 * rendered visibly, so escaping at the point of use is still required — this
 * check only removes the values that have no business being stored at all.
 */
export function isUsableImageCaption(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > NOTE_DOCUMENT_LIMITS.maxImageCaption) return false;
  return !UNSAFE_TEXT_PATTERN.test(value);
}

/** Absent/`undefined` means "use the default"; any other unusable value is invalid. */
export function isImageCaption(value: unknown): value is string | undefined {
  return value === undefined || isUsableImageCaption(value);
}

/** Absent/`undefined` means "use the default"; any other non-member is invalid. */
export function isImageAlign(value: unknown): value is NoteDocumentImageAlign | undefined {
  return value === undefined || (typeof value === "string" && IMAGE_ALIGN_VALUES.has(value));
}

export function isImageWrap(value: unknown): value is NoteDocumentImageWrap | undefined {
  return value === undefined || (typeof value === "string" && IMAGE_WRAP_VALUES.has(value));
}

/**
 * Strictly boolean. `"true"`, `1`, and `null` are all rejected rather than
 * coerced: a layout flag that quietly accepts truthy values is a flag whose
 * stored meaning depends on which client wrote it.
 */
export function isImageFullWidth(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** `null`, absent, or a positive integer within the stored-dimension bound. */
export function isImageDimension(value: unknown): value is number | null | undefined {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= NOTE_DOCUMENT_LIMITS.maxImageDimension
  );
}

export function imageDimensionOrNull(value: unknown): number | null {
  return isImageDimension(value) && typeof value === "number" ? value : null;
}

/**
 * Return the reviewed image attributes, or `null` when the node does not carry a
 * stable attachment id and a usable alt. Never throws.
 *
 * The four Part 43 layout attributes are **optional on input and always present
 * on output**: absent means the documented default. That is what keeps every
 * document written before Part 43 readable without a migration, and it is why
 * adding them did not bump `NOTE_DOCUMENT_SCHEMA_VERSION`. A *present but
 * invalid* value is still rejected, so `"align": "diagonal"` degrades through
 * `normalizeImageNode` rather than reaching a renderer.
 */
export function noteDocumentImageAttrs(attrs: unknown): NoteDocumentImageAttrs | null {
  if (!isRecord(attrs)) return null;
  const { attachmentId, alt, width, height, align, wrap, fullWidth, caption } = attrs;
  if (!isUuidValue(attachmentId) || !isUsableImageAlt(alt)) return null;
  if (!isImageDimension(width) || !isImageDimension(height)) return null;
  if (!isImageAlign(align) || !isImageWrap(wrap)) return null;
  if (!isImageFullWidth(fullWidth) || !isImageCaption(caption)) return null;
  return {
    attachmentId,
    alt,
    width: imageDimensionOrNull(width),
    height: imageDimensionOrNull(height),
    align: align ?? NOTE_DOCUMENT_IMAGE_ALIGN_DEFAULT,
    wrap: wrap ?? NOTE_DOCUMENT_IMAGE_WRAP_DEFAULT,
    fullWidth: fullWidth ?? false,
    caption: caption ?? "",
  };
}

/**
 * Whatever readable alternative text a node carries, cleaned and bounded. Used
 * by the plain-text projection and by last-resort migration recovery so a
 * malformed historical image still contributes its text rather than vanishing.
 */
export function imagePlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.alt : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(UNSAFE_TEXT_PATTERN_GLOBAL, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxImageAlt);
}

/** The same recovery for the visible caption, at its own bound. */
export function imageCaptionPlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.caption : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(UNSAFE_TEXT_PATTERN_GLOBAL, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxImageCaption);
}

/* -------------------------------------------------------------------------- */
/* Generic file attachments (Part 44)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A conservative MIME grammar: one bounded token, a slash, one bounded token.
 * Parameters (`; charset=…`) are deliberately rejected — the server stores a
 * bare type and nothing downstream parses one.
 */
export const ATTACHMENT_MIME_PATTERN = /^[\w!#$&^.+-]{1,60}\/[\w!#$&^.+-]{1,60}$/u;
export const ATTACHMENT_MIME_MAX_LENGTH = 100;

/**
 * The four attributes a generic file attachment stores (Part 44).
 *
 * **There is deliberately no `src`, `url`, `href`, `downloadUrl`, or `dataUri`
 * field, and `NODE_ALLOWED_ATTRS.attachment` rejects one** — the identical
 * structural guarantee the `image` node relies on. A reader resolves bytes by
 * asking the authorized content endpoint for `attachmentId`, which re-checks
 * workspace membership on every single request, so a stored document can never
 * carry a URL that outlives permission.
 *
 * The other three are a **cached display projection**, not authority:
 *
 * - `name` is the sanitized display filename the server derived at upload time.
 *   It is echoed to every reader, so it is bounded and stripped of control
 *   characters here, exactly like a mention's cached label.
 * - `mimeType` selects an icon and a label. It is validated against a bounded
 *   *grammar* rather than a closed enumeration — unlike `align` or `wrap` —
 *   because it crosses the server/client boundary and the server's admitted set
 *   can legitimately grow. A closed set here would mean that adding one file
 *   type to the API produces editor output `safeParseNoteDocument` rejects,
 *   which stops autosave silently for the whole session (Part 39). The value is
 *   never used to decide how anything is rendered or served, so a bounded
 *   opaque string costs nothing.
 * - `sizeBytes` is what the card shows before the metadata request lands. The
 *   authoritative size is always the `attachments.size_bytes` column.
 *
 * A stale `name`/`mimeType`/`sizeBytes` is therefore a cosmetic inaccuracy, never
 * a security or correctness problem: the attachment directory overrides all
 * three the moment the authorized listing arrives.
 */
export interface NoteDocumentAttachmentAttrs {
  /** Stable attachment UUID. The only handle on the bytes. */
  readonly attachmentId: string;
  /** Sanitized display filename. Untrusted text; bounded and escaped on render. */
  readonly name: string;
  /** Stored MIME type, used only to pick an icon and a label. */
  readonly mimeType: string;
  /** Cached byte count for the card; the database column is authoritative. */
  readonly sizeBytes: number;
}

/**
 * A filename is untrusted text echoed to every reader, so it is bounded and
 * required to be free of control characters here — before it can reach the
 * renderer or the plain-text projection — rather than only escaped at the point
 * of use. Empty is rejected: a card with no name is not a card, and the server
 * always produces a non-empty sanitized name.
 */
export function isUsableAttachmentName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > NOTE_DOCUMENT_LIMITS.maxAttachmentName) return false;
  return !UNSAFE_TEXT_PATTERN.test(value);
}

export function isUsableAttachmentMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ATTACHMENT_MIME_MAX_LENGTH &&
    ATTACHMENT_MIME_PATTERN.test(value)
  );
}

/** A non-negative integer within the stored-size bound. Zero is legal. */
export function isAttachmentSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= NOTE_DOCUMENT_LIMITS.maxAttachmentSizeBytes
  );
}

/**
 * Return the four reviewed attachment attributes, or `null` when the node does
 * not carry a stable attachment id, a usable name, a usable MIME type, and a
 * bounded size. Never throws.
 *
 * Unlike the image node's Part 43 additions, none of these is optional: an
 * attachment card has nothing to show without them, and the node type is new in
 * this part so there is no historical document that could omit one.
 */
export function noteDocumentAttachmentAttrs(attrs: unknown): NoteDocumentAttachmentAttrs | null {
  if (!isRecord(attrs)) return null;
  const { attachmentId, name, mimeType, sizeBytes } = attrs;
  if (!isUuidValue(attachmentId)) return null;
  if (!isUsableAttachmentName(name)) return null;
  if (!isUsableAttachmentMimeType(mimeType)) return null;
  if (!isAttachmentSize(sizeBytes)) return null;
  return { attachmentId, name, mimeType, sizeBytes };
}

/**
 * Whatever readable filename a node carries, cleaned and bounded. Used by the
 * plain-text projection and by last-resort migration recovery, so a malformed
 * historical attachment still contributes its name rather than vanishing.
 */
export function attachmentPlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.name : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(UNSAFE_TEXT_PATTERN_GLOBAL, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxAttachmentName);
}

/**
 * The only `codeBlock.language` values the contract stores. The web editor
 * registers exactly this set with lowlight, so a persisted language can always
 * be highlighted and an unknown language can never reach the renderer.
 */
export const NOTE_DOCUMENT_CODE_LANGUAGES = Object.freeze([
  "bash",
  "css",
  "go",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "typescript",
  "xml",
  "yaml",
] as const);
export type NoteDocumentCodeLanguage = (typeof NOTE_DOCUMENT_CODE_LANGUAGES)[number];

export const CODE_LANGUAGE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_CODE_LANGUAGES);

/**
 * Aliases accepted from markdown fences and pasted `language-*` classes. They
 * are normalized to a canonical name so the stored attribute stays inside
 * `NOTE_DOCUMENT_CODE_LANGUAGES`.
 */
export const CODE_LANGUAGE_ALIASES: Readonly<Record<string, NoteDocumentCodeLanguage>> = {
  golang: "go",
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "shell",
};

/** Longest accepted alias/name; keeps the lookup bounded for hostile input. */
export const CODE_LANGUAGE_MAX_LENGTH = 32;

/**
 * Return the canonical registered language for `value`, or `null` when it is
 * absent, unknown, or out of bounds. Never throws and never returns free text.
 */
export function normalizeNoteDocumentCodeLanguage(value: unknown): NoteDocumentCodeLanguage | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length === 0 || cleaned.length > CODE_LANGUAGE_MAX_LENGTH) return null;
  if (CODE_LANGUAGE_SET.has(cleaned)) return cleaned as NoteDocumentCodeLanguage;
  return CODE_LANGUAGE_ALIASES[cleaned] ?? null;
}

export const NOTE_DOCUMENT_MARK_TYPES = Object.freeze([
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "link",
  "textStyle",
  "highlight",
  "subscript",
  "superscript",
] as const);
export type NoteDocumentMarkType = (typeof NOTE_DOCUMENT_MARK_TYPES)[number];

export const NODE_TYPE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_NODE_TYPES);
export const MARK_TYPE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_MARK_TYPES);
export const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "pageBreak",
  "taskList",
  "table",
  // Block, not inline. Part 43's alignment, text wrap, full-bleed width, and
  // caption all need a block box to lay out; an inline image could carry none
  // of them without a second, incompatible widening later.
  "image",
  // Block for a simpler reason: an attachment card is a *card*. It carries an
  // icon, a name, a size, a date, and controls, and none of that can sit inside
  // a line of prose. `Notted.md` §6 describes it as a card, not a chip.
  "attachment",
]);
export const INLINE_NODE_TYPES: ReadonlySet<string> = new Set(["text", "hardBreak", "mention"]);
export const TABLE_CELL_TYPES: ReadonlySet<string> = new Set(["tableHeader", "tableCell"]);

export const NODE_ALLOWED_FIELDS: Readonly<Record<NoteDocumentNodeType, ReadonlySet<string>>> = {
  doc: new Set(["type", "content"]),
  paragraph: new Set(["type", "attrs", "content"]),
  heading: new Set(["type", "attrs", "content"]),
  text: new Set(["type", "text", "marks"]),
  bulletList: new Set(["type", "content"]),
  orderedList: new Set(["type", "attrs", "content"]),
  listItem: new Set(["type", "content"]),
  blockquote: new Set(["type", "content"]),
  codeBlock: new Set(["type", "attrs", "content"]),
  hardBreak: new Set(["type"]),
  horizontalRule: new Set(["type"]),
  // A leaf atom that carries no state at all: where the break falls is the
  // node's position, so there is nothing to store and nothing to migrate.
  pageBreak: new Set(["type"]),
  taskList: new Set(["type", "content"]),
  taskItem: new Set(["type", "attrs", "content"]),
  table: new Set(["type", "content"]),
  tableRow: new Set(["type", "content"]),
  tableHeader: new Set(["type", "attrs", "content"]),
  tableCell: new Set(["type", "attrs", "content"]),
  // An atom: no content, and — like hardBreak — no marks, so a mention can
  // never smuggle a link, a colour, or any other mark through the renderer.
  mention: new Set(["type", "attrs"]),
  // An atom with no content and — like `mention` — no marks, so an image can
  // never smuggle a link, a colour, or any other mark through the renderer.
  image: new Set(["type", "attrs"]),
  // Identical treatment for the same reason: a card that could carry a `link`
  // mark would be a card that could carry an arbitrary href.
  attachment: new Set(["type", "attrs"]),
};

export const NODE_ALLOWED_ATTRS: Readonly<Record<NoteDocumentNodeType, ReadonlySet<string>>> = {
  doc: new Set(),
  paragraph: new Set(["textAlign"]),
  heading: new Set(["level", "textAlign"]),
  text: new Set(),
  bulletList: new Set(),
  orderedList: new Set(["start", "type"]),
  listItem: new Set(),
  blockquote: new Set(),
  codeBlock: new Set(["language"]),
  hardBreak: new Set(),
  horizontalRule: new Set(),
  pageBreak: new Set(),
  taskList: new Set(),
  taskItem: new Set(["checked"]),
  table: new Set(),
  tableRow: new Set(),
  tableHeader: new Set(["colspan", "rowspan", "colwidth"]),
  tableCell: new Set(["colspan", "rowspan", "colwidth"]),
  mention: new Set(["id", "label"]),
  // No `src`. See `NoteDocumentImageAttrs`: the absence is the guarantee that a
  // temporary `blob:`/`data:` URL can never be persisted, and this loop is what
  // rejects a node that tries to carry one. Part 43 added the four layout
  // attributes; none of them is URL-shaped and none of them ever will be.
  image: new Set([
    "attachmentId",
    "alt",
    "width",
    "height",
    "align",
    "wrap",
    "fullWidth",
    "caption",
  ]),
  // No `src`, no `href`, no `downloadUrl`. See `NoteDocumentAttachmentAttrs`:
  // the absence of any URL-shaped attribute is what guarantees a stored note can
  // never carry a link to bytes that outlives the reader's permission, and this
  // loop is what rejects a node that tries to add one.
  attachment: new Set(["attachmentId", "name", "mimeType", "sizeBytes"]),
};

export const MARK_ALLOWED_ATTRS: Readonly<Record<NoteDocumentMarkType, ReadonlySet<string>>> = {
  bold: new Set(),
  italic: new Set(),
  strike: new Set(),
  code: new Set(),
  underline: new Set(),
  link: new Set(["href", "target", "rel", "class"]),
  textStyle: new Set(["color", "fontSize"]),
  highlight: new Set(["color"]),
  subscript: new Set(),
  superscript: new Set(),
};

export const ATTRLESS_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "subscript",
  "superscript",
]);
/*
 * Re-exported, not moved on paper: `index.ts`, `note.schema.ts` and the
 * document test all import `sanitizeDocumentUrl` from this module, and a split
 * that renames someone's import is a refactor rather than a split.
 */
export { sanitizeDocumentUrl, SAFE_LINK_REL } from "./document-url";

export const TEXT_ALIGN_VALUES: ReadonlySet<string> = new Set([
  "left",
  "center",
  "right",
  "justify",
]);
export const FONT_SIZE_VALUES: ReadonlySet<string> = new Set([
  "8px",
  "9px",
  "10px",
  "11px",
  "12px",
  "14px",
  "16px",
  "18px",
  "20px",
  "24px",
  "28px",
  "32px",
  "36px",
  "48px",
  "72px",
]);

/**
 * Join the text of each paragraph, heading, or code block with a newline. A
 * table contributes one line per row, with cells separated by a tab, so search
 * and export see readable tabular text instead of a run-on sentence.
 */

export function hexColorOrNull(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : null;
}

export function fontSizeOrNull(value: unknown): string | null {
  return typeof value === "string" && FONT_SIZE_VALUES.has(value) ? value : null;
}

export function headingLevelOrNull(attrs: unknown): 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (!isRecord(attrs)) return null;
  const level = attrs.level;
  return typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6
    ? (level as 1 | 2 | 3 | 4 | 5 | 6)
    : null;
}

export function textAlignOrNull(attrs: unknown): string | null {
  if (!isRecord(attrs)) return null;
  const align = attrs.textAlign;
  return typeof align === "string" && TEXT_ALIGN_VALUES.has(align) ? align : null;
}

export function orderedListStartOrNull(attrs: unknown): number | null {
  if (!isRecord(attrs)) return null;
  const start = attrs.start;
  return typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 1 &&
    start <= NOTE_DOCUMENT_LIMITS.maxOrderedListStart
    ? start
    : null;
}

/** `colspan`/`rowspan`: an integer between 1 and the table span limit. */
export function cellSpanOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= NOTE_DOCUMENT_LIMITS.maxTableCellSpan
    ? value
    : null;
}

/**
 * `colwidth` is either `null` or one width per spanned column.
 * prosemirror-tables writes `0` for a column that has never been resized and
 * fractional pixel widths while dragging, so both are accepted; anything
 * negative, non-finite, oversized, or beyond the array bound is not.
 */
export function columnWidthsOrNull(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const maxLength = Math.min(
    NOTE_DOCUMENT_LIMITS.maxAttributeArray,
    NOTE_DOCUMENT_LIMITS.maxTableCellSpan,
  );
  if (value.length === 0 || value.length > maxLength) return null;
  const widths: number[] = [];
  for (const width of value) {
    if (
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width < 0 ||
      width > NOTE_DOCUMENT_LIMITS.maxTableColumnWidth
    ) {
      return null;
    }
    widths.push(width);
  }
  return widths;
}

/** Total rendered width of a cell, or `null` when no column width is stored. */
export function cellWidthOrNull(attrs: unknown): number | null {
  if (!isRecord(attrs)) return null;
  const widths = columnWidthsOrNull(attrs.colwidth);
  if (widths === null) return null;
  let total = 0;
  for (const width of widths) total += width;
  return total > 0 && total <= NOTE_DOCUMENT_LIMITS.maxTableColumnWidth ? total : null;
}
