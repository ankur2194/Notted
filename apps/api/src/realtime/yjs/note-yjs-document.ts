// Part 58 — the ONLY place the server converts between the stored TipTap JSON
// document (ADR 0004) and a Yjs shared type.
//
// This module is PURE on purpose: no NestJS, no database, no logging, no clock.
// It imports `yjs` and the shared document contract and nothing else, so the
// conversion can be exercised in isolation by `note-yjs-document.test.ts` — the
// only cheap way to be confident about the property below.
//
// THE INTEROP PROPERTY THIS FILE EXISTS TO HOLD. The browser does NOT use this
// code. It runs the real `y-prosemirror` via `@tiptap/extension-collaboration`,
// and it writes the SAME shared type this module reads and writes. So the
// mapping here is not a design choice — it is a transcription of what
// `y-prosemirror` 1.3.x already does in `updateYFragment` /
// `createTypeFromElementNode` / `createNodeFromYElement`. Any deviation
// produces a document that decodes differently on the two sides, which is
// silent content corruption rather than an error. The rules, in full:
//
//   - The root is `doc.getXmlFragment("default")` — the field name Tiptap's
//     `Collaboration` extension defaults to. The ProseMirror `doc` node itself
//     is NOT represented; its `content` array IS the fragment's children.
//   - A non-text node becomes `new Y.XmlElement(node.type)`. Each entry of
//     `attrs` is set with `setAttribute` EXCEPT `null` values, which
//     `y-prosemirror` skips (a `null` attribute means "the ProseMirror default",
//     and storing it would make two clients disagree about defaults).
//   - Children are normalised the way `normalizePNodeContent` does: a run of
//     CONSECUTIVE `text` nodes collapses into ONE `Y.XmlText`; every other
//     child gets its own sibling `Y.XmlElement`. That includes INLINE atoms
//     (`mention`, `hardBreak`) — they are siblings, not `insertEmbed` values.
//     An embed would not round-trip through `y-prosemirror`, which only ever
//     reads string inserts out of an `XmlText`.
//   - A text run is written as one `applyDelta` whose ops carry
//     `attributes = { [markType]: markAttrs ?? {} }`. The `attributes` key is
//     always present, even when empty, matching `marksToAttributes`.
//
// VALIDATION BOUNDARY. `noteDocumentToYDoc` runs the input through
// `safeParseNoteDocument` FIRST. That is deliberate and it is the only
// allowlist: an unknown node type, a disallowed attribute, or an oversized
// document is REJECTED here rather than silently dropped into a shared type
// that every connected client would then adopt. `yDocToNoteDocument` does the
// opposite — it returns `unknown` and validates nothing, because the caller
// owns what happens to a projection that fails the contract (reject the update,
// keep the last good projection) and this module must not decide that.

import { safeParseNoteDocument, type NoteDocumentJson } from "@notted/shared-validators";
import * as Y from "yjs";

/**
 * The Yjs root field name. Must match `Collaboration.configure({ field })` on
 * the client; `"default"` is the Tiptap default and is not configured away.
 */
export const NOTE_YJS_FIELD = "default";

/** Raised when a document or a shared type cannot be converted losslessly. */
export class NoteYjsConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteYjsConversionError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One normalised child slot: either a run of consecutive text nodes that share
 * a single `Y.XmlText`, or a single non-text node that gets its own element.
 * Mirrors `y-prosemirror`'s `normalizePNodeContent`.
 */
type NormalizedChild =
  | { readonly kind: "textRun"; readonly nodes: JsonRecord[] }
  | { readonly kind: "node"; readonly node: JsonRecord };

function normalizeChildren(content: readonly unknown[]): NormalizedChild[] {
  const normalized: NormalizedChild[] = [];
  let run: JsonRecord[] | null = null;
  for (const child of content) {
    if (!isRecord(child)) {
      throw new NoteYjsConversionError("Document child must be an object");
    }
    if (child.type === "text") {
      if (run === null) {
        run = [];
        normalized.push({ kind: "textRun", nodes: run });
      }
      run.push(child);
      continue;
    }
    run = null;
    normalized.push({ kind: "node", node: child });
  }
  return normalized;
}

/** `marksToAttributes`: one delta attribute per mark, always an object value. */
function marksToAttributes(marks: unknown): Record<string, NoteDocumentJson> {
  const attributes: Record<string, NoteDocumentJson> = {};
  if (marks === undefined) return attributes;
  if (!Array.isArray(marks)) {
    throw new NoteYjsConversionError("Document text node marks must be an array");
  }
  for (const mark of marks) {
    if (!isRecord(mark) || typeof mark.type !== "string") {
      throw new NoteYjsConversionError("Document mark must carry a string type");
    }
    attributes[mark.type] = (mark.attrs ?? {}) as NoteDocumentJson;
  }
  return attributes;
}

function createXmlText(nodes: readonly JsonRecord[]): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(
    nodes.map((node) => {
      if (typeof node.text !== "string") {
        throw new NoteYjsConversionError("Document text node requires string text");
      }
      return { insert: node.text, attributes: marksToAttributes(node.marks) };
    }),
  );
  return text;
}

function createXmlElement(node: JsonRecord): Y.XmlElement {
  if (typeof node.type !== "string" || node.type.length === 0) {
    throw new NoteYjsConversionError("Document node requires a non-empty string type");
  }
  const element = new Y.XmlElement(node.type);

  const attrs = node.attrs;
  if (attrs !== undefined) {
    if (!isRecord(attrs)) {
      throw new NoteYjsConversionError(`Document ${node.type} attributes must be an object`);
    }
    for (const [key, value] of Object.entries(attrs)) {
      // `y-prosemirror` skips null attributes; see the module comment.
      if (value === null) continue;
      // Yjs types attribute values as `string`, but `y-prosemirror` stores RAW
      // ProseMirror attribute values (numbers like `level`, booleans like
      // `checked`, arrays like `colwidth`) and Yjs encodes them as `ContentAny`.
      // The cast keeps the encoded bytes identical to what the browser writes;
      // narrowing to `string` here would corrupt every numeric attribute.
      element.setAttribute(key, value as never);
    }
  }

  const content = node.content;
  if (content !== undefined) {
    if (!Array.isArray(content)) {
      throw new NoteYjsConversionError(`Document ${node.type} content must be an array`);
    }
    element.insert(0, createChildren(content));
  }
  return element;
}

function createChildren(content: readonly unknown[]): (Y.XmlElement | Y.XmlText)[] {
  return normalizeChildren(content).map((child) =>
    child.kind === "textRun" ? createXmlText(child.nodes) : createXmlElement(child.node),
  );
}

/**
 * Build a fresh `Y.Doc` whose `"default"` fragment holds `document`.
 *
 * @throws NoteYjsConversionError when the document fails the shared contract.
 */
export function noteDocumentToYDoc(document: unknown): Y.Doc {
  const parsed = safeParseNoteDocument(document);
  if (!parsed.success) {
    throw new NoteYjsConversionError(`Invalid note document: ${parsed.errors.join("; ")}`);
  }

  const doc = new Y.Doc();
  // Validation already guarantees `content` is either absent or an array, so an
  // absent root content is simply an empty fragment.
  const content = parsed.doc.content;
  if (Array.isArray(content)) {
    doc.getXmlFragment(NOTE_YJS_FIELD).insert(0, createChildren(content));
  }
  return doc;
}

function deltaToTextNodes(text: Y.XmlText): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  for (const op of text.toDelta() as unknown[]) {
    if (!isRecord(op) || typeof op.insert !== "string") {
      // An embed. `y-prosemirror` never writes one, so reading one back means
      // the shared type was written by something that is not this editor.
      throw new NoteYjsConversionError("Yjs text delta must insert strings only");
    }
    const attributes = op.attributes;
    const marks: JsonRecord[] = [];
    if (attributes !== undefined) {
      if (!isRecord(attributes)) {
        throw new NoteYjsConversionError("Yjs text delta attributes must be an object");
      }
      for (const [markType, markAttrs] of Object.entries(attributes)) {
        marks.push(
          isRecord(markAttrs) && Object.keys(markAttrs).length > 0
            ? { type: markType, attrs: markAttrs }
            : { type: markType },
        );
      }
    }
    nodes.push(
      marks.length > 0
        ? { type: "text", text: op.insert, marks }
        : { type: "text", text: op.insert },
    );
  }
  return nodes;
}

function elementToJson(element: Y.XmlElement): JsonRecord {
  const attrs: JsonRecord = element.getAttributes();
  const content = childrenToJson(element.toArray());
  return {
    type: element.nodeName,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

function childrenToJson(children: readonly unknown[]): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  for (const child of children) {
    if (child instanceof Y.XmlElement) {
      nodes.push(elementToJson(child));
    } else if (child instanceof Y.XmlText) {
      nodes.push(...deltaToTextNodes(child));
    } else {
      throw new NoteYjsConversionError("Yjs fragment child must be an XmlElement or XmlText");
    }
  }
  return nodes;
}

/**
 * Project the `"default"` fragment back to TipTap JSON.
 *
 * Returns `unknown`: the caller validates with `safeParseNoteDocument` and owns
 * what happens when a projection fails the contract (see the module comment).
 *
 * @throws NoteYjsConversionError on a structurally impossible shared type.
 */
export function yDocToNoteDocument(doc: Y.Doc): unknown {
  return {
    type: "doc",
    content: childrenToJson(doc.getXmlFragment(NOTE_YJS_FIELD).toArray()),
  };
}
