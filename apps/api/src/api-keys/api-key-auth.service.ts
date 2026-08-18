// Part 65 — authenticating a request that presents an API key.
//
// WHAT THIS INSTALLS. A valid key makes the request behave like the key's
// creator, plus an `ApiKeyAuthorizationActor` that the HTTP authorization guard
// intersects with the creator's LIVE workspace role. Effective permission is
// therefore `scope ∩ creator role`, and it fails closed by itself when the
// creator is demoted or removed — no revocation sweep is required for that.
//
// WHAT THIS NEVER DOES. It never caches a row (an instantly revoked key must
// stop on the very next request), never distinguishes unknown from revoked from
// expired (that would be an enumeration oracle), and never logs the secret, its
// hash, the Authorization header, or the display prefix.

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { API_KEY_SECRET_PATTERN } from "@notted/shared-validators";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { setAuthPrincipal } from "../auth/auth-principal";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { setTrustedPrincipal } from "../common/rate-limit/trusted-principal";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { DatabaseService } from "../database/database.service";
import { apiKeys } from "../database/schema";

import { setApiKeyActor } from "./api-key-context";
import { hashApiKey, parseScopes } from "./api-key-secret";
import { API_KEY_LAST_USED_THROTTLE_MS } from "./api-keys.constants";

import type { Request } from "express";

/** A key with no expiry still needs a bounded synthetic principal lifetime. */
const SYNTHETIC_PRINCIPAL_TTL_MS = 60 * 60 * 1_000;

/**
 * ONE message and ONE code for every rejection reason. Unknown hash, revoked
 * key and expired key are indistinguishable to the caller by construction.
 */
function invalidApiKey(): ApiHttpException {
  return new ApiHttpException(HttpStatus.UNAUTHORIZED, {
    code: "UNAUTHENTICATED",
    message: "The API key is invalid.",
  });
}

/**
 * The presented secret, or `null` when this request carries no API-key
 * credential at all. A `Bearer` value that is not our wire format is somebody
 * else's credential, so it resolves to `null` — no database round-trip and no
 * log line for traffic that was never addressed to this authenticator.
 */
function bearerSecret(request: Request): string | null {
  const header = request.header("authorization");
  if (header === undefined) return null;
  const separator = header.indexOf(" ");
  if (separator === -1) return null;
  if (header.slice(0, separator).toLowerCase() !== "bearer") return null;
  const secret = header.slice(separator + 1).trim();
  return API_KEY_SECRET_PATTERN.test(secret) ? secret : null;
}

@Injectable()
export class ApiKeyAuthService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * @returns `true` when a valid API-key credential was presented and the
   * request is now authenticated; `false` when no API-key credential is present
   * and the caller should fall back to the cookie session.
   * @throws ApiHttpException 401 when a credential was presented but is invalid.
   */
  async authenticate(request: Request): Promise<boolean> {
    const secret = bearerSecret(request);
    if (secret === null) return false;

    // NOT tenant-scoped, and deliberately so: this lookup is what ESTABLISHES
    // the workspace, exactly like `AuthorizationRepository.findMembership`. It
    // is a single unique-index probe keyed by a value only the holder of the
    // secret can produce, and it grants nothing on its own — the row's
    // `workspace_id` becomes the actor's tenant, and every downstream statement
    // is scoped by it.
    const [row] = await this.database.db
      .select({
        id: apiKeys.id,
        workspaceId: apiKeys.workspaceId,
        createdById: apiKeys.createdById,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        isRevoked: apiKeys.isRevoked,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(secret, this.authConfig.secret)))
      .limit(1);

    const now = new Date();
    if (row === undefined || row.isRevoked) throw invalidApiKey();
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) throw invalidApiKey();

    // Order is load-bearing. The actor is what the HTTP authorization guard and
    // the route guard read; the trusted principal is what the rate limiter
    // reads; the synthetic principal is what every existing controller reads.
    // Installing the principal last means no downstream reader can ever observe
    // an authenticated request that is missing its API-key actor.
    setApiKeyActor(request, {
      kind: "api-key",
      apiKeyId: row.id,
      workspaceId: row.workspaceId,
      scopes: parseScopes(row.scopes),
    });
    setTrustedPrincipal(request, { kind: "api-key", actorId: row.id });
    const expiresAt = row.expiresAt ?? new Date(now.getTime() + SYNTHETIC_PRINCIPAL_TTL_MS);
    setAuthPrincipal(request, {
      userId: row.createdById,
      sessionId: `api-key:${row.id}`,
      method: "api-key",
      assurance: "single-factor",
      authenticatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      // A machine credential is never "recently authenticated", so
      // `requireRecentAuthentication` denies API keys with no extra code.
      isFresh: false,
    });

    // `last_used_at` is informational, so a failed touch must never turn a
    // successfully authenticated request into an error — but it must not vanish
    // either, or the column silently stops tracking anything.
    void this.touchLastUsed(row.id).catch(() => {
      this.logger.warning({ apiKeyId: row.id, outcome: "error" }, "API key last-used touch failed");
    });

    this.logger.info(
      { apiKeyId: row.id, workspaceId: row.workspaceId },
      "API key authenticated a request",
    );
    return true;
  }

  /**
   * Conditional so a hot key writes at most one row per throttle window rather
   * than one per request. Keyed by the primary key just proven above, so it
   * needs no tenant predicate.
   *
   * ponytail: a per-request UPDATE that usually matches zero rows. If key
   * traffic ever makes this row hot, batch the touches through Redis and flush
   * them on an interval instead of widening this statement.
   */
  private async touchLastUsed(apiKeyId: string): Promise<void> {
    const throttleSeconds = API_KEY_LAST_USED_THROTTLE_MS / 1_000;
    const staleBefore = sql`now() - make_interval(secs => ${throttleSeconds})`;
    await this.database.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiKeys.id, apiKeyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, staleBefore)),
        ),
      );
  }
}
