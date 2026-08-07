// Part 45: the workspace storage REST transport.
//
// A SEPARATE controller from `WorkspacesController` on purpose. Usage is a
// `sum()` over the workspace's attachment rows; folding it into
// `GET /api/v1/workspaces/:id` would make every ordinary workspace read — the
// shell, the switcher, the settings page load — pay for an aggregate that most
// of them ignore. A dedicated route also gives the administrative cleanup
// action a natural home under the same prefix.
//
// The prefix uses `:workspaceId` (matching `AttachmentsController`) rather than
// the `:id` that `WorkspacesController` uses, because these routes address a
// workspace's storage rather than the workspace record itself.
//
// Thin, as required: both handlers parse with shared Zod schemas and delegate.
// Neither one authorizes anything itself — `@RequireAuthorization` runs the
// central policy before the handler, and the services re-authorize independently
// so a mis-wired transport cannot widen access.

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { storageMaintenanceRequestSchema, uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";
import { StorageMaintenanceService } from "../maintenance/storage-maintenance.service";

import { StorageQuotaService } from "./storage-quota.service";

import type {
  AuthenticatedPrincipal,
  StorageMaintenanceReport,
  WorkspaceStorageUsage,
} from "@notted/shared-types";
import type { Request } from "express";

function workspaceIdFromRoute(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

/**
 * Reading usage is `settings.read` on the `settings` resource: every role may
 * see how full their workspace is, and the central policy already permits that
 * action for owner, admin, editor, and viewer alike.
 */
const READ_USAGE_AUTHORIZATION = {
  action: "settings.read" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "settings" as const }),
};

/**
 * Running cleanup is `settings.update`, which the central policy grants to
 * owner and admin and denies to editor and viewer. Reusing that existing action
 * is deliberate: a bespoke role comparison in this file would be a second,
 * untested copy of the permission matrix.
 */
const MAINTENANCE_AUTHORIZATION = {
  action: "settings.update" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "settings" as const }),
};

@Controller("workspaces/:workspaceId/storage")
export class StorageController {
  constructor(
    private readonly quota: StorageQuotaService,
    private readonly maintenance: StorageMaintenanceService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(READ_USAGE_AUTHORIZATION)
  read(@Req() request: Request): Promise<WorkspaceStorageUsage> {
    return this.quota.readUsage({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      requestId: getRequestId(request) ?? null,
    });
  }

  /**
   * Administrative cleanup.
   *
   * `HttpCode(OK)` rather than the POST default of 201: nothing is created, and
   * with `dryRun` (the schema default) nothing is modified either. The response
   * is a report.
   */
  @Post("maintenance")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(MAINTENANCE_AUTHORIZATION)
  runMaintenance(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<StorageMaintenanceReport> {
    this.auth.assertTrustedMutationOrigin(request);
    // An absent body is a valid request that means "report only", because
    // `dryRun` defaults to `true` in the shared schema. A body that is present
    // but malformed is still rejected.
    const body = storageMaintenanceRequestSchema.safeParse(rawBody ?? {});
    if (!body.success) this.invalid();
    return this.maintenance.runForWorkspace({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      dryRun: body.data.dryRun,
      requestId: getRequestId(request) ?? null,
    });
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
