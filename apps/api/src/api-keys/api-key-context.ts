// Part 65 — the API-key actor carried on an authenticated request.
//
// A Symbol-keyed slot, exactly like `auth/auth-principal.ts`: it cannot be set
// from a header, cannot be JSON-serialized into a response by accident, and
// cannot collide with an Express or middleware property.

import type { ApiKeyAuthorizationActor } from "../authorization/authorization.contracts";
import type { Request } from "express";

const API_KEY_ACTOR = Symbol("notted.apiKeyActor");

type ApiKeyRequest = Request & { [API_KEY_ACTOR]?: ApiKeyAuthorizationActor };

export function getApiKeyActor(request: Request): ApiKeyAuthorizationActor | undefined {
  return (request as ApiKeyRequest)[API_KEY_ACTOR];
}

/** Only {@link ApiKeyAuthService} calls this, and only after the key validates. */
export function setApiKeyActor(request: Request, actor: ApiKeyAuthorizationActor): void {
  (request as ApiKeyRequest)[API_KEY_ACTOR] = Object.freeze({
    ...actor,
    scopes: Object.freeze([...actor.scopes]),
  });
}
