// Part 67 — the gate every AI request passes through.
//
// FAIL CLOSED, EVERY BRANCH. There is no permissive default anywhere in this
// file: a missing config row, an unparseable settings blob, a Redis that is not
// there, a quota query that throws — each one REFUSES. That is the opposite of
// the usual availability instinct, and it is deliberate. Every path guarded
// here spends a customer's money at a third party and ships their note text off
// our servers; "let it through, we'll fix the counter later" is not a recovery,
// it is an unbounded bill and a data-handling promise broken.
//
// WHY NOT `whereWorkspace`. `acquire` is called with the workspace id of an
// ALREADY-AUTHORIZED operation (`ai.use`), and its callers include a streaming
// SSE handler and, later, queue workers — contexts where the request-scoped
// tenant `AsyncLocalStorage` may not be the frame the query runs in. Every
// statement here therefore pins `workspace_id` to that authorized id
// EXPLICITLY, which is the same guarantee by a route that cannot be lost when
// the call moves off the request thread.
//
// NOTHING HERE LOGS CONTENT. The credential is returned on the grant and never
// written anywhere; prompts and completions never reach this file at all. The
// one log statement records a workspace id, a feature name and a status.

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { AI_CONFIG, type AiConfig } from "../config/ai.config";
import { DatabaseService } from "../database/database.service";
import { aiProviderConfig, aiUsage } from "../database/schema";
import { REDIS_CLIENT } from "../infrastructure/redis/redis.tokens";
import { AiProviderRateLimiterService } from "../queue/ai-provider-rate-limiter.service";

import { AiCredentialService } from "./ai-credential.service";
import {
  AI_LIMITER_PROVIDER,
  AI_WORKSPACE_RATE_LIMIT_KEY_PREFIX,
  AI_WORKSPACE_RATE_LIMIT_WINDOW_MS,
  estimateCostMicros,
  parseAiSettings,
  startOfUtcDay,
} from "./ai.constants";

import type {
  AiFailureCode,
  AiProviderName,
  AiUsageStatus,
  ApiErrorCode,
} from "@notted/shared-types";
import type Redis from "ioredis";

/** The five refusals this gate can raise. `ai_provider_error` is Part 68's. */
type GovernanceFailureCode = Exclude<AiFailureCode, "ai_provider_error">;

/**
 * The one place the two spellings of a refusal are tied together, so they
 * cannot drift: the HTTP envelope carries the UPPER_SNAKE code and
 * `ai_usage.error_code` stores the lowercase one, and both come from this map's
 * single key.
 */
const GOVERNANCE_ENVELOPE: Readonly<Record<GovernanceFailureCode, ApiErrorCode>> = Object.freeze({
  ai_disabled: "AI_DISABLED",
  ai_not_configured: "AI_NOT_CONFIGURED",
  ai_consent_required: "AI_CONSENT_REQUIRED",
  ai_quota_exceeded: "AI_QUOTA_EXCEEDED",
  ai_rate_limited: "AI_RATE_LIMITED",
});

/**
 * Every governance refusal, carrying the two things the public envelope cannot.
 *
 * `ApiError.details` is typed as a list of validation issues, so a retry delay
 * has nowhere to go there and widening it would cost every client a type
 * change for one number. Part 68 reads `retryAfterMs` off this class to set a
 * `Retry-After` header, and `failureCode` is the lowercase form already written
 * to the usage row.
 */
export class AiGovernanceRefusal extends ApiHttpException {
  readonly failureCode: GovernanceFailureCode;
  readonly retryAfterMs: number | null;

  constructor(
    failureCode: GovernanceFailureCode,
    status: HttpStatus,
    message: string,
    retryAfterMs: number | null = null,
  ) {
    super(status, { code: GOVERNANCE_ENVELOPE[failureCode], message });
    this.name = "AiGovernanceRefusal";
    this.failureCode = failureCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What a caller reports back once the provider call has finished, or failed. */
export interface AiUsageOutcome {
  readonly status: AiUsageStatus;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly errorCode?: string | null;
}

export interface AiRuntimeGrant {
  readonly configId: string;
  readonly workspaceId: string;
  readonly provider: Exclude<AiProviderName, "disabled">;
  readonly model: string;
  /** Decrypted for this request only. Never logged, never returned by an API. */
  readonly apiKey: string;
  /** Idempotent BY CONSTRUCTION: the first call writes the one `ai_usage` row, later calls are no-ops. */
  recordUsage(outcome: AiUsageOutcome): Promise<void>;
}

export interface AiAcquireInput {
  readonly workspaceId: string;
  /** Null for system-triggered work; the column is nullable for exactly that. */
  readonly userId: string | null;
  readonly feature: string;
}

/**
 * Fixed window, incremented and expired in ONE round trip. Copied from
 * `ai-provider-rate-limiter.service.ts` rather than shared, because that
 * service's limits come from deployment configuration while these come from a
 * tenant's own settings row — one script, two policies, no coupling.
 */
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

interface WindowVerdict {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/** `bigint` aggregates arrive from the driver as strings; anything odd is 0. */
function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class AiGovernanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: AiCredentialService,
    private readonly providerLimiter: AiProviderRateLimiterService,
    private readonly logger: StructuredLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async acquire(input: AiAcquireInput): Promise<AiRuntimeGrant> {
    // 1. The deployment-wide kill-switch. It is checked first because it is the
    // one refusal an operator can rely on being absolute: no workspace
    // configuration can re-enable AI once `FEATURE_AI_ENABLED` is off.
    if (!this.aiConfig.enabled) {
      throw new AiGovernanceRefusal(
        "ai_disabled",
        HttpStatus.FORBIDDEN,
        "AI features are turned off for this deployment.",
      );
    }

    // 2. The workspace's own configuration. A missing row, a disabled provider,
    // a switched-off flag, a missing model and a missing credential are ONE
    // refusal on purpose: they are all "an admin has not finished setting this
    // up", and splitting them would tell a caller which half of the setup is
    // missing without helping them fix it.
    const row = await this.loadConfig(input.workspaceId);
    if (
      row === undefined ||
      row.provider === "disabled" ||
      !row.isEnabled ||
      row.model === null ||
      row.encryptedCredentials === null ||
      row.encryptionKeyVersion === null
    ) {
      throw this.notConfigured();
    }
    // Captured immediately, while the narrowing above is still in view: the
    // credential is read again several awaits later, and a local const is
    // clearer than trusting flow analysis to survive that distance.
    const configId = row.id;
    const provider = row.provider;
    const model = row.model;
    const ciphertext = row.encryptedCredentials;
    const keyVersion = row.encryptionKeyVersion;
    const settings = parseAiSettings(row.settings);

    // 3. Consent, checked again here even though `aiConfigUpdateSchema` refuses
    // to enable AI without it. This is the AUTHORITATIVE check: the write-time
    // one guards a form, while this one guards the actual moment note content
    // would leave our servers, and it is the only one that still holds if the
    // settings blob is edited by hand during an incident.
    if (!settings.contentConsent) {
      throw new AiGovernanceRefusal(
        "ai_consent_required",
        HttpStatus.FORBIDDEN,
        "An administrator must accept the AI data-handling notice before AI features can be used.",
      );
    }

    // 4. The daily token budget. A quota of 0 is a real setting meaning "no AI
    // at all", which is why the comparison is `>=` rather than `>`.
    let usedToday: number;
    try {
      usedToday = await this.tokensUsedToday(input.workspaceId);
    } catch {
      // FAIL CLOSED. An unreadable quota is indistinguishable from an exhausted
      // one from the caller's side, and the alternative — serving requests we
      // cannot meter — is how a runaway bill happens. No refusal row is written
      // here: the database is precisely the thing that just failed.
      throw new AiGovernanceRefusal(
        "ai_quota_exceeded",
        HttpStatus.TOO_MANY_REQUESTS,
        "The AI usage quota could not be verified. Try again shortly.",
      );
    }
    // ponytail: check-then-act — N concurrent requests at the boundary can all
    // pass; the per-workspace burst window below bounds the overshoot. Upgrade
    // to a reserve-then-settle row if exact quota enforcement is ever required.
    if (usedToday >= settings.dailyTokenQuota) {
      await this.recordRefusal(input, provider, model, "ai_quota_exceeded");
      throw new AiGovernanceRefusal(
        "ai_quota_exceeded",
        HttpStatus.TOO_MANY_REQUESTS,
        "This workspace has used its daily AI token quota.",
      );
    }

    // 5. The workspace's own burst limit, so one workspace cannot spend the
    // whole deployment's provider allowance in a second.
    const burst = await this.withinWorkspaceWindow(input.workspaceId, settings.rateLimitPerMinute);
    if (!burst.allowed) {
      await this.recordRefusal(input, provider, model, "ai_rate_limited");
      throw new AiGovernanceRefusal(
        "ai_rate_limited",
        HttpStatus.TOO_MANY_REQUESTS,
        "Too many AI requests in this workspace. Try again shortly.",
        burst.retryAfterMs,
      );
    }

    // 6. The deployment-wide per-provider allowance. THE ONE CALL SITE that
    // translates the database's `anthropic` into the queue's `claude`.
    const providerVerdict = await this.providerLimiter.acquire(AI_LIMITER_PROVIDER[provider]);
    if (!providerVerdict.allowed) {
      await this.recordRefusal(input, provider, model, "ai_rate_limited");
      throw new AiGovernanceRefusal(
        "ai_rate_limited",
        HttpStatus.TOO_MANY_REQUESTS,
        "The AI provider allowance for this deployment is saturated. Try again shortly.",
        providerVerdict.retryAfterMs,
      );
    }

    // 7. The credential, decrypted last so a request refused above never
    // materialises a plaintext key at all.
    let apiKey: string;
    try {
      apiKey = this.credentials.decrypt(configId, ciphertext, keyVersion);
    } catch {
      // An unreadable credential is an operator problem — a rotated-away key
      // version, or a row restored from a backup taken under a different key —
      // and the caller can do nothing with the detail, so it collapses into the
      // same "not configured" answer an empty row gives.
      throw this.notConfigured();
    }

    // `recorded` is flipped BEFORE the await, so even two overlapping calls
    // cannot both reach the insert. That is what makes "charge exactly once,
    // even when the caller's `finally` also fires" true without a lock.
    let recorded = false;
    const recordUsage = async (outcome: AiUsageOutcome): Promise<void> => {
      if (recorded) return;
      recorded = true;
      await this.writeUsage(input, provider, model, outcome);
    };

    return Object.freeze({
      configId,
      workspaceId: input.workspaceId,
      provider,
      model,
      apiKey,
      recordUsage,
    });
  }

  private loadConfig(workspaceId: string): Promise<
    | {
        readonly id: string;
        readonly provider: AiProviderName;
        readonly model: string | null;
        readonly encryptedCredentials: string | null;
        readonly encryptionKeyVersion: number | null;
        readonly isEnabled: boolean;
        readonly settings: unknown;
      }
    | undefined
  > {
    return this.database.db
      .select({
        id: aiProviderConfig.id,
        provider: aiProviderConfig.provider,
        model: aiProviderConfig.model,
        encryptedCredentials: aiProviderConfig.encryptedCredentials,
        encryptionKeyVersion: aiProviderConfig.encryptionKeyVersion,
        isEnabled: aiProviderConfig.isEnabled,
        settings: aiProviderConfig.settings,
      })
      .from(aiProviderConfig)
      .where(eq(aiProviderConfig.workspaceId, workspaceId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  private async tokensUsedToday(workspaceId: string): Promise<number> {
    const [totals] = await this.database.db
      .select({
        tokens: sql<string>`cast(coalesce(sum(${aiUsage.totalTokens}), 0) as bigint)`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.workspaceId, workspaceId),
          gte(aiUsage.createdAt, startOfUtcDay(new Date())),
        ),
      );
    return numeric(totals?.tokens);
  }

  /**
   * A `null` Redis client, an eval that throws, and a reply this code cannot
   * parse all DENY. Redis is ephemeral infrastructure, so the tempting reading
   * is "no limiter, no limit" — but the thing being rationed is a metered
   * third-party API, and an outage is exactly when a retry storm would arrive.
   */
  private async withinWorkspaceWindow(workspaceId: string, limit: number): Promise<WindowVerdict> {
    if (this.redis === null) {
      return { allowed: false, retryAfterMs: AI_WORKSPACE_RATE_LIMIT_WINDOW_MS };
    }
    try {
      const raw: unknown = await this.redis.eval(
        WINDOW_SCRIPT,
        1,
        `${AI_WORKSPACE_RATE_LIMIT_KEY_PREFIX}${workspaceId}`,
        String(AI_WORKSPACE_RATE_LIMIT_WINDOW_MS),
      );
      if (!Array.isArray(raw) || raw.length !== 2) {
        return { allowed: false, retryAfterMs: AI_WORKSPACE_RATE_LIMIT_WINDOW_MS };
      }
      const count = Number(raw[0]);
      const ttl = Number(raw[1]);
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl)) {
        return { allowed: false, retryAfterMs: AI_WORKSPACE_RATE_LIMIT_WINDOW_MS };
      }
      if (count <= limit) return { allowed: true, retryAfterMs: 0 };
      return {
        allowed: false,
        retryAfterMs: Math.max(1, Math.min(AI_WORKSPACE_RATE_LIMIT_WINDOW_MS, Math.ceil(ttl))),
      };
    } catch {
      return { allowed: false, retryAfterMs: AI_WORKSPACE_RATE_LIMIT_WINDOW_MS };
    }
  }

  private recordRefusal(
    input: AiAcquireInput,
    provider: AiProviderName,
    model: string,
    errorCode: GovernanceFailureCode,
  ): Promise<void> {
    // A refusal is a real usage event: it is how an admin sees that their
    // workspace is hitting its ceiling rather than that AI "stopped working".
    return this.writeUsage(input, provider, model, { status: "rate_limited", errorCode });
  }

  /**
   * NEVER THROWS OUTWARD. A metering row that fails to write is a lost data
   * point; an exception here would instead fail a request whose answer the user
   * has already been given, or mask the provider error that actually mattered.
   */
  private async writeUsage(
    input: AiAcquireInput,
    provider: AiProviderName,
    model: string,
    outcome: AiUsageOutcome,
  ): Promise<void> {
    const promptTokens = outcome.promptTokens ?? null;
    const completionTokens = outcome.completionTokens ?? null;
    // Null only when BOTH are null: "we were never told" is a different fact
    // from "it cost zero tokens", and the column is nullable to say so.
    const totalTokens =
      promptTokens === null && completionTokens === null
        ? null
        : (promptTokens ?? 0) + (completionTokens ?? 0);
    try {
      await this.database.db.insert(aiUsage).values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        feature: input.feature,
        provider,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        // No tokens measured means no cost claimed, even for a priced model:
        // a refused request never reached the provider.
        costMicros:
          totalTokens === null ? null : estimateCostMicros(model, promptTokens, completionTokens),
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
      });
    } catch {
      this.logger.failure(
        { workspaceId: input.workspaceId, feature: input.feature, status: outcome.status },
        "AI usage row was not recorded",
      );
    }
  }

  private notConfigured(): AiGovernanceRefusal {
    return new AiGovernanceRefusal(
      "ai_not_configured",
      HttpStatus.CONFLICT,
      "AI is not configured for this workspace.",
    );
  }
}
