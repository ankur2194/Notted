// Part 67 — AI configuration, credential handling and governance against a
// live PostgreSQL.
//
// Same shape as `webhooks.integration.test.ts`: self-provisioning (`migrate` +
// `seedDatabase`), self-skipping when no reachable `DATABASE_URL` is
// configured, and every collaborator constructed BY HAND rather than through
// the Nest container — so this exercises the real SQL, the real policies and
// the real AES-256-GCM, without booting the application graph.
//
// NO PROVIDER IS EVER CONTACTED. Everything under test here happens strictly
// BEFORE a provider call: which role may configure AI, what the database ends
// up holding, and which requests the governance gate refuses. The adapters are
// covered by their own colocated unit tests against a stubbed `fetch`.
//
// WHAT THE FOUR VERIFY CLAUSES OF PART 67 MEAN HERE:
// - "disabled/missing-key states are harmless" — every fail-closed branch is
//   asserted to REFUSE, and to refuse without writing a credential.
// - "credential rotation works" — a row written under key version 1 is still
//   readable after version 2 becomes active, and migrates on the next save.
// - "tenant usage is isolated" — alpha and beta both have usage rows in the
//   SAME table in the SAME run, and each workspace's roll-up sees only its own.
// - "provider errors map to actionable UI messages" — the governance refusals
//   carry distinct stable codes, which is what the web client keys its copy on.

import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AiCredentialService } from "../src/ai/ai-credential.service";
import { AiGovernanceService, type AiRuntimeGrant } from "../src/ai/ai-governance.service";
import { AI_AUDIT_ACTIONS, AI_AUDIT_ENTITY_TYPE } from "../src/ai/ai.constants";
import { AiService } from "../src/ai/ai.service";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { AuthorizationDeniedError } from "../src/authorization/authorization.errors";
import { ApiHttpException } from "../src/common/errors/api-http.exception";
import { parseSecurityConfig } from "../src/config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import { aiProviderConfig, aiUsage, auditLogs, schema } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { TenantContextService } from "../src/tenant";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AiConfig } from "../src/config/ai.config";
import type { AiProviderRateLimiterService } from "../src/queue/ai-provider-rate-limiter.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";
import type Redis from "ioredis";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const ALPHA = SEED_IDS.workspaces.alpha;
const BETA = SEED_IDS.workspaces.beta;
const OPENAI_KEY = "sk-integration-openai-key-0123456789";
const ANTHROPIC_KEY = "sk-ant-integration-key-0123456789ab";

/**
 * Two key versions, active first — that ordering is what `security.config.ts`
 * reads as "the key new ciphertext is written under". Version 1 is the parser's
 * own development key, so a row encrypted before the rotation is byte-identical
 * to one a pre-rotation deployment would have written.
 */
const KEY_V1 = "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const KEY_V2 = `2:${randomBytes(32).toString("base64")}`;
const SECURITY_V1 = parseSecurityConfig({ NODE_ENV: "test", DATA_ENCRYPTION_KEYS: KEY_V1 });
const SECURITY_V2 = parseSecurityConfig({
  NODE_ENV: "test",
  DATA_ENCRYPTION_KEYS: `${KEY_V2},${KEY_V1}`,
});

/** `ai.configure` is HIGH_RISK, so a stale principal is denied before any SQL. */
function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `ai:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface HarnessOptions {
  /** The deployment kill-switch. Default on, so refusals prove a real branch. */
  readonly featureEnabled?: boolean;
  /** Second key version active — the rotation case. */
  readonly rotated?: boolean;
  /** `null` models a Redis outage, which must DENY rather than fall open. */
  readonly redisAvailable?: boolean;
  /** The deployment-wide per-provider allowance verdict. */
  readonly providerAllowed?: boolean;
  /** How many requests the fake window has already seen in this minute. */
  readonly windowCount?: number;
}

function build(db: NodePgDatabase<typeof schema>, options: HarnessOptions = {}) {
  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: <T>(
      work: (scope: DatabaseTransaction) => Promise<T>,
      config?: PgTransactionConfig,
    ) => db.transaction(work, config),
  } as unknown as DatabaseService;
  const authorization = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const credentials = new AiCredentialService(options.rotated === true ? SECURITY_V2 : SECURITY_V1);
  const aiConfig = { enabled: options.featureEnabled ?? true } as AiConfig;
  const logs: string[] = [];
  const logger = {
    info: () => undefined,
    warning: () => undefined,
    failure: (_metadata: unknown, message: string) => logs.push(message),
    warn: () => undefined,
  } as unknown as StructuredLogger;

  // The fake window returns `[count, ttl]` exactly as the Lua script does, so
  // the service's own parsing and comparison are what is under test — not a
  // stubbed verdict. `redisAvailable: false` hands it `null`, the outage case.
  const redis: Redis | null =
    options.redisAvailable === false
      ? null
      : ({
          eval: () => Promise.resolve([options.windowCount ?? 1, 60_000]),
        } as unknown as Redis);

  const providerLimiter = {
    acquire: () =>
      Promise.resolve(
        options.providerAllowed === false
          ? { allowed: false, reason: "rate_limited", retryAfterMs: 1_500 }
          : { allowed: true, remaining: 5 },
      ),
  } as unknown as AiProviderRateLimiterService;

  return {
    tenant,
    credentials,
    logs,
    service: new AiService(database, authorization, tenant, credentials, aiConfig),
    governance: new AiGovernanceService(
      database,
      credentials,
      providerLimiter,
      logger,
      redis,
      aiConfig,
    ),
  };
}

const configure = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
  principal: principal(workspaceId === BETA ? SEED_IDS.users.betaOwner : SEED_IDS.users.alphaOwner),
  workspaceId,
  requestId: null,
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isEnabled: true,
  dailyTokenQuota: 50_000,
  rateLimitPerMinute: 10,
  contentConsent: true,
  ...overrides,
});

/** Asserts a rejection and hands back the `ApiHttpException` for inspection. */
async function refusal(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe.skipIf(!HAS_DATABASE_URL)("Part 67 AI configuration and governance", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let available = false;

  beforeAll(async () => {
    if (!HAS_DATABASE_URL) return;
    available = await reachable(DATABASE_URL);
    if (!available) return;
    pool = new Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await seedDatabase(db);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    if (!available) return;
    // Both tables, both workspaces: an AI configuration left behind by one case
    // would silently become the "already configured" precondition of the next.
    await db.delete(aiUsage).where(inArray(aiUsage.workspaceId, [ALPHA, BETA]));
    await db.delete(aiProviderConfig).where(inArray(aiProviderConfig.workspaceId, [ALPHA, BETA]));
  });

  it("stores the credential encrypted and never returns it", async () => {
    if (!available) return;
    const { service, credentials } = build(db);
    const view = await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

    expect(view).toMatchObject({
      workspaceId: ALPHA,
      provider: "openai",
      model: "gpt-4o-mini",
      isEnabled: true,
      hasCredentials: true,
      contentConsent: true,
    });
    // The response carries no key, under any name, and no ciphertext either.
    expect(JSON.stringify(view)).not.toContain(OPENAI_KEY);
    for (const key of Object.keys(view)) {
      if (key === "hasCredentials") continue;
      expect(key).not.toMatch(/credential|cipher|secret|apikey|encryption/iu);
    }

    const [row] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));
    // At rest: not the plaintext, and bound to this row's id via the AAD.
    expect(row?.encryptedCredentials).not.toBe(OPENAI_KEY);
    expect(row?.encryptedCredentials).not.toContain(OPENAI_KEY);
    expect(row?.encryptionKeyVersion).toBe(1);
    expect(
      credentials.decrypt(row!.id, row!.encryptedCredentials!, row!.encryptionKeyVersion!),
    ).toBe(OPENAI_KEY);
    // A blob lifted into a different row is unreadable, not silently reused.
    expect(() => credentials.decrypt(randomUUID(), row!.encryptedCredentials!, 1)).toThrow(
      /unreadable/iu,
    );

    // GET agrees with what PUT answered, and still says nothing about the key.
    const read = await service.getConfig({
      principal: principal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
    });
    expect(read.hasCredentials).toBe(true);
    expect(JSON.stringify(read)).not.toContain(OPENAI_KEY);
  });

  it("records the write without any key material", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY, requestId: "req-ai-1" }));

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, AI_AUDIT_ENTITY_TYPE));
    expect(entry?.action).toBe(AI_AUDIT_ACTIONS.configure);
    expect(entry?.workspaceId).toBe(ALPHA);
    const serialized = JSON.stringify(entry?.metadata);
    expect(serialized).not.toContain(OPENAI_KEY);
    // Not even a prefix: an 8-character head of a provider key is still a leak.
    expect(serialized).not.toContain(OPENAI_KEY.slice(0, 8));
    expect(serialized).toContain("credentialChanged");
  });

  it("keeps the stored key when none is supplied", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));
    const [before] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));

    await service.updateConfig(configure(ALPHA, { dailyTokenQuota: 1_234 }));
    const [after] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));

    expect(after?.encryptedCredentials).toBe(before?.encryptedCredentials);
    expect(after?.settings).toMatchObject({ dailyTokenQuota: 1_234 });
  });

  it("refuses a provider switch that carries no new key", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

    const error = await refusal(
      service.updateConfig(
        configure(ALPHA, { provider: "anthropic", model: "claude-3-5-haiku-latest" }),
      ),
    );
    expect(error.safeResponse.code).toBe("AI_CREDENTIAL_REQUIRED");

    // The OpenAI key was NOT carried over to Anthropic.
    const [row] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));
    expect(row?.provider).toBe("openai");
  });

  it("clears the credential when AI is disabled", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));
    const view = await service.updateConfig(
      configure(ALPHA, { provider: "disabled", model: null, isEnabled: false }),
    );

    expect(view.hasCredentials).toBe(false);
    const [row] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));
    // A dangling ciphertext for a provider nobody selected is a secret with no
    // owner and no expiry, so disabling must actually remove it.
    expect(row?.encryptedCredentials).toBeNull();
    expect(row?.encryptionKeyVersion).toBeNull();
    expect(row?.isEnabled).toBe(false);
  });

  it("keeps a pre-rotation row readable and migrates it on the next save", async () => {
    if (!available) return;
    // Written while version 1 was the only key.
    const before = build(db);
    await before.service.updateConfig(
      configure(ALPHA, {
        apiKey: ANTHROPIC_KEY,
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
      }),
    );
    const [old] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));
    expect(old?.encryptionKeyVersion).toBe(1);

    // Version 2 becomes active. The old row must still be READABLE, because
    // decryption uses the version the ROW names, not the active one.
    const after = build(db, { rotated: true });
    expect(after.credentials.decrypt(old!.id, old!.encryptedCredentials!, 1)).toBe(ANTHROPIC_KEY);

    // LAZY MIGRATION: no batch job, no re-paste. The next configuration save
    // moves the row onto the active key, with no `apiKey` in the request.
    await after.service.updateConfig(
      configure(ALPHA, { provider: "anthropic", model: "claude-3-5-haiku-latest" }),
    );
    const [migrated] = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));

    expect(migrated?.encryptionKeyVersion).toBe(2);
    expect(migrated?.encryptedCredentials).not.toBe(old?.encryptedCredentials);
    expect(after.credentials.decrypt(migrated!.id, migrated!.encryptedCredentials!, 2)).toBe(
      ANTHROPIC_KEY,
    );
  });

  it("denies ai.configure to an editor", async () => {
    if (!available) return;
    const { service } = build(db);
    await expect(
      service.updateConfig(
        configure(ALPHA, {
          principal: principal(SEED_IDS.users.alphaEditor),
          apiKey: OPENAI_KEY,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    // The refusal happened before any write, not after one.
    const rows = await db
      .select()
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, ALPHA));
    expect(rows).toEqual([]);
  });

  it("denies ai.use to a viewer but allows it for an editor", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

    await expect(
      service.getStatus({
        principal: principal(SEED_IDS.users.alphaViewer),
        workspaceId: ALPHA,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    // An editor writes notes, so an editor may spend the workspace's AI budget.
    const status = await service.getStatus({
      principal: principal(SEED_IDS.users.alphaEditor),
      workspaceId: ALPHA,
      requestId: null,
    });
    expect(status).toEqual({ enabled: true, provider: "openai", model: "gpt-4o-mini" });
    // Deliberately narrower than the admin view: no quota, no consent flag, and
    // nothing about the stored credential.
    expect(Object.keys(status)).toEqual(["enabled", "provider", "model"]);
  });

  it("never lets one workspace read another's usage", async () => {
    if (!available) return;
    const { service } = build(db);
    await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));
    await service.updateConfig(
      configure(BETA, {
        apiKey: ANTHROPIC_KEY,
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
      }),
    );

    // Both tenants' rows live in the SAME table in the SAME run: an unscoped
    // aggregate would silently sum them, and only a two-tenant fixture catches
    // that. The counts differ so neither can be mistaken for the other.
    await db.insert(aiUsage).values([
      {
        workspaceId: ALPHA,
        userId: SEED_IDS.users.alphaOwner,
        feature: "summarize",
        provider: "openai",
        model: "gpt-4o-mini",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costMicros: 45,
        status: "success",
      },
      {
        workspaceId: BETA,
        userId: SEED_IDS.users.betaOwner,
        feature: "summarize",
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        promptTokens: 900,
        completionTokens: 900,
        totalTokens: 1_800,
        costMicros: 4_320,
        status: "success",
      },
    ]);

    const alpha = await service.getUsage({
      principal: principal(SEED_IDS.users.alphaOwner),
      workspaceId: ALPHA,
      requestId: null,
      days: 30,
    });
    const beta = await service.getUsage({
      principal: principal(SEED_IDS.users.betaOwner),
      workspaceId: BETA,
      requestId: null,
      days: 30,
    });

    expect(alpha.totalRequests).toBe(1);
    expect(alpha.totalTokens).toBe(150);
    expect(alpha.tokensUsedToday).toBe(150);
    expect(beta.totalRequests).toBe(1);
    expect(beta.totalTokens).toBe(1_800);
    expect(beta.tokensUsedToday).toBe(1_800);
    expect(alpha.features).toEqual([
      { feature: "summarize", requests: 1, totalTokens: 150, costMicros: 45 },
    ]);

    // And a member of one workspace cannot ask for the other's numbers at all.
    await expect(
      service.getUsage({
        principal: principal(SEED_IDS.users.alphaOwner),
        workspaceId: BETA,
        requestId: null,
        days: 30,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  describe("the governance gate", () => {
    const acquire = (governance: ReturnType<typeof build>["governance"]) =>
      governance.acquire({
        workspaceId: ALPHA,
        userId: SEED_IDS.users.alphaOwner,
        feature: "summarize",
      });

    it("refuses when the deployment kill-switch is off", async () => {
      if (!available) return;
      const configured = build(db);
      await configured.service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

      const { governance } = build(db, { featureEnabled: false });
      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_DISABLED");
      // A refusal this early is not a usage event: nothing was metered.
      expect(await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, ALPHA))).toEqual([]);
    });

    it("refuses a workspace that was never configured", async () => {
      if (!available) return;
      const { governance } = build(db);
      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_NOT_CONFIGURED");
    });

    it("refuses when consent was never given", async () => {
      if (!available) return;
      const { service, governance } = build(db);
      await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));
      // Consent revoked directly in the column, which is the case the write-time
      // schema refinement cannot cover: a hand-edited settings blob.
      await db
        .update(aiProviderConfig)
        .set({
          settings: { dailyTokenQuota: 50_000, rateLimitPerMinute: 10, contentConsent: false },
        })
        .where(eq(aiProviderConfig.workspaceId, ALPHA));

      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_CONSENT_REQUIRED");
    });

    it("refuses once the daily token quota is spent", async () => {
      if (!available) return;
      const { service, governance } = build(db);
      await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY, dailyTokenQuota: 100 }));
      await db.insert(aiUsage).values({
        workspaceId: ALPHA,
        userId: SEED_IDS.users.alphaOwner,
        feature: "summarize",
        provider: "openai",
        model: "gpt-4o-mini",
        totalTokens: 100,
        status: "success",
      });

      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_QUOTA_EXCEEDED");
      // The refusal itself is recorded, so an admin sees a workspace hitting its
      // ceiling rather than AI mysteriously "not working".
      const rows = await db.select().from(aiUsage).where(eq(aiUsage.status, "rate_limited"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.errorCode).toBe("ai_quota_exceeded");
      expect(rows[0]?.workspaceId).toBe(ALPHA);
    });

    it("denies rather than falls open when Redis is gone", async () => {
      if (!available) return;
      const configured = build(db);
      await configured.service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

      const { governance } = build(db, { redisAvailable: false });
      const error = await refusal(acquire(governance));
      expect(error.safeResponse.code).toBe("AI_RATE_LIMITED");
    });

    it("refuses past the workspace's own burst limit", async () => {
      if (!available) return;
      const { service } = build(db);
      await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY, rateLimitPerMinute: 2 }));

      const { governance } = build(db, { windowCount: 3 });
      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_RATE_LIMITED");
    });

    it("refuses when the deployment's provider allowance is saturated", async () => {
      if (!available) return;
      const { service } = build(db);
      await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

      const { governance } = build(db, { providerAllowed: false });
      expect((await refusal(acquire(governance))).safeResponse.code).toBe("AI_RATE_LIMITED");
    });

    it("grants the decrypted key and charges the request exactly once", async () => {
      if (!available) return;
      const { service, governance } = build(db);
      await service.updateConfig(configure(ALPHA, { apiKey: OPENAI_KEY }));

      const grant: AiRuntimeGrant = await acquire(governance);
      expect(grant.provider).toBe("openai");
      expect(grant.model).toBe("gpt-4o-mini");
      // The whole point of the gate: the caller gets a usable key without any
      // code path having written or logged it.
      expect(grant.apiKey).toBe(OPENAI_KEY);

      // Called twice, exactly as a `finally` racing an explicit call would.
      await grant.recordUsage({ status: "success", promptTokens: 40, completionTokens: 60 });
      await grant.recordUsage({ status: "failed", errorCode: "should_not_be_written" });

      const rows = await db.select().from(aiUsage).where(eq(aiUsage.workspaceId, ALPHA));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        feature: "summarize",
        provider: "openai",
        model: "gpt-4o-mini",
        promptTokens: 40,
        completionTokens: 60,
        totalTokens: 100,
        status: "success",
      });
      // Priced model, so a cost is claimed: 40 prompt + 60 completion at
      // gpt-4o-mini's rates, rounded up.
      expect(rows[0]?.costMicros).toBe(42);
      // NO CONTENT COLUMN EXISTS. Prompts and output are never retained, so
      // there is nothing on the row that could hold them (ADR 0007).
      expect(Object.keys(rows[0] ?? {})).not.toContain("prompt");
      expect(JSON.stringify(rows[0])).not.toContain(OPENAI_KEY);
    });
  });
});
