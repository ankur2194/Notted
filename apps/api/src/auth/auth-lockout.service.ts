// Part 74 — per-identifier credential-attempt budget and account lockout.
//
// WHY THIS IS NOT IN THE EXPRESS MIDDLEWARE. Better Auth needs the raw request
// stream, so `auth-rate-limit.middleware.ts` must not read the JSON body and
// therefore cannot see the email being attempted. It can only limit per IP,
// which a distributed attacker rotates for free. The identifier is the one axis
// they cannot rotate, and Better Auth's `hooks.before` is the first place it is
// parsed — so the counting lives there and this service holds the state.
//
// WHY REDIS AND NOT THE IN-MEMORY STORE. A lockout that only holds on the
// instance that saw the failures is not a lockout; the attacker just retries
// until they land on another replica. `incrementWithTtl` is a single atomic
// fixed-window INCR + PEXPIRE, so concurrent attempts cannot both read "9".

import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { RedisService } from "../infrastructure/redis/redis.service";

/**
 * The identical answer for a known and an unknown identifier. A distinct
 * "this account is locked" message would turn the lockout into an account
 * enumeration oracle, which is a worse leak than the brute force it stops.
 */
export const AUTH_LOCKOUT_MESSAGE = "Too many attempts. Try again later.";

const BUDGET_WINDOW_MS = 60_000;

export type AuthLockoutCode = "RATE_LIMITED" | "ACCOUNT_LOCKED";

/**
 * Transport-neutral refusal. `better-auth.setup.ts` maps it to an `APIError`;
 * nothing else should need to, because nothing else counts auth attempts.
 */
export class AuthLockoutError extends Error {
  constructor(
    readonly status: 429 | 423,
    readonly code: AuthLockoutCode,
    readonly retryAfterSeconds: number,
  ) {
    super(AUTH_LOCKOUT_MESSAGE);
    this.name = "AuthLockoutError";
  }
}

/**
 * Identifiers are emails. They are never stored, logged, or keyed in the clear:
 * Redis contents and log lines both outlive the request, and neither is a place
 * to accumulate a list of who tried to sign in.
 */
export function identifierHash(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toLowerCase(), "utf8").digest("hex");
}

@Injectable()
export class AuthLockoutService {
  constructor(
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
    private readonly redis: RedisService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Fixed 60-second window per identifier PER ENDPOINT, independent of the
   * per-IP bucket.
   *
   * `scope` is what stops one endpoint spending another's budget. The key used
   * to be `auth:budget:<hash>` alone, shared by every path in
   * `AUTH_IDENTIFIER_PATHS` — so an attacker with only a victim's email address
   * could drain it through `/notted/request-password-reset`, which needs no
   * password and no session, and the victim's real sign-in attempts then
   * answered 429. Scoping by the raw path needs no classification table and
   * makes the cross-endpoint spend structurally impossible rather than merely
   * unlikely.
   */
  async consumeIdentifierBudget(identifier: string, scope: string): Promise<void> {
    const hash = identifierHash(identifier);
    const used = await this.redis.incrementWithTtl(
      `auth:budget:${scope}:${hash}`,
      BUDGET_WINDOW_MS,
    );
    if (used > this.appConfig.authRateLimitPerMinute) {
      throw new AuthLockoutError(429, "RATE_LIMITED", BUDGET_WINDOW_MS / 1_000);
    }
  }

  /** Refuses before any password is verified, so a locked identifier costs no hash. */
  async assertNotLocked(identifier: string): Promise<void> {
    const lockedUntil = await this.redis.get(`auth:lock:${identifierHash(identifier)}`);
    if (lockedUntil === null) return;
    const remainingMs = Number(lockedUntil) - Date.now();
    if (remainingMs <= 0) return;
    throw new AuthLockoutError(423, "ACCOUNT_LOCKED", Math.max(1, Math.ceil(remainingMs / 1_000)));
  }

  /**
   * Counted in the same window as the lock duration: N failures within
   * `lockoutSeconds` lock for `lockoutSeconds`. One window, one knob.
   */
  async recordFailure(identifier: string): Promise<void> {
    const hash = identifierHash(identifier);
    const windowMs = this.authConfig.lockoutSeconds * 1_000;
    const failures = await this.redis.incrementWithTtl(`auth:fail:${hash}`, windowMs);
    if (failures < this.authConfig.lockoutAttempts) return;
    await this.redis.set(`auth:lock:${hash}`, String(Date.now() + windowMs), windowMs);
    // The hash only. An operator correlating a lockout with a support request
    // can hash the address they were given; the log itself names nobody.
    this.logger.warning(
      { component: "auth", outcome: "account_locked", identifierHash: hash, failures },
      "Authentication identifier locked after repeated failures",
    );
  }

  /** A successful sign-in clears the failure count and any residual lock. */
  async recordSuccess(identifier: string): Promise<void> {
    const hash = identifierHash(identifier);
    await this.redis.delete(`auth:fail:${hash}`);
    await this.redis.delete(`auth:lock:${hash}`);
  }
}
