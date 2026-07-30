import type { AuthorizedOperation } from "./authorization.contracts";
import type { Request } from "express";

const AUTHORIZED_OPERATION = Symbol("notted.authorizedOperation");

type AuthorizedRequest = Request & { [AUTHORIZED_OPERATION]?: AuthorizedOperation };

export function setAuthorizedOperation(request: Request, operation: AuthorizedOperation): void {
  (request as AuthorizedRequest)[AUTHORIZED_OPERATION] = operation;
}

export function getAuthorizedOperation(request: Request): AuthorizedOperation | undefined {
  return (request as AuthorizedRequest)[AUTHORIZED_OPERATION];
}
