import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

const AUTH_PRINCIPAL = Symbol("notted.authPrincipal");

type AuthenticatedRequest = Request & { [AUTH_PRINCIPAL]?: AuthenticatedPrincipal };

export function getAuthPrincipal(request: Request): AuthenticatedPrincipal | undefined {
  return (request as AuthenticatedRequest)[AUTH_PRINCIPAL];
}

export function setAuthPrincipal(request: Request, principal: AuthenticatedPrincipal): void {
  (request as AuthenticatedRequest)[AUTH_PRINCIPAL] = Object.freeze({ ...principal });
}
