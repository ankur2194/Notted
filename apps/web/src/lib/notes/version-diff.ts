import type { NoteDocument } from "@notted/shared-validators";

export type VersionDiffKind = "same" | "added" | "deleted";
export interface VersionDiffSegment {
  readonly kind: VersionDiffKind;
  readonly text: string;
}
export interface VersionDiffResult {
  readonly tooLarge: boolean;
  readonly before: readonly VersionDiffSegment[];
  readonly after: readonly VersionDiffSegment[];
  readonly additions: number;
  readonly deletions: number;
}

export const VERSION_DIFF_MAX_TOKENS = 400;
const VERSION_DIFF_MAX_CELLS = 80_000;
const VERSION_DIFF_MAX_INLINE_TOKENS = 1_000;
const VERSION_DIFF_MAX_INLINE_CELLS = 50_000;

interface JsonNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: unknown;
  readonly marks?: unknown;
  readonly content?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const data = value as Record<string, unknown>;
  return `{${Object.keys(data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(data[key])}`)
    .join(",")}}`;
}

function inline(node: JsonNode): string {
  if (node.type === "text") {
    const marks = Array.isArray(node.marks) ? stable(node.marks) : "[]";
    return `text:${marks}:${typeof node.text === "string" ? node.text : ""}`;
  }
  if (node.type === "mention") {
    const attrs = record(node.attrs);
    return `mention:${String(attrs.id ?? "")}:${String(attrs.label ?? attrs.name ?? "")}`;
  }
  return `${String(node.type ?? "unknown")}:${stable(node.attrs)}`;
}

function projectNode(node: JsonNode, depth: number, output: string[]): void {
  const type = typeof node.type === "string" ? node.type : "unknown";
  const attrs = record(node.attrs);
  const children = Array.isArray(node.content) ? (node.content as JsonNode[]) : [];
  const prefix = "  ".repeat(Math.min(depth, 12));
  if (type === "paragraph" || type === "heading") {
    const label = type === "heading" ? `Heading ${String(attrs.level ?? "")}` : "Paragraph";
    output.push(`${prefix}${label}: ${children.map(inline).join(" ")}`);
    return;
  }
  if (type === "image") {
    output.push(
      `${prefix}Image: ${stable({ attachmentId: attrs.attachmentId, alt: attrs.alt, caption: attrs.caption, width: attrs.width, height: attrs.height, align: attrs.align, wrap: attrs.wrap, fullWidth: attrs.fullWidth })}`,
    );
    return;
  }
  if (type === "attachment") {
    output.push(
      `${prefix}Attachment: ${stable({ attachmentId: attrs.attachmentId, name: attrs.name, mimeType: attrs.mimeType, sizeBytes: attrs.sizeBytes })}`,
    );
    return;
  }
  if (type === "pageBreak") {
    output.push(`${prefix}Page break`);
    return;
  }
  if (type === "horizontalRule") {
    output.push(`${prefix}Horizontal rule`);
    return;
  }
  if (type === "codeBlock") {
    output.push(
      `${prefix}Code (${String(attrs.language ?? "plain")}): ${children.map(inline).join("\n")}`,
    );
    return;
  }
  if (type === "tableCell" || type === "tableHeader") {
    output.push(`${prefix}${type === "tableHeader" ? "Header cell" : "Cell"} ${stable(attrs)}`);
  } else if (type === "taskItem") {
    output.push(`${prefix}Task ${attrs.checked === true ? "checked" : "unchecked"}`);
  } else if (type !== "doc") {
    output.push(
      `${prefix}${type} ${Object.keys(attrs).length === 0 ? "" : stable(attrs)}`.trimEnd(),
    );
  }
  for (const child of children) projectNode(child, depth + (type === "doc" ? 0 : 1), output);
}

export function projectVersionDocument(document: NoteDocument): readonly string[] {
  const output: string[] = [];
  projectNode(document as JsonNode, 0, output);
  return output;
}

function inlineTokens(value: string): readonly string[] {
  return value.split(/(\s+|(?=[.,;:!?()[\]{}])|(?<=[.,;:!?()[\]{}]))/u).filter(Boolean);
}

function inlineReplacement(
  before: string,
  after: string,
): {
  readonly before: readonly VersionDiffSegment[];
  readonly after: readonly VersionDiffSegment[];
} | null {
  const left = inlineTokens(before);
  const right = inlineTokens(after);
  if (
    left.length > VERSION_DIFF_MAX_INLINE_TOKENS ||
    right.length > VERSION_DIFF_MAX_INLINE_TOKENS ||
    left.length * right.length > VERSION_DIFF_MAX_INLINE_CELLS
  ) {
    return null;
  }
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i]![j] =
        left[i] === right[j]
          ? (matrix[i + 1]![j + 1] ?? 0) + 1
          : Math.max(matrix[i + 1]![j] ?? 0, matrix[i]![j + 1] ?? 0);
    }
  }
  const beforeSegments: VersionDiffSegment[] = [];
  const afterSegments: VersionDiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      beforeSegments.push({ kind: "same", text: left[i]! });
      afterSegments.push({ kind: "same", text: right[j]! });
      i += 1;
      j += 1;
    } else if (
      j < right.length &&
      (i === left.length || (matrix[i]![j + 1] ?? 0) >= (matrix[i + 1]![j] ?? 0))
    ) {
      afterSegments.push({ kind: "added", text: right[j]! });
      j += 1;
    } else {
      beforeSegments.push({ kind: "deleted", text: left[i]! });
      i += 1;
    }
  }
  return { before: beforeSegments, after: afterSegments };
}

export function diffVersionDocuments(before: NoteDocument, after: NoteDocument): VersionDiffResult {
  const left = projectVersionDocument(before);
  const right = projectVersionDocument(after);
  if (
    left.length > VERSION_DIFF_MAX_TOKENS ||
    right.length > VERSION_DIFF_MAX_TOKENS ||
    left.length * right.length > VERSION_DIFF_MAX_CELLS
  ) {
    return { tooLarge: true, before: [], after: [], additions: 0, deletions: 0 };
  }
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i]![j] =
        left[i] === right[j]
          ? (matrix[i + 1]![j + 1] ?? 0) + 1
          : Math.max(matrix[i + 1]![j] ?? 0, matrix[i]![j + 1] ?? 0);
    }
  }
  const beforeSegments: VersionDiffSegment[] = [];
  const afterSegments: VersionDiffSegment[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      beforeSegments.push({ kind: "same", text: left[i]! });
      afterSegments.push({ kind: "same", text: right[j]! });
      i += 1;
      j += 1;
    } else if (
      i < left.length &&
      j < right.length &&
      (matrix[i + 1]![j + 1] ?? 0) >= (matrix[i + 1]![j] ?? 0) &&
      (matrix[i + 1]![j + 1] ?? 0) >= (matrix[i]![j + 1] ?? 0) &&
      /^(?:Paragraph|Heading \d+|Code \()/u.test(left[i]!) &&
      /^(?:Paragraph|Heading \d+|Code \()/u.test(right[j]!)
    ) {
      const replacement = inlineReplacement(left[i]!, right[j]!);
      if (replacement === null) {
        beforeSegments.push({ kind: "deleted", text: left[i]! });
        afterSegments.push({ kind: "added", text: right[j]! });
      } else {
        beforeSegments.push(...replacement.before);
        afterSegments.push(...replacement.after);
      }
      deletions += 1;
      additions += 1;
      i += 1;
      j += 1;
    } else if (
      j < right.length &&
      (i === left.length || (matrix[i]![j + 1] ?? 0) >= (matrix[i + 1]![j] ?? 0))
    ) {
      afterSegments.push({ kind: "added", text: right[j]! });
      additions += 1;
      j += 1;
    } else {
      beforeSegments.push({ kind: "deleted", text: left[i]! });
      deletions += 1;
      i += 1;
    }
  }
  return { tooLarge: false, before: beforeSegments, after: afterSegments, additions, deletions };
}
