import { isRecord, isUuidValue, NOTE_DOCUMENT_LIMITS } from "./document-core";
import { safeParseNoteDocument } from "./document.schema";

/**
 * Whether the CURRENT, valid persisted document contains this typed attachment.
 * A historical attachment row (or a filename/id in text) is not a grant. The
 * document validator supplies the size, depth, node and shape bounds before we
 * inspect any content; invalid or cyclic input never authorizes a download.
 */
export function documentReferencesAttachment(
  document: unknown,
  attachmentId: string,
  mediaType: "image" | "file",
): boolean {
  if (!isUuidValue(attachmentId) || (mediaType !== "image" && mediaType !== "file")) return false;

  try {
    // Snapshot unknown input into JSON first. A getter that changes between
    // validation and traversal must not be able to swap in a forged reference.
    // Persisted PostgreSQL JSON is already inert, but this exported boundary
    // also accepts callers' plain unknown values.
    const serialized = JSON.stringify(document);
    if (serialized === undefined) return false;
    const snapshot: unknown = JSON.parse(serialized);
    // Validate the WHOLE document before granting access, even when the first
    // node happens to match. A forged attribute or malformed sibling is not a
    // reference. This also enforces the serialized-byte and nesting budgets.
    const parsed = safeParseNoteDocument(snapshot, serialized);
    if (!parsed.success) return false;

    const nodes: unknown[] = [parsed.doc];
    let visited = 0;
    while (nodes.length > 0) {
      if (++visited > NOTE_DOCUMENT_LIMITS.maxNodes) return false;
      const node = nodes.pop();
      if (!isRecord(node)) return false;
      if (
        node.type === (mediaType === "image" ? "image" : "attachment") &&
        isRecord(node.attrs) &&
        node.attrs.attachmentId === attachmentId
      ) {
        return true;
      }
      if (Array.isArray(node.content)) nodes.push(...node.content);
    }
  } catch {
    // The persisted value is JSON, but this public helper accepts unknown.
    // Hostile accessors and other non-JSON objects must fail closed too.
    return false;
  }
  return false;
}
