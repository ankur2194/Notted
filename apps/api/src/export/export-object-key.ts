// Part 62 — export object addressing.
//
// ADR 0005: PostgreSQL is authoritative for export identity, ownership and
// state; MinIO stores only the private bytes. The key below is a storage
// ADDRESS, never authority. Possession of it grants nothing: the `exports`
// bucket is private (`compose.yaml:310` applies `mc anonymous set none`) and
// every download re-reads the `exports` row, re-checks the workspace scope and
// the download grant before a single byte is streamed.
//
// The key is DELIBERATELY deterministic in (workspace, export). A retried
// generation overwrites the same object instead of orphaning bytes that the
// Part 45 storage-maintenance sweep would then have to reconcile against a row
// that never referenced them. There is exactly one artefact per export row, so
// there is nothing to version.
//
// The workspace prefix is what makes the sweep and any future per-tenant
// lifecycle rule expressible as a single `listObjects({ prefix })` call.

/** Deterministic, workspace-scoped storage ADDRESS. Never authority (ADR 0005). */
export function exportObjectKey(
  workspaceId: string,
  exportId: string,
  fileExtension: string,
): string {
  return `${workspaceId}/${exportId}.${fileExtension}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXPORT_OBJECT_KEY_PATTERN = new RegExp(`^(${UUID})/(${UUID})\\.([a-z0-9]{1,8})$`, "u");

export interface ParsedExportObjectKey {
  readonly workspaceId: string;
  readonly exportId: string;
  readonly fileExtension: string;
}

/**
 * Reconciliation/cleanup helper, mirroring `parseAttachmentObjectKey`.
 *
 * NEVER call this to make an access decision — a key is a storage ADDRESS and
 * never authority (ADR 0005). It exists so the Part 45 storage sweep can
 * attribute a stray object in the `exports` bucket to a workspace, which it
 * could not do at all before: the sweep only ever listed `attachments`, so
 * bytes written by a worker that died between `putObject` and `markReady` were
 * referenced by no row and reclaimed by nothing.
 *
 * Returns `null` for any key that is not the canonical layout, which is what
 * routes an unrecognised object to the `unparsable_key` branch rather than to
 * deletion.
 */
export function parseExportObjectKey(key: string): ParsedExportObjectKey | null {
  const match = EXPORT_OBJECT_KEY_PATTERN.exec(key);
  if (match === null) return null;
  const [, workspaceId, exportId, fileExtension] = match;
  if (workspaceId === undefined || exportId === undefined || fileExtension === undefined) {
    return null;
  }
  return Object.freeze({ workspaceId, exportId, fileExtension });
}

/** Longest filename stem we hand back; long enough to stay recognisable. */
const MAX_FILENAME_STEM_LENGTH = 80;

/**
 * Safe download filename: an ASCII-ish slug of the source title plus the
 * extension. The stem is rebuilt from an allow-list, so a hostile title cannot
 * smuggle a path separator, a quote that would break the `Content-Disposition`
 * header, or a control character into the response. The controller's own
 * `contentDisposition` helper still applies RFC 5987 encoding on top; this is
 * the value-level guard, not a replacement for it.
 */
export function exportDownloadFilename(sourceLabel: string, fileExtension: string): string {
  const stem = sourceLabel
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^A-Za-z0-9._-]/gu, "")
    // Trim the separators the two steps above can leave behind: a leading dot
    // would produce a hidden file, and a stem of only punctuation is no name at
    // all (a title written entirely in a non-Latin script reduces to exactly
    // that, and must fall through to the generic name below).
    .replace(/^[.\-_]+|[.\-_]+$/gu, "")
    .slice(0, MAX_FILENAME_STEM_LENGTH);
  return `${stem === "" ? "export" : stem}.${fileExtension}`;
}
