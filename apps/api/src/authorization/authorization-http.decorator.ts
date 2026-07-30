import { applyDecorators, SetMetadata, UseGuards, UseInterceptors } from "@nestjs/common";

import { AuthorizationHttpGuard } from "./authorization-http.guard";
import { AuthorizationHttpInterceptor } from "./authorization-http.interceptor";

import type { AuthorizationAction, ResourceLocator } from "./authorization.contracts";
import type { Request } from "express";

export const AUTHORIZATION_HTTP_SPEC = Symbol("AUTHORIZATION_HTTP_SPEC");

export interface HttpAuthorizationSpec {
  readonly action: AuthorizationAction;
  readonly workspaceId: (request: Request) => string | null | undefined;
  readonly resource: (request: Request) => ResourceLocator | null | undefined;
}

/** Selector functions identify a workspace/resource; they never assert permission. */
export function RequireAuthorization(spec: HttpAuthorizationSpec): MethodDecorator {
  return applyDecorators(
    SetMetadata(AUTHORIZATION_HTTP_SPEC, spec),
    UseGuards(AuthorizationHttpGuard),
    UseInterceptors(AuthorizationHttpInterceptor),
  );
}
