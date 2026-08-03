import {
  type NoteDocumentMigrationResult,
  migrateNoteDocument,
  parseNoteDocument,
  renderDocumentHtml,
  sanitizeDocumentUrl,
} from "@notted/shared-validators";

export interface NoteDocumentHtmlResult extends NoteDocumentMigrationResult {
  readonly html: string;
}

/** Normalize historical input before it can be handed to a TipTap editor. */
export function prepareNoteDocumentForEditor(input: unknown): NoteDocumentMigrationResult {
  const migration = migrateNoteDocument(input);
  return {
    ...migration,
    doc: parseNoteDocument(migration.doc),
  };
}

/** Render only a migrated, contract-valid document through the shared allow-list renderer. */
export function noteDocumentToSafeHtml(input: unknown): NoteDocumentHtmlResult {
  const migration = prepareNoteDocumentForEditor(input);
  return {
    ...migration,
    html: renderDocumentHtml(migration.doc),
  };
}

export function isAllowedDocumentLink(href: unknown): boolean {
  return sanitizeDocumentUrl(href) !== null;
}
