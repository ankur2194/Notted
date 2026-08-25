import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

/**
 * Part 71 — the workspace audit trail.
 *
 * Read-only by construction: `audit_logs` is append-only (a database trigger
 * refuses UPDATE and DELETE), so there is no mutation contract here — only the
 * two routes an administrator reads it through.
 */
export const AUDIT_LOG_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/audit-logs`,
  export: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/audit-logs/export`,
} as const);

/**
 * One recorded action. `userId`/`userName` are `null` for a system actor and for
 * an actor whose account was deleted (`user_id` is SET NULL, so the event
 * survives the person).
 */
export interface AuditLogEntry {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId | null;
  readonly userName: string | null;
  /** `<entity>.<verb>`, lowercase — e.g. `apiKey.created`, `export.download`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Identifiers and cheap facts only; never content, credentials, or URLs. */
  readonly metadata: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly createdAt: IsoTimestamp;
}

export interface AuditLogPage {
  readonly items: readonly AuditLogEntry[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** Filters shared by the paged list and the bounded CSV export. */
export interface AuditLogFilters {
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly userId?: string;
  readonly from?: IsoTimestamp;
  readonly to?: IsoTimestamp;
}

export interface AuditLogListQuery extends AuditLogFilters {
  readonly page: number;
  readonly limit: number;
}
