// Part 45: stable identifiers for the storage-maintenance surface.

/** Audit verb written once per authorized, workspace-scoped maintenance run. */
export const STORAGE_MAINTENANCE_AUDIT_ACTION = "storage.maintenance" as const;

/** The audited entity is the workspace itself, not an individual attachment. */
export const STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE = "workspace" as const;

/**
 * The complete vocabulary of sweep note codes.
 *
 * Fixed strings, never interpolated and never derived from an exception
 * message, so a report can be logged and returned to an administrator without
 * any chance of leaking a filename, an object key, a signed URL, or content
 * (`docs/standards/observability.md`). The shared Zod contract additionally
 * constrains them to snake_case.
 */
export const STORAGE_MAINTENANCE_NOTES = Object.freeze({
  /** Object storage is switched off, so object-touching work was skipped. */
  storageDisabled: "storage_disabled",
  /** The bucket listing hit its configured key ceiling. */
  objectScanTruncated: "object_scan_truncated",
  /** Keys were seen that are not in the Part 40 attachment layout; never deleted. */
  unparsableKeysSkipped: "unparsable_keys_skipped",
  /** A key's workspace partition disagreed with its row; refused, not deleted. */
  workspaceMismatchSkipped: "workspace_mismatch_skipped",
  /** `ready` rows whose bytes are gone were marked failed. */
  missingObjectsMarked: "missing_objects_marked",
  /**
   * `ready` file attachments that no note document currently references.
   * REPORT ONLY — see `StorageMaintenanceService` for why these are never
   * deleted.
   */
  unreferencedAttachmentsDetected: "unreferenced_attachments_detected",
  /** An export object could not be removed; its key was deliberately kept. */
  exportObjectRemovalFailed: "export_object_removal_failed",
  /** A note was skipped because purging it would cascade into a live descendant. */
  notePurgeSkippedLiveDescendant: "note_purge_skipped_live_descendant",
  /** Every plan has an unlimited deleted-note window, so nothing was scanned. */
  deletedNoteRetentionUnlimited: "deleted_note_retention_unlimited",
} as const);
