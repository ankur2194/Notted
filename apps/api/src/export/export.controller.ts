// Part 62: export job REST transport.
//
// Downloads are PROXIED through the API rather than presigned: MinIO stays on
// the internal-only Docker network with port 9000 unpublished, so a browser can
// never reach the object store directly. ADR 0005 explicitly permits
// "authorized streaming" as an alternative to short-lived signed URLs. It is
// also the safer of the two here: a presigned URL is a bearer secret that would
// survive in browser history, proxy logs, and `Referer` headers long after the
// export grant expired, whereas a streamed response leaves no reusable artefact
// and re-authorizes on every request.
//
// REST only. `apps/web` has no tRPC client, and the two shipped sibling
// surfaces (notifications, attachments) are REST-only for the same reason; a
// tRPC subrouter here would be a second transport with no caller.
//
// Query strings and bodies parse through shared Zod schemas exactly as
// `notes.controller.ts` and `attachments.controller.ts` do.

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from "@nestjs/common";
import { exportCreateSchema, exportListQuerySchema, uuidSchema } from "@notted/shared-validators";

import { contentDisposition } from "../attachments/attachments.controller";
import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { ExportService } from "./export.service";

import type { AuthenticatedPrincipal, ExportJob, ExportPage } from "@notted/shared-types";
import type { Request, Response } from "express";

function routeUuid(request: Request, key: "workspaceId" | "exportId"): string {
  return uuidSchema.parse(request.params[key]);
}

function principalOf(request: Request): AuthenticatedPrincipal {
  const principal = getAuthPrincipal(request);
  if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
  return principal;
}

function invalidRequest(): never {
  throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
    code: "VALIDATION_ERROR",
    message: "The request is invalid.",
  });
}

/** The three per-job routes all address the same `export` resource. */
const exportAuthorization = (action: "export.read" | "export.download" | "export.cancel") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({
    kind: "export" as const,
    id: routeUuid(request, "exportId"),
  }),
});

/**
 * Workspace-scoped export surface.
 *
 * `RequireAuthorization` carries the status guards for free:
 * `AuthorizationPolicyService` already refuses `export.download` unless the row
 * is `ready` and `export.cancel` unless it is `queued`/`processing`, so neither
 * handler re-checks status.
 */
@Controller("workspaces/:workspaceId/exports")
export class ExportController {
  constructor(
    private readonly exports: ExportService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 202, not 201: the response body is a QUEUED job, not the finished artefact.
   * The caller polls the detail route (or waits for its notification) and only
   * then has bytes to download.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireAuthorization({
    action: "export.create",
    workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
    /*
     * `RESOURCE_KINDS_BY_ACTION["export.create"]` is
     * `["workspace", "project", "note"]`, so the resource being authorized is
     * the SOURCE of the export, not some export row that does not exist yet.
     *
     * A note source therefore authorizes against the note itself — which is
     * exactly what "may this actor export this note" means. `project` and
     * `workspace` sources are not supported in Part 62; they fall through to
     * the service's `EXPORT_FORMAT_UNSUPPORTED` rejection, and because the
     * selector never resolves a privileged row for them, nothing is read on the
     * way there.
     *
     * An unparseable body yields `null` so the GUARD denies. Letting the handler
     * reject it instead would leak, through the difference between a 400 and a
     * 403, whether the caller has any standing in this workspace at all.
     */
    resource: (request: Request) => {
      const parsed = exportCreateSchema.safeParse(request.body);
      if (!parsed.success) return null;
      const { sourceType, sourceId } = parsed.data;
      // `sourceId !== undefined` is already guaranteed for `note` by the
      // schema's refinement; narrowing here keeps the cast out of the code.
      return sourceType === "note" && sourceId !== undefined
        ? { kind: "note" as const, id: sourceId }
        : { kind: "workspace" as const };
    },
  })
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<ExportJob> {
    this.auth.assertTrustedMutationOrigin(request);
    // MANDATORY. Generating an export is expensive and enqueues work, so a
    // retried POST must resolve to the same job rather than a second one.
    const idempotencyKey = requireIdempotencyKey(request);
    const body = exportCreateSchema.safeParse(rawBody);
    if (!body.success) invalidRequest();
    return this.exports.create({
      principal: principalOf(request),
      workspaceId: routeUuid(request, "workspaceId"),
      format: body.data.format,
      sourceType: body.data.sourceType,
      sourceId: body.data.sourceId ?? null,
      options: body.data.options,
      idempotencyKey,
      correlationId: getRequestId(request) ?? null,
    });
  }

  /**
   * A list addresses no single export, so it authorizes `workspace.read` against
   * the workspace; the rows are then scoped to the calling user by the service.
   */
  @Get()
  @RequireAuthorization({
    action: "workspace.read",
    workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
    resource: () => ({ kind: "workspace" as const }),
  })
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<ExportPage> {
    const query = exportListQuerySchema.safeParse(rawQuery ?? {});
    if (!query.success) invalidRequest();
    return this.exports.list({
      workspaceId: routeUuid(request, "workspaceId"),
      requestedById: principalOf(request).userId,
      page: query.data.page,
      limit: query.data.limit,
      status: query.data.status,
    });
  }

  @Get(":exportId")
  @RequireAuthorization(exportAuthorization("export.read"))
  read(@Req() request: Request): Promise<ExportJob> {
    return this.exports.read({
      workspaceId: routeUuid(request, "workspaceId"),
      exportId: routeUuid(request, "exportId"),
    });
  }

  @Post(":exportId/cancel")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(exportAuthorization("export.cancel"))
  cancel(@Req() request: Request): Promise<ExportJob> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.exports.cancel({
      workspaceId: routeUuid(request, "workspaceId"),
      exportId: routeUuid(request, "exportId"),
    });
  }

  @Get(":exportId/download")
  @RequireAuthorization(exportAuthorization("export.download"))
  async download(@Req() request: Request, @Res() response: Response): Promise<void> {
    const content = await this.exports.openDownload({
      workspaceId: routeUuid(request, "workspaceId"),
      exportId: routeUuid(request, "exportId"),
    });
    response.setHeader("Content-Type", content.mimeType);
    // ALWAYS `attachment`, never `inline`. An export is a GENERATED document
    // built from workspace-authored content; rendering it in the API origin
    // would turn author-controlled text into same-origin markup.
    response.setHeader("Content-Disposition", contentDisposition(content.filename, "attachment"));
    // `helmet()` sets this globally for JSON routes, but this route writes its
    // own header block on a response it pipes itself, so it is restated rather
    // than assumed.
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    // Deliberately DIFFERENT from `attachments.controller.ts`, which serves
    // `private, max-age=31536000, immutable`. An attachment rendition is
    // immutable and addressed by a random key; an export is principal-dependent
    // AND expiring, so a cached copy could outlive the grant and be replayed
    // from disk after the row went `expired`. It must not be stored at all.
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("Accept-Ranges", "none");
    response.setHeader("Content-Length", String(content.contentLength));
    // No ETag / 304 branch: an export is a single-shot download whose grant
    // expires, so revalidation has nothing to revalidate against.
    response.status(HttpStatus.OK);
    content.stream.pipe(response);
  }
}
