// The public-note counterpart of `AttachmentsController#content`. Sits beside
// `PublicNoteController` in the codebase's small set of deliberately
// unauthenticated routes — no `@RequireAuthorization`, no principal, no
// `TenantContextService`. `RateLimitGuard` (global) still applies at the
// unauthenticated per-IP tier, same reasoning as `PublicNoteController`.
//
// Tenancy for the attachment is proved in two steps, neither of which trusts
// the caller: `PublicNoteService.resolveNoteScope` turns the token into a
// (noteId, workspaceId) pair from a live, validated public link, and
// `AttachmentsService.readPublicImageContent` then requires the requested
// attachment to match that exact pair. A holder of one note's link therefore
// cannot walk `attachmentId` values into another note's images.

import { Controller, Get, HttpStatus, Param, Req, Res } from "@nestjs/common";
import { ATTACHMENT_INLINE_MIME_TYPES, uuidSchema } from "@notted/shared-validators";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { PublicNoteService } from "../notes/public-note.service";

import { applyContentHeaders, matchesEtag } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";

import type { Request, Response } from "express";

const INLINE_SERVABLE_MIME_TYPES = new Set<string>(ATTACHMENT_INLINE_MIME_TYPES);

function notFound(): never {
  throw new ApiHttpException(HttpStatus.NOT_FOUND, {
    code: "NOT_FOUND",
    message: "The requested resource was not found.",
  });
}

@Controller("public/notes/:token/attachments")
export class PublicAttachmentController {
  constructor(
    private readonly publicNote: PublicNoteService,
    private readonly attachments: AttachmentsService,
  ) {}

  @Get(":attachmentId/content")
  async content(
    @Param("token") token: string,
    @Param("attachmentId") rawAttachmentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const scope = await this.publicNote.resolveNoteScope(String(token ?? ""));
    if (scope === null) notFound();
    const attachmentId = uuidSchema.safeParse(rawAttachmentId);
    if (!attachmentId.success) notFound();
    const content = await this.attachments.readPublicImageContent({
      noteId: scope.noteId,
      workspaceId: scope.workspaceId,
      attachmentId: attachmentId.data,
    });
    if (content === null) notFound();
    if (!INLINE_SERVABLE_MIME_TYPES.has(content.mimeType)) {
      content.stream.destroy();
      throw new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "No servable rendition is available for this attachment.",
      });
    }
    applyContentHeaders(response, content, "inline");
    if (matchesEtag(request.header("if-none-match"), content.etag)) {
      content.stream.destroy();
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader("Content-Length", String(content.contentLength));
    response.status(HttpStatus.OK);
    content.stream.pipe(response);
  }
}
