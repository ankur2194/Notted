/**
 * Stable domain identifiers, deliberately independent from physical queue names.
 * Only identifiers in the registry may be dispatched; historical outbox rows
 * with unknown queue/type pairs must remain untouched for operator remediation.
 */
export const DOMAIN_JOB_TYPES = Object.freeze({
  deliverAuthEmail: "deliver-auth-email",
  sendWorkspaceInvitation: "workspace.invitation.send",
  noteCreated: "note.created",
  noteUpdated: "note.updated",
  noteMoved: "note.moved",
  noteDeleted: "note.deleted",
  noteRestored: "note.restored",
  notePermanentlyDeleted: "note.permanently_deleted",
  folderCreated: "folder.created",
  folderUpdated: "folder.updated",
  folderDeleted: "folder.deleted",
  noteShareUpserted: "note.share.upserted",
  noteShareRevoked: "note.share.revoked",
  projectCreated: "project.created",
  projectUpdated: "project.updated",
  projectArchived: "project.archived",
  projectCompleted: "project.completed",
  projectRestored: "project.restored",
  projectDeleted: "project.deleted",
  tagCreated: "tag.created",
  tagUpdated: "tag.updated",
  tagDeleted: "tag.deleted",
  taskCreated: "task.created",
  taskUpdated: "task.updated",
  taskReordered: "task.reordered",
  taskDeleted: "task.deleted",
  taskBulkApplied: "task.bulk_applied",
  attachmentCreated: "attachment.created",
  attachmentDeleted: "attachment.deleted",
  workspaceDeleted: "workspace.deleted",
  workspaceSearchPurge: "workspace.search.purge",
  storageMaintenanceSweep: "storage.maintenance.sweep",
  jobIdempotencyCleanup: "queue.idempotency.cleanup",
  // Part 51.2 — system-owned, rebuildable search-index sync. Producers
  // (Part 51.3) emit one intent per note mutation batch; the handler re-reads
  // authoritative PostgreSQL state so out-of-order events converge.
  noteSearchSync: "note.search.sync",
} as const);

export type DomainJobType = (typeof DOMAIN_JOB_TYPES)[keyof typeof DOMAIN_JOB_TYPES];
