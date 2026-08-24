// Part 67 — unit tests for the AI configuration and usage service.
//
// WHAT THIS SUITE IS FOR. Three properties here are security properties rather
// than features, and none of them fails loudly when it regresses:
//
//   1. THE CREDENTIAL PROJECTION. `encryptedCredentials` must be absent from
//      every read path BY CONSTRUCTION. The fixture rows below deliberately
//      CARRY a ciphertext the service never asked for, so a DTO that spreads a
//      row instead of building one fails these tests.
//   2. THE AUDIT TRAIL. A configuration change is exactly the event an auditor
//      reads, and exactly the place a well-meaning "log what changed" would put
//      a key prefix. The metadata assertions below say the key is not there.
//   3. THE KEY LIFECYCLE. A provider switch that silently kept the old
//      provider's ciphertext, or a stale key version that never migrated, both
//      look fine until the first request fails at the provider.
//
// The database and the credential service are plain object stubs; there is no
// Nest testing module, because nothing under test resolves from the container.

import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { aiProviderConfig, aiUsage, auditLogs } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { AI_AUDIT_ACTIONS, AI_AUDIT_ENTITY_TYPE } from "./ai.constants";
import { AiService } from "./ai.service";

import type { AiCredentialService } from "./ai-credential.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { AiConfig } from "../config/ai.config";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "90000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "90000000-0000-4000-8100-000000000001";
const CONFIG_ID = "90000000-0000-4000-8200-000000000001";
const CIPHERTEXT = "c3RvcmVkLWNpcGhlcnRleHQ=";
const API_KEY = "sk-live-000000000000000000000000000";
const PLAINTEXT_FROM_DECRYPT = "sk-live-recovered-00000000000000000";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

const scoped = Object.freeze({ principal, workspaceId: WORKSPACE_ID });

/** Everything a full update body carries, so each test overrides one thing. */
const updateBase = Object.freeze({
  ...scoped,
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isEnabled: true,
  dailyTokenQuota: 1_000,
  rateLimitPerMinute: 5,
  contentConsent: true,
});

type Row = Record<string, unknown>;

/**
 * Carries `encryptedCredentials` / `encryptionKeyVersion` that no read path
 * selects. A view that echoes a row rather than building one leaks them here.
 */
const configRow: Row = Object.freeze({
  workspaceId: WORKSPACE_ID,
  provider: "openai",
  model: "gpt-4o-mini",
  isEnabled: true,
  hasCredentials: true,
  settings: { dailyTokenQuota: 1_000, rateLimitPerMinute: 5, contentConsent: true },
  updatedById: USER_ID,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  encryptedCredentials: CIPHERTEXT,
  encryptionKeyVersion: 1,
});

const credentialRow: Row = Object.freeze({
  id: CONFIG_ID,
  provider: "openai",
  encryptedCredentials: CIPHERTEXT,
  encryptionKeyVersion: 1,
});

const totalsRow: Row = Object.freeze({
  totalRequests: 5,
  successfulRequests: 3,
  failedRequests: 1,
  rateLimitedRequests: 1,
  promptTokens: "1200",
  completionTokens: "800",
  totalTokens: "2000",
  costMicros: "4500",
});

const featureRow: Row = Object.freeze({
  feature: "summarize",
  requests: 3,
  totalTokens: "1500",
  costMicros: "3000",
});

interface Awaitable<T> extends Promise<T> {
  limit: (count: number) => Awaitable<T>;
  groupBy: (...columns: readonly unknown[]) => Awaitable<T>;
  orderBy: (...columns: readonly unknown[]) => Awaitable<T>;
}

function rows(value: readonly unknown[]): Awaitable<unknown[]> {
  const promise = Promise.resolve([...value]) as Awaitable<unknown[]>;
  promise.limit = () => promise;
  promise.groupBy = () => promise;
  promise.orderBy = () => promise;
  return promise;
}

interface HarnessOptions {
  /** `[]` is the "never configured" case for both config reads. */
  readonly configRows?: readonly Row[];
  readonly credentialRows?: readonly Row[];
  readonly activeKeyVersion?: number;
  readonly decryptFails?: boolean;
  readonly featureEnabled?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const tenant = new TenantContextService();
  const inserted: { readonly table: unknown; readonly values: Row }[] = [];
  const updated: Row[] = [];

  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const entry = {
    authorizeUser,
    run: <T>(operation: { workspaceId: string; userId: string | null }, work: () => T): T =>
      tenant.run(
        createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
        work,
      ),
  } as unknown as AuthorizationEntryService;

  /** Models the row a `RETURNING` of the safe projection would produce. */
  const writtenRow = (values: Row): Row => ({
    ...configRow,
    provider: values.provider,
    model: values.model,
    isEnabled: values.isEnabled,
    hasCredentials: values.encryptedCredentials !== null,
    settings: values.settings,
    updatedById: values.updatedById,
    updatedAt: values.updatedAt,
    // Still present, still never asked for — see the fixture comment.
    encryptedCredentials: values.encryptedCredentials,
    encryptionKeyVersion: values.encryptionKeyVersion,
  });

  const answer = (table: unknown, fields: Row): readonly unknown[] => {
    if (table === aiProviderConfig) {
      return "encryptedCredentials" in fields
        ? (options.credentialRows ?? [credentialRow])
        : (options.configRows ?? [configRow]);
    }
    if (table === aiUsage) {
      if ("feature" in fields) return [featureRow];
      if ("totalRequests" in fields) return [totalsRow];
      return [{ tokens: "500" }];
    }
    return [];
  };

  const scope = {
    select: (fields: Row) => ({
      from: (table: unknown) => ({ where: () => rows(answer(table, fields)) }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserted.push({ table, values });
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          returning: (fields: Row) => Promise<unknown[]>;
        };
        promise.returning = () => Promise.resolve([writtenRow(values)]);
        return promise;
      },
    }),
    update: () => ({
      set: (values: Row) => ({
        where: () => {
          updated.push(values);
          return { returning: () => Promise.resolve([writtenRow(values)]) };
        },
      }),
    }),
  };

  const database = {
    db: scope,
    transaction: (work: (value: typeof scope) => Promise<unknown>) => work(scope),
  } as unknown as DatabaseService;

  const encrypt = vi.fn((configId: string) => ({
    encryptedCredentials: `encrypted:${configId}`,
    encryptionKeyVersion: options.activeKeyVersion ?? 1,
  }));
  const decrypt = vi.fn(() => {
    if (options.decryptFails === true) throw new Error("AI credential is unreadable");
    return PLAINTEXT_FROM_DECRYPT;
  });
  const credentials = {
    encrypt,
    decrypt,
    activeKeyVersion: options.activeKeyVersion ?? 1,
  } as unknown as AiCredentialService;

  const service = new AiService(database, entry, tenant, credentials, {
    enabled: options.featureEnabled ?? true,
  } as AiConfig);

  return { service, inserted, updated, encrypt, decrypt, authorizeUser };
}

const auditOf = (inserted: readonly { readonly table: unknown; readonly values: Row }[]): Row =>
  (inserted.find((entry) => entry.table === auditLogs)?.values ?? {}) as Row;

const configInsertOf = (
  inserted: readonly { readonly table: unknown; readonly values: Row }[],
): Row => (inserted.find((entry) => entry.table === aiProviderConfig)?.values ?? {}) as Row;

async function rejection(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** Any key a stored credential could plausibly hide behind. */
const CREDENTIAL_SHAPED = /credential|cipher|secret|apikey|api_key|encryption/iu;

function expectNoCredentialLeak(view: object): void {
  for (const key of Object.keys(view)) {
    if (key === "hasCredentials") continue;
    expect(key).not.toMatch(CREDENTIAL_SHAPED);
  }
  expect(JSON.stringify(view)).not.toContain(CIPHERTEXT);
  expect(JSON.stringify(view)).not.toContain(API_KEY);
}

describe("AiService.getConfig", () => {
  it("authorizes before reading, and returns the safe projection", async () => {
    const { service, authorizeUser } = harness();
    const view = await service.getConfig(scoped);

    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.configure", resource: { kind: "workspace" } }),
    );
    expect(view).toEqual({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      isEnabled: true,
      hasCredentials: true,
      dailyTokenQuota: 1_000,
      rateLimitPerMinute: 5,
      contentConsent: true,
      updatedById: USER_ID,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expectNoCredentialLeak(view);
  });

  it("reports hasCredentials false when the column is empty", async () => {
    const { service } = harness({
      configRows: [{ ...configRow, hasCredentials: false, encryptedCredentials: null }],
    });
    expect((await service.getConfig(scoped)).hasCredentials).toBe(false);
  });

  it("synthesizes a disabled default view when the workspace has no row", async () => {
    const { service, inserted } = harness({ configRows: [] });
    const view = await service.getConfig(scoped);

    expect(view).toMatchObject({
      workspaceId: WORKSPACE_ID,
      provider: "disabled",
      model: null,
      isEnabled: false,
      hasCredentials: false,
      contentConsent: false,
      dailyTokenQuota: 50_000,
      rateLimitPerMinute: 10,
      updatedById: null,
    });
    // A read must not write the row it did not find.
    expect(inserted).toEqual([]);
  });

  it("falls back to the documented defaults when the settings blob is unusable", async () => {
    const { service } = harness({
      configRows: [{ ...configRow, settings: { dailyTokenQuota: -5, contentConsent: "yes" } }],
    });
    const view = await service.getConfig(scoped);

    expect(view.dailyTokenQuota).toBe(50_000);
    expect(view.rateLimitPerMinute).toBe(10);
    // Anything that is not literally `true` denies.
    expect(view.contentConsent).toBe(false);
  });
});

describe("AiService.updateConfig", () => {
  it("keeps the stored ciphertext untouched when no key is supplied", async () => {
    const { service, updated, encrypt, decrypt, inserted } = harness();
    await service.updateConfig(updateBase);

    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(updated[0]).toMatchObject({
      encryptedCredentials: CIPHERTEXT,
      encryptionKeyVersion: 1,
      isEnabled: true,
      settings: { dailyTokenQuota: 1_000, rateLimitPerMinute: 5, contentConsent: true },
      updatedById: USER_ID,
    });
    // A settings-only save is a configure, and it says the key did not move.
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.configure);
    expect(auditOf(inserted).metadata).toMatchObject({ credentialChanged: false });
  });

  it("encrypts a supplied key under the id the row already has", async () => {
    const { service, updated, encrypt, inserted } = harness();
    await service.updateConfig({ ...updateBase, apiKey: API_KEY });

    expect(encrypt).toHaveBeenCalledWith(CONFIG_ID, API_KEY);
    expect(updated[0]).toMatchObject({ encryptedCredentials: `encrypted:${CONFIG_ID}` });
    // Replacing an existing credential is a rotation, not a first configure.
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.credentialRotated);
  });

  it("mints the row id before the insert, because the AAD binds to it", async () => {
    const { service, inserted, encrypt } = harness({ configRows: [], credentialRows: [] });
    await service.updateConfig({ ...updateBase, apiKey: API_KEY });

    const written = configInsertOf(inserted);
    expect(typeof written.id).toBe("string");
    expect(encrypt).toHaveBeenCalledWith(written.id, API_KEY);
    expect(written.encryptedCredentials).toBe(`encrypted:${String(written.id)}`);
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.configure);
    expect(auditOf(inserted).entityId).toBe(written.id);
  });

  it("refuses a provider switch that carries no new key", async () => {
    const { service, updated, inserted } = harness();
    const error = await rejection(
      service.updateConfig({ ...updateBase, provider: "anthropic", model: "claude-sonnet-4-5" }),
    );

    expect(error.safeResponse.code).toBe("AI_CREDENTIAL_REQUIRED");
    expect(error.safeResponse.message).toContain("anthropic");
    // Nothing was written: the old provider's ciphertext is not carried over.
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("lets a workspace with no stored key select a provider without supplying one", async () => {
    // Leaving `disabled` is not a provider SWITCH: there is no old provider's
    // ciphertext to carry across, so the refusal above must not fire here. An
    // admin has to be able to choose a provider before fetching its key; the
    // "no credential" rule below still stops them ENABLING it.
    const { service, updated } = harness({
      credentialRows: [
        {
          ...credentialRow,
          provider: "disabled",
          encryptedCredentials: null,
          encryptionKeyVersion: null,
        },
      ],
    });
    await service.updateConfig({ ...updateBase, provider: "anthropic", isEnabled: false });

    expect(updated[0]).toMatchObject({
      provider: "anthropic",
      encryptedCredentials: null,
      isEnabled: false,
    });
  });

  it("refuses to enable AI when nothing is stored and nothing was supplied", async () => {
    const { service } = harness({ configRows: [], credentialRows: [] });
    const error = await rejection(service.updateConfig(updateBase));

    expect(error.safeResponse.code).toBe("AI_CREDENTIAL_REQUIRED");
  });

  it("still saves a not-yet-enabled configuration with no credential at all", async () => {
    const { service, inserted } = harness({ configRows: [], credentialRows: [] });
    await service.updateConfig({ ...updateBase, isEnabled: false });

    expect(configInsertOf(inserted)).toMatchObject({
      encryptedCredentials: null,
      encryptionKeyVersion: null,
      isEnabled: false,
    });
  });

  it("migrates a stale row onto the active key without asking for a new one", async () => {
    const { service, updated, decrypt, encrypt, inserted } = harness({ activeKeyVersion: 2 });
    await service.updateConfig(updateBase);

    expect(decrypt).toHaveBeenCalledWith(CONFIG_ID, CIPHERTEXT, 1);
    expect(encrypt).toHaveBeenCalledWith(CONFIG_ID, PLAINTEXT_FROM_DECRYPT);
    expect(updated[0]).toMatchObject({
      encryptedCredentials: `encrypted:${CONFIG_ID}`,
      encryptionKeyVersion: 2,
    });
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.credentialRotated);
  });

  it("leaves a row that is already on the active key alone", async () => {
    const { service, decrypt, encrypt, inserted } = harness({ activeKeyVersion: 1 });
    await service.updateConfig(updateBase);

    expect(decrypt).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.configure);
  });

  it("asks for a fresh key rather than wedging the update when migration fails", async () => {
    const { service } = harness({ activeKeyVersion: 2, decryptFails: true });
    const error = await rejection(service.updateConfig(updateBase));

    expect(error.safeResponse.code).toBe("AI_CREDENTIAL_REQUIRED");
    // The remedy, not the cause: nothing says what was wrong with the old blob.
    expect(error.safeResponse.message).not.toContain("decrypt");
  });

  it("clears the ciphertext columns when the provider is disabled", async () => {
    const { service, updated, inserted } = harness();
    await service.updateConfig({
      ...updateBase,
      provider: "disabled",
      model: null,
      isEnabled: false,
    });

    expect(updated[0]).toMatchObject({
      encryptedCredentials: null,
      encryptionKeyVersion: null,
      isEnabled: false,
    });
    expect(auditOf(inserted).action).toBe(AI_AUDIT_ACTIONS.disable);
    expect(auditOf(inserted).metadata).toMatchObject({ credentialChanged: true });
  });

  it("forces isEnabled false for a disabled provider even if the caller asked for true", async () => {
    const { service, updated } = harness();
    await service.updateConfig({ ...updateBase, provider: "disabled", isEnabled: true });

    expect(updated[0]).toMatchObject({ isEnabled: false });
  });

  it("writes audit metadata that carries no key material", async () => {
    const { service, inserted } = harness();
    await service.updateConfig({ ...updateBase, apiKey: API_KEY, requestId: "req-1" });

    const audit = auditOf(inserted);
    expect(audit).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: AI_AUDIT_ENTITY_TYPE,
      entityId: CONFIG_ID,
      requestId: "req-1",
    });
    expect(audit.metadata).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      isEnabled: true,
      dailyTokenQuota: 1_000,
      rateLimitPerMinute: 5,
      contentConsent: true,
      credentialChanged: true,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(CIPHERTEXT);
    expect(serialized).not.toContain(API_KEY.slice(0, 8));
  });

  it("returns the safe projection of what it wrote", async () => {
    const { service } = harness();
    const view = await service.updateConfig({ ...updateBase, apiKey: API_KEY });

    expect(view.hasCredentials).toBe(true);
    expectNoCredentialLeak(view);
  });
});

describe("AiService.getUsage", () => {
  it("coerces the driver's bigint strings and rolls up per feature", async () => {
    const { service, authorizeUser } = harness();
    const summary = await service.getUsage({ ...scoped, days: 30 });

    expect(authorizeUser).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.configure" }));
    expect(summary).toMatchObject({
      workspaceId: WORKSPACE_ID,
      totalRequests: 5,
      successfulRequests: 3,
      failedRequests: 1,
      rateLimitedRequests: 1,
      promptTokens: 1_200,
      completionTokens: 800,
      totalTokens: 2_000,
      costMicros: 4_500,
      tokensUsedToday: 500,
      dailyTokenQuota: 1_000,
    });
    expect(summary.features).toEqual([
      { feature: "summarize", requests: 3, totalTokens: 1_500, costMicros: 3_000 },
    ]);
    expect(Date.parse(summary.until) - Date.parse(summary.since)).toBe(30 * 86_400_000);
  });

  it("reports the default quota when the workspace has no configuration row", async () => {
    const { service } = harness({ configRows: [] });
    expect((await service.getUsage({ ...scoped, days: 7 })).dailyTokenQuota).toBe(50_000);
  });
});

describe("AiService.getStatus", () => {
  it("answers with the member-facing shape and nothing else", async () => {
    const { service, authorizeUser } = harness();
    const status = await service.getStatus(scoped);

    expect(authorizeUser).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.use" }));
    expect(status).toEqual({ enabled: true, provider: "openai", model: "gpt-4o-mini" });
    expect(Object.keys(status)).toEqual(["enabled", "provider", "model"]);
  });

  it("is disabled when the deployment kill-switch is off", async () => {
    const { service } = harness({ featureEnabled: false });
    expect((await service.getStatus(scoped)).enabled).toBe(false);
  });

  it.each([
    ["the row is switched off", { isEnabled: false }],
    ["no model is selected", { model: null }],
    ["no credential is stored", { hasCredentials: false }],
    ["consent was never given", { settings: { contentConsent: false } }],
  ] as const)("is disabled when %s", async (_label, override) => {
    const { service } = harness({ configRows: [{ ...configRow, ...override }] });
    expect((await service.getStatus(scoped)).enabled).toBe(false);
  });

  it("is disabled, not absent, when the workspace has no configuration row", async () => {
    const { service } = harness({ configRows: [] });
    expect(await service.getStatus(scoped)).toEqual({
      enabled: false,
      provider: "disabled",
      model: null,
    });
  });
});
