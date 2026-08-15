// Part 60 — versioned REST surface for inline comments (ADR 0002: the public
// integration surface; `comments.trpc.ts` is the first-party twin and both call
// the same service).

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  commentListQuerySchema,
  commentResolutionSchema,
  createCommentSchema,
  updateCommentSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { CommentsService } from "./comments.service";

import type {
  AuthenticatedPrincipal,
  CommentDeleteResult,
  CommentMutationResult,
  CommentPage,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "noteId" | "commentId"): string {
  return uuidSchema.parse(request.params[key]);
}

/**
 * `comment.create` is declared over a NOTE resource (it asks "may this actor
 * comment on this note"), while update/delete/resolve are declared over a
 * COMMENT resource. Listing uses `note.read` — see `CommentsService.list`.
 */
const noteAuthorization = (action: "note.read" | "comment.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "note" as const, id: routeUuid(request, "noteId") }),
});

const commentAuthorization = (action: "comment.update" | "comment.delete" | "comment.resolve") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({
    kind: "comment" as const,
    id: routeUuid(request, "commentId"),
  }),
});

@Controller("workspaces/:workspaceId/notes/:noteId/comments")
export class CommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(noteAuthorization("note.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<CommentPage> {
    const query = commentListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.comments.list({ ...this.scope(request), ...query.data });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(noteAuthorization("comment.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<CommentMutationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createCommentSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.comments.create({
      ...this.scope(request),
      content: body.data.content,
      parentId: body.data.parentId ?? null,
      anchor: body.data.anchor ?? null,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Patch(":commentId")
  @RequireAuthorization(commentAuthorization("comment.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<CommentMutationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateCommentSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.comments.update({
      ...this.scope(request),
      commentId: routeUuid(request, "commentId"),
      content: body.data.content,
    });
  }

  @Delete(":commentId")
  @RequireAuthorization(commentAuthorization("comment.delete"))
  remove(@Req() request: Request): Promise<CommentDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.comments.remove({
      ...this.scope(request),
      commentId: routeUuid(request, "commentId"),
    });
  }

  /** ONE resolution route, not a resolve/unresolve pair: the body carries the target state. */
  @Post(":commentId/resolution")
  @RequireAuthorization(commentAuthorization("comment.resolve"))
  setResolution(@Req() request: Request, @Body() raw: unknown): Promise<CommentMutationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = commentResolutionSchema.safeParse(raw);
    if (!body.success) this.invalid();
    return this.comments.setResolution({
      ...this.scope(request),
      commentId: routeUuid(request, "commentId"),
      isResolved: body.data.isResolved,
    });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      noteId: routeUuid(request, "noteId"),
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
