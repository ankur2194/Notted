import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { uuidSchema } from "@notted/shared-validators";
import { and, desc, eq, gt } from "drizzle-orm";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService } from "../database/database.service";
import { passkey, session, users } from "../database/schema";

import { BETTER_AUTH_INSTANCE } from "./auth.tokens";

import type { BetterAuthInstance } from "./better-auth.setup";
import type {
  AuthPasskeySummary,
  AuthenticatedPrincipal,
  AuthSecurityOverview,
  AuthSessionSummary,
} from "@notted/shared-types";

function summarizeUserAgent(value: string | null): string {
  if (value === null || value.trim() === "") return "Unknown device";
  const normalized = value.toLowerCase();
  const browser = normalized.includes("edg/")
    ? "Edge"
    : normalized.includes("firefox/")
      ? "Firefox"
      : normalized.includes("chrome/")
        ? "Chrome"
        : normalized.includes("safari/")
          ? "Safari"
          : "Browser";
  const operatingSystem = normalized.includes("windows")
    ? "Windows"
    : normalized.includes("android")
      ? "Android"
      : normalized.includes("iphone") || normalized.includes("ipad")
        ? "iOS"
        : normalized.includes("mac os") || normalized.includes("macintosh")
          ? "macOS"
          : normalized.includes("linux")
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${operatingSystem}`;
}

@Injectable()
export class AuthSecurityService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(BETTER_AUTH_INSTANCE) private readonly auth: BetterAuthInstance | null,
  ) {}

  async overview(principal: AuthenticatedPrincipal): Promise<AuthSecurityOverview> {
    if (this.auth === null) {
      throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication is unavailable.",
      });
    }
    const [userRows, sessionRows, passkeyRows] = await Promise.all([
      this.database.db
        .select({ twoFactorEnabled: users.twoFactorEnabled })
        .from(users)
        .where(eq(users.id, principal.userId))
        .limit(1),
      this.database.db
        .select({
          id: session.id,
          userAgent: session.userAgent,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
        })
        .from(session)
        .where(and(eq(session.userId, principal.userId), gt(session.expiresAt, new Date())))
        .orderBy(desc(session.updatedAt)),
      this.database.db
        .select({
          id: passkey.id,
          name: passkey.name,
          deviceType: passkey.deviceType,
          backedUp: passkey.backedUp,
          createdAt: passkey.createdAt,
        })
        .from(passkey)
        .where(eq(passkey.userId, principal.userId))
        .orderBy(desc(passkey.createdAt)),
    ]);

    if (userRows[0] === undefined) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }

    const sessions: readonly AuthSessionSummary[] = sessionRows.map((row) =>
      Object.freeze({
        id: row.id,
        current: row.id === principal.sessionId,
        device: summarizeUserAgent(row.userAgent ?? null),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }),
    );
    const passkeys: readonly AuthPasskeySummary[] = passkeyRows.map((row) =>
      Object.freeze({
        id: row.id,
        name: row.name?.trim() || "Passkey",
        deviceType: row.deviceType,
        backedUp: row.backedUp,
        createdAt: row.createdAt.toISOString(),
      }),
    );

    return Object.freeze({
      twoFactorEnabled: userRows[0].twoFactorEnabled,
      sessions: Object.freeze(sessions),
      passkeys: Object.freeze(passkeys),
    });
  }

  async revokeSession(principal: AuthenticatedPrincipal, sessionId: string): Promise<void> {
    if (this.auth === null) {
      throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication is unavailable.",
      });
    }
    const parsed = uuidSchema.safeParse(sessionId);
    if (!parsed.success) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The session identifier is invalid.",
      });
    }
    if (parsed.data === principal.sessionId) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "CURRENT_SESSION_NOT_REMOTE",
        message: "Use sign out to end the current session.",
      });
    }
    const rows = await this.database.db
      .select({ token: session.token })
      .from(session)
      .where(and(eq(session.id, parsed.data), eq(session.userId, principal.userId)))
      .limit(1);
    if (rows[0] === undefined) {
      return;
    }
    const authContext = await this.auth.$context;
    await authContext.internalAdapter.deleteSession(rows[0].token);
  }

  async revokeOtherSessions(principal: AuthenticatedPrincipal): Promise<void> {
    if (this.auth === null) {
      throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication is unavailable.",
      });
    }
    const authContext = await this.auth.$context;
    const sessions = await this.database.db
      .select({ id: session.id, token: session.token })
      .from(session)
      .where(and(eq(session.userId, principal.userId), gt(session.expiresAt, new Date())));
    // Better Auth updates one shared active-session index in secondary storage
    // per deletion. Serialize these idempotent deletes so concurrent read/write
    // cycles cannot leave a remotely revoked token in that index.
    for (const candidate of sessions) {
      if (candidate.id !== principal.sessionId) {
        await authContext.internalAdapter.deleteSession(candidate.token);
      }
    }
  }
}
