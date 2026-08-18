import { EXPORT_API_PATHS } from "@notted/shared-types";
import {
  exportCreateSchema,
  exportFormatSchema,
  exportOptionsSchema,
  exportSourceSchema,
  exportStatusSchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type { ExportJob } from "@notted/shared-types";
import type { ExportCreateInput } from "@notted/shared-validators";

import { publicEnvironment } from "@/config/public-environment";
import { json, requestJson, validIds } from "@/lib/api/request-json";

/*
 * Part 64 — the browser half of the export job lifecycle.
 *
 * There is no response schema for `ExportJob` in `@notted/shared-validators`
 * (that package ships the *request* contracts), and `apps/web` does not depend
 * on `zod` directly, so the trust-boundary parser below is hand written. It
 * still reuses the shared enum and options schemas for every field that has
 * one, so a new format or status can never be accepted here without being
 * accepted by the server first.
 */

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Narrow parser for the `ExportJob` wire shape.
 *
 * Unknown extra properties are ignored rather than rejected: the server may add
 * a field before this client is redeployed, and refusing the whole response
 * would turn a forward-compatible addition into a broken export dialog.
 */
export function parseExportJob(
  value: unknown,
): { readonly success: true; readonly data: ExportJob } | { readonly success: false } {
  if (typeof value !== "object" || value === null) return { success: false };
  const raw = value as Record<string, unknown>;
  const format = exportFormatSchema.safeParse(raw.format);
  const status = exportStatusSchema.safeParse(raw.status);
  const sourceType = exportSourceSchema.safeParse(raw.sourceType);
  const options = exportOptionsSchema.safeParse(raw.options);
  if (!format.success || !status.success || !sourceType.success || !options.success) {
    return { success: false };
  }
  const { id, workspaceId, requestedById, createdAt } = raw;
  if (!isString(id) || !isString(workspaceId) || !isString(requestedById) || !isString(createdAt)) {
    return { success: false };
  }
  const { sourceId, errorCode, errorMessage, completedAt, downloadExpiresAt, downloadPath } = raw;
  if (
    !isNullableString(sourceId) ||
    !isNullableString(errorCode) ||
    !isNullableString(errorMessage) ||
    !isNullableString(completedAt) ||
    !isNullableString(downloadExpiresAt) ||
    !isNullableString(downloadPath)
  ) {
    return { success: false };
  }
  return {
    success: true,
    data: {
      id,
      workspaceId,
      requestedById,
      format: format.data,
      status: status.data,
      sourceType: sourceType.data,
      sourceId,
      options: options.data,
      errorCode,
      errorMessage,
      createdAt,
      completedAt,
      downloadExpiresAt,
      downloadPath,
    },
  };
}

/**
 * Start an export.
 *
 * `Idempotency-Key` is mandatory on this route (the controller refuses the
 * request without one), so the caller owns the key and must reuse the SAME
 * value across retries of one user-initiated export — otherwise a retry after a
 * network timeout queues a second render of the same note.
 */
export function createExportJob(
  workspaceId: string,
  input: ExportCreateInput,
  idempotencyKey: string,
): Promise<ApiRequestResult<ExportJob>> {
  const parsed = exportCreateSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    EXPORT_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    parseExportJob,
  );
}

export function requestExportJob(
  workspaceId: string,
  exportId: string,
): Promise<ApiRequestResult<ExportJob>> {
  if (!validIds(workspaceId, exportId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(EXPORT_API_PATHS.detail(workspaceId, exportId), {}, parseExportJob);
}

/** Cancel is a POST with no body; the route is idempotent server-side. */
export function cancelExportJob(
  workspaceId: string,
  exportId: string,
): Promise<ApiRequestResult<ExportJob>> {
  if (!validIds(workspaceId, exportId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    EXPORT_API_PATHS.cancel(workspaceId, exportId),
    json("POST", {}),
    parseExportJob,
  );
}

/**
 * Absolute URL for the streaming download route, used as an `<a download href>`
 * exactly like an attachment's content URL (Part 44): the route is login gated
 * and re-authorizes on every byte, so a plain anchor carrying the session
 * cookie is the whole mechanism — no fetch, no blob, no signed URL.
 *
 * Built from `EXPORT_API_PATHS` rather than from the job's own `downloadPath`
 * on purpose: they address the same route, and resolving a server-supplied
 * string into an anchor href would make that field an open-redirect surface.
 */
export function exportDownloadUrl(workspaceId: string, exportId: string): string {
  return new URL(
    EXPORT_API_PATHS.download(workspaceId, exportId),
    publicEnvironment.NEXT_PUBLIC_API_URL,
  ).toString();
}
