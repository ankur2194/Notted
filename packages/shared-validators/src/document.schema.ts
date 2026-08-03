import { z } from "zod";

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
 */
export const NOTE_DOCUMENT_SCHEMA_VERSION = 1 as const;

/** Bounds retained from the Part 31 transitional safety envelope. */
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
  "taskList",
  "taskItem",
] as const);
export type NoteDocumentNodeType = (typeof NOTE_DOCUMENT_NODE_TYPES)[number];

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
  "taskList",
]);
const INLINE_NODE_TYPES: ReadonlySet<string> = new Set(["text", "hardBreak"]);

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
  taskList: new Set(["type", "content"]),
  taskItem: new Set(["type", "attrs", "content"]),
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
  taskList: new Set(),
  taskItem: new Set(["checked"]),
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

/** Join the text of each paragraph, heading, or code block with a newline. */
export function extractNoteContentPlain(document: unknown): string {
  const blocks: string[] = [];

  const collectInline = (node: unknown): string => {
    if (!isRecord(node)) return "";
    if (node.type === "text") return typeof node.text === "string" ? node.text : "";
    if (node.type === "hardBreak") return "\n";
    if (!Array.isArray(node.content)) return "";
    return node.content.map(collectInline).join("");
  };

  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
      blocks.push(collectInline(node));
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };

  visit(document);
  return blocks.join("\n");
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

function renderNodeHtml(node: unknown): string {
  if (!isRecord(node)) return "";
  if (node.type === "text") {
    return typeof node.text === "string" ? renderTextWithMarks(node.text, node.marks) : "";
  }
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "horizontalRule") return "<hr>";

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
    default:
      return "";
  }
}

/** Render only escaped text and the contract's fixed safe tag/attribute map. */
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
      (typeof language !== "string" || language.length > 64)
    ) {
      errors.push("Document codeBlock language attribute must be null or a string <= 64 chars");
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
      errors.push(`Document ${type} content must contain inline text or hardBreak nodes only`);
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
  if (
    (type === "hardBreak" || type === "horizontalRule" || type === "text") &&
    content !== undefined
  ) {
    errors.push(`Document ${type} must be a leaf node`);
  }
}

function validateNode(
  node: unknown,
  depth: number,
  counters: { nodes: number; totalText: number },
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

  if (
    (type === "heading" || type === "orderedList" || type === "taskItem") &&
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
  validateNode(value, 0, { nodes: 0, totalText: 0 }, errors);
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

function normalizeInlineNode(node: unknown): PlainRecord[] {
  if (!isRecord(node)) return [];
  if (node.type === "hardBreak" && node.text === undefined && node.content === undefined) {
    return [{ type: "hardBreak" }];
  }
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

function normalizeItemNode(node: PlainRecord): PlainRecord[] {
  const blocks: PlainRecord[] = [];
  if (typeof node.text === "string" && node.text.length > 0) {
    blocks.push(...paragraphsFromRecoveredText(node.text));
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) blocks.push(...normalizeToBlocks(child));
  }
  return ensureItemContent(blocks);
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
    const language =
      sourceAttrs.language === null ||
      (typeof sourceAttrs.language === "string" && sourceAttrs.language.length <= 64)
        ? sourceAttrs.language
        : null;
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
