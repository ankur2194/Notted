/**
 * Loaded attachment metadata, as the image node view sees it (Part 42).
 *
 * Deliberately shaped exactly like `MentionDirectory`: node views are created
 * once per node, so they subscribe here and repaint when metadata arrives or
 * changes. `setEntries(null)` means "not loaded or unavailable", which resolves
 * to `unknown` — never to `missing`, because an unavailable list is not evidence
 * that an attachment was deleted, and rendering "this image is gone" on a failed
 * fetch would be a lie the reader cannot check.
 *
 * Every URL held here is an **absolute, authorization-checked API URL** built by
 * `lib/notes/attachment-requests.ts`. There are no presigned storage URLs
 * anywhere in the frontend: MinIO is unreachable from a browser, and the content
 * endpoint re-checks workspace membership on every request.
 */

import type {
  AttachmentMediaType,
  AttachmentServableVariant,
  AttachmentStatus,
} from "@notted/shared-types";

/** One attachment's renderable projection. Never carries an object key. */
export interface AttachmentEntry {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly status: AttachmentStatus;
  /**
   * Part 44. `image` renders through `CustomImage`; `file` renders a card.
   * The node type in the document already says which, so this is a consistency
   * check rather than a router: a card whose metadata says `image` is a document
   * that disagrees with the database, and the card says so instead of guessing.
   */
  readonly mediaType: AttachmentMediaType;
  /** Authoritative stored type. Overrides the node's cached copy. */
  readonly mimeType: string;
  /** Authoritative size in bytes. Overrides the node's cached copy. */
  readonly sizeBytes: number;
  /** ISO timestamp the attachment was created. Shown on the card. */
  readonly createdAt: string;
  /**
   * Absolute, authorization-checked API URL for the stored bytes (Part 44).
   *
   * It is the `full` content URL, which for a generic file resolves to the one
   * stored object. It is used as an `<a download href>` target and as the fetch
   * source for the PDF preview — never persisted into the note document, which
   * has no attribute that could hold it.
   */
  readonly contentUrl: string;
  /** Intrinsic size of the servable rendition, for reserving layout space. */
  readonly width: number | null;
  readonly height: number | null;
  /**
   * Bounded `data:image/webp;base64,…` placeholder from the Part 41 pipeline, or
   * `null`. It is painted as a CSS background while the real bytes load and
   * **never enters the note document** — the contract has no attribute for it.
   */
  readonly blurDataUri: string | null;
  /** Absolute proxied API URLs, one per servable variant. */
  readonly sources: Readonly<Record<AttachmentServableVariant, string>>;
}

export type AttachmentResolution =
  | { readonly kind: "ready"; readonly entry: AttachmentEntry }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

export interface AttachmentDirectory {
  resolve(attachmentId: string): AttachmentResolution;
  /** Replace the loaded set. `null` means "not loaded or unavailable". */
  setEntries(entries: readonly AttachmentEntry[] | null): void;
  /**
   * Add or replace one entry.
   *
   * The upload manager calls this **before** the temp→permanent swap, so the
   * node view already has the blur placeholder and the intrinsic size when the
   * node first mounts. Without that ordering the image would mount unresolved
   * and flash an empty frame for one paint.
   */
  upsert(entry: AttachmentEntry): void;
  subscribe(listener: () => void): () => void;
}

export function createAttachmentDirectory(
  initial: readonly AttachmentEntry[] | null = null,
): AttachmentDirectory {
  let byId: Map<string, AttachmentEntry> | null =
    initial === null ? null : new Map(initial.map((entry) => [entry.attachmentId, entry]));
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    resolve: (attachmentId: string): AttachmentResolution => {
      if (byId === null) return { kind: "unknown" };
      const entry = byId.get(attachmentId);
      return entry === undefined ? { kind: "missing" } : { kind: "ready", entry };
    },
    setEntries: (entries: readonly AttachmentEntry[] | null): void => {
      byId = entries === null ? null : new Map(entries.map((e) => [e.attachmentId, e]));
      notify();
    },
    upsert: (entry: AttachmentEntry): void => {
      // A freshly uploaded attachment is known even when the list request has
      // not landed (or failed), so the map is created rather than left null.
      byId = new Map(byId ?? []);
      byId.set(entry.attachmentId, entry);
      notify();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Whether a document contains at least one `image` node.
 *
 * Gates the attachment metadata fetch exactly the way `documentHasMention` gates
 * the member fetch: a note with no images asks for nothing on open, and a note
 * that gains one populates the same cache entry through the upload path. Reads
 * raw JSON because it only gates a fetch — a false negative costs one lazy
 * request, never correctness.
 */
export function documentHasImage(document: unknown): boolean {
  return documentHasNodeType(document, "image");
}

/**
 * Whether a document contains at least one `attachment` node (Part 44).
 *
 * Gates the same metadata fetch `documentHasImage` gates, and for the same
 * reason. Both feed one directory and one cache entry, so a note holding either
 * kind issues exactly one listing request on open.
 */
export function documentHasAttachment(document: unknown): boolean {
  return documentHasNodeType(document, "attachment");
}

function documentHasNodeType(document: unknown, type: string): boolean {
  if (Array.isArray(document)) return document.some((child) => documentHasNodeType(child, type));
  if (typeof document !== "object" || document === null) return false;
  const node: Record<string, unknown> = document as Record<string, unknown>;
  if (node.type === type) return true;
  return documentHasNodeType(node.content, type);
}
