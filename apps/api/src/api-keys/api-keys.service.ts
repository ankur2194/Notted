// Part 65 — API-key management: the application service.
//
// TENANT SCOPE. `api_keys` is workspace-owned, so every statement here carries
// `whereWorkspace(apiKeys, tenantContext)` and every single-row statement also
// pins the id (ADR 0009). A foreign key id is a 404, never a 403: existence
// itself must not leak across workspaces.
//
// THE SECRET. `keyHash` is never selected, never projected, never audited and
// never logged. The raw secret exists in exactly one place in this file — the
// value returned by `create` — and nowhere else in the system afterwards.

import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { apiKeys, auditLogs } from "../database/schema";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { formatScopes, generateApiKeySecret, hashApiKey, parseScopes } from "./api-key-secret";
import { API_KEY_AUDIT_ACTIONS, API_KEY_AUDIT_ENTITY_TYPE } from "./api-keys.constants";

import type {
  ApiKeyCreateResult,
  ApiKeyPage,
  ApiKeyRevokeResult,
  ApiKeyScope,
  ApiKeySortField,
  ApiKeySummary,
  AuthenticatedPrincipal,
} from "@notted/shared-types";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

/** The safe projection. `keyHash` is absent by construction, not by filtering. */
interface ApiKeyRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: string;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly isRevoked: boolean;
  readonly createdById: string;
  readonly createdAt: Date;
}

export interface ListApiKeysServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly includeRevoked?: boolean;
  readonly sortBy: ApiKeySortField;
  readonly sortDirection: "asc" | "desc";
}

export interface CreateApiKeyServiceInput extends ScopedInput {
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  /** ISO timestamp. `createApiKeySchema` already proved it is in the future. */
  readonly expiresAt?: string;
  readonly idempotencyKey: string;
}

export interface RevokeApiKeyServiceInput extends ScopedInput {
  readonly apiKeyId: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  async list(input: ListApiKeysServiceInput): Promise<ApiKeyPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "apiKey.list",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const conditions: SQL[] = [whereWorkspace(apiKeys, this.tenantContext)];
      // Revoked keys are hidden unless explicitly requested: the usual admin
      // question is "what can reach my workspace right now".
      if (input.includeRevoked !== true) conditions.push(eq(apiKeys.isRevoked, false));
      const sortColumn =
        input.sortBy === "name"
          ? apiKeys.name
          : input.sortBy === "lastUsedAt"
            ? apiKeys.lastUsedAt
            : apiKeys.createdAt;
      const rows = await this.database.db
        .select(this.apiKeySelection())
        .from(apiKeys)
        .where(and(...conditions))
        .orderBy(
          input.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn),
          // Deterministic tiebreak so page N+1 cannot repeat or skip a row.
          asc(apiKeys.id),
        )
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toSummary(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async create(input: CreateApiKeyServiceInput): Promise<ApiKeyCreateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "apiKey.create",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const apiKeyId = randomUUID();
      const secret = generateApiKeySecret();
      const scopes = formatScopes(input.scopes);
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `apiKey.create:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: { name: input.name, scopes, expiresAt: input.expiresAt ?? null },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            // A mismatched payload is still key reuse, so report that first.
            assertIdempotencyPayload(replay, idempotency);
            // The raw secret existed only in the original response and cannot
            // be recomputed from the stored hash. Replaying the create would
            // otherwise hand back a key row the caller can never authenticate
            // with, so the replay fails loudly instead.
            throw new ApiHttpException(HttpStatus.CONFLICT, {
              code: "IDEMPOTENT_RESULT_UNAVAILABLE",
              message: "The idempotent API key result is no longer available.",
            });
          }
          await tx.insert(apiKeys).values(
            assertWorkspaceInsertValues(
              {
                id: apiKeyId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                createdById: input.principal.userId,
                name: input.name,
                keyHash: hashApiKey(secret.raw, this.authConfig.secret),
                keyPrefix: secret.prefix,
                scopes,
                expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt),
              },
              this.tenantContext,
              "apiKey.create",
            ),
          );
          await this.recordAudit(tx, API_KEY_AUDIT_ACTIONS.created, apiKeyId, input, {
            keyPrefix: secret.prefix,
            scopes: [...input.scopes],
          });
          await storeApiIdempotency(tx, idempotency, apiKeyId);
          return this.readRow(tx, apiKeyId);
        },
        { isolationLevel: "read committed" },
      );
      // The only moment the raw secret ever leaves this process.
      return Object.freeze({ apiKey: this.toSummary(row), secret: secret.raw });
    });
  }

  async revoke(input: RevokeApiKeyServiceInput): Promise<ApiKeyRevokeResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "apiKey.revoke",
      resource: { kind: "apiKey", id: input.apiKeyId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        // One conditional UPDATE carrying the expected prior state, so two
        // concurrent revokes cannot both believe they made the transition and
        // write two audit rows.
        const [transitioned] = await tx
          .update(apiKeys)
          .set({ isRevoked: true })
          .where(
            and(
              eq(apiKeys.id, input.apiKeyId),
              whereWorkspace(apiKeys, this.tenantContext),
              eq(apiKeys.isRevoked, false),
            ),
          )
          .returning({
            id: apiKeys.id,
            keyPrefix: apiKeys.keyPrefix,
            scopes: apiKeys.scopes,
          });
        if (transitioned === undefined) {
          // Zero rows means either "already revoked" or "not ours". Only a
          // scoped read can tell them apart, and only the second is an error.
          const [existing] = await tx
            .select({ id: apiKeys.id })
            .from(apiKeys)
            .where(and(eq(apiKeys.id, input.apiKeyId), whereWorkspace(apiKeys, this.tenantContext)))
            .limit(1);
          if (existing === undefined) this.notFound();
          return Object.freeze({ apiKeyId: input.apiKeyId, revoked: true as const });
        }
        await this.recordAudit(tx, API_KEY_AUDIT_ACTIONS.revoked, transitioned.id, input, {
          keyPrefix: transitioned.keyPrefix,
          scopes: [...parseScopes(transitioned.scopes)],
        });
        return Object.freeze({ apiKeyId: transitioned.id, revoked: true as const });
      }),
    );
  }

  private apiKeySelection() {
    return {
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      isRevoked: apiKeys.isRevoked,
      createdById: apiKeys.createdById,
      createdAt: apiKeys.createdAt,
    };
  }

  private async readRow(tx: DatabaseTransaction, apiKeyId: string): Promise<ApiKeyRow> {
    const [row] = await tx
      .select(this.apiKeySelection())
      .from(apiKeys)
      .where(and(eq(apiKeys.id, apiKeyId), whereWorkspace(apiKeys, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  private toSummary(row: ApiKeyRow): ApiKeySummary {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: parseScopes(row.scopes),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      isRevoked: row.isRevoked,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    });
  }

  /**
   * Audit metadata carries the display prefix and the granted scopes only —
   * enough to answer "which credential was this" without ever recording
   * anything that could authenticate.
   */
  private async recordAudit(
    tx: DatabaseTransaction,
    action: (typeof API_KEY_AUDIT_ACTIONS)[keyof typeof API_KEY_AUDIT_ACTIONS],
    entityId: string,
    input: ScopedInput,
    metadata: { readonly keyPrefix: string; readonly scopes: readonly ApiKeyScope[] },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action,
      entityType: API_KEY_AUDIT_ENTITY_TYPE,
      entityId,
      metadata: { keyPrefix: metadata.keyPrefix, scopes: [...metadata.scopes] },
      requestId: input.requestId ?? null,
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
