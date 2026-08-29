// Part 72 — the workspace logo transport.
//
// Three routes on one controller because they are one resource, but they are NOT
// three of a kind:
//
//   POST / DELETE  authorize `settings.update` through `@RequireAuthorization`
//                  and additionally require a trusted mutation origin (CSRF).
//   GET :token     is PUBLIC. It carries no guard on purpose — an `<img src>` in
//                  a mail client has no session, no `Origin`, and no way to
//                  follow a login redirect. The 128-bit token in the path is the
//                  authorization, compared in constant time by the service.
//
// The multipart body is read HERE rather than in the service, matching
// `attachments.controller.ts`: `@RequireAuthorization` must decide the caller may
// write to this workspace's settings BEFORE a single body byte comes off the
// socket, and `parseSingleFileUpload` enforces the 2 MiB ceiling during transfer.

import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import { uuidSchema } from "@notted/shared-validators";

import { matchesEtag } from "../attachments/attachments.controller";
import { parseSingleFileUpload } from "../attachments/multipart-upload.parser";
import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import {
  WORKSPACE_LOGO_CACHE_CONTROL,
  WORKSPACE_LOGO_FILE_FIELD,
  WORKSPACE_LOGO_MAX_BYTES,
  WorkspaceLogoService,
} from "./workspace-logo.service";

import type { AuthenticatedPrincipal, WorkspaceLogoResult } from "@notted/shared-types";
import type { Request, Response } from "express";

function workspaceIdFromRoute(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

const LOGO_UPDATE_AUTHORIZATION = {
  action: "settings.update" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "settings" as const }),
};

@Controller("workspaces/:workspaceId/logo")
export class WorkspaceLogoController {
  constructor(
    private readonly logos: WorkspaceLogoService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(LOGO_UPDATE_AUTHORIZATION)
  async upload(@Req() request: Request): Promise<WorkspaceLogoResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const upload = await parseSingleFileUpload(request, {
      maxBytes: WORKSPACE_LOGO_MAX_BYTES,
      fileField: WORKSPACE_LOGO_FILE_FIELD,
      fieldNames: [],
    });
    return this.logos.upload({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      buffer: upload.buffer,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(LOGO_UPDATE_AUTHORIZATION)
  remove(@Req() request: Request): Promise<WorkspaceLogoResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.logos.remove({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      requestId: getRequestId(request) ?? null,
    });
  }

  /**
   * Public, tokenised read. No `@UseGuards(AuthGuard)` and no
   * `@RequireAuthorization` — see the file header. The response is always a
   * WebP the API itself encoded, so serving it inline is safe, and `nosniff`
   * still says so explicitly because this handler writes its own header block.
   */
  @Get(":token")
  async content(@Req() request: Request, @Res() response: Response): Promise<void> {
    const token = request.params.token;
    if (typeof token !== "string") this.notFound();
    /*
     * `safeParse`, not `parse`, because this is the one deliberately public,
     * unauthenticated route in this controller.
     *
     * `@RequireAuthorization` routes get this for free -- `AuthorizationHttpGuard`
     * wraps selector calls in try/catch and answers 404. This handler has no
     * guard, and the global filter has no `ZodError` branch, so
     * `GET /api/v1/workspaces/not-a-uuid/logo/<32 hex>` produced a
     * 500 INTERNAL_SERVER_ERROR plus an "Unhandled HTTP exception" log line --
     * on unauthenticated attacker-controlled input, for a service whose whole
     * contract is that every miss answers an identical 404
     * (`workspace-logo.service.ts`). Same shape as the token check above.
     */
    const workspaceId = uuidSchema.safeParse(request.params.workspaceId);
    if (!workspaceId.success) this.notFound();
    const content = await this.logos.read(workspaceId.data, token);
    response.setHeader("Content-Type", content.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    // PUBLIC, unlike the attachment route's `private`: the token changes on
    // every replacement, so a shared cache can never serve a superseded logo,
    // and there is no principal for the entry to be specific to.
    response.setHeader("Cache-Control", WORKSPACE_LOGO_CACHE_CONTROL);
    response.setHeader("ETag", content.etag);
    response.setHeader("Content-Disposition", "inline");
    if (matchesEtag(request.header("if-none-match"), content.etag)) {
      content.stream.destroy();
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader("Content-Length", String(content.contentLength));
    response.status(HttpStatus.OK);
    content.stream.pipe(response);
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
