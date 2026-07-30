import type { AuthorizationDecision } from "./authorization.contracts";

export class AuthorizationDeniedError extends Error {
  readonly decision: Extract<AuthorizationDecision, { readonly allowed: false }>;

  constructor(decision: Extract<AuthorizationDecision, { readonly allowed: false }>) {
    super(decision.safeMessage);
    this.name = "AuthorizationDeniedError";
    this.decision = decision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
