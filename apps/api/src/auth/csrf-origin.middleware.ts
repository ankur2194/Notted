// Part 74 — the blanket Origin check for cookie-authenticated mutations.
//
// Individual services already call `AuthService.assertTrustedMutationOrigin`
// and those calls stay: they are the ones a reviewer can see next to the
// mutation they protect. This middleware exists because "someone remembered to
// call it" is not a boundary — a new controller that forgets the call would be
// forgeable from any origin. Mounted on `/api/v1` it is default-deny for the
// whole versioned surface, and a double check costs one string comparison.
//
// THREE CONDITIONS, ALL REQUIRED, AND EACH ONE MATTERS:
//   * a mutating method — GET/HEAD/OPTIONS carry no side effects to forge;
//   * a session cookie present — a request with no ambient credential has
//     nothing for a cross-site page to ride on, and rejecting it would break
//     anonymous public routes (Part 72's logo, Part 73's resolve);
//   * no API-key actor — a bearer token is not ambient, integrations send no
//     Origin at all, and Part 65 already settled that the check is meaningless
//     for them.

import { Injectable } from "@nestjs/common";

import { getApiKeyActor } from "../api-keys/api-key-context";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getRequestId } from "../common/request/request-context";

import { AuthService } from "./auth.service";

import type { NextFunction, Request, Response } from "express";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

@Injectable()
export class CsrfOriginMiddleware {
  constructor(private readonly auth: AuthService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (!MUTATING_METHODS.has(request.method) || getApiKeyActor(request) !== undefined) {
      next();
      return;
    }
    // Both Better Auth spellings — `better-auth.session_token` and the
    // `__Secure-` prefixed production one — contain this substring, so the
    // match survives the secure-cookie switch without enumerating names.
    const cookies = request.header("cookie") ?? "";
    if (!cookies.includes("session_token")) {
      next();
      return;
    }
    try {
      this.auth.assertTrustedMutationOrigin(request);
      next();
    } catch (error: unknown) {
      if (!(error instanceof ApiHttpException)) {
        next(error);
        return;
      }
      response.status(error.getStatus()).json({
        success: false,
        error: error.safeResponse,
        requestId: getRequestId(request) ?? "unknown",
      });
    }
  }
}
