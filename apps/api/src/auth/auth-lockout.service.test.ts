import { describe, expect, it } from "vitest";

import { parseAppConfig } from "../config/app.config";
import { parseAuthConfig } from "../config/auth.config";

import {
  AUTH_LOCKOUT_MESSAGE,
  AuthLockoutError,
  AuthLockoutService,
  identifierHash,
} from "./auth-lockout.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AppConfig } from "../config/app.config";
import type { AuthConfig } from "../config/auth.config";
import type { RedisService } from "../infrastructure/redis/redis.service";

/**
 * In-memory stand-in for Redis. Honours TTL expiry and the atomic
 * INCR + PEXPIRE-on-create semantics `incrementWithTtl` promises, so the
 * service's fixed-window counting behaves the same as it would against
 * real Redis.
 */
class FakeRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();

  private prune(key: string): void {
    const entry = this.store.get(key);
    if (entry !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.prune(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? Number.MAX_SAFE_INTEGER) });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incrementWithTtl(key: string, ttlMs: number): Promise<number> {
    this.prune(key);
    const existing = this.store.get(key);
    if (existing === undefined) {
      this.store.set(key, { value: "1", expiresAt: Date.now() + ttlMs });
      return 1;
    }
    const next = Number(existing.value) + 1;
    this.store.set(key, { value: String(next), expiresAt: existing.expiresAt });
    return next;
  }
}

class FakeLogger {
  readonly warnings: { metadata: Record<string, unknown>; message: string }[] = [];

  warning(metadata: Record<string, unknown>, message: string): void {
    this.warnings.push({ metadata, message });
  }
}

interface Overrides {
  readonly authRateLimitPerMinute?: string;
  readonly lockoutAttempts?: string;
  readonly lockoutSeconds?: string;
}

function buildService(overrides: Overrides = {}): {
  service: AuthLockoutService;
  redis: FakeRedis;
  logger: FakeLogger;
  appConfig: AppConfig;
  authConfig: AuthConfig;
} {
  const appConfig = parseAppConfig(
    overrides.authRateLimitPerMinute === undefined
      ? {}
      : { RATE_LIMIT_AUTH_PER_MINUTE: overrides.authRateLimitPerMinute },
  );
  const authConfig = parseAuthConfig({
    ...(overrides.lockoutAttempts === undefined
      ? {}
      : { AUTH_LOCKOUT_ATTEMPTS: overrides.lockoutAttempts }),
    ...(overrides.lockoutSeconds === undefined
      ? {}
      : { AUTH_LOCKOUT_SECONDS: overrides.lockoutSeconds }),
  });
  const redis = new FakeRedis();
  const logger = new FakeLogger();
  const service = new AuthLockoutService(
    appConfig,
    authConfig,
    redis as unknown as RedisService,
    logger as unknown as StructuredLogger,
  );
  return { service, redis, logger, appConfig, authConfig };
}

describe("AuthLockoutService", () => {
  it("allows exactly the configured per-minute budget then rate-limits the next attempt", async () => {
    const { service, appConfig } = buildService({ authRateLimitPerMinute: "3" });
    const identifier = "budget@example.test";

    for (let attempt = 0; attempt < appConfig.authRateLimitPerMinute; attempt += 1) {
      await expect(
        service.consumeIdentifierBudget(identifier, "/sign-in/email"),
      ).resolves.toBeUndefined();
    }

    const error = await service
      .consumeIdentifierBudget(identifier, "/sign-in/email")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthLockoutError);
    const lockoutError = error as AuthLockoutError;
    expect(lockoutError.status).toBe(429);
    expect(lockoutError.code).toBe("RATE_LIMITED");
    // Fixed 60-second window regardless of the configured capacity.
    expect(lockoutError.retryAfterSeconds).toBe(60);
  });

  it("locks after the configured attempt count and leaves the account open below it", async () => {
    const { service } = buildService({ lockoutAttempts: "3", lockoutSeconds: "60" });
    const identifier = "lockout@example.test";

    await service.recordFailure(identifier);
    await service.recordFailure(identifier);
    // Below the threshold: the account is still usable.
    await expect(service.assertNotLocked(identifier)).resolves.toBeUndefined();

    await service.recordFailure(identifier);
    const error = await service.assertNotLocked(identifier).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthLockoutError);
    const lockoutError = error as AuthLockoutError;
    expect(lockoutError.status).toBe(423);
    expect(lockoutError.code).toBe("ACCOUNT_LOCKED");
    expect(lockoutError.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("clears the failure count on success so the next attempts do not lock", async () => {
    const { service } = buildService({ lockoutAttempts: "3", lockoutSeconds: "60" });
    const identifier = "recovers@example.test";

    await service.recordFailure(identifier);
    await service.recordFailure(identifier);
    await service.recordSuccess(identifier);
    // Had the counter not been reset by the success, these two more (four
    // total) would have crossed the threshold of three and locked.
    await service.recordFailure(identifier);
    await service.recordFailure(identifier);
    await expect(service.assertNotLocked(identifier)).resolves.toBeUndefined();
  });

  it("answers a known and an unknown identifier with the identical enumeration-safe message", async () => {
    const { service } = buildService({ lockoutAttempts: "3", lockoutSeconds: "60" });
    const known = "known@example.test";
    const unknown = "unknown@example.test";
    await service.recordFailure(known);
    await service.recordFailure(known);
    await service.recordFailure(known);

    const knownError = (await service
      .assertNotLocked(known)
      .catch((caught: unknown) => caught)) as AuthLockoutError;
    // A distinct "this account is locked" message would turn the lockout
    // into an account-enumeration oracle, so the constant is asserted verbatim.
    expect(knownError.message).toBe(AUTH_LOCKOUT_MESSAGE);
    // The unlocked, never-seen identifier resolves rather than throwing at
    // all, which is itself part of the identical treatment.
    await expect(service.assertNotLocked(unknown)).resolves.toBeUndefined();
  });

  it("never stores or logs the raw identifier, only its hash", async () => {
    const { service, redis, logger } = buildService({
      lockoutAttempts: "3",
      lockoutSeconds: "60",
    });
    const identifier = "Secret.Person@Example.test";
    const hash = identifierHash(identifier);

    await service.consumeIdentifierBudget(identifier, "/sign-in/email");
    await service.recordFailure(identifier);
    await service.recordFailure(identifier);
    await service.recordFailure(identifier);

    for (const key of redis.store.keys()) {
      // Every Redis key carries the hash, never the plaintext identifier,
      // in any casing.
      expect(key).not.toContain(identifier);
      expect(key).not.toContain(identifier.toLowerCase());
    }
    expect([...redis.store.keys()].some((key) => key.includes(hash))).toBe(true);

    expect(logger.warnings).toHaveLength(1);
    const warning = logger.warnings[0];
    expect(warning).toBeDefined();
    // The account_locked warning carries the hash, never the email.
    expect(JSON.stringify(warning?.metadata)).not.toContain(identifier);
    expect(JSON.stringify(warning?.metadata)).not.toContain(identifier.toLowerCase());
    expect(warning?.metadata.identifierHash).toBe(hash);
    expect(warning?.message).not.toContain(identifier);
  });

  it("hashes an identifier independent of case and surrounding whitespace", () => {
    // So a distributed attacker cannot dodge the budget by varying case or
    // padding, and a legitimate retry with different casing still counts
    // against the same lock.
    expect(identifierHash(" A@B.test ")).toBe(identifierHash("a@b.test"));
  });
});

describe("AuthLockoutService budget scoping", () => {
  /*
   * THE DEFECT THIS BLOCK EXISTS FOR. Every path in `AUTH_IDENTIFIER_PATHS`
   * shared one Redis key per email address, so an unauthenticated stranger who
   * knew a victim's address could drain the victim's SIGN-IN budget by posting
   * to `/notted/request-password-reset` — an endpoint that needs no password,
   * no session, and answers the same either way.
   */
  it("does not let one endpoint spend another endpoint's budget", async () => {
    const { service, appConfig } = buildService({ authRateLimitPerMinute: "3" });
    const identifier = "victim@example.test";

    // Drain the reset endpoint's budget completely.
    for (let attempt = 0; attempt < appConfig.authRateLimitPerMinute; attempt += 1) {
      await service.consumeIdentifierBudget(identifier, "/notted/request-password-reset");
    }
    await expect(
      service.consumeIdentifierBudget(identifier, "/notted/request-password-reset"),
    ).rejects.toBeInstanceOf(AuthLockoutError);

    // The victim's real sign-in is untouched.
    for (let attempt = 0; attempt < appConfig.authRateLimitPerMinute; attempt += 1) {
      await expect(
        service.consumeIdentifierBudget(identifier, "/sign-in/email"),
      ).resolves.toBeUndefined();
    }
  });

  it("still keys every scoped budget by hash, never by the address", async () => {
    const { service, redis } = buildService({ authRateLimitPerMinute: "3" });
    const identifier = "Secret.Person@Example.test";

    await service.consumeIdentifierBudget(identifier, "/sign-in/email");
    for (const key of redis.store.keys()) {
      expect(key).not.toContain(identifier);
      expect(key).not.toContain(identifier.toLowerCase());
    }
    expect([...redis.store.keys()].some((key) => key.includes(identifierHash(identifier)))).toBe(
      true,
    );
  });
});
