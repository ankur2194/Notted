import { z } from "zod";

import { uuidSchema } from "./common.schema";
import { formatBinaryBytes } from "./format-bytes";

/** JSON values accepted by the framework-neutral document contract. */
export type NoteDocumentJson =
  boolean | number | string | null | NoteDocumentJson[] | { [key: string]: NoteDocumentJson };

/** Structurally compatible with `NoteDocument` from `@notted/shared-types`. */
export interface NoteDocument {
  readonly type: "doc";
  readonly [key: string]: NoteDocumentJson;
}

export interface NoteDocumentMigrationResult {
  readonly doc: NoteDocument;
  readonly migrated: boolean;
  readonly version: typeof NOTE_DOCUMENT_SCHEMA_VERSION;
}

export type NoteDocumentSafeParseResult =
  | { readonly success: true; readonly doc: NoteDocument; readonly errors: readonly [] }
  | { readonly success: false; readonly errors: readonly string[] };

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
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

/** C0 and C1 control characters, which a display name never legitimately contains. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * A cached display name is untrusted text that is echoed back to every reader,
 * so it is bounded and stripped of control characters here — before it can
 * reach the renderer or the plain-text projection — rather than only escaped at
 * the point of use. Keeping the label single-line also keeps the plain-text
 * projection's one-line-per-block shape intact.
 */
function isUsableMentionLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > NOTE_DOCUMENT_LIMITS.maxMentionLabel) return false;
  CONTROL_CHARACTER_PATTERN.lastIndex = 0;
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

function isUuidValue(value: unknown): value is string {
  return typeof value === "string" && uuidSchema.safeParse(value).success;
}

function isMentionId(value: unknown): value is string {
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
function mentionPlainText(node: PlainRecord): string {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null) return `${NOTE_DOCUMENT_MENTION_PREFIX}${attrs.label}`;
  // A malformed historical mention still contributes whatever readable label it
  // stored, so recovery degrades to text rather than silently dropping it.
  const rawLabel = isRecord(node.attrs) ? node.attrs.label : undefined;
  if (typeof rawLabel !== "string") return "";
  const cleaned = rawLabel
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxMentionLabel);
  return cleaned.length === 0 ? "" : `${NOTE_DOCUMENT_MENTION_PREFIX}${cleaned}`;
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

const IMAGE_ALIGN_VALUES: ReadonlySet<string> = new Set(NOTE_DOCUMENT_IMAGE_ALIGNMENTS);
const IMAGE_WRAP_VALUES: ReadonlySet<string> = new Set(NOTE_DOCUMENT_IMAGE_WRAP_MODES);

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
function isUsableImageAlt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > NOTE_DOCUMENT_LIMITS.maxImageAlt) return false;
  CONTROL_CHARACTER_PATTERN.lastIndex = 0;
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * A caption gets the identical treatment to alt at its own, larger bound. It is
 * rendered visibly, so escaping at the point of use is still required — this
 * check only removes the values that have no business being stored at all.
 */
function isUsableImageCaption(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > NOTE_DOCUMENT_LIMITS.maxImageCaption) return false;
  CONTROL_CHARACTER_PATTERN.lastIndex = 0;
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

/** Absent/`undefined` means "use the default"; any other unusable value is invalid. */
function isImageCaption(value: unknown): value is string | undefined {
  return value === undefined || isUsableImageCaption(value);
}

/** Absent/`undefined` means "use the default"; any other non-member is invalid. */
function isImageAlign(value: unknown): value is NoteDocumentImageAlign | undefined {
  return value === undefined || (typeof value === "string" && IMAGE_ALIGN_VALUES.has(value));
}

function isImageWrap(value: unknown): value is NoteDocumentImageWrap | undefined {
  return value === undefined || (typeof value === "string" && IMAGE_WRAP_VALUES.has(value));
}

/**
 * Strictly boolean. `"true"`, `1`, and `null` are all rejected rather than
 * coerced: a layout flag that quietly accepts truthy values is a flag whose
 * stored meaning depends on which client wrote it.
 */
function isImageFullWidth(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** `null`, absent, or a positive integer within the stored-dimension bound. */
function isImageDimension(value: unknown): value is number | null | undefined {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= NOTE_DOCUMENT_LIMITS.maxImageDimension
  );
}

function imageDimensionOrNull(value: unknown): number | null {
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
function imagePlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.alt : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim()
    .slice(0, NOTE_DOCUMENT_LIMITS.maxImageAlt);
}

/** The same recovery for the visible caption, at its own bound. */
function imageCaptionPlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.caption : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(CONTROL_CHARACTER_PATTERN, " ")
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
const ATTACHMENT_MIME_PATTERN = /^[\w!#$&^.+-]{1,60}\/[\w!#$&^.+-]{1,60}$/u;
const ATTACHMENT_MIME_MAX_LENGTH = 100;

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
function isUsableAttachmentName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > NOTE_DOCUMENT_LIMITS.maxAttachmentName) return false;
  CONTROL_CHARACTER_PATTERN.lastIndex = 0;
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

function isUsableAttachmentMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ATTACHMENT_MIME_MAX_LENGTH &&
    ATTACHMENT_MIME_PATTERN.test(value)
  );
}

/** A non-negative integer within the stored-size bound. Zero is legal. */
function isAttachmentSize(value: unknown): value is number {
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
function attachmentPlainText(node: PlainRecord): string {
  const raw = isRecord(node.attrs) ? node.attrs.name : undefined;
  if (typeof raw !== "string") return "";
  return raw
    .replace(CONTROL_CHARACTER_PATTERN, " ")
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

const CODE_LANGUAGE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_CODE_LANGUAGES);

/**
 * Aliases accepted from markdown fences and pasted `language-*` classes. They
 * are normalized to a canonical name so the stored attribute stays inside
 * `NOTE_DOCUMENT_CODE_LANGUAGES`.
 */
const CODE_LANGUAGE_ALIASES: Readonly<Record<string, NoteDocumentCodeLanguage>> = {
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
const CODE_LANGUAGE_MAX_LENGTH = 32;

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

const NODE_TYPE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_NODE_TYPES);
const MARK_TYPE_SET: ReadonlySet<string> = new Set(NOTE_DOCUMENT_MARK_TYPES);
const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
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
const INLINE_NODE_TYPES: ReadonlySet<string> = new Set(["text", "hardBreak", "mention"]);
const TABLE_CELL_TYPES: ReadonlySet<string> = new Set(["tableHeader", "tableCell"]);

const NODE_ALLOWED_FIELDS: Readonly<Record<NoteDocumentNodeType, ReadonlySet<string>>> = {
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

const NODE_ALLOWED_ATTRS: Readonly<Record<NoteDocumentNodeType, ReadonlySet<string>>> = {
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

const MARK_ALLOWED_ATTRS: Readonly<Record<NoteDocumentMarkType, ReadonlySet<string>>> = {
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

const ATTRLESS_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "subscript",
  "superscript",
]);
const SAFE_LINK_REL = "noopener noreferrer nofollow";
const URL_MAX_LENGTH = 2_048;
const MAILTO_ADDRESS_MAX_LENGTH = 320;
const TEL_VALUE_MAX_LENGTH = 64;
const URL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const HTTP_HOST_LABEL_PATTERN = /^[a-z0-9-]+$/i;
const MAILBOX_LOCAL_PATTERN = /^[A-Za-z0-9.!#$&'*+/=?^_`{|}~-]+$/;
const TELEPHONE_PATTERN = /^\+?(?:\d|\(\d+\))(?:[\d .-]|\(\d+\))*$/;
const TEXT_ALIGN_VALUES: ReadonlySet<string> = new Set(["left", "center", "right", "justify"]);
const FONT_SIZE_VALUES: ReadonlySet<string> = new Set([
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

function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function hasUnsafeUrlCharacter(value: string, rejectSpace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (rejectSpace && code === 0x20) ||
      code === 0x3c ||
      code === 0x3e ||
      code === 0x22 ||
      code === 0x5c
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafePercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x25) continue;
    if (index + 2 >= value.length) return true;
    const high = hexDigitValue(value.charCodeAt(index + 1));
    const low = hexDigitValue(value.charCodeAt(index + 2));
    if (high < 0 || low < 0) return true;
    const decoded = high * 16 + low;
    if (decoded <= 0x20 || decoded === 0x7f || decoded === 0x5c) return true;
    index += 2;
  }
  return false;
}

function rawHttpAuthority(value: string, schemeMatchLength: number): string | null {
  const remainder = value.slice(schemeMatchLength);
  if (!remainder.startsWith("//")) return null;
  const authorityStart = schemeMatchLength + 2;
  let authorityEnd = value.length;
  for (let index = authorityStart; index < value.length; index += 1) {
    const character = value[index];
    if (character === "/" || character === "?" || character === "#") {
      authorityEnd = index;
      break;
    }
  }
  const authority = value.slice(authorityStart, authorityEnd);
  return authority.length === 0 ? null : authority;
}

function isValidHttpHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  const labels = hostname.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      HTTP_HOST_LABEL_PATTERN.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

interface RuntimeUrl {
  readonly href: string;
  readonly hostname: string;
  readonly password: string;
  readonly protocol: string;
  readonly username: string;
}

type RuntimeUrlConstructor = new (input: string) => RuntimeUrl;

function runtimeUrlConstructor(): RuntimeUrlConstructor | null {
  const runtime = globalThis as unknown as { readonly URL?: RuntimeUrlConstructor };
  return runtime.URL ?? null;
}

function sanitizeHttpUrl(
  value: string,
  scheme: "http" | "https",
  schemeLength: number,
): string | null {
  if (hasUnsafeUrlCharacter(value, true) || hasUnsafePercentEncoding(value)) return null;
  const authority = rawHttpAuthority(value, schemeLength);
  if (authority === null || authority.includes("%") || authority.endsWith(":")) return null;

  const Url = runtimeUrlConstructor();
  if (Url === null) return null;
  let parsed: RuntimeUrl;
  try {
    parsed = new Url(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    !isValidHttpHostname(parsed.hostname)
  ) {
    return null;
  }
  return parsed.href;
}

function sanitizeMailtoUrl(value: string, schemeLength: number): string | null {
  if (hasUnsafeUrlCharacter(value, false) || hasUnsafePercentEncoding(value)) return null;
  const address = value.slice(schemeLength);
  if (
    address.length === 0 ||
    address.length > MAILTO_ADDRESS_MAX_LENGTH ||
    address.startsWith("//") ||
    address.includes(":") ||
    address.includes("?") ||
    address.includes("#") ||
    address.includes("%")
  ) {
    return null;
  }
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    local.length > 64 ||
    !MAILBOX_LOCAL_PATTERN.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !isValidHttpHostname(domain)
  ) {
    return null;
  }
  return value;
}

function sanitizeTelephoneUrl(value: string, schemeLength: number): string | null {
  if (hasUnsafeUrlCharacter(value, false) || hasUnsafePercentEncoding(value)) return null;
  const telephone = value.slice(schemeLength);
  if (
    telephone.length === 0 ||
    telephone.length > TEL_VALUE_MAX_LENGTH ||
    telephone.startsWith("//") ||
    telephone.includes("@") ||
    telephone.includes("?") ||
    telephone.includes("#") ||
    telephone.includes("%") ||
    !TELEPHONE_PATTERN.test(telephone)
  ) {
    return null;
  }
  for (let index = 0; index < telephone.length; index += 1) {
    const code = telephone.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) return value;
  }
  return null;
}

/**
 * Return a trimmed, bounded URL when it matches the contract's conservative
 * http, https, mailto, or tel grammar. HTTP parsing uses the cross-runtime
 * WHATWG URL implementation and rejects credentials and deceptive authorities.
 */
export function sanitizeDocumentUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length > URL_MAX_LENGTH) return null;

  const match = URL_SCHEME_PATTERN.exec(cleaned);
  const schemePart = match?.[1];
  const fullMatch = match?.[0];
  if (schemePart === undefined || fullMatch === undefined) return null;
  const scheme = schemePart.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return sanitizeHttpUrl(cleaned, scheme, fullMatch.length);
  }
  if (scheme === "mailto") return sanitizeMailtoUrl(cleaned, fullMatch.length);
  if (scheme === "tel") return sanitizeTelephoneUrl(cleaned, fullMatch.length);
  return null;
}

/**
 * Join the text of each paragraph, heading, or code block with a newline. A
 * table contributes one line per row, with cells separated by a tab, so search
 * and export see readable tabular text instead of a run-on sentence.
 */
export function extractNoteContentPlain(document: unknown): string {
  const blocks: string[] = [];

  const collectInline = (node: unknown): string => {
    if (!isRecord(node)) return "";
    if (node.type === "text") return typeof node.text === "string" ? node.text : "";
    if (node.type === "hardBreak") return "\n";
    // A mention reads as `@Ada Lovelace` so search and exports see a name.
    if (node.type === "mention") return mentionPlainText(node);
    if (!Array.isArray(node.content)) return "";
    return node.content.map(collectInline).join("");
  };

  const visit = (node: unknown, sink: string[]): void => {
    if (!isRecord(node)) return;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
      sink.push(collectInline(node));
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
        visit(cell, cellBlocks);
        return cellBlocks.join(" ");
      });
      sink.push(cells.join("\t"));
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child, sink);
    }
  };

  visit(document, blocks);
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
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === "taskItem") {
      total += 1;
      if (isRecord(node.attrs) && node.attrs.checked === true) done += 1;
    }
    if (Array.isArray(node.content)) for (const child of node.content) visit(child);
  };
  visit(document);
  return { done, total };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hexColorOrNull(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : null;
}

function fontSizeOrNull(value: unknown): string | null {
  return typeof value === "string" && FONT_SIZE_VALUES.has(value) ? value : null;
}

function headingLevelOrNull(attrs: unknown): 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (!isRecord(attrs)) return null;
  const level = attrs.level;
  return typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6
    ? (level as 1 | 2 | 3 | 4 | 5 | 6)
    : null;
}

function textAlignOrNull(attrs: unknown): string | null {
  if (!isRecord(attrs)) return null;
  const align = attrs.textAlign;
  return typeof align === "string" && TEXT_ALIGN_VALUES.has(align) ? align : null;
}

function orderedListStartOrNull(attrs: unknown): number | null {
  if (!isRecord(attrs)) return null;
  const start = attrs.start;
  return typeof start === "number" && Number.isInteger(start) && start >= 1 ? start : null;
}

/** `colspan`/`rowspan`: an integer between 1 and the table span limit. */
function cellSpanOrNull(value: unknown): number | null {
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
function columnWidthsOrNull(value: unknown): readonly number[] | null {
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
function cellWidthOrNull(attrs: unknown): number | null {
  if (!isRecord(attrs)) return null;
  const widths = columnWidthsOrNull(attrs.colwidth);
  if (widths === null) return null;
  let total = 0;
  for (const width of widths) total += width;
  return total > 0 && total <= NOTE_DOCUMENT_LIMITS.maxTableColumnWidth ? total : null;
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

function renderNodeHtml(node: unknown): string {
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

  const children = Array.isArray(node.content) ? node.content.map(renderNodeHtml).join("") : "";
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

function validateAttributeBounds(value: unknown, depth: number, errors: string[]): void {
  if (depth > NOTE_DOCUMENT_LIMITS.maxAttributeDepth) {
    errors.push("Document attributes are too deeply nested");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push("Document attributes require finite numbers");
    return;
  }
  if (typeof value === "string") {
    if (value.length > NOTE_DOCUMENT_LIMITS.maxString) {
      errors.push("Document attribute text is too long");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > NOTE_DOCUMENT_LIMITS.maxAttributeArray) {
      errors.push("Document attribute arrays are too large");
      return;
    }
    for (const item of value) validateAttributeBounds(item, depth + 1, errors);
    return;
  }
  if (!isRecord(value)) {
    errors.push("Document attributes contain an unsupported value");
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > NOTE_DOCUMENT_LIMITS.maxAttributes) {
    errors.push("Document attribute objects have too many keys");
    return;
  }
  for (const [, item] of entries) validateAttributeBounds(item, depth + 1, errors);
}

function validateNodeAttrs(type: NoteDocumentNodeType, attrs: unknown, errors: string[]): void {
  if (!isRecord(attrs)) {
    errors.push("Document node attributes must be an object");
    return;
  }
  validateAttributeBounds(attrs, 0, errors);
  for (const key of Object.keys(attrs)) {
    if (!NODE_ALLOWED_ATTRS[type].has(key)) {
      errors.push(`Document attribute is not allowed on ${type}: ${key}`);
    }
  }

  if (type === "heading") {
    const level = attrs.level;
    if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) {
      errors.push("Document heading level attribute must be an integer 1-6");
    }
  }
  if (type === "paragraph" || type === "heading") {
    const align = attrs.textAlign;
    if (
      align !== undefined &&
      align !== null &&
      (typeof align !== "string" || !TEXT_ALIGN_VALUES.has(align))
    ) {
      errors.push("Document textAlign attribute must be null, left, center, right, or justify");
    }
  }
  if (type === "orderedList") {
    const start = attrs.start;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 1) {
      errors.push("Document orderedList start attribute must be an integer >= 1");
    }
    if (attrs.type !== undefined && attrs.type !== null) {
      errors.push("Document orderedList type attribute must be null or omitted");
    }
  }
  if (type === "taskItem" && typeof attrs.checked !== "boolean") {
    errors.push("Document taskItem checked attribute is required and must be boolean");
  }
  if (type === "codeBlock") {
    const language = attrs.language;
    if (
      language !== undefined &&
      language !== null &&
      (typeof language !== "string" || !CODE_LANGUAGE_SET.has(language))
    ) {
      errors.push("Document codeBlock language attribute must be null or a registered language");
    }
  }
  if (type === "tableHeader" || type === "tableCell") {
    if (cellSpanOrNull(attrs.colspan) === null) {
      errors.push(
        `Document ${type} colspan attribute must be an integer 1-${NOTE_DOCUMENT_LIMITS.maxTableCellSpan}`,
      );
    }
    if (cellSpanOrNull(attrs.rowspan) === null) {
      errors.push(
        `Document ${type} rowspan attribute must be an integer 1-${NOTE_DOCUMENT_LIMITS.maxTableCellSpan}`,
      );
    }
    if (attrs.colwidth !== null && columnWidthsOrNull(attrs.colwidth) === null) {
      errors.push(
        `Document ${type} colwidth attribute must be null or an array of widths 0-${NOTE_DOCUMENT_LIMITS.maxTableColumnWidth}`,
      );
    }
  }
  if (type === "mention") {
    if (!isMentionId(attrs.id)) {
      errors.push("Document mention id attribute is required and must be a UUID user id");
    }
    if (!isUsableMentionLabel(attrs.label)) {
      errors.push(
        `Document mention label attribute is required and must be 1-${NOTE_DOCUMENT_LIMITS.maxMentionLabel} characters without control characters`,
      );
    }
  }
  if (type === "image") {
    if (!isUuidValue(attrs.attachmentId)) {
      errors.push("Document image attachmentId attribute is required and must be a UUID");
    }
    // Deliberately permits `""`: an empty alt is the accessible way to mark an
    // image decorative, and rejecting it would push authors toward filler text.
    if (!isUsableImageAlt(attrs.alt)) {
      errors.push(
        `Document image alt attribute is required and must be 0-${NOTE_DOCUMENT_LIMITS.maxImageAlt} characters without control characters`,
      );
    }
    for (const key of ["width", "height"] as const) {
      if (!isImageDimension(attrs[key])) {
        errors.push(
          `Document image ${key} attribute must be null or an integer 1-${NOTE_DOCUMENT_LIMITS.maxImageDimension}`,
        );
      }
    }
    // Part 43. Each is optional — absent means the documented default — so no
    // document written before Part 43 becomes invalid. `fullWidth` combined with
    // `wrap: "inline"` is deliberately ACCEPTED and resolved at render time by
    // `resolveNoteImageWrap`; rejecting it here would let the editor build a
    // document the API refuses, which stops autosave for the whole session.
    if (!isImageAlign(attrs.align)) {
      errors.push(
        `Document image align attribute must be one of: ${NOTE_DOCUMENT_IMAGE_ALIGNMENTS.join(", ")}`,
      );
    }
    if (!isImageWrap(attrs.wrap)) {
      errors.push(
        `Document image wrap attribute must be one of: ${NOTE_DOCUMENT_IMAGE_WRAP_MODES.join(", ")}`,
      );
    }
    if (!isImageFullWidth(attrs.fullWidth)) {
      errors.push("Document image fullWidth attribute must be a boolean");
    }
    if (!isImageCaption(attrs.caption)) {
      errors.push(
        `Document image caption attribute must be 0-${NOTE_DOCUMENT_LIMITS.maxImageCaption} characters without control characters`,
      );
    }
  }
  if (type === "attachment") {
    if (!isUuidValue(attrs.attachmentId)) {
      errors.push("Document attachment attachmentId attribute is required and must be a UUID");
    }
    if (!isUsableAttachmentName(attrs.name)) {
      errors.push(
        `Document attachment name attribute is required and must be 1-${NOTE_DOCUMENT_LIMITS.maxAttachmentName} characters without control characters`,
      );
    }
    if (!isUsableAttachmentMimeType(attrs.mimeType)) {
      errors.push("Document attachment mimeType attribute is required and must be a MIME type");
    }
    if (!isAttachmentSize(attrs.sizeBytes)) {
      errors.push(
        `Document attachment sizeBytes attribute must be an integer 0-${NOTE_DOCUMENT_LIMITS.maxAttachmentSizeBytes}`,
      );
    }
  }
}

function validateMarkAttrs(type: NoteDocumentMarkType, attrs: unknown, errors: string[]): void {
  if (!isRecord(attrs)) {
    errors.push("Document mark attributes must be an object");
    return;
  }
  validateAttributeBounds(attrs, 0, errors);
  for (const key of Object.keys(attrs)) {
    if (!MARK_ALLOWED_ATTRS[type].has(key)) {
      errors.push(`Document attribute is not allowed on ${type} mark: ${key}`);
    }
  }

  if (type === "link") {
    if (sanitizeDocumentUrl(attrs.href) === null) {
      errors.push("Document link href attribute is required and must be a safe URL");
    }
    if (attrs.target !== "_blank") {
      errors.push("Document link target attribute must be _blank");
    }
    if (attrs.rel !== SAFE_LINK_REL) {
      errors.push(`Document link rel attribute must be ${SAFE_LINK_REL}`);
    }
    if (attrs.class !== undefined && attrs.class !== null) {
      errors.push("Document link class attribute must be null or omitted");
    }
  }
  if (type === "highlight") {
    if (attrs.color !== undefined && attrs.color !== null && hexColorOrNull(attrs.color) === null) {
      errors.push("Document highlight color attribute must be null or a #rrggbb hex string");
    }
  }
  if (type === "textStyle") {
    const colorValid =
      attrs.color === undefined || attrs.color === null || hexColorOrNull(attrs.color) !== null;
    const fontSizeValid =
      attrs.fontSize === undefined ||
      attrs.fontSize === null ||
      fontSizeOrNull(attrs.fontSize) !== null;
    if (!colorValid) {
      errors.push("Document textStyle color attribute must be null or a #rrggbb hex string");
    }
    if (!fontSizeValid) errors.push("Document textStyle fontSize attribute is not allowed");
  }
}

function validateMark(mark: unknown, errors: string[]): NoteDocumentMarkType | null {
  if (!isRecord(mark)) {
    errors.push("Document mark must be an object");
    return null;
  }
  for (const key of Object.keys(mark)) {
    if (key !== "type" && key !== "attrs") errors.push(`Document mark has unknown field: ${key}`);
  }
  if (typeof mark.type !== "string" || mark.type.length === 0) {
    errors.push("Document mark type is invalid");
    return null;
  }
  if (!MARK_TYPE_SET.has(mark.type)) {
    errors.push(`Document mark type is not allowed: ${mark.type}`);
    return null;
  }
  const type = mark.type as NoteDocumentMarkType;
  if (ATTRLESS_MARK_TYPES.has(type)) {
    if (mark.attrs !== undefined) errors.push(`Document ${type} mark does not allow attributes`);
  } else if (type === "highlight" && mark.attrs === undefined) {
    return type;
  } else if (mark.attrs === undefined) {
    errors.push(`Document ${type} mark attributes are required`);
  } else {
    validateMarkAttrs(type, mark.attrs, errors);
  }
  return type;
}

function validateMarks(marks: unknown[], errors: string[]): void {
  if (marks.length > NOTE_DOCUMENT_LIMITS.maxMarks) errors.push("Document has too many marks");
  const seen = new Set<NoteDocumentMarkType>();
  for (const mark of marks) {
    const type = validateMark(mark, errors);
    if (type === null) continue;
    if (seen.has(type)) errors.push(`Document has duplicate ${type} marks`);
    seen.add(type);
  }
  if (seen.has("code") && seen.size > 1) {
    errors.push("Document code mark cannot be combined with other marks");
  }
  if (seen.has("subscript") && seen.has("superscript")) {
    errors.push("Document subscript and superscript marks conflict");
  }
}

function nodeType(node: unknown): string | null {
  return isRecord(node) && typeof node.type === "string" ? node.type : null;
}

function validateContentStructure(
  type: NoteDocumentNodeType,
  content: unknown[] | undefined,
  errors: string[],
): void {
  const children = content ?? [];
  if (type === "doc") {
    if (children.some((child) => !BLOCK_NODE_TYPES.has(nodeType(child) ?? ""))) {
      errors.push("Document root content must contain block nodes only");
    }
    return;
  }
  if (type === "paragraph" || type === "heading") {
    if (children.some((child) => !INLINE_NODE_TYPES.has(nodeType(child) ?? ""))) {
      errors.push(`Document ${type} content must contain inline text, hardBreak, or mention nodes`);
    }
    return;
  }
  if (type === "bulletList" || type === "orderedList") {
    if (children.length === 0 || children.some((child) => nodeType(child) !== "listItem")) {
      errors.push(`Document ${type} requires one or more listItem children`);
    }
    return;
  }
  if (type === "listItem" || type === "taskItem") {
    if (children.length === 0 || nodeType(children[0]) !== "paragraph") {
      errors.push(`Document ${type} must start with a paragraph`);
    }
    if (children.slice(1).some((child) => !BLOCK_NODE_TYPES.has(nodeType(child) ?? ""))) {
      errors.push(`Document ${type} subsequent children must be block nodes`);
    }
    return;
  }
  if (type === "blockquote") {
    if (
      children.length === 0 ||
      children.some((child) => !BLOCK_NODE_TYPES.has(nodeType(child) ?? ""))
    ) {
      errors.push("Document blockquote requires one or more block children");
    }
    return;
  }
  if (type === "codeBlock") {
    if (children.some((child) => nodeType(child) !== "text")) {
      errors.push("Document codeBlock content must contain text nodes only");
    }
    for (const child of children) {
      if (isRecord(child) && child.marks !== undefined) {
        errors.push("Document codeBlock text cannot have marks");
      }
    }
    return;
  }
  if (type === "taskList") {
    if (children.length === 0 || children.some((child) => nodeType(child) !== "taskItem")) {
      errors.push("Document taskList requires one or more taskItem children");
    }
    return;
  }
  if (type === "table") {
    if (children.length === 0 || children.some((child) => nodeType(child) !== "tableRow")) {
      errors.push("Document table requires one or more tableRow children");
    }
    if (children.length > NOTE_DOCUMENT_LIMITS.maxTableRows) {
      errors.push("Document table has too many rows");
    }
    return;
  }
  if (type === "tableRow") {
    if (
      children.length === 0 ||
      children.some((child) => !TABLE_CELL_TYPES.has(nodeType(child) ?? ""))
    ) {
      errors.push("Document tableRow requires one or more tableHeader or tableCell children");
    }
    if (children.length > NOTE_DOCUMENT_LIMITS.maxTableColumns) {
      errors.push("Document tableRow has too many cells");
    }
    return;
  }
  if (type === "tableHeader" || type === "tableCell") {
    if (
      children.length === 0 ||
      children.some((child) => !BLOCK_NODE_TYPES.has(nodeType(child) ?? ""))
    ) {
      errors.push(`Document ${type} requires one or more block children`);
    }
    return;
  }
  if (
    (type === "hardBreak" ||
      type === "horizontalRule" ||
      type === "pageBreak" ||
      type === "text" ||
      type === "mention" ||
      type === "image" ||
      type === "attachment") &&
    content !== undefined
  ) {
    errors.push(`Document ${type} must be a leaf node`);
  }
}

interface DocumentCounters {
  nodes: number;
  totalText: number;
  tableCells: number;
  mentions: number;
  images: number;
  attachments: number;
}

function validateNode(
  node: unknown,
  depth: number,
  counters: DocumentCounters,
  errors: string[],
): void {
  if (depth > NOTE_DOCUMENT_LIMITS.maxDepth) {
    errors.push("Document nesting is too deep");
    return;
  }
  if (!isRecord(node)) {
    errors.push("Document nodes must be objects");
    return;
  }

  counters.nodes += 1;
  if (counters.nodes > NOTE_DOCUMENT_LIMITS.maxNodes) {
    errors.push("Document has too many nodes");
    return;
  }
  if (typeof node.type !== "string" || node.type.length === 0) {
    errors.push("Document node type is invalid");
    return;
  }
  if (!NODE_TYPE_SET.has(node.type)) {
    errors.push(`Document node type is not allowed: ${node.type}`);
    return;
  }

  const type = node.type as NoteDocumentNodeType;
  for (const [key, value] of Object.entries(node)) {
    if (!NODE_ALLOWED_FIELDS[type].has(key)) {
      errors.push(`Document ${type} node has unknown field: ${key}`);
    }
    if (value === undefined) errors.push(`Document node field ${key} must contain a JSON value`);
  }

  if (type === "text") {
    if (typeof node.text !== "string" || node.text.length === 0) {
      errors.push("Text nodes require non-empty string text");
    } else {
      if (node.text.length > NOTE_DOCUMENT_LIMITS.maxString) {
        errors.push("Document text node is too long");
      }
      counters.totalText += node.text.length;
      if (counters.totalText > NOTE_DOCUMENT_LIMITS.maxTotalText) {
        errors.push("Document text is too long");
      }
    }
  }

  if (type === "tableHeader" || type === "tableCell") {
    counters.tableCells += 1;
    if (counters.tableCells > NOTE_DOCUMENT_LIMITS.maxTableCells) {
      errors.push("Document has too many table cells");
      return;
    }
  }

  if (type === "mention") {
    counters.mentions += 1;
    if (counters.mentions > NOTE_DOCUMENT_LIMITS.maxMentions) {
      errors.push("Document has too many mentions");
      return;
    }
  }

  if (type === "image") {
    counters.images += 1;
    if (counters.images > NOTE_DOCUMENT_LIMITS.maxImages) {
      // Bounds the authorized content requests one note can fan out into.
      errors.push("Document has too many images");
      return;
    }
  }

  if (type === "attachment") {
    counters.attachments += 1;
    if (counters.attachments > NOTE_DOCUMENT_LIMITS.maxAttachments) {
      // Bounds the authorized metadata and content requests one note can fan
      // out into, exactly as `maxImages` does.
      errors.push("Document has too many attachments");
      return;
    }
  }

  if (
    (type === "heading" ||
      type === "orderedList" ||
      type === "taskItem" ||
      type === "tableHeader" ||
      type === "tableCell" ||
      type === "mention" ||
      type === "image" ||
      type === "attachment") &&
    node.attrs === undefined
  ) {
    errors.push(`Document ${type} node attributes are required`);
  }
  if (node.attrs !== undefined) validateNodeAttrs(type, node.attrs, errors);

  if (type !== "text" && node.marks !== undefined) {
    errors.push(`Document ${type} node cannot have marks`);
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) errors.push("Document marks must be an array");
    else validateMarks(node.marks, errors);
  }

  let content: unknown[] | undefined;
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) {
      errors.push("Document child content must be an array");
    } else {
      content = node.content;
      if (content.length > NOTE_DOCUMENT_LIMITS.maxChildren) {
        errors.push("Document child array is too large");
      }
    }
  }
  validateContentStructure(type, content, errors);
  if (content !== undefined) {
    for (const child of content) validateNode(child, depth + 1, counters, errors);
  }
}

function validateDocumentContract(value: unknown, errors: string[]): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    errors.push("Document must be serializable JSON");
    return;
  }
  if (serialized === undefined) {
    errors.push("Document must be serializable JSON");
    return;
  }
  if (utf8ByteLength(serialized) > NOTE_DOCUMENT_LIMITS.serializedBytes) {
    errors.push("Document is too large");
  }
  if (!isRecord(value) || value.type !== "doc") {
    errors.push('Document root must be { type: "doc" }');
    return;
  }
  validateNode(
    value,
    0,
    { nodes: 0, totalText: 0, tableCells: 0, mentions: 0, images: 0, attachments: 0 },
    errors,
  );
}

/** Validate the complete contract while collecting all independently reachable issues. */
export function safeParseNoteDocument(value: unknown): NoteDocumentSafeParseResult {
  const errors: string[] = [];
  validateDocumentContract(value, errors);
  return errors.length === 0
    ? { success: true, doc: value as NoteDocument, errors: [] }
    : { success: false, errors };
}

export function parseNoteDocument(value: unknown): NoteDocument {
  const result = safeParseNoteDocument(value);
  if (!result.success) throw new Error(`Invalid note document: ${result.errors.join("; ")}`);
  return result.doc;
}

export const noteDocumentSchema = z.custom<NoteDocument>(
  (value) => safeParseNoteDocument(value).success,
  "Invalid note document",
);

/** An invalid historical document could not be recovered within the contract bounds. */
export class NoteDocumentMigrationError extends Error {
  public constructor(message: string) {
    super(`Note document migration failed: ${message}`);
    this.name = "NoteDocumentMigrationError";
  }
}

function assertMigrationInputBounds(input: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new NoteDocumentMigrationError("input must be serializable JSON");
  }
  if (serialized === undefined) {
    throw new NoteDocumentMigrationError("input must be serializable JSON");
  }
  if (utf8ByteLength(serialized) > NOTE_DOCUMENT_LIMITS.serializedBytes) {
    throw new NoteDocumentMigrationError("input exceeds the serialized byte limit");
  }

  const counters = { nodes: 0, totalText: 0 };
  const visit = (node: unknown, depth: number): void => {
    if (typeof node === "string") {
      if (node.length > NOTE_DOCUMENT_LIMITS.maxString) {
        throw new NoteDocumentMigrationError("input contains an oversized text value");
      }
      counters.totalText += node.length;
      if (counters.totalText > NOTE_DOCUMENT_LIMITS.maxTotalText) {
        throw new NoteDocumentMigrationError("input exceeds the aggregate text limit");
      }
      return;
    }
    if (Array.isArray(node)) {
      if (depth > NOTE_DOCUMENT_LIMITS.maxDepth) {
        throw new NoteDocumentMigrationError("input exceeds the nesting depth limit");
      }
      if (node.length > NOTE_DOCUMENT_LIMITS.maxChildren) {
        throw new NoteDocumentMigrationError("input exceeds the children-per-node limit");
      }
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    if (depth > NOTE_DOCUMENT_LIMITS.maxDepth) {
      throw new NoteDocumentMigrationError("input exceeds the nesting depth limit");
    }
    counters.nodes += 1;
    if (counters.nodes > NOTE_DOCUMENT_LIMITS.maxNodes) {
      throw new NoteDocumentMigrationError("input exceeds the node limit");
    }
    if (typeof node.text === "string") {
      if (node.text.length > NOTE_DOCUMENT_LIMITS.maxString) {
        throw new NoteDocumentMigrationError("input contains an oversized text node");
      }
      counters.totalText += node.text.length;
      if (counters.totalText > NOTE_DOCUMENT_LIMITS.maxTotalText) {
        throw new NoteDocumentMigrationError("input exceeds the aggregate text limit");
      }
    }
    if (node.attrs !== undefined) {
      const attributeErrors: string[] = [];
      validateAttributeBounds(node.attrs, 0, attributeErrors);
      if (attributeErrors.length > 0) {
        throw new NoteDocumentMigrationError(attributeErrors[0] ?? "invalid attrs");
      }
    }
    if (Array.isArray(node.marks)) {
      if (node.marks.length > NOTE_DOCUMENT_LIMITS.maxMarks) {
        throw new NoteDocumentMigrationError("input exceeds the marks-per-node limit");
      }
      for (const mark of node.marks) {
        if (isRecord(mark) && mark.attrs !== undefined) {
          const attributeErrors: string[] = [];
          validateAttributeBounds(mark.attrs, 0, attributeErrors);
          if (attributeErrors.length > 0) {
            throw new NoteDocumentMigrationError(attributeErrors[0] ?? "invalid mark attrs");
          }
        }
      }
    }
    if (!Array.isArray(node.content)) return;
    if (node.content.length > NOTE_DOCUMENT_LIMITS.maxChildren) {
      throw new NoteDocumentMigrationError("input exceeds the children-per-node limit");
    }
    for (const child of node.content) visit(child, depth + 1);
  };
  visit(input, 0);
}

function recoverTextFromNode(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(recoverTextFromNode).join("");
  if (!isRecord(node)) return "";
  let recovered = typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") recovered += "\n";
  // A mention stores its readable name in an attribute, so the last-resort
  // text-only recovery has to read it explicitly or the name would be lost.
  if (node.type === "mention") recovered += mentionPlainText(node);
  // Same reasoning for an image: its alt text and its caption are the only
  // readable things it carries, so text-only recovery has to read both
  // attributes explicitly, in the same order the plain-text projection uses.
  if (node.type === "image") {
    recovered += [imagePlainText(node), imageCaptionPlainText(node)]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  // Same reasoning again: the filename is the only readable thing an attachment
  // carries, so text-only recovery has to read the attribute explicitly or a
  // malformed card would vanish without a trace of what it referenced.
  if (node.type === "attachment") recovered += attachmentPlainText(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) recovered += recoverTextFromNode(child);
  }
  return recovered;
}

function splitRecoveredText(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + NOTE_DOCUMENT_LIMITS.maxString, text.length);
    if (
      end < text.length &&
      end > offset &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function textNodes(text: string, marks?: PlainRecord[]): PlainRecord[] {
  return splitRecoveredText(text)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ type: "text", text: chunk, ...(marks === undefined ? {} : { marks }) }));
}

function paragraphsFromRecoveredText(text: string): PlainRecord[] {
  return splitRecoveredText(text)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({ type: "paragraph", content: [{ type: "text", text: chunk }] }));
}

function normalizeMarks(marks: unknown): PlainRecord[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const output: PlainRecord[] = [];
  const seen = new Set<string>();
  let textStyle: PlainRecord | undefined;
  let textStylePosition = -1;
  let styleColor: string | null = null;
  let styleFontSize: string | null = null;

  for (const mark of marks) {
    if (!isRecord(mark) || typeof mark.type !== "string") continue;
    const attrs = isRecord(mark.attrs) ? mark.attrs : {};
    const type = mark.type;
    if (type === "code") return [{ type: "code" }];
    if (type === "color" || type === "textStyle") {
      if (textStyle === undefined) {
        textStyle = { type: "textStyle", attrs: {} };
        textStylePosition = output.length;
        output.push(textStyle);
      }
      const color = hexColorOrNull(attrs.color);
      const fontSize = fontSizeOrNull(attrs.fontSize);
      if (color !== null) styleColor = color;
      if (fontSize !== null) styleFontSize = fontSize;
      continue;
    }
    if (type === "subscript" || type === "superscript") {
      const conflict = type === "subscript" ? "superscript" : "subscript";
      if (seen.has(type) || seen.has(conflict)) continue;
      seen.add(type);
      output.push({ type });
      continue;
    }
    if (ATTRLESS_MARK_TYPES.has(type)) {
      if (seen.has(type)) continue;
      seen.add(type);
      output.push({ type });
      continue;
    }
    if (type === "highlight") {
      if (seen.has(type)) continue;
      seen.add(type);
      output.push({ type, attrs: { color: hexColorOrNull(attrs.color) } });
      continue;
    }
    if (type === "link") {
      if (seen.has(type)) continue;
      const href = sanitizeDocumentUrl(attrs.href);
      if (href === null) continue;
      seen.add(type);
      output.push({
        type,
        attrs: { href, target: "_blank", rel: SAFE_LINK_REL, class: null },
      });
    }
  }

  if (textStyle !== undefined) {
    if (styleColor === null && styleFontSize === null) output.splice(textStylePosition, 1);
    else textStyle.attrs = { color: styleColor, fontSize: styleFontSize };
  }
  return output.length === 0 ? undefined : output;
}

function normalizedTextAlignAttrs(attrs: unknown): PlainRecord | undefined {
  if (!isRecord(attrs)) return undefined;
  const align = attrs.textAlign;
  if (align === null) return { textAlign: null };
  return typeof align === "string" && TEXT_ALIGN_VALUES.has(align)
    ? { textAlign: align }
    : undefined;
}

/**
 * Keep a mention as a mention when it still carries a stable user id and a
 * usable label; otherwise degrade it to its readable `@label` text. A mention
 * is never silently dropped.
 */
function normalizeMentionNode(node: PlainRecord): PlainRecord[] {
  const attrs = noteDocumentMentionAttrs(node.attrs);
  if (attrs !== null && node.content === undefined) {
    return [{ type: "mention", attrs: { id: attrs.id, label: attrs.label } }];
  }
  return textNodes(recoverTextFromNode(node));
}

/**
 * Keep an image as an image when it still carries a stable attachment id and a
 * usable alt; otherwise degrade it to its alt and caption text. Attributes are
 * re-emitted in canonical form, so a historical node carrying a stray `src` —
 * the one thing the contract must never store — loses it here instead of failing
 * the note, an absent Part 43 attribute gains its documented default, and an
 * unusable one (`align: "diagonal"`) is replaced rather than propagated.
 *
 * Recovery is also the one place the `fullWidth` + `wrap: "inline"` conflict is
 * *written down* rather than only resolved for rendering: a node being repaired
 * is being rewritten anyway, so it is stored in the form
 * `resolveNoteImageWrap` would have produced. A valid document is never touched
 * — `migrateNoteDocument` short-circuits before reaching here — so this can
 * never silently rewrite a note that was already fine.
 */
function normalizeImageNode(node: PlainRecord): PlainRecord[] {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs !== null) {
    return [
      {
        type: "image",
        attrs: {
          attachmentId: attrs.attachmentId,
          alt: attrs.alt,
          width: attrs.width,
          height: attrs.height,
          align: attrs.align,
          wrap: resolveNoteImageWrap(attrs),
          fullWidth: attrs.fullWidth,
          caption: attrs.caption,
        },
      },
    ];
  }
  // Salvage what a malformed node can still contribute: bounded text, a bounded
  // id only when it is genuinely a UUID, and defaults for every layout value
  // that did not survive.
  const raw = isRecord(node.attrs) ? node.attrs : {};
  if (isUuidValue(raw.attachmentId)) {
    const fullWidth = isImageFullWidth(raw.fullWidth) ? (raw.fullWidth ?? false) : false;
    const wrap = isImageWrap(raw.wrap)
      ? (raw.wrap ?? NOTE_DOCUMENT_IMAGE_WRAP_DEFAULT)
      : NOTE_DOCUMENT_IMAGE_WRAP_DEFAULT;
    return [
      {
        type: "image",
        attrs: {
          attachmentId: raw.attachmentId,
          alt: imagePlainText(node),
          width: imageDimensionOrNull(raw.width),
          height: imageDimensionOrNull(raw.height),
          align: isImageAlign(raw.align)
            ? (raw.align ?? NOTE_DOCUMENT_IMAGE_ALIGN_DEFAULT)
            : NOTE_DOCUMENT_IMAGE_ALIGN_DEFAULT,
          wrap: resolveNoteImageWrap({ wrap, fullWidth }),
          fullWidth,
          caption: imageCaptionPlainText(node),
        },
      },
    ];
  }
  return paragraphsFromRecoveredText(
    [imagePlainText(node), imageCaptionPlainText(node)]
      .filter((part) => part.length > 0)
      .join("\n"),
  );
}

/**
 * Keep an attachment as an attachment when it still carries a stable id and a
 * usable name; otherwise degrade it to its filename as text. An attachment is
 * never silently dropped.
 *
 * Attributes are re-emitted in canonical form, so a historical node carrying a
 * stray `href` — the one thing the contract must never store — loses it here
 * instead of failing the whole note. When only the id survives, the remaining
 * three are filled with the safest possible stand-ins: the recovered filename
 * (or a generic one), the generic binary MIME type, and a zero size. All three
 * are display-only and the attachment directory replaces them the moment the
 * authorized listing arrives, so the repaired card is accurate as soon as it is
 * on screen. A valid document is never touched — `migrateNoteDocument`
 * short-circuits before reaching here.
 */
function normalizeAttachmentNode(node: PlainRecord): PlainRecord[] {
  const attrs = noteDocumentAttachmentAttrs(node.attrs);
  if (attrs !== null) {
    return [
      {
        type: "attachment",
        attrs: {
          attachmentId: attrs.attachmentId,
          name: attrs.name,
          mimeType: attrs.mimeType,
          sizeBytes: attrs.sizeBytes,
        },
      },
    ];
  }
  const raw = isRecord(node.attrs) ? node.attrs : {};
  if (isUuidValue(raw.attachmentId)) {
    const recovered = attachmentPlainText(node);
    return [
      {
        type: "attachment",
        attrs: {
          attachmentId: raw.attachmentId,
          name: recovered.length > 0 ? recovered : "Attachment",
          mimeType: isUsableAttachmentMimeType(raw.mimeType)
            ? raw.mimeType
            : "application/octet-stream",
          sizeBytes: isAttachmentSize(raw.sizeBytes) ? raw.sizeBytes : 0,
        },
      },
    ];
  }
  return paragraphsFromRecoveredText(attachmentPlainText(node));
}

function normalizeInlineNode(node: unknown): PlainRecord[] {
  if (!isRecord(node)) return [];
  if (node.type === "hardBreak" && node.text === undefined && node.content === undefined) {
    return [{ type: "hardBreak" }];
  }
  if (node.type === "mention") return normalizeMentionNode(node);
  if (node.type === "text") {
    const recovered = recoverTextFromNode(node);
    const marks = normalizeMarks(node.marks);
    return textNodes(recovered, marks);
  }
  return textNodes(recoverTextFromNode(node));
}

function normalizeInlineContent(node: PlainRecord): PlainRecord[] {
  const output: PlainRecord[] = [];
  if (typeof node.text === "string") output.push(...textNodes(node.text));
  if (Array.isArray(node.content)) {
    for (const child of node.content) output.push(...normalizeInlineNode(child));
  }
  return output;
}

function ensureItemContent(blocks: PlainRecord[]): PlainRecord[] {
  if (blocks.length === 0) return [{ type: "paragraph" }];
  if (blocks[0]?.type === "paragraph") return blocks;
  return [{ type: "paragraph" }, ...blocks];
}

function normalizeChildBlocks(node: PlainRecord): PlainRecord[] {
  const blocks: PlainRecord[] = [];
  if (typeof node.text === "string" && node.text.length > 0) {
    blocks.push(...paragraphsFromRecoveredText(node.text));
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) blocks.push(...normalizeToBlocks(child));
  }
  return blocks;
}

function normalizeItemNode(node: PlainRecord): PlainRecord[] {
  return ensureItemContent(normalizeChildBlocks(node));
}

/** Recover any node into a canonical table cell carrying only reviewed attrs. */
function normalizeTableCell(node: unknown): PlainRecord {
  const record = isRecord(node) ? node : {};
  const isHeader = record.type === "tableHeader";
  const blocks =
    isHeader || record.type === "tableCell"
      ? normalizeChildBlocks(record)
      : normalizeToBlocks(node);
  const attrs = isRecord(record.attrs) ? record.attrs : {};
  const widths = columnWidthsOrNull(attrs.colwidth);
  return {
    type: isHeader ? "tableHeader" : "tableCell",
    attrs: {
      colspan: cellSpanOrNull(attrs.colspan) ?? 1,
      rowspan: cellSpanOrNull(attrs.rowspan) ?? 1,
      colwidth: widths === null ? null : [...widths],
    },
    content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
  };
}

function normalizeTableRow(node: unknown): PlainRecord | null {
  const record = isRecord(node) ? node : {};
  const children = Array.isArray(record.content) ? record.content : [];
  if (children.length === 0) return null;
  return { type: "tableRow", content: children.map(normalizeTableCell) };
}

function normalizeListItem(node: unknown): PlainRecord {
  if (isRecord(node) && node.type === "listItem") {
    return { type: "listItem", content: normalizeItemNode(node) };
  }
  const blocks = normalizeToBlocks(node);
  return { type: "listItem", content: ensureItemContent(blocks) };
}

function normalizeTaskItem(node: unknown): PlainRecord {
  if (isRecord(node) && node.type === "taskItem") {
    const attrs = isRecord(node.attrs) ? node.attrs : {};
    return {
      type: "taskItem",
      attrs: { checked: attrs.checked === true },
      content: normalizeItemNode(node),
    };
  }
  const blocks = normalizeToBlocks(node);
  return {
    type: "taskItem",
    attrs: { checked: false },
    content: ensureItemContent(blocks),
  };
}

function normalizeToBlocks(node: unknown): PlainRecord[] {
  if (Array.isArray(node)) {
    const output: PlainRecord[] = [];
    for (const child of node) output.push(...normalizeToBlocks(child));
    return output;
  }
  if (!isRecord(node) || typeof node.type !== "string") {
    return paragraphsFromRecoveredText(recoverTextFromNode(node));
  }
  if (node.type === "doc") {
    const output = typeof node.text === "string" ? paragraphsFromRecoveredText(node.text) : [];
    if (Array.isArray(node.content)) {
      for (const child of node.content) output.push(...normalizeToBlocks(child));
    }
    return output;
  }
  if (node.type === "paragraph") {
    const content = normalizeInlineContent(node);
    const attrs = normalizedTextAlignAttrs(node.attrs);
    return [
      {
        type: "paragraph",
        ...(attrs === undefined ? {} : { attrs }),
        ...(content.length ? { content } : {}),
      },
    ];
  }
  if (node.type === "heading") {
    const content = normalizeInlineContent(node);
    const attrs: PlainRecord = { level: headingLevelOrNull(node.attrs) ?? 1 };
    const alignment = normalizedTextAlignAttrs(node.attrs);
    if (alignment !== undefined) attrs.textAlign = alignment.textAlign;
    return [{ type: "heading", attrs, ...(content.length ? { content } : {}) }];
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const content: PlainRecord[] = [];
    if (typeof node.text === "string" && node.text.length > 0) {
      content.push(normalizeListItem(node.text));
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) content.push(normalizeListItem(child));
    }
    if (content.length === 0) return [];
    if (node.type === "bulletList") return [{ type: "bulletList", content }];
    return [
      {
        type: "orderedList",
        attrs: { start: orderedListStartOrNull(node.attrs) ?? 1, type: null },
        content,
      },
    ];
  }
  if (node.type === "listItem" || node.type === "taskItem") {
    return normalizeItemNode(node);
  }
  if (node.type === "blockquote") {
    const content: PlainRecord[] = [];
    if (typeof node.text === "string" && node.text.length > 0) {
      content.push(...paragraphsFromRecoveredText(node.text));
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) content.push(...normalizeToBlocks(child));
    }
    return [{ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] }];
  }
  if (node.type === "codeBlock") {
    const text = recoverTextFromNode(node);
    const sourceAttrs = isRecord(node.attrs) ? node.attrs : {};
    const language = normalizeNoteDocumentCodeLanguage(sourceAttrs.language);
    return [
      {
        type: "codeBlock",
        attrs: { language },
        ...(text.length ? { content: textNodes(text) } : {}),
      },
    ];
  }
  if (node.type === "horizontalRule") {
    return [...paragraphsFromRecoveredText(recoverTextFromNode(node)), { type: "horizontalRule" }];
  }
  if (node.type === "pageBreak") {
    // Identical treatment to `horizontalRule`: any text a malformed historical
    // node carried is recovered first, then the leaf is re-emitted attribute-free.
    return [...paragraphsFromRecoveredText(recoverTextFromNode(node)), { type: "pageBreak" }];
  }
  if (node.type === "taskList") {
    const content: PlainRecord[] = [];
    if (typeof node.text === "string" && node.text.length > 0) {
      content.push(normalizeTaskItem(node.text));
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) content.push(normalizeTaskItem(child));
    }
    return content.length === 0 ? [] : [{ type: "taskList", content }];
  }
  if (node.type === "table") {
    const rows: PlainRecord[] = [];
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const row = normalizeTableRow(child);
        if (row !== null) rows.push(row);
      }
    }
    if (rows.length === 0) return paragraphsFromRecoveredText(recoverTextFromNode(node));
    return [{ type: "table", content: rows }];
  }
  if (node.type === "tableRow" || node.type === "tableHeader" || node.type === "tableCell") {
    // A row or cell outside a table cannot be represented; keep only its blocks.
    return normalizeChildBlocks(node);
  }
  if (node.type === "mention") {
    // A mention in block position cannot stay there; wrap it in a paragraph so
    // the stable user id survives instead of collapsing to text.
    const inline = normalizeMentionNode(node);
    return inline.length === 0 ? [] : [{ type: "paragraph", content: inline }];
  }
  if (node.type === "image") return normalizeImageNode(node);
  if (node.type === "attachment") return normalizeAttachmentNode(node);
  if (node.type === "hardBreak") {
    return paragraphsFromRecoveredText(recoverTextFromNode(node));
  }
  if (node.type === "text") {
    return paragraphsFromRecoveredText(recoverTextFromNode(node));
  }
  return paragraphsFromRecoveredText(recoverTextFromNode(node));
}

/**
 * Preserve clean v1 input exactly. Invalid or historical input is recovered
 * into bounded canonical nodes without dropping recoverable text. Recovery
 * throws `NoteDocumentMigrationError` when input/output bounds or authoritative
 * post-validation cannot be satisfied; it never returns a partial document.
 */
export function normalizeUnsupportedNodes(input: unknown): {
  readonly doc: NoteDocument;
  readonly changed: boolean;
} {
  assertMigrationInputBounds(input);
  const clean = safeParseNoteDocument(input);
  if (clean.success) return { doc: clean.doc, changed: false };

  const content = normalizeToBlocks(input);
  const recovered = safeParseNoteDocument({ type: "doc", content });
  if (recovered.success) return { doc: recovered.doc, changed: true };

  const textOnly = safeParseNoteDocument({
    type: "doc",
    content: paragraphsFromRecoveredText(recoverTextFromNode(input)),
  });
  if (!textOnly.success) {
    throw new NoteDocumentMigrationError(
      `recovered output is invalid (${textOnly.errors.join("; ")})`,
    );
  }
  return { doc: textOnly.doc, changed: true };
}

/**
 * Migrate a historical projection to v1. Throws `NoteDocumentMigrationError`
 * instead of truncating when bounded, schema-valid recovery is impossible.
 */
export function migrateNoteDocument(input: unknown): NoteDocumentMigrationResult {
  const normalized = normalizeUnsupportedNodes(input);
  return {
    doc: normalized.doc,
    migrated: normalized.changed,
    version: NOTE_DOCUMENT_SCHEMA_VERSION,
  };
}
