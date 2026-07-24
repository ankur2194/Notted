import type { Request } from "express";

const TRUSTED_PRINCIPAL = Symbol("notted.trustedPrincipal");

export interface TrustedPrincipal {
  readonly actorId: string;
  readonly kind: "api-key" | "user";
}

type RequestWithPrincipal = Request & {
  [TRUSTED_PRINCIPAL]?: TrustedPrincipal;
};

export function getTrustedPrincipal(request: Request): TrustedPrincipal | undefined {
  return (request as RequestWithPrincipal)[TRUSTED_PRINCIPAL];
}

/**
 * Authentication adapters call this only after validating a credential.
 * Request headers are deliberately never consulted by the rate-limit guard.
 */
export function setTrustedPrincipal(request: Request, principal: TrustedPrincipal): void {
  (request as RequestWithPrincipal)[TRUSTED_PRINCIPAL] = Object.freeze({ ...principal });
}
