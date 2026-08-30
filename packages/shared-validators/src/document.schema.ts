import { z } from "zod";

import {
  ATTRLESS_MARK_TYPES,
  BLOCK_NODE_TYPES,
  CODE_LANGUAGE_SET,
  INLINE_NODE_TYPES,
  MARK_ALLOWED_ATTRS,
  MARK_TYPE_SET,
  NODE_ALLOWED_ATTRS,
  NODE_ALLOWED_FIELDS,
  NODE_TYPE_SET,
  NOTE_DOCUMENT_IMAGE_ALIGNMENTS,
  NOTE_DOCUMENT_IMAGE_ALIGN_DEFAULT,
  NOTE_DOCUMENT_IMAGE_WRAP_DEFAULT,
  NOTE_DOCUMENT_IMAGE_WRAP_MODES,
  NOTE_DOCUMENT_LIMITS,
  NOTE_DOCUMENT_SCHEMA_VERSION,
  NoteDocumentMarkType,
  NoteDocumentNodeType,
  PlainRecord,
  TABLE_CELL_TYPES,
  TEXT_ALIGN_VALUES,
  attachmentPlainText,
  cellSpanOrNull,
  columnWidthsOrNull,
  fontSizeOrNull,
  headingLevelOrNull,
  hexColorOrNull,
  imageCaptionPlainText,
  imageDimensionOrNull,
  imagePlainText,
  isAttachmentSize,
  isImageAlign,
  isImageCaption,
  isImageDimension,
  isImageFullWidth,
  isImageWrap,
  isMentionId,
  isRecord,
  isUsableAttachmentMimeType,
  isUsableAttachmentName,
  isUsableImageAlt,
  isUsableMentionLabel,
  isUuidValue,
  mentionPlainText,
  normalizeNoteDocumentCodeLanguage,
  noteDocumentAttachmentAttrs,
  noteDocumentImageAttrs,
  noteDocumentMentionAttrs,
  orderedListStartOrNull,
  resolveNoteImageWrap,
  utf8ByteLength,
} from "./document-core";
import { sanitizeDocumentUrl, SAFE_LINK_REL } from "./document-url";

/*
 * The vocabulary, the renderers and the flatteners are re-exported so every
 * existing importer — `index.ts`, `note.schema.ts`, `comment.schema.ts` and the
 * 2 378-line test — keeps the import it already had. The edges only ever point
 * this way: none of those modules imports this one, which is what makes the
 * split acyclic rather than four files pretending to be separate.
 */

export * from "./document-core";
export * from "./document-html";
export * from "./document-text";
export { sanitizeDocumentUrl, SAFE_LINK_REL } from "./document-url";

import type { JsonValue, NoteDocument } from "@notted/shared-types";

/**
 * JSON values accepted by the framework-neutral document contract.
 *
 * An alias for `JsonValue`, not a second declaration of it. These were two
 * structurally identical recursive types whose only stated relationship was a
 * comment, so if either grew a member the mismatch would surface as an
 * assignability error in whichever app imported both — and nothing here would
 * fail.
 */
export type NoteDocumentJson = JsonValue;

/**
 * The document contract, re-exported from `@notted/shared-types` rather than
 * declared twice. The node types, attribute rules, bounds and migration policy
 * are owned here; the shape is owned there.
 */
export type { NoteDocument };

export interface NoteDocumentMigrationResult {
  readonly doc: NoteDocument;
  readonly migrated: boolean;
  readonly version: typeof NOTE_DOCUMENT_SCHEMA_VERSION;
}

export type NoteDocumentSafeParseResult =
  | { readonly success: true; readonly doc: NoteDocument; readonly errors: readonly [] }
  | { readonly success: false; readonly errors: readonly string[] };

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
    if (
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      start < 1 ||
      start > NOTE_DOCUMENT_LIMITS.maxOrderedListStart
    ) {
      errors.push(
        `Document orderedList start attribute must be an integer 1-${NOTE_DOCUMENT_LIMITS.maxOrderedListStart}`,
      );
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
      // `validateNode` already carries `depth`, and depth 0 IS the document
      // root — the one place where "children of this node" means "blocks in
      // this note" rather than "fan-out under one node".
      const childLimit =
        depth === 0 ? NOTE_DOCUMENT_LIMITS.maxRootChildren : NOTE_DOCUMENT_LIMITS.maxChildren;
      if (content.length > childLimit) {
        errors.push("Document child array is too large");
      }
    }
  }
  validateContentStructure(type, content, errors);
  if (content !== undefined) {
    for (const child of content) validateNode(child, depth + 1, counters, errors);
  }
}

function validateDocumentContract(value: unknown, errors: string[], serializedHint?: string): void {
  // `serializedHint` exists so the migration path does not stringify the same
  // input twice: `assertMigrationInputBounds` already produced this string, and
  // on a large note that serialisation is the dominant cost of the whole parse.
  let serialized: string | undefined = serializedHint;
  if (serialized === undefined) {
    try {
      serialized = JSON.stringify(value);
    } catch {
      errors.push("Document must be serializable JSON");
      return;
    }
  }
  if (serialized === undefined) {
    errors.push("Document must be serializable JSON");
    return;
  }
  if (utf8ByteLength(serialized) > NOTE_DOCUMENT_LIMITS.serializedBytes) {
    // Return rather than continue. Walking a document already known to exceed
    // the byte budget only manufactures thousands of structural errors nobody
    // reads, each able to interpolate an attacker-supplied field name, and
    // "too large" is the more useful message on its own.
    errors.push("Document is too large");
    return;
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
export function safeParseNoteDocument(
  value: unknown,
  serializedHint?: string,
): NoteDocumentSafeParseResult {
  const errors: string[] = [];
  validateDocumentContract(value, errors, serializedHint);
  return errors.length === 0
    ? { success: true, doc: value as NoteDocument, errors: [] }
    : { success: false, errors };
}

const MAX_REPORTED_ERRORS = 10;
const MAX_REPORTED_ERROR_CHARS = 200;

/**
 * A bounded, human-readable summary of a validation failure.
 *
 * Never the whole array joined. Both dimensions are capped, and both are load
 * bearing: the count, because a large document produces thousands of entries;
 * and the length of each entry, because several of them interpolate a caller
 * string of arbitrary size (`Document ${type} node has unknown field: ${key}`).
 * Capping only the count would still let one 512 KB entry through, which is how
 * an 840 KB request used to produce a megabyte-scale exception message.
 */
export function formatNoteDocumentErrors(errors: readonly string[]): string {
  const shown = errors
    .slice(0, MAX_REPORTED_ERRORS)
    .map((error) =>
      error.length > MAX_REPORTED_ERROR_CHARS
        ? `${error.slice(0, MAX_REPORTED_ERROR_CHARS)}…`
        : error,
    );
  const remaining = errors.length - shown.length;
  return remaining > 0 ? `${shown.join("; ")} (+${remaining} more)` : shown.join("; ");
}

export function parseNoteDocument(value: unknown): NoteDocument {
  const result = safeParseNoteDocument(value);
  if (!result.success)
    throw new Error(`Invalid note document: ${formatNoteDocumentErrors(result.errors)}`);
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

/*
 * The child budget at a given depth, for the migration walker.
 *
 * Depth 0 is the document itself — either the `{ type: "doc" }` record or a
 * bare content array — so its child count is "blocks in this note". Every
 * deeper node is per-node fan-out and keeps the 200 guard.
 *
 * This MUST agree with `validateNode`, or a note passes validation and then
 * cannot be OPENED. That was the sharper half of the defect: the migration
 * threw before any recovery could run, so a note already stored with more than
 * 200 top-level blocks was unreadable, not merely unsaveable.
 */
function childLimitAt(depth: number): number {
  return depth === 0 ? NOTE_DOCUMENT_LIMITS.maxRootChildren : NOTE_DOCUMENT_LIMITS.maxChildren;
}

function assertMigrationInputBounds(input: unknown): string {
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
  const serializedInput = serialized;

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
      if (node.length > childLimitAt(depth)) {
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
    if (node.content.length > childLimitAt(depth)) {
      throw new NoteDocumentMigrationError("input exceeds the children-per-node limit");
    }
    for (const child of node.content) visit(child, depth + 1);
  };
  visit(input, 0);
  return serializedInput;
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
  // One serialisation of `input`, reused. Both calls stringified it separately,
  // and on a large note that is the dominant cost of this path.
  const serialized = assertMigrationInputBounds(input);
  const clean = safeParseNoteDocument(input, serialized);
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
      `recovered output is invalid (${formatNoteDocumentErrors(textOnly.errors)})`,
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
