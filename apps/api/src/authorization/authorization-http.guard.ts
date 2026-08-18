import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { getApiKeyActor } from "../api-keys/api-key-context";
import { AuthService } from "../auth/auth.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import { AuthorizationAdaptersService } from "./authorization-adapters.service";
import { setAuthorizedOperation } from "./authorization-http.context";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "./authorization-http.decorator";
import {
  authorizationDenialToHttpException,
  AuthorizationDeniedError,
} from "./authorization.errors";

import type { Request } from "express";

@Injectable()
export class AuthorizationHttpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly adapters: AuthorizationAdaptersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<HttpAuthorizationSpec>(AUTHORIZATION_HTTP_SPEC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (spec === undefined) {
      throw new ApiHttpException(403, {
        code: "FORBIDDEN",
        message: "You are not allowed to do that.",
      });
    }
    const request = context.switchToHttp().getRequest<Request>();
    const principal = await this.auth.authenticate(request);
    if (principal === null) {
      throw new ApiHttpException(401, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }
    let workspaceId: string | null | undefined;
    let resource: ReturnType<HttpAuthorizationSpec["resource"]>;
    try {
      workspaceId = spec.workspaceId(request);
      resource = spec.resource(request);
    } catch {
      throw new ApiHttpException(404, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    if (
      workspaceId === null ||
      workspaceId === undefined ||
      resource === null ||
      resource === undefined
    ) {
      throw new ApiHttpException(404, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    // Part 65. An API-key request carries BOTH a synthetic principal for the
    // key's creator (installed by the pre-guard, which is why the 401 branch
    // above is unchanged) and a separate API-key actor. Scope is decided here;
    // the creator's live workspace role is still enforced unchanged at the
    // service layer, so the effective permission is scope ∩ creator role.
    const apiKeyActor = getApiKeyActor(request);
    // A key is bound to ONE workspace (ADR 0003), and `authorizeApiKey` derives
    // its tenant context from the actor alone — it never sees this route's
    // workspace. Without this check a key issued for workspace A reaching a
    // workspace-B path would be authorized against A here, and then re-checked
    // downstream against the CREATOR's membership in B: any creator who belongs
    // to both workspaces would carry the key across the tenant boundary.
    // 404, never 403, so a foreign workspace id leaks no existence signal.
    if (apiKeyActor !== undefined && apiKeyActor.workspaceId !== workspaceId) {
      throw new ApiHttpException(404, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    try {
      const operation =
        apiKeyActor === undefined
          ? await this.adapters.authorizeHttp({
              principal,
              workspaceId,
              action: spec.action,
              resource,
              correlationId: getRequestId(request),
            })
          : await this.adapters.authorizeApiKey({
              actor: apiKeyActor,
              action: spec.action,
              resource,
              correlationId: getRequestId(request),
            });
      setAuthorizedOperation(request, operation);
      return true;
    } catch (error: unknown) {
      if (error instanceof AuthorizationDeniedError)
        throw authorizationDenialToHttpException(error);
      throw error;
    }
  }
}
