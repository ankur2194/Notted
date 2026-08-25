// Part 40: attachment REST transport.
//
// Downloads are PROXIED through the API rather than presigned: MinIO stays on
// the internal-only Docker network with port 9000 unpublished, so a browser can
// never reach the object store directly. ADR 0005 explicitly permits
// "authorized streaming" as an alternative to short-lived signed URLs.
//
// Multipart routes take `@Req()` only. The global `ValidationPipe` runs with
// `forbidNonWhitelisted: true`; binding `@Body()` on a multipart route would
// hand it an unparsed stream. Query strings parse through shared Zod schemas
// exactly as `notes.controller.ts` does.

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  attachmentContentQuerySchema,
  ATTACHMENT_INLINE_MIME_TYPES,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { admitUpload } from "./attachment-admission";
import { ATTACHMENT_UPLOAD_FILE_FIELD } from "./attachments.constants";
import { AttachmentsService } from "./attachments.service";
import { parseSingleFileUpload } from "./multipart-upload.parser";

import type { AttachmentContent } from "./attachments.service";
import type {
  AttachmentDeleteResult,
  AttachmentListResult,
  AttachmentUploadResult,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Request, Response } from "express";

/**
 * Only these MIME types are ever streamed inline. Part 41 rasterizes SVG and
 * converts HEIC, so no servable rendition is active content; this set is the
 * last line of defence if that ever regresses.
 */
const INLINE_SERVABLE_MIME_TYPES = new Set<string>(ATTACHMENT_INLINE_MIME_TYPES);

function routeUuid(request: Request, key: "workspaceId" | "attachmentId" | "noteId"): string {
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

const attachmentAuthorization = (action: "file.read" | "file.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({
    kind: "file" as const,
    id: routeUuid(request, "attachmentId"),
  }),
});

const noteAuthorization = (action: "file.upload" | "note.read") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "note" as const, id: routeUuid(request, "noteId") }),
});

/**
 * RFC 6266 / RFC 5987 disposition: ASCII fallback plus a UTF-8 form.
 *
 * Part 44 added the `disposition` parameter. `inline` remains the default so the
 * Part 40/41 image path is byte-for-byte unchanged; a generic file is always
 * passed `attachment`, which is what turns "the browser might try to render
 * this" into "the browser saves it under the name the author uploaded".
 */
export function contentDisposition(
  filename: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  const ascii = filename.replace(/[^ -~]/gu, "_").replace(/["\\]/gu, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Compare a client validator against the stored ETag, tolerating quotes and
 * the weak-comparison prefix that proxies add. */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const normalize = (value: string): string => value.trim().replace(/^W\//u, "").replace(/"/gu, "");
  return normalize(ifNoneMatch) === normalize(etag);
}

/**
 * Workspace-scoped attachment surface: streamed content and deletion. Both
 * routes address an existing `file` resource, so the central policy can select
 * it before the handler runs.
 */
@Controller("workspaces/:workspaceId/attachments")
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly auth: AuthService,
  ) {}

  @Get(":attachmentId/content")
  @RequireAuthorization(attachmentAuthorization("file.read"))
  async content(
    @Req() request: Request,
    @Res() response: Response,
    @Query() rawQuery: unknown,
  ): Promise<void> {
    const query = attachmentContentQuerySchema.safeParse(rawQuery ?? {});
    if (!query.success) invalidRequest();
    const content = await this.attachments.readContent({
      principal: principalOf(request),
      workspaceId: routeUuid(request, "workspaceId"),
      attachmentId: routeUuid(request, "attachmentId"),
      variant: query.data.variant,
      requestId: getRequestId(request) ?? null,
    });
    /*
     * Part 44. The disposition is chosen from the row's MEDIA TYPE, not from its
     * MIME type, so a crafted or corrupted type string can never talk this route
     * into serving a generic file inline.
     *
     * - `image` keeps the Part 40 behaviour exactly: inline, and only for the
     *   browser-safe raster allow-list. Anything else is still refused outright.
     * - `file` is ALWAYS `attachment`. That is the ADR 0005 rule ("untrusted
     *   active content is not served inline") and the Part 44 plan's verbatim
     *   instruction not to embed untrusted active documents. It is what makes an
     *   uploaded `.html` — stored as `text/plain` — harmless: it downloads.
     */
    const inline = content.mediaType === "image";
    if (inline && !INLINE_SERVABLE_MIME_TYPES.has(content.mimeType)) {
      content.stream.destroy();
      throw new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "No servable rendition is available for this attachment.",
      });
    }
    applyContentHeaders(response, content, inline ? "inline" : "attachment");
    if (matchesEtag(request.header("if-none-match"), content.etag)) {
      content.stream.destroy();
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    // Only now that a body is definitely being sent.
    response.setHeader("Content-Length", String(content.contentLength));
    response.status(HttpStatus.OK);
    content.stream.pipe(response);
  }

  @Delete(":attachmentId")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(attachmentAuthorization("file.delete"))
  delete(@Req() request: Request): Promise<AttachmentDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.attachments.delete({
      principal: principalOf(request),
      workspaceId: routeUuid(request, "workspaceId"),
      attachmentId: routeUuid(request, "attachmentId"),
      requestId: getRequestId(request) ?? null,
    });
  }
}

/**
 * Note-scoped attachment surface.
 *
 * Upload lives here rather than on the workspace collection so the note id is a
 * ROUTE segment: `RequireAuthorization` can then evaluate `file.upload` against
 * the target note BEFORE a single body byte is read. A multipart form field
 * would have forced the guard to run without a resource.
 */
@Controller("workspaces/:workspaceId/notes/:noteId/attachments")
export class NoteAttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(noteAuthorization("note.read"))
  list(@Req() request: Request): Promise<AttachmentListResult> {
    return this.attachments.listForNote({
      principal: principalOf(request),
      workspaceId: routeUuid(request, "workspaceId"),
      noteId: routeUuid(request, "noteId"),
      requestId: getRequestId(request) ?? null,
    });
  }

  /**
   * One endpoint, two media types (Part 44).
   *
   * The editor uploads images and generic files through the SAME route, and the
   * route decides which service method to call by sniffing the bytes — never by
   * reading the declared `Content-Type` or the filename. That keeps the browser
   * client simple (one URL, one idempotency contract, one progress source) and
   * keeps the classification rule in one pure, unit-tested function.
   *
   * Ordering that is a security property, not a detail: `@RequireAuthorization`
   * still evaluates `file.upload` against the target NOTE before
   * `parseSingleFileUpload` reads a single body byte. Routing happens strictly
   * after that, on bytes the caller was already permitted to send. Both service
   * methods additionally re-run admission for themselves, so a mis-wired
   * transport cannot force a payload down the wrong path.
   *
   * ponytail: this route is governed only by the GLOBAL authenticated bucket
   * (`AUTH_RATE_LIMIT_PER_MINUTE`, 1000/min) even though it is by far the most
   * expensive endpoint in the API — up to 50 MiB buffered in memory, then
   * decoded. A single authorized actor can therefore issue ~1000 large uploads a
   * minute; the workspace quota bounds what is KEPT, not what is buffered.
   * `RateLimitService` has one bucket and no per-route policy, so tightening
   * this needs a route-scoped policy decorator, guard metadata resolution, and a
   * config value — recorded as follow-up in the Part 44 completion record rather
   * than bolted on here. The concrete mitigations already in place are the
   * `maxBytes` ceiling (a body is refused before it is fully buffered), the
   * per-request idempotency key, and `file.upload` authorization on the note.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(noteAuthorization("file.upload"))
  async upload(@Req() request: Request): Promise<AttachmentUploadResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const upload = await parseSingleFileUpload(request, {
      // The wider of the two ceilings, because the media type is unknown until
      // the body has been read. `AttachmentsService` re-applies the narrower
      // image bound once the bytes identify themselves.
      maxBytes: this.attachments.maximumUploadBytes,
      fileField: ATTACHMENT_UPLOAD_FILE_FIELD,
      fieldNames: [],
    });

    const scope = {
      principal: principalOf(request),
      workspaceId: routeUuid(request, "workspaceId"),
      noteId: routeUuid(request, "noteId"),
      buffer: upload.buffer,
      declaredMimeType: upload.declaredMimeType,
      declaredFilename: upload.declaredFilename,
      idempotencyKey,
      requestId: getRequestId(request) ?? null,
    };

    const admission = admitUpload(upload.buffer, upload.declaredFilename);
    if (!admission.ok) {
      throw new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The uploaded file type is not supported.",
      });
    }
    return admission.admitted.kind === "image"
      ? this.attachments.uploadImage(scope)
      : this.attachments.uploadFile(scope);
  }
}

function applyContentHeaders(
  response: Response,
  content: AttachmentContent,
  disposition: "inline" | "attachment",
): void {
  response.setHeader("Content-Type", content.mimeType);
  // NOTE: `Content-Length` is deliberately NOT set here. It is a property of the
  // body being sent, and a 304 has no body — RFC 9110 §15.4.5 says a 304 sends
  // only the validating/metadata headers. The caller sets it on the 200 path.
  response.setHeader("Content-Disposition", contentDisposition(content.filename, disposition));
  // Part 44, and it applies to BOTH media types. `helmet()` sets this globally
  // for JSON routes, but this route writes its own header block on a response it
  // pipes itself, so it is restated here rather than assumed. Without it a
  // browser may content-sniff a `text/plain` download back into HTML and run it.
  response.setHeader("X-Content-Type-Options", "nosniff");
  // The key carries a random token and every rendition is immutable, so the
  // response can be cached forever — but only privately: it is principal
  // dependent and must never enter a shared cache.
  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  response.setHeader("ETag", content.etag);
  response.setHeader("Vary", "Cookie");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  // MANDATORY. `main.ts` installs bare `helmet()`, whose default
  // `Cross-Origin-Resource-Policy: same-origin` makes the browser HARD-BLOCK an
  // <img> served from http://localhost:3001 into a page on
  // http://localhost:3000. jsdom does not enforce CORP, so only a real browser
  // reveals the failure. A cross-registrable-domain deployment would need
  // `cross-origin` here plus a cookie-policy change; that is out of scope.
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  // Renditions are small and always fetched whole; 206 bookkeeping buys nothing
  // and audio/video is out of scope.
  response.setHeader("Accept-Ranges", "none");
}
