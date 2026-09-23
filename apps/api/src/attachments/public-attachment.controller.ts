// The public-note counterpart of `AttachmentsController#content`. Sits beside
// `PublicNoteController` in the codebase's small set of deliberately
// unauthenticated routes — no `@RequireAuthorization`, no principal, no
// `TenantContextService`. `RateLimitGuard` (global) still applies at a separate
// public per-IP tier even when the request also has a session or API key.
//
// The service joins the live token, note and attachment in one authoritative
// lookup, then checks the current document before any object-store read.

import { Controller, Get, HttpStatus, Param, Res } from "@nestjs/common";
import { uuidSchema } from "@notted/shared-validators";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";

import { contentDisposition } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";

import type { Response } from "express";

function notFound(): never {
  throw new ApiHttpException(HttpStatus.NOT_FOUND, {
    code: "NOT_FOUND",
    message: "The requested resource was not found.",
  });
}

@Controller("public/notes/:token/attachments")
export class PublicAttachmentController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(":attachmentId/content")
  @RateLimitTier("public-ip")
  async content(
    @Param("token") token: string,
    @Param("attachmentId") rawAttachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    // Set even on misses. An intermediary must not cache either an old grant
    // or a denial that becomes valid after a note is restored.
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    const attachmentId = uuidSchema.safeParse(rawAttachmentId);
    if (!attachmentId.success) notFound();
    const content = await this.attachments.readPublicContent({
      token: String(token ?? ""),
      attachmentId: attachmentId.data,
    });
    if (content === null) notFound();
    response.setHeader("Content-Type", content.mimeType);
    response.setHeader(
      "Content-Disposition",
      contentDisposition(content.filename, content.mediaType === "image" ? "inline" : "attachment"),
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    response.setHeader("Accept-Ranges", "none");
    // No ETag/304, including If-None-Match: each request must re-authorize.
    response.setHeader("Content-Length", String(content.contentLength));
    response.status(HttpStatus.OK);
    content.stream.pipe(response);
  }
}
