import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { parseAuthConfig } from "../config/auth.config";
import { parseRetentionConfig } from "../config/retention.config";
import { passkey as passkeyTable, twoFactor as twoFactorTable } from "../database/schema";

import { setAuthPrincipal } from "./auth-principal";
import { AuthService } from "./auth.service";
import {
  AUTH_IDENTIFIER_PATHS,
  type BetterAuthInstance,
  configuredSocialProviders,
  passkeyPluginOptions,
  preserveNonRememberedRotationExpiry,
  RECENT_AUTHENTICATION_PATHS,
  twoFactorPluginOptions,
} from "./better-auth.setup";

import type { VerifiedHostsService } from "../common/verified-hosts.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

function principal(isFresh: boolean): AuthenticatedPrincipal {
  return {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    method: "opaque-session",
    assurance: "single-factor",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authenticatedAt: new Date().toISOString(),
    isFresh,
  };
}

describe("advanced authentication policy", () => {
  it("omits disabled social providers entirely and exposes no credentials in capabilities", () => {
    const credential = ["runtime", crypto.randomUUID()].join("-");
    const config = parseAuthConfig({
      AUTH_OAUTH_GITHUB_CLIENT_ID: "client-id",
      AUTH_OAUTH_GITHUB_CLIENT_SECRET: credential,
    });
    expect(Object.keys(configuredSocialProviders(config))).toEqual(["github"]);

    const service = new AuthService(
      {} as BetterAuthInstance,
      config,
      parseRetentionConfig({ SESSION_REMEMBER_ME_DAYS: "30" }),
      // Part 73. A stub that trusts nothing beyond the configured list, so this
      // suite still asserts exactly what it asserted before custom domains.
      { isTrustedOriginSync: () => false } as unknown as VerifiedHostsService,
    );
    const serialized = JSON.stringify(service.capabilities());
    expect(serialized).toContain("github");
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("client-id");
  });

  it(
    "matches the installed passkey 1.6.24 schema without migration drift",
    // These schema-drift guards dynamically import the heavy ESM-only passkey
    // and two-factor plugins, which Vitest transforms on first resolve. Give
    // the import pipeline ample time instead of the default 5s test budget.
    { timeout: 180_000 },
    async () => {
      const { passkey } = await import("@better-auth/passkey");
      const pluginFields = Object.keys(passkey().schema.passkey.fields).sort();
      const tableFields = Object.keys(getTableColumns(passkeyTable))
        .filter((field) => field !== "id")
        .sort();
      expect(tableFields).toEqual(pluginFields);
      expect(passkeyPluginOptions(parseAuthConfig({}))).toMatchObject({
        rpID: "localhost",
        origin: ["http://localhost:3000"],
        authenticatorSelection: { userVerification: "required" },
      });
    },
  );

  it(
    "matches two-factor lockout and redacted schema fields",
    // Heavy ESM plugin import (see the passkey test above for rationale).
    { timeout: 180_000 },
    async () => {
      const { twoFactor } = await import("better-auth/plugins");
      const pluginFields = Object.keys(twoFactor().schema.twoFactor.fields).sort();
      const tableFields = Object.keys(getTableColumns(twoFactorTable))
        .filter((field) => field !== "id")
        .sort();
      expect(tableFields).toEqual(pluginFields);
      expect(twoFactorPluginOptions(parseAuthConfig({}))).toMatchObject({
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      });
      expect(twoFactor().schema.twoFactor.fields.secret.returned).toBe(false);
      expect(twoFactor().schema.twoFactor.fields.backupCodes.returned).toBe(false);
    },
  );

  it("uses one day for non-remembered sessions and the configured remembered duration", () => {
    const service = new AuthService(
      {} as BetterAuthInstance,
      parseAuthConfig({ AUTH_RECENT_AUTH_SECONDS: "300" }),
      parseRetentionConfig({ SESSION_REMEMBER_ME_DAYS: "45" }),
      // Part 73. A stub that trusts nothing beyond the configured list, so this
      // suite still asserts exactly what it asserted before custom domains.
      { isTrustedOriginSync: () => false } as unknown as VerifiedHostsService,
    );
    expect(service.capabilities()).toMatchObject({
      nonRememberedSessionSeconds: 86_400,
      rememberedSessionSeconds: 3_888_000,
      recentAuthenticationSeconds: 300,
    });
  });

  it("requires a fresh principal for every delegated high-risk path", () => {
    expect(RECENT_AUTHENTICATION_PATHS).toEqual(
      expect.arrayContaining([
        "/two-factor/enable",
        "/two-factor/disable",
        "/two-factor/get-totp-uri",
        "/two-factor/generate-backup-codes",
        "/passkey/generate-register-options",
        "/passkey/verify-registration",
        "/passkey/delete-passkey",
        "/link-social",
        "/change-email",
        "/change-password",
        "/delete-user",
        "/revoke-session",
      ]),
    );
    const service = new AuthService(
      {} as BetterAuthInstance,
      parseAuthConfig({}),
      parseRetentionConfig({}),
      // Part 73. A stub that trusts nothing beyond the configured list, so this
      // suite still asserts exactly what it asserted before custom domains.
      { isTrustedOriginSync: () => false } as unknown as VerifiedHostsService,
    );
    expect(() => service.requireRecentAuthentication(principal(false))).toThrowError(
      "Confirm your identity",
    );
    expect(() => service.requireRecentAuthentication(principal(true))).not.toThrow();
  });

  // Part 65 regression. The API-key pre-guard installs a synthetic principal
  // before this ever runs, and Better Auth is null on any deployment without
  // Redis. Checking availability first threw that principal away and 401'd
  // every API-key request.
  it("returns an already-installed principal even with no Better Auth instance", async () => {
    const service = new AuthService(null, parseAuthConfig({}), parseRetentionConfig({}), {
      isTrustedOriginSync: () => false,
    } as unknown as VerifiedHostsService);
    expect(service.isAvailable()).toBe(false);

    const request = { headers: {} } as unknown as Request;
    expect(await service.authenticate(request)).toBeNull();

    const installed = principal(false);
    setAuthPrincipal(request, installed);
    expect(await service.authenticate(request)).toEqual(installed);
  });

  // Part 74. OAuth and passkey paths are deliberately absent: neither accepts
  // a guessable secret, and locking on them would let one attacker lock a
  // victim out of their own provider sign-in.
  it("limits identifier-based lockout counting to the four credential-guessing paths", () => {
    expect(AUTH_IDENTIFIER_PATHS).toEqual([
      "/sign-in/email",
      "/sign-up/email",
      "/sign-in/magic-link",
      "/notted/request-password-reset",
    ]);
  });

  it("preserves one-day intent across Better Auth TOTP management rotations", () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const proposed = {
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    };
    const short = {
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 60_000 + 86_400_000),
    };
    const remembered = {
      createdAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 60_000 + 30 * 86_400_000),
    };

    expect(preserveNonRememberedRotationExpiry("/two-factor/verify-totp", proposed, short)).toEqual(
      new Date(now.getTime() + 86_400_000),
    );
    expect(preserveNonRememberedRotationExpiry("/two-factor/disable", proposed, remembered)).toBe(
      proposed.expiresAt,
    );
    expect(preserveNonRememberedRotationExpiry("/sign-in/email", proposed, short)).toBe(
      proposed.expiresAt,
    );
  });
});
