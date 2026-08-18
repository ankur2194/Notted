// Part 66 — outbound webhooks over the versioned REST surface.
//
// REST only, no tRPC subrouter: `apps/web` reaches this from workspace settings
// through the same REST client the sibling admin surfaces (API keys, exports,
// notifications) use, and a second transport with no caller is a second thing
// to keep authorized.
//
// EVERY HANDLER CARRIES `@RequireAuthorization`, WITHOUT EXCEPTION. Part 65's
// `ApiKeyRouteGuard` is a default-deny APP_GUARD: an API-key request may only
// reach a handler that carries `AUTHORIZATION_HTTP_SPEC` metadata, so a missing
// decorator does not merely skip a check — it makes the route 403 for every API
// key while still serving session callers. That asymmetry is exactly the kind
// of bug nobody notices for a month.
//
// Managing webhooks is an admin action end to end: `webhook.create`,
// `webhook.update` and `webhook.delete` are `HIGH_RISK_ACTIONS` (so they demand
// a fresh session), and `editorAllowed`/`viewerAllowed` deny every `webhook.*`
// outright. Nothing in this file re-implements any of that.
//
// Response bodies are the plain result objects, matching `api-keys.controller.ts`
// and `export.controller.ts`; the exception filter owns the error envelope.

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
  paginationQuerySchema,
  uuidSchema,
  webhookCreateSchema,
  webhookDeliveryListQuerySchema,
  webhookUpdateSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { WebhooksService } from "./webhooks.service";

import type {
  AuthenticatedPrincipal,
  WebhookCreateResult,
  WebhookDeleteResult,
  WebhookDeliveryPage,
  WebhookEndpoint,
  WebhookEndpointPage,
  WebhookRetryResult,
  WebhookSecretRotationResult,
  WebhookVerificationResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "webhookId" | "deliveryId"): string {
  return uuidSchema.parse(request.params[key]);
}

/** `webhook.list` and `webhook.create` both address the workspace itself. */
const workspaceAuthorization = (action: "webhook.list" | "webhook.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
});

/** Every per-endpoint route addresses the `webhook` resource by its route id. */
const webhookAuthorization = (
  action: "webhook.update" | "webhook.delete" | "webhook.redeliver",
) => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({
    kind: "webhook" as const,
    id: routeUuid(request, "webhookId"),
  }),
});

@Controller("workspaces/:workspaceId/webhooks")
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("webhook.list"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<WebhookEndpointPage> {
    const query = paginationQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.webhooks.list({ ...this.scope(request), ...query.data });
  }

  /**
   * `sensitive` tier: registering a destination is the highest-value mutation
   * on this surface — it points our server at an address of the caller's
   * choosing — and a stolen session should not be able to enumerate a private
   * network by creating endpoints as fast as the general allowance permits.
   *
   * Deliberately NOT idempotency-keyed. Creating an endpoint is cheap and
   * repeatable, the endpoint arrives disabled and unverified, and the
   * export/API-key precedent for `Idempotency-Key` is about work that is
   * expensive or whose result cannot be reproduced (a raw secret is returned
   * here, but a duplicate create is a duplicate row an admin can simply delete,
   * not a lost credential).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("webhook.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<WebhookCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = webhookCreateSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.webhooks.create({
      ...this.scope(request),
      url: body.data.url,
      events: body.data.events,
    });
  }

  @Patch(":webhookId")
  @RequireAuthorization(webhookAuthorization("webhook.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<WebhookEndpoint> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = webhookUpdateSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.webhooks.update({ ...this.webhookScope(request), ...body.data });
  }

  /**
   * 200 with a body, not 204: it matches `api-keys.controller.ts` and
   * `tags.controller.ts`, and it lets the client confirm WHICH endpoint the
   * server considers gone rather than inferring it from the request it sent.
   */
  @Delete(":webhookId")
  @RequireAuthorization(webhookAuthorization("webhook.delete"))
  remove(@Req() request: Request): Promise<WebhookDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.webhooks.remove(this.webhookScope(request));
  }

  @Post(":webhookId/rotate-secret")
  @RequireAuthorization(webhookAuthorization("webhook.update"))
  rotateSecret(@Req() request: Request): Promise<WebhookSecretRotationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.webhooks.rotateSecret(this.webhookScope(request));
  }

  /**
   * THE ONE PLACE A RECEIVER'S LATENCY TOUCHES A REQUEST THREAD.
   *
   * Every real delivery happens on a queue worker; the verification challenge
   * is synchronous because its whole point is to answer "did that host echo my
   * signature" while the admin is looking at the dialog. It is bounded
   * (`WEBHOOK_VERIFY_TIMEOUT_MS`, 5s, never retried), it is admin-initiated,
   * and it runs through the same SSRF guard as a delivery — so it gets the
   * `sensitive` rate-limit tier as well: it is the cheapest way for a caller to
   * make our server dial an address, and it must not be free.
   */
  @Post(":webhookId/verify")
  @RateLimitTier("sensitive")
  @RequireAuthorization(webhookAuthorization("webhook.update"))
  verify(@Req() request: Request): Promise<WebhookVerificationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.webhooks.verify(this.webhookScope(request));
  }

  @Get(":webhookId/deliveries")
  @RequireAuthorization(workspaceAuthorization("webhook.list"))
  listDeliveries(
    @Req() request: Request,
    @Query() rawQuery: unknown,
  ): Promise<WebhookDeliveryPage> {
    const query = webhookDeliveryListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.webhooks.listDeliveries({ ...this.webhookScope(request), ...query.data });
  }

  /**
   * 202: the replay is a queued intent, not a completed delivery. The caller
   * watches the delivery log for the new attempt row.
   */
  @Post(":webhookId/deliveries/:deliveryId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireAuthorization(webhookAuthorization("webhook.redeliver"))
  retryDelivery(@Req() request: Request): Promise<WebhookRetryResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.webhooks.retryDelivery({
      ...this.webhookScope(request),
      deliveryId: routeUuid(request, "deliveryId"),
    });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private webhookScope(request: Request) {
    return { ...this.scope(request), webhookId: routeUuid(request, "webhookId") };
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
