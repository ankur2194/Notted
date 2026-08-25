// Part 71 — the read-only workspace audit trail over the versioned REST
// surface. There is no tRPC counterpart: audit review is an admin/compliance
// surface, not a first-party editor feature, matching the api-keys precedent.
//
// Both routes authorize `{ kind: "workspace" }`: an audit trail is
// workspace-wide, not per-entity, so reading or exporting it is an
// owner/admin question about the WORKSPACE, never about one row in it.

import { Controller, Get, HttpStatus, Query, Req, Res } from "@nestjs/common";
import {
  auditLogExportQuerySchema,
  auditLogListQuerySchema,
  uuidSchema,
} from "@notted/shared-validators";

import { contentDisposition } from "../attachments/attachments.controller";
import { getAuthPrincipal } from "../auth/auth-principal";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { auditLogsToCsv } from "./audit-csv";
import { AuditLogsService } from "./audit-logs.service";

import type { AuditLogPage, AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request, Response } from "express";

function routeWorkspaceId(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

const workspaceAuthorization = (action: "audit.read" | "audit.export") => ({
  action,
  workspaceId: (request: Request) => routeWorkspaceId(request),
  resource: () => ({ kind: "workspace" as const }),
});

/** `yyyymmdd`, UTC, for the export filename — sorts and diffs cleanly on disk. */
function exportDateStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/gu, "");
}

@Controller("workspaces/:workspaceId/audit-logs")
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  /**
   * Declared BEFORE the bare `@Get()` collection route on purpose: Nest
   * matches routes in declaration order, and a literal path like "export"
   * must never be able to fall through to a parameterised sibling declared
   * earlier. This controller has no `:id` route today, so nothing actually
   * shadows this one yet — the ordering is kept anyway as the house
   * convention (see `export.controller.ts`), so a future `:auditLogId` route
   * cannot silently swallow it.
   */
  @Get("export")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("audit.export"))
  async export(
    @Req() request: Request,
    @Query() rawQuery: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const query = auditLogExportQuerySchema.safeParse(rawQuery ?? {});
    if (!query.success) this.invalid();
    const rows = await this.auditLogs.exportRows({ ...this.scope(request), ...query.data });
    const csv = auditLogsToCsv(rows);
    const workspaceId = routeWorkspaceId(request);

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    // ALWAYS `attachment`: the file is opened in a spreadsheet application,
    // never rendered same-origin.
    response.setHeader(
      "Content-Disposition",
      contentDisposition(`audit-logs-${workspaceId}-${exportDateStamp()}.csv`, "attachment"),
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    // Principal-dependent and filter-dependent: a cached copy could answer a
    // different query than the one that produced it.
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("Content-Length", String(Buffer.byteLength(csv, "utf8")));
    response.status(HttpStatus.OK);
    // Fully materialised, not streamed: the row count is bounded at
    // `AUDIT_LOG_EXPORT_MAX_ROWS` (10,000) by the service, so the whole CSV
    // already fits comfortably in memory — a stream would add ceremony for
    // no bound it does not already have.
    response.send(csv);
  }

  @Get()
  @RequireAuthorization(workspaceAuthorization("audit.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<AuditLogPage> {
    const query = auditLogListQuerySchema.safeParse(rawQuery ?? {});
    if (!query.success) this.invalid();
    return this.auditLogs.list({ ...this.scope(request), ...query.data });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeWorkspaceId(request),
      requestId: getRequestId(request) ?? null,
    };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
