import { HttpStatus, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService } from "../database/database.service";
import { users } from "../database/schema";

import { AuthService } from "./auth.service";

import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

/** Database-authoritative platform permission; workspace roles are never consulted. */
@Injectable()
export class PlatformOperatorService {
  constructor(
    private readonly auth: AuthService,
    private readonly database: DatabaseService,
  ) {}

  async requireOperator(request: Request): Promise<AuthenticatedPrincipal> {
    if (!this.auth.isAvailable()) {
      throw unavailable();
    }

    let principal: AuthenticatedPrincipal | null;
    try {
      principal = await this.auth.authenticate(request);
    } catch {
      throw unavailable();
    }
    if (principal === null) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }

    let rows: { isPlatformOperator: boolean }[];
    try {
      rows = await this.database.db
        .select({ isPlatformOperator: users.isPlatformOperator })
        .from(users)
        .where(eq(users.id, principal.userId))
        .limit(1);
    } catch {
      throw unavailable();
    }

    // A session whose authoritative user disappeared is no longer a real
    // active session. Keep this response indistinguishable from no session.
    const authoritativeUser = rows[0];
    if (authoritativeUser === undefined) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }
    if (authoritativeUser.isPlatformOperator !== true) {
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "FORBIDDEN",
        message: "Access is denied.",
      });
    }
    return principal;
  }
}

function unavailable(): ApiHttpException {
  return new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
    code: "SERVICE_UNAVAILABLE",
    message: "Administrative access is unavailable.",
  });
}
