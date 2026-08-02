export const NOTE_AUDIT_ENTITY_TYPE = "note" as const;
export const FOLDER_AUDIT_ENTITY_TYPE = "folder" as const;
export const NOTE_DOMAIN_EVENT_QUEUE = "note-domain-events" as const;
export const NOTE_DOMAIN_EVENT_PAYLOAD_VERSION = 1 as const;
export const NOTE_DOMAIN_EVENT_IDEMPOTENCY_PREFIX = "note-domain:" as const;

export const NOTE_DOMAIN_EVENTS = Object.freeze({
  create: "note.created",
  update: "note.updated",
  move: "note.moved",
  delete: "note.deleted",
  restore: "note.restored",
  permanentDelete: "note.permanently_deleted",
  folderCreate: "folder.created",
  folderUpdate: "folder.updated",
  folderDelete: "folder.deleted",
} as const);

export const NOTE_SHARE_DOMAIN_EVENTS = Object.freeze({
  upsert: "note.share.upserted",
  revoke: "note.share.revoked",
} as const);

export type NoteMutation = keyof typeof NOTE_DOMAIN_EVENTS;

export const FOLDER_MAX_DEPTH = 3 as const;

export const NOTE_DEFAULT_DOCUMENT = Object.freeze({
  type: "doc",
  content: [],
}) satisfies NoteDocument;
import type { NoteDocument } from "@notted/shared-types";
