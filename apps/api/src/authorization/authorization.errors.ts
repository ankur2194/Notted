import { ApiHttpException } from "../common/errors/api-http.exception";

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

/**
 * The one translation from an authorization denial to an HTTP answer.
 *
 * A concealed decision becomes 404, never 403: answering "forbidden" for a
 * resource in another workspace would confirm that it exists.
 *
 * This lives beside the error rather than inside the HTTP guard because a
 * denial can be raised in two places — the guard, before the handler runs, and
 * a SERVICE that authorizes a nested resource it only learns about from the
 * request body or query (a task list scoped to a note id, for example). Both
 * must produce the identical response; when only the guard converted, every
 * service-raised denial escaped the filter as an unhandled 500 and leaked the
 * difference between "denied" and "broken".
 */
export function authorizationDenialToHttpException(
  error: AuthorizationDeniedError,
): ApiHttpException {
  const code =
    error.decision.code === "authorization.unauthenticated"
      ? "UNAUTHENTICATED"
      : error.decision.code === "authorization.concealed"
        ? "NOT_FOUND"
        : error.decision.code === "authorization.recent_authentication_required"
          ? "RECENT_AUTHENTICATION_REQUIRED"
          : "FORBIDDEN";
  return new ApiHttpException(error.decision.httpStatus, {
    code,
    message: error.decision.safeMessage,
  });
}
