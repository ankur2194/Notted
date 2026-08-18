import { describe, expect, it, vi } from "vitest";

import { getAuthPrincipal } from "../auth/auth-principal";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { getTrustedPrincipal } from "../common/rate-limit/trusted-principal";

import { ApiKeyAuthService } from "./api-key-auth.service";
import { getApiKeyActor } from "./api-key-context";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AuthConfig } from "../config/auth.config";
import type { DatabaseService } from "../database/database.service";
import type { Request } from "express";

const API_KEY_ID = "50000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "50000000-0000-4000-8100-000000000001";
const CREATOR_ID = "50000000-0000-4000-8200-000000000001";
const SECRET = `ntd_pk_${"a".repeat(32)}`;
const PEPPER = "auth-secret-000000000000000000000";

interface KeyRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdById: string;
  readonly scopes: string;
  readonly expiresAt: Date | null;
  readonly isRevoked: boolean;
}

const liveRow: KeyRow = Object.freeze({
  id: API_KEY_ID,
  workspaceId: WORKSPACE_ID,
  createdById: CREATOR_ID,
  scopes: "read,write",
  expiresAt: null,
  isRevoked: false,
});

function request(authorization?: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  } as unknown as Request;
}

function harness(row: KeyRow | undefined, options: { readonly touchRejects?: boolean } = {}) {
  const selects: unknown[] = [];
  const touch = vi.fn(() =>
    options.touchRejects === true ? Promise.reject(new Error("touch failed")) : Promise.resolve([]),
  );
  const database = {
    db: {
      select: (fields: unknown) => {
        selects.push(fields);
        return {
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(row === undefined ? [] : [row]) }),
          }),
        };
      },
      update: () => ({ set: () => ({ where: touch }) }),
    },
  } as unknown as DatabaseService;
  const logger = { info: vi.fn(), warning: vi.fn() } as unknown as StructuredLogger;
  const service = new ApiKeyAuthService(database, { secret: PEPPER } as AuthConfig, logger);
  return { service, selects, touch, logger };
}

async function apiRejection(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("ApiKeyAuthService credential detection", () => {
  it.each([
    ["no Authorization header", undefined],
    ["a cookie-shaped header", "Cookie session=abc"],
    ["a Basic credential", "Basic dXNlcjpwYXNz"],
    ["a Bearer token that is not our format", "Bearer not-a-notted-api-key"],
    ["a Bearer token with the right prefix but the wrong length", "Bearer ntd_pk_short"],
    ["a bare Bearer scheme", "Bearer"],
    ["an empty Bearer value", "Bearer "],
  ])("returns false and hits no database for %s", async (_name, header) => {
    const { service, selects } = harness(liveRow);
    await expect(service.authenticate(request(header))).resolves.toBe(false);
    expect(selects).toHaveLength(0);
  });

  it("accepts a lowercase bearer scheme", async () => {
    const { service, selects } = harness(liveRow);
    await expect(service.authenticate(request(`bearer ${SECRET}`))).resolves.toBe(true);
    expect(selects).toHaveLength(1);
  });
});

describe("ApiKeyAuthService rejection is a single indistinguishable outcome", () => {
  it("answers unknown, revoked and expired keys identically", async () => {
    const expired: KeyRow = { ...liveRow, expiresAt: new Date(Date.now() - 1_000) };
    const revoked: KeyRow = { ...liveRow, isRevoked: true };
    const errors = await Promise.all(
      [undefined, revoked, expired].map(async (row) =>
        apiRejection(harness(row).service.authenticate(request(`Bearer ${SECRET}`))),
      ),
    );
    for (const error of errors) {
      expect(error.getStatus()).toBe(401);
      expect(error.safeResponse.code).toBe("UNAUTHENTICATED");
    }
    const [unknown, revokedError, expiredError] = errors;
    // Identical strings, not merely equal codes: any difference is an oracle
    // that tells an attacker which of their guesses named a real key.
    expect(unknown?.safeResponse.message).toBe(revokedError?.safeResponse.message);
    expect(revokedError?.safeResponse.message).toBe(expiredError?.safeResponse.message);
    expect(unknown?.safeResponse.message).toBe("The API key is invalid.");
  });

  it("still accepts a key whose expiry is in the future", async () => {
    const { service } = harness({ ...liveRow, expiresAt: new Date(Date.now() + 60_000) });
    await expect(service.authenticate(request(`Bearer ${SECRET}`))).resolves.toBe(true);
  });

  it("installs nothing on the request when the key is rejected", async () => {
    const { service } = harness(undefined);
    const value = request(`Bearer ${SECRET}`);
    await apiRejection(service.authenticate(value));
    expect(getApiKeyActor(value)).toBeUndefined();
    expect(getAuthPrincipal(value)).toBeUndefined();
    expect(getTrustedPrincipal(value)).toBeUndefined();
  });
});

describe("ApiKeyAuthService successful authentication", () => {
  it("installs the api-key actor, the trusted principal and the synthetic principal", async () => {
    const { service } = harness(liveRow);
    const value = request(`Bearer ${SECRET}`);
    await expect(service.authenticate(value)).resolves.toBe(true);

    expect(getApiKeyActor(value)).toEqual({
      kind: "api-key",
      apiKeyId: API_KEY_ID,
      workspaceId: WORKSPACE_ID,
      scopes: ["read", "write"],
    });
    expect(getTrustedPrincipal(value)).toEqual({ kind: "api-key", actorId: API_KEY_ID });

    const principal = getAuthPrincipal(value);
    expect(principal?.userId).toBe(CREATOR_ID);
    expect(principal?.method).toBe("api-key");
    expect(principal?.assurance).toBe("single-factor");
    expect(principal?.sessionId).toBe(`api-key:${API_KEY_ID}`);
    // A machine credential is never "recently authenticated".
    expect(principal?.isFresh).toBe(false);
  });

  it("bounds the synthetic principal by the key expiry when there is one", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { service } = harness({ ...liveRow, expiresAt });
    const value = request(`Bearer ${SECRET}`);
    await service.authenticate(value);
    expect(getAuthPrincipal(value)?.expiresAt).toBe(expiresAt.toISOString());
  });

  it("drops an unknown stored scope token instead of widening the actor", async () => {
    const { service } = harness({ ...liveRow, scopes: "read,superuser" });
    const value = request(`Bearer ${SECRET}`);
    await service.authenticate(value);
    expect(getApiKeyActor(value)?.scopes).toEqual(["read"]);
  });

  it("issues the throttled last_used_at touch", async () => {
    const { service, touch } = harness(liveRow);
    await service.authenticate(request(`Bearer ${SECRET}`));
    expect(touch).toHaveBeenCalledOnce();
  });

  it("survives a rejected last_used_at touch and reports it without the credential", async () => {
    const { service, touch, logger } = harness(liveRow, { touchRejects: true });
    await expect(service.authenticate(request(`Bearer ${SECRET}`))).resolves.toBe(true);
    await Promise.resolve();
    expect(touch).toHaveBeenCalledOnce();
    const warning = vi.mocked(logger.warning);
    expect(warning).toHaveBeenCalledWith(
      { apiKeyId: API_KEY_ID, outcome: "error" },
      expect.any(String),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
  });

  it("logs identifiers only, exactly once, and never the credential", async () => {
    const { service, logger } = harness(liveRow);
    await service.authenticate(request(`Bearer ${SECRET}`));
    const info = vi.mocked(logger.info);
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      { apiKeyId: API_KEY_ID, workspaceId: WORKSPACE_ID },
      expect.any(String),
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET.slice(0, 8));
    expect(logged).not.toContain(PEPPER);
  });
});
