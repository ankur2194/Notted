import { getAuthPrincipal } from "../auth/auth-principal";
import { getRequestId } from "../common/request/request-context";

import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

export interface TrpcContext {
  readonly request: Request;
  readonly principal: AuthenticatedPrincipal | null;
  readonly requestId: string | null;
}

export function createTrpcContext(request: Request): TrpcContext {
  return Object.freeze({
    request,
    principal: getAuthPrincipal(request) ?? null,
    requestId: getRequestId(request) ?? null,
  });
}
