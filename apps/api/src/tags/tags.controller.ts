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
  createTagSchema,
  tagListQuerySchema,
  updateTagSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { TagsService } from "./tags.service";

import type {
  AuthenticatedPrincipal,
  TagCreateResult,
  TagDeleteResult,
  TagPage,
  TagUpdateResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "tagId"): string {
  return uuidSchema.parse(request.params[key]);
}

const workspaceAuthorization = (action: "tag.read" | "tag.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
});

const tagAuthorization = (action: "tag.update" | "tag.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "tag" as const, id: routeUuid(request, "tagId") }),
});

@Controller("workspaces/:workspaceId/tags")
export class TagsController {
  constructor(
    private readonly tags: TagsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("tag.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<TagPage> {
    const query = tagListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.tags.list({ ...this.scope(request), ...query.data });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(workspaceAuthorization("tag.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<TagCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createTagSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tags.create({
      ...this.scope(request),
      name: body.data.name,
      color: body.data.color,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Patch(":tagId")
  @RequireAuthorization(tagAuthorization("tag.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<TagUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateTagSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tags.update({ ...this.tagScope(request), ...body.data });
  }

  @Delete(":tagId")
  @RequireAuthorization(tagAuthorization("tag.delete"))
  remove(@Req() request: Request): Promise<TagDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.tags.remove(this.tagScope(request));
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private tagScope(request: Request) {
    return { ...this.scope(request), tagId: routeUuid(request, "tagId") };
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
