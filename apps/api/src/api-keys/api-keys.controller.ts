// Part 65 — API-key management over the versioned REST surface.
//
// Managing credentials is an admin action, so `decideApiKey` requires the
// `admin` scope for every `apiKey.*` action: a read/write key cannot mint
// itself a wider key. Response bodies are the plain result objects; the global
// interceptor and exception filter own the envelope.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { apiKeyListQuerySchema, createApiKeySchema, uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { ApiKeysService } from "./api-keys.service";

import type {
  ApiKeyCreateResult,
  ApiKeyPage,
  ApiKeyRevokeResult,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "apiKeyId"): string {
  return uuidSchema.parse(request.params[key]);
}

const workspaceAuthorization = (action: "apiKey.list" | "apiKey.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
});

@Controller("workspaces/:workspaceId/api-keys")
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("apiKey.list"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<ApiKeyPage> {
    const query = apiKeyListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.apiKeys.list({ ...this.scope(request), ...query.data });
  }

  /**
   * The one route with a tighter rate-limit tier: minting a long-lived
   * credential is the highest-value mutation on this surface, and a stolen
   * session should not be able to fan out hundreds of keys before revocation.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("apiKey.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<ApiKeyCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createApiKeySchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.apiKeys.create({
      ...this.scope(request),
      name: body.data.name,
      scopes: body.data.scopes,
      expiresAt: body.data.expiresAt,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Delete(":apiKeyId")
  @RequireAuthorization({
    action: "apiKey.revoke",
    workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
    resource: (request: Request) => ({
      kind: "apiKey" as const,
      id: routeUuid(request, "apiKeyId"),
    }),
  })
  remove(@Req() request: Request): Promise<ApiKeyRevokeResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.apiKeys.revoke({
      ...this.scope(request),
      apiKeyId: routeUuid(request, "apiKeyId"),
    });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
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
