// Part 26 — stable identifiers for workspace lifecycle audit and cleanup.
//
// These constants name the audit action verbs written to `audit_logs` and the
// durable `job_outbox` intent emitted when a workspace is deleted. The object-
// completed object-store cleanup and the search-index purge use separate
// concern-specific intents committed atomically with workspace deletion.
//
// Mirrors `apps/api/src/auth/auth-email.types.ts` for the job-type/version pair.

/** Audit `action` verbs for `audit_logs` rows written by WorkspacesService. */
export const WORKSPACE_AUDIT_ACTIONS = Object.freeze({
  create: "workspace.create",
  update: "workspace.update",
  delete: "workspace.delete",
  // Part 72 branding. Separate from `workspace.update` because the logo does
  // not travel through `PATCH /workspaces/{id}` at all — it is a multipart
  // route with its own object-store side effect — and because "who replaced the
  // workspace's public face, and when" is exactly the question an audit reader
  // asks. Metadata carries the stored byte count and the source format only —
  // never the image, a URL, or the object token, which is the bearer capability
  // for a public address and must not reach an exportable log.
  logoUpdate: "workspace.logo.update",
  logoDelete: "workspace.logo.delete",
} as const);

/** `audit_logs.entity_type` for workspace lifecycle events. */
export const WORKSPACE_AUDIT_ENTITY_TYPE = "workspace" as const;

/**
 * Durable cleanup intent emitted on workspace deletion. The payload carries
 * identifiers only (workspace id, actor id) — never content, credentials, or
 * signed URLs. `job_outbox.workspace_id` is SET NULL on cascade so the intent
 * survives the workspace row deletion; the payload's `workspaceId` preserves
 * the target for the cleanup worker.
 */
export const WORKSPACE_DELETED_JOB_TYPE = "workspace.deleted" as const;
export const WORKSPACE_DELETED_QUEUE_NAME = "workspace-cleanup" as const;
export const WORKSPACE_DELETED_PAYLOAD_VERSION = 1 as const;

/**
 * Idempotency prefix for the cleanup intent. Workspace ids are unique UUIDs and
 * are never recycled, so `workspace-deleted:<workspaceId>` is naturally unique
 * per deletion and safe to retry if the dispatcher re-reads the outbox row.
 */
export const WORKSPACE_DELETED_IDEMPOTENCY_PREFIX = "workspace-deleted:" as const;
export const WORKSPACE_SEARCH_PURGE_JOB_TYPE = "workspace.search.purge" as const;
export const WORKSPACE_SEARCH_PURGE_QUEUE_NAME = "workspace-search-purge" as const;
export const WORKSPACE_SEARCH_PURGE_IDEMPOTENCY_PREFIX = "workspace-search-purge:" as const;

/** Maximum slug-resolution attempts before surfacing a slug-collision error. */
export const WORKSPACE_MAX_SLUG_ATTEMPTS = 5 as const;
