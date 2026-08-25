import { AUDIT_LOG_API_PATHS } from "@notted/shared-types";
import { auditLogListQuerySchema, auditLogPageSchema } from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type { AuditLogFilters, AuditLogListQuery, AuditLogPage } from "@notted/shared-types";

import { apiOrigin } from "@/lib/api/api-origin";
import { requestJson, validIds } from "@/lib/api/request-json";

/**
 * Part 71 — the browser half of the workspace audit trail.
 *
 * Modelled on `@/lib/api-keys/requests`: the *serialized* query params are
 * validated against the shared schema before a request is allowed to leave,
 * and the response is `safeParse`d against the shared page schema so an
 * off-contract body is a failure rather than a silent cast. The routes are
 * admin-only server-side (`audit.read` / `audit.export`); a viewer or editor
 * gets a 403, which `requestJson` already collapses to
 * `kind: "forbidden-or-not-found"`.
 */
function auditLogSearch(query: AuditLogListQuery): URLSearchParams | null {
  const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
  // Each filter is set only when present: an absent filter must be OMITTED,
  // never sent empty, so the server's own "no filter" default stays in charge.
  if (query.action !== undefined) params.set("action", query.action);
  if (query.entityType !== undefined) params.set("entityType", query.entityType);
  if (query.entityId !== undefined) params.set("entityId", query.entityId);
  if (query.userId !== undefined) params.set("userId", query.userId);
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  return auditLogListQuerySchema.safeParse(Object.fromEntries(params)).success ? params : null;
}

/** One page of a workspace's audit trail, newest first. */
export function listAuditLogs(
  workspaceId: string,
  query: AuditLogListQuery,
): Promise<ApiRequestResult<AuditLogPage>> {
  const search = auditLogSearch(query);
  if (!validIds(workspaceId) || search === null) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    `${AUDIT_LOG_API_PATHS.collection(workspaceId)}?${search.toString()}`,
    {},
    (value) => auditLogPageSchema.safeParse(value),
  );
}

/**
 * Absolute URL for the bounded CSV export, used as an `<a download href>`
 * exactly like `exportDownloadUrl` (Part 64): the route is cookie-authorized
 * and re-authorizes `audit.export` on every request, so a plain anchor
 * carrying the session cookie is the whole mechanism — no fetch, no blob, no
 * signed URL.
 */
export function auditLogExportUrl(workspaceId: string, filters: AuditLogFilters): string {
  const url = new URL(AUDIT_LOG_API_PATHS.export(workspaceId), apiOrigin());
  if (filters.action !== undefined) url.searchParams.set("action", filters.action);
  if (filters.entityType !== undefined) url.searchParams.set("entityType", filters.entityType);
  if (filters.entityId !== undefined) url.searchParams.set("entityId", filters.entityId);
  if (filters.userId !== undefined) url.searchParams.set("userId", filters.userId);
  if (filters.from !== undefined) url.searchParams.set("from", filters.from);
  if (filters.to !== undefined) url.searchParams.set("to", filters.to);
  return url.toString();
}
