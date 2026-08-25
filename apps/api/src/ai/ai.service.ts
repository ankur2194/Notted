// Part 67 — AI provider configuration and usage reporting: the application
// service.
//
// TENANT SCOPE. `ai_provider_config` and `ai_usage` are workspace-owned, so
// every statement here carries `whereWorkspace(..., this.tenantContext)` and
// runs inside `AuthorizationEntryService.run`, which is what establishes that
// context. A foreign workspace id never reaches SQL at all: authorization
// refuses first (ADR 0009).
//
// THE CREDENTIAL IS NEVER PROJECTED. The read selection is built BY
// CONSTRUCTION — an explicit `select({...})` with no ciphertext key, and a
// `hasCredentials` boolean computed in SQL — rather than by deleting a field
// from a row after the fact, which is one careless spread away from leaking.
// `updateConfig` is the only method that reads the ciphertext column, and the
// only thing it ever does with the plaintext is hand it straight back to
// `AiCredentialService.encrypt` during a key migration.
//
// SETTINGS ARE A REPLACEMENT, NOT A PATCH. `aiConfigUpdateSchema` demands the
// whole desired configuration, so a settings form that submits every field
// cannot half-apply, and this service never merges an old settings blob into a
// new one.

import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { AI_CONFIG, type AiConfig } from "../config/ai.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { aiProviderConfig, aiUsage } from "../database/schema";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { AiCredentialService } from "./ai-credential.service";
import {
  AI_AUDIT_ACTIONS,
  AI_AUDIT_ENTITY_TYPE,
  parseAiSettings,
  startOfUtcDay,
  type AiAuditAction,
} from "./ai.constants";

import type {
  AiConfigView,
  AiProviderName,
  AiStatus,
  AiUsageFeatureSummary,
  AiUsageSummary,
  AuthenticatedPrincipal,
} from "@notted/shared-types";

/**
 * How many features the roll-up names. The shared schema caps the array at 50;
 * this is lower because the list is a "where is the budget going" summary, not
 * an inventory, and an unbounded GROUP BY over a `varchar` column an operator
 * can widen at any time deserves its own ceiling.
 */
const USAGE_FEATURE_LIMIT = 20;

const MILLISECONDS_PER_DAY = 86_400_000;

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

/** The safe projection: no ciphertext key exists on it to be leaked. */
interface AiConfigRow {
  readonly workspaceId: string;
  readonly provider: AiProviderName;
  readonly model: string | null;
  readonly isEnabled: boolean;
  readonly hasCredentials: boolean;
  readonly settings: unknown;
  readonly updatedById: string | null;
  readonly updatedAt: Date;
}

export interface UpdateAiConfigServiceInput extends ScopedInput {
  readonly provider: AiProviderName;
  readonly model: string | null;
  /** Absent means "leave the stored credential alone" — see `updateConfig`. */
  readonly apiKey?: string;
  readonly isEnabled: boolean;
  readonly dailyTokenQuota: number;
  readonly rateLimitPerMinute: number;
  readonly contentConsent: boolean;
}

export interface AiUsageServiceInput extends ScopedInput {
  readonly days: number;
}

/** `bigint` aggregates arrive from the driver as strings; anything odd is 0. */
function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class AiService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly credentials: AiCredentialService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async getConfig(input: ScopedInput): Promise<AiConfigView> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "ai.configure",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.readConfig();
      // A workspace that has never been configured has no row, and inventing
      // one on read would mean a GET that writes. The synthesized view says
      // exactly what the absent row would have said.
      return row === undefined ? this.defaultView(input.workspaceId) : this.toView(row);
    });
  }

  async updateConfig(input: UpdateAiConfigServiceInput): Promise<AiConfigView> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "ai.configure",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(async (tx) => {
        const current = await this.readCredentialState(tx);
        // MINTED BEFORE THE INSERT, deliberately: the id is an input to the
        // credential's encryption AAD, so it cannot be read back from the
        // column's `DEFAULT`. An existing row keeps its own id, because the
        // ciphertext already stored is bound to it.
        const configId = current?.id ?? randomUUID();
        const credential = this.resolveCredential(input, configId, current);
        const isEnabled = input.provider === "disabled" ? false : input.isEnabled;
        const now = new Date();

        const values = {
          provider: input.provider,
          model: input.model,
          encryptedCredentials: credential.encryptedCredentials,
          encryptionKeyVersion: credential.encryptionKeyVersion,
          isEnabled,
          settings: {
            dailyTokenQuota: input.dailyTokenQuota,
            rateLimitPerMinute: input.rateLimitPerMinute,
            contentConsent: input.contentConsent,
          },
          updatedById: input.principal.userId,
          updatedAt: now,
        };

        // Two explicit branches rather than an upsert: `ON CONFLICT DO UPDATE`
        // would keep the existing row's id while the ciphertext above was
        // encrypted under the freshly minted one, and the AAD would no longer
        // match. Two admins saving at the same instant race on the unique index
        // and one gets a constraint error — acceptable on an admin-only action.
        const [written] =
          current === undefined
            ? await tx
                .insert(aiProviderConfig)
                .values(
                  assertWorkspaceInsertValues(
                    {
                      id: configId,
                      workspaceId: activeWorkspaceId(this.tenantContext),
                      ...values,
                    },
                    this.tenantContext,
                    "ai.configure",
                  ),
                )
                .returning(this.configSelection())
            : await tx
                .update(aiProviderConfig)
                .set(values)
                .where(
                  and(
                    eq(aiProviderConfig.id, configId),
                    whereWorkspace(aiProviderConfig, this.tenantContext),
                  ),
                )
                .returning(this.configSelection());
        if (written === undefined) throw new Error("AI configuration was not written");

        // AUDIT METADATA CARRIES NO KEY MATERIAL — not the key, not a prefix of
        // it, not the ciphertext, not the key version. `credentialChanged` is
        // the whole story an auditor needs: that the stored credential is not
        // the one it was before.
        await recordAudit(tx, {
          workspaceId: activeWorkspaceId(this.tenantContext),
          userId: input.principal.userId,
          action: credential.auditAction,
          entityType: AI_AUDIT_ENTITY_TYPE,
          entityId: configId,
          metadata: {
            provider: input.provider,
            model: input.model,
            isEnabled,
            dailyTokenQuota: input.dailyTokenQuota,
            rateLimitPerMinute: input.rateLimitPerMinute,
            contentConsent: input.contentConsent,
            credentialChanged: credential.changed,
          },
          requestId: input.requestId ?? null,
        });
        // `hasCredentials` comes from the decision just made, not from a second
        // read: `resolveCredential` is the authority on what the column now
        // holds, and re-selecting it would only add a way for the two to differ.
        return { ...written, hasCredentials: credential.encryptedCredentials !== null };
      });
      return this.toView(row);
    });
  }

  async getUsage(input: AiUsageServiceInput): Promise<AiUsageSummary> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "ai.configure",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const until = new Date();
      const since = new Date(until.getTime() - input.days * MILLISECONDS_PER_DAY);
      const reportWindow = and(
        whereWorkspace(aiUsage, this.tenantContext),
        gte(aiUsage.createdAt, since),
        lte(aiUsage.createdAt, until),
      );

      const [totals] = await this.database.db
        .select({
          // `count(*)` is `bigint`, which the driver hands back as a string;
          // the `filter` clauses count one status each in the same pass.
          totalRequests: sql<number>`cast(count(*) as integer)`,
          successfulRequests: sql<number>`cast(count(*) filter (where ${aiUsage.status} = 'success') as integer)`,
          failedRequests: sql<number>`cast(count(*) filter (where ${aiUsage.status} = 'failed') as integer)`,
          rateLimitedRequests: sql<number>`cast(count(*) filter (where ${aiUsage.status} = 'rate_limited') as integer)`,
          promptTokens: sql<string>`cast(coalesce(sum(${aiUsage.promptTokens}), 0) as bigint)`,
          completionTokens: sql<string>`cast(coalesce(sum(${aiUsage.completionTokens}), 0) as bigint)`,
          totalTokens: sql<string>`cast(coalesce(sum(${aiUsage.totalTokens}), 0) as bigint)`,
          costMicros: sql<string>`cast(coalesce(sum(${aiUsage.costMicros}), 0) as bigint)`,
        })
        .from(aiUsage)
        .where(reportWindow);

      const featureRows = await this.database.db
        .select({
          feature: aiUsage.feature,
          requests: sql<number>`cast(count(*) as integer)`,
          totalTokens: sql<string>`cast(coalesce(sum(${aiUsage.totalTokens}), 0) as bigint)`,
          costMicros: sql<string>`cast(coalesce(sum(${aiUsage.costMicros}), 0) as bigint)`,
        })
        .from(aiUsage)
        .where(reportWindow)
        .groupBy(aiUsage.feature)
        .orderBy(desc(sql`coalesce(sum(${aiUsage.totalTokens}), 0)`), aiUsage.feature)
        .limit(USAGE_FEATURE_LIMIT);

      // Its own query rather than a slice of the window above: the quota window
      // starts at UTC midnight regardless of how many days the report covers,
      // and `tokensUsedToday` must match what `AiGovernanceService` compares
      // against or the screen and the gate disagree.
      const [today] = await this.database.db
        .select({ tokens: sql<string>`cast(coalesce(sum(${aiUsage.totalTokens}), 0) as bigint)` })
        .from(aiUsage)
        .where(
          and(
            whereWorkspace(aiUsage, this.tenantContext),
            gte(aiUsage.createdAt, startOfUtcDay(until)),
          ),
        );

      const config = await this.readConfig();
      const settings = parseAiSettings(config?.settings);

      return Object.freeze({
        workspaceId: input.workspaceId,
        since: since.toISOString(),
        until: until.toISOString(),
        totalRequests: numeric(totals?.totalRequests),
        successfulRequests: numeric(totals?.successfulRequests),
        failedRequests: numeric(totals?.failedRequests),
        rateLimitedRequests: numeric(totals?.rateLimitedRequests),
        promptTokens: numeric(totals?.promptTokens),
        completionTokens: numeric(totals?.completionTokens),
        totalTokens: numeric(totals?.totalTokens),
        costMicros: numeric(totals?.costMicros),
        dailyTokenQuota: settings.dailyTokenQuota,
        tokensUsedToday: numeric(today?.tokens),
        features: Object.freeze(
          featureRows.map((row): AiUsageFeatureSummary =>
            Object.freeze({
              feature: row.feature,
              requests: numeric(row.requests),
              totalTokens: numeric(row.totalTokens),
              costMicros: numeric(row.costMicros),
            }),
          ),
        ),
      });
    });
  }

  /**
   * What a non-admin member may learn: whether to offer AI at all, and by whom.
   *
   * Deliberately narrower than {@link AiConfigView} — no quota, no consent flag,
   * no credential state — because `ai.use` reaches editors, and an editor
   * learning "the key is configured but consent is off" is an admin's business
   * leaking through a member's endpoint.
   */
  async getStatus(input: ScopedInput): Promise<AiStatus> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "ai.use",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.readConfig();
      if (row === undefined) {
        return Object.freeze({ enabled: false, provider: "disabled" as const, model: null });
      }
      const settings = parseAiSettings(row.settings);
      // The same conjunction `AiGovernanceService.acquire` enforces, so the UI
      // never offers a button whose first click is guaranteed to be refused.
      return Object.freeze({
        enabled:
          this.aiConfig.enabled &&
          row.isEnabled &&
          row.provider !== "disabled" &&
          row.model !== null &&
          row.hasCredentials &&
          settings.contentConsent,
        provider: row.provider,
        model: row.model,
      });
    });
  }

  /**
   * Decides what the credential columns become, and which audit action the
   * write deserves. Pulled out of the transaction body because it is the one
   * piece of `updateConfig` that is pure decision rather than SQL.
   */
  private resolveCredential(
    input: UpdateAiConfigServiceInput,
    configId: string,
    current:
      | {
          readonly id: string;
          readonly provider: AiProviderName;
          readonly encryptedCredentials: string | null;
          readonly encryptionKeyVersion: number | null;
        }
      | undefined,
  ): {
    readonly encryptedCredentials: string | null;
    readonly encryptionKeyVersion: number | null;
    readonly auditAction: AiAuditAction;
    readonly changed: boolean;
  } {
    const stored = current?.encryptedCredentials ?? null;
    const storedVersion = current?.encryptionKeyVersion ?? null;

    // Turning AI off CLEARS the credential rather than parking it. A dangling
    // ciphertext for a provider nobody selected is a secret with no owner and
    // no expiry, and re-enabling deserves a deliberate new key anyway.
    if (input.provider === "disabled") {
      return {
        encryptedCredentials: null,
        encryptionKeyVersion: null,
        auditAction: AI_AUDIT_ACTIONS.disable,
        changed: stored !== null,
      };
    }

    if (input.apiKey !== undefined) {
      const encrypted = this.credentials.encrypt(configId, input.apiKey);
      return {
        ...encrypted,
        auditAction:
          stored === null ? AI_AUDIT_ACTIONS.configure : AI_AUDIT_ACTIONS.credentialRotated,
        changed: true,
      };
    }

    // A PROVIDER SWITCH NEEDS A NEW KEY. The stored ciphertext is an OpenAI key
    // or an Anthropic key; carrying it across to the other provider would store
    // a credential that can only ever fail authentication, and would do it
    // silently until the first request.
    //
    // The `stored !== null` half matters: a workspace sitting on `disabled` has
    // no credential to carry across, so selecting a provider there is not a
    // switch at all. Refusing it would stop an admin from choosing a provider
    // before they have fetched a key, which the `stored === null` branch below
    // already handles correctly — it only insists on a key to ENABLE.
    if (current !== undefined && current.provider !== input.provider && stored !== null) {
      throw this.credentialRequired(
        `Provide an API key for ${input.provider} before switching providers.`,
      );
    }

    if (stored === null || storedVersion === null) {
      if (input.isEnabled) {
        throw this.credentialRequired("Provide an API key before enabling AI features.");
      }
      return {
        encryptedCredentials: null,
        encryptionKeyVersion: null,
        auditAction: AI_AUDIT_ACTIONS.configure,
        changed: false,
      };
    }

    // LAZY KEY MIGRATION. There is no bulk re-encryption job: a row moves onto
    // the active key the next time an admin saves this form, which is the only
    // moment we are certain nobody is mid-request against it.
    if (storedVersion !== this.credentials.activeKeyVersion) {
      let plaintext: string;
      try {
        plaintext = this.credentials.decrypt(configId, stored, storedVersion);
      } catch {
        // A failed migration must not wedge the whole settings update — an
        // admin trying to lower a quota should not be blocked by a key we can
        // no longer read. Asking for a fresh key is the only real remedy, and
        // it is stated without saying what went wrong with the old one.
        throw this.credentialRequired(
          "The stored API key can no longer be read. Provide it again to continue.",
        );
      }
      return {
        ...this.credentials.encrypt(configId, plaintext),
        auditAction: AI_AUDIT_ACTIONS.credentialRotated,
        changed: true,
      };
    }

    return {
      encryptedCredentials: stored,
      encryptionKeyVersion: storedVersion,
      auditAction: AI_AUDIT_ACTIONS.configure,
      changed: false,
    };
  }

  /**
   * The columns a config response is built from. The ciphertext is absent BY
   * CONSTRUCTION: there is no key here it could be assigned to, so it never
   * travels over the wire from PostgreSQL and never sits in a row object some
   * later refactor might spread into a response.
   *
   * `hasCredentials` is NOT part of this selection. On the read path it is
   * computed in SQL (see `readConfig`); on the write path the caller already
   * knows the answer exactly, because it just decided what the column becomes.
   * Keeping the shared selection free of `sql` expressions also keeps it usable
   * in `.returning()`, whose accepted field shapes are narrower than
   * `.select()`'s.
   */
  private configSelection() {
    return {
      workspaceId: aiProviderConfig.workspaceId,
      provider: aiProviderConfig.provider,
      model: aiProviderConfig.model,
      isEnabled: aiProviderConfig.isEnabled,
      settings: aiProviderConfig.settings,
      updatedById: aiProviderConfig.updatedById,
      updatedAt: aiProviderConfig.updatedAt,
    };
  }

  private async readConfig(): Promise<AiConfigRow | undefined> {
    const [row] = await this.database.db
      .select({
        ...this.configSelection(),
        hasCredentials: sql<boolean>`${aiProviderConfig.encryptedCredentials} is not null`,
      })
      .from(aiProviderConfig)
      .where(whereWorkspace(aiProviderConfig, this.tenantContext))
      .limit(1);
    return row;
  }

  /** The ONLY read of the ciphertext columns in this file. */
  private async readCredentialState(tx: DatabaseTransaction): Promise<
    | {
        readonly id: string;
        readonly provider: AiProviderName;
        readonly encryptedCredentials: string | null;
        readonly encryptionKeyVersion: number | null;
      }
    | undefined
  > {
    const [row] = await tx
      .select({
        id: aiProviderConfig.id,
        provider: aiProviderConfig.provider,
        encryptedCredentials: aiProviderConfig.encryptedCredentials,
        encryptionKeyVersion: aiProviderConfig.encryptionKeyVersion,
      })
      .from(aiProviderConfig)
      .where(whereWorkspace(aiProviderConfig, this.tenantContext))
      .limit(1);
    return row;
  }

  private defaultView(workspaceId: string): AiConfigView {
    const settings = parseAiSettings(undefined);
    return Object.freeze({
      workspaceId,
      provider: "disabled" as const,
      model: null,
      isEnabled: false,
      hasCredentials: false,
      dailyTokenQuota: settings.dailyTokenQuota,
      rateLimitPerMinute: settings.rateLimitPerMinute,
      contentConsent: settings.contentConsent,
      updatedById: null,
      updatedAt: new Date().toISOString(),
    });
  }

  private toView(row: AiConfigRow): AiConfigView {
    const settings = parseAiSettings(row.settings);
    return Object.freeze({
      workspaceId: row.workspaceId,
      provider: row.provider,
      model: row.model,
      isEnabled: row.isEnabled,
      hasCredentials: row.hasCredentials,
      dailyTokenQuota: settings.dailyTokenQuota,
      rateLimitPerMinute: settings.rateLimitPerMinute,
      contentConsent: settings.contentConsent,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private credentialRequired(message: string): ApiHttpException {
    return new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: "AI_CREDENTIAL_REQUIRED",
      message,
    });
  }
}
