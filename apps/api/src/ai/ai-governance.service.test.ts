// Part 67 — unit tests for the fail-closed AI gate.
//
// WHAT THIS SUITE IS FOR. Almost every branch in `ai-governance.service.ts` is
// a refusal, and a refusal that silently becomes a permission does not break a
// feature — it quietly spends money and ships note text to a third party. So
// each infrastructure failure gets its own case: a `null` Redis, a Redis that
// throws, a quota query that throws. "It still worked" is the bug here.
//
// The database, Redis and the provider limiter are plain object stubs; there is
// no Nest testing module, because nothing under test resolves anything from the
// container.

import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { AiGovernanceRefusal, AiGovernanceService } from "./ai-governance.service";

import type { AiCredentialService } from "./ai-credential.service";
import type { AiRuntimeGrant } from "./ai-governance.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AiConfig } from "../config/ai.config";
import type { DatabaseService } from "../database/database.service";
import type { AiProviderRateLimiterService } from "../queue/ai-provider-rate-limiter.service";
import type Redis from "ioredis";

const WORKSPACE_ID = "80000000-0000-4000-8100-000000000001";
const USER_ID = "80000000-0000-4000-8000-000000000001";
const CONFIG_ID = "80000000-0000-4000-8200-000000000001";
const API_KEY = "sk-live-000000000000000000000000000";
const CIPHERTEXT = "Y2lwaGVydGV4dC1ibG9i";

const acquireInput = Object.freeze({
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  feature: "summarize",
});

type Row = Record<string, unknown>;

const configuredRow: Row = Object.freeze({
  id: CONFIG_ID,
  provider: "anthropic",
  model: "claude-3-5-sonnet-latest",
  encryptedCredentials: CIPHERTEXT,
  encryptionKeyVersion: 1,
  isEnabled: true,
  settings: { dailyTokenQuota: 1_000, rateLimitPerMinute: 5, contentConsent: true },
});

interface HarnessOptions {
  readonly featureEnabled?: boolean;
  /** `[]` is the "no configuration row" case. */
  readonly configRows?: readonly Row[];
  readonly tokensUsedToday?: number;
  readonly quotaQueryFails?: boolean;
  readonly insertFails?: boolean;
  /** `null` models a deployment with no Redis wired up at all. */
  readonly redis?: "ok" | "throws" | "garbage" | null;
  readonly windowCount?: number;
  readonly providerAllowed?: boolean;
  readonly decryptFails?: boolean;
}

interface Awaitable<T> extends Promise<T> {
  limit: (count: number) => Awaitable<T>;
}

function rows(value: readonly unknown[]): Awaitable<unknown[]> {
  const promise = Promise.resolve([...value]) as Awaitable<unknown[]>;
  promise.limit = () => promise;
  return promise;
}

function harness(options: HarnessOptions = {}) {
  const inserted: Row[] = [];
  const selects: { readonly fields: Row }[] = [];

  const db = {
    select: (fields: Row) => ({
      from: () => ({
        where: () => {
          selects.push({ fields });
          if ("tokens" in fields) {
            if (options.quotaQueryFails === true) {
              return Promise.reject(new Error("connection terminated")) as unknown as Awaitable<
                unknown[]
              >;
            }
            // `bigint` really does arrive from the driver as a string.
            return rows([{ tokens: String(options.tokensUsedToday ?? 0) }]);
          }
          return rows(options.configRows ?? [configuredRow]);
        },
      }),
    }),
    insert: () => ({
      values: (values: Row) => {
        if (options.insertFails === true) return Promise.reject(new Error("insert failed"));
        inserted.push(values);
        return Promise.resolve(undefined);
      },
    }),
  };

  const database = { db } as unknown as DatabaseService;

  const decrypt = vi.fn(() => {
    if (options.decryptFails === true) throw new Error("AI credential is unreadable");
    return API_KEY;
  });
  const credentials = { decrypt, activeKeyVersion: 1 } as unknown as AiCredentialService;

  const evaluate = vi.fn(() => {
    if (options.redis === "throws") throw new Error("redis is down");
    if (options.redis === "garbage") return Promise.resolve("not-an-array");
    return Promise.resolve([options.windowCount ?? 1, 30_000]);
  });
  const redis = options.redis === null ? null : ({ eval: evaluate } as unknown as Redis);

  const providerAcquire = vi.fn(() =>
    Promise.resolve(
      options.providerAllowed === false
        ? { allowed: false as const, reason: "rate_limited" as const, retryAfterMs: 4_321 }
        : { allowed: true as const, remaining: 3 },
    ),
  );
  const providerLimiter = {
    acquire: providerAcquire,
  } as unknown as AiProviderRateLimiterService;

  const failure = vi.fn();
  const logger = { failure } as unknown as StructuredLogger;

  const service = new AiGovernanceService(database, credentials, providerLimiter, logger, redis, {
    enabled: options.featureEnabled ?? true,
  } as AiConfig);

  return { service, inserted, selects, decrypt, evaluate, providerAcquire, failure };
}

async function refusal(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

const codeOf = (error: ApiHttpException): string => error.safeResponse.code;

describe("AiGovernanceService.acquire refuses", () => {
  it("when the deployment kill-switch is off, without touching the database", async () => {
    const { service, selects, inserted } = harness({ featureEnabled: false });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_DISABLED");
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(selects).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it.each([
    ["no configuration row exists", []],
    ["the provider is disabled", [{ ...configuredRow, provider: "disabled" }]],
    ["the feature flag on the row is off", [{ ...configuredRow, isEnabled: false }]],
    ["no model is selected", [{ ...configuredRow, model: null }]],
    ["no credential is stored", [{ ...configuredRow, encryptedCredentials: null }]],
  ] as const)("when %s", async (_label, configRows) => {
    const { service, inserted } = harness({ configRows });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_NOT_CONFIGURED");
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    // A setup problem is not usage: nothing was rationed and nothing was spent.
    expect(inserted).toEqual([]);
  });

  it("when content consent is missing, even though the row is otherwise complete", async () => {
    const { service, inserted } = harness({
      configRows: [{ ...configuredRow, settings: { contentConsent: false } }],
    });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_CONSENT_REQUIRED");
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(inserted).toEqual([]);
  });

  it("when the settings blob is unusable, because consent then reads as false", async () => {
    // A hand-edited or corrupted blob must deny, not inherit a default `true`.
    const { service } = harness({ configRows: [{ ...configuredRow, settings: "corrupted" }] });
    expect(codeOf(await refusal(service.acquire(acquireInput)))).toBe("AI_CONSENT_REQUIRED");
  });

  it("when today's usage has reached the quota exactly", async () => {
    const { service, inserted } = harness({ tokensUsedToday: 1_000 });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_QUOTA_EXCEEDED");
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      status: "rate_limited",
      errorCode: "ai_quota_exceeded",
      totalTokens: null,
      costMicros: null,
    });
  });

  it("when the quota is zero, which is a real setting meaning no AI at all", async () => {
    const { service } = harness({
      configRows: [{ ...configuredRow, settings: { dailyTokenQuota: 0, contentConsent: true } }],
      tokensUsedToday: 0,
    });
    expect(codeOf(await refusal(service.acquire(acquireInput)))).toBe("AI_QUOTA_EXCEEDED");
  });

  it("when the quota query itself throws — an unreadable budget is a spent budget", async () => {
    const { service, evaluate, inserted } = harness({ quotaQueryFails: true });
    expect(codeOf(await refusal(service.acquire(acquireInput)))).toBe("AI_QUOTA_EXCEEDED");
    // It stopped there: no window was consumed, and the database it could not
    // read was not asked for a refusal row either.
    expect(evaluate).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it.each([
    ["Redis is not configured at all", null],
    ["the Redis eval throws", "throws"],
    ["Redis answers something unparseable", "garbage"],
  ] as const)("when %s", async (_label, redis) => {
    const { service, inserted } = harness({ redis });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_RATE_LIMITED");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: "rate_limited", errorCode: "ai_rate_limited" });
  });

  it("when the workspace window counter is over its limit", async () => {
    const { service, providerAcquire } = harness({ windowCount: 6 });
    expect(codeOf(await refusal(service.acquire(acquireInput)))).toBe("AI_RATE_LIMITED");
    // The deployment allowance is only spent by requests the workspace's own
    // limit already let through.
    expect(providerAcquire).not.toHaveBeenCalled();
  });

  it("when the provider allowance is saturated, keeping the limiter's retry delay", async () => {
    const { service, providerAcquire, inserted } = harness({ providerAllowed: false });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_RATE_LIMITED");
    // The one place the database's `anthropic` becomes the queue's `claude`.
    expect(providerAcquire).toHaveBeenCalledWith("claude");
    expect(inserted).toHaveLength(1);
    // The limiter's own delay survives to the caller, which is what Part 68
    // turns into a `Retry-After` header.
    expect(error).toBeInstanceOf(AiGovernanceRefusal);
    expect((error as AiGovernanceRefusal).retryAfterMs).toBe(4_321);
    expect((error as AiGovernanceRefusal).failureCode).toBe("ai_rate_limited");
  });

  it("when the stored credential cannot be decrypted, without saying why", async () => {
    const { service } = harness({ decryptFails: true });
    const error = await refusal(service.acquire(acquireInput));

    expect(codeOf(error)).toBe("AI_NOT_CONFIGURED");
    expect(error.safeResponse.message).not.toContain("decrypt");
  });
});

describe("AiGovernanceService.acquire grants", () => {
  async function grant(options: HarnessOptions = {}): Promise<{
    readonly grant: AiRuntimeGrant;
    readonly inserted: Row[];
    readonly failure: ReturnType<typeof vi.fn>;
  }> {
    const { service, inserted, decrypt, failure } = harness(options);
    const issued = await service.acquire(acquireInput);
    expect(decrypt).toHaveBeenCalledWith(CONFIG_ID, CIPHERTEXT, 1);
    return { grant: issued, inserted, failure };
  }

  it("returns the workspace's provider, model and decrypted key", async () => {
    const { grant: issued, inserted } = await grant();

    expect(issued).toMatchObject({
      configId: CONFIG_ID,
      workspaceId: WORKSPACE_ID,
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      apiKey: API_KEY,
    });
    // Acquiring is not usage; the row is written when the outcome is known.
    expect(inserted).toEqual([]);
  });

  it("writes exactly one usage row however many times recordUsage is called", async () => {
    const { grant: issued, inserted } = await grant();

    await issued.recordUsage({ status: "success", promptTokens: 120, completionTokens: 80 });
    await issued.recordUsage({ status: "failed", errorCode: "ai_provider_error" });
    await Promise.all([
      issued.recordUsage({ status: "success", promptTokens: 1 }),
      issued.recordUsage({ status: "success", promptTokens: 2 }),
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      feature: "summarize",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      status: "success",
      errorCode: null,
    });
    // 120 prompt + 80 completion at the priced Sonnet rate, rounded up.
    expect(inserted[0]?.costMicros).toBe(1_560);
  });

  it("records a null total when neither token count was reported", async () => {
    const { grant: issued, inserted } = await grant();
    await issued.recordUsage({ status: "failed", errorCode: "network" });

    expect(inserted[0]).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costMicros: null,
      status: "failed",
      errorCode: "network",
    });
  });

  it("prices an unknown model at null rather than guessing", async () => {
    const { grant: issued, inserted } = await grant({
      configRows: [{ ...configuredRow, model: "some-unreleased-model" }],
    });
    await issued.recordUsage({ status: "success", promptTokens: 10, completionTokens: 10 });

    expect(inserted[0]).toMatchObject({ totalTokens: 20, costMicros: null });
  });

  it("swallows a usage-write failure rather than losing the answer the user has", async () => {
    const { grant: issued, failure } = await grant({ insertFails: true });

    await expect(
      issued.recordUsage({ status: "success", promptTokens: 5, completionTokens: 5 }),
    ).resolves.toBeUndefined();
    expect(failure).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, feature: "summarize", status: "success" },
      "AI usage row was not recorded",
    );
  });
});
