import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { workspaceSettingsSchema } from "@notted/shared-validators";
import { and, asc, desc, eq, ilike, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  auditLogs,
  jobOutbox,
  type JobOutboxPayload,
  workspaceDeletionAudits,
  workspaces,
  workspaceMembers,
} from "../database/schema";
import { createTenantContext, TenantContextService, whereWorkspaceId } from "../tenant";

import {
  WORKSPACE_AUDIT_ACTIONS,
  WORKSPACE_AUDIT_ENTITY_TYPE,
  WORKSPACE_DELETED_IDEMPOTENCY_PREFIX,
  WORKSPACE_DELETED_JOB_TYPE,
  WORKSPACE_DELETED_PAYLOAD_VERSION,
  WORKSPACE_DELETED_QUEUE_NAME,
  WORKSPACE_SEARCH_PURGE_IDEMPOTENCY_PREFIX,
  WORKSPACE_SEARCH_PURGE_JOB_TYPE,
  WORKSPACE_SEARCH_PURGE_QUEUE_NAME,
  WORKSPACE_MAX_SLUG_ATTEMPTS,
} from "./workspaces.constants";

import type {
  AuthenticatedPrincipal,
  WorkspaceCreateResult,
  WorkspaceDeleteResult,
  WorkspaceDetail,
  WorkspacePage,
  WorkspacePlan,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceSummary,
  WorkspaceUpdateResult,
} from "@notted/shared-types";

/**
 * PostgreSQL constraint names that surface unique violations. The `pg` driver
 * exposes them on the thrown `DatabaseError` (`code` + `constraint`); Drizzle
 * re-throws the raw error so the helper inspects it directly.
 */
const WORKSPACES_SLUG_UNIQUE_CONSTRAINT = "workspaces_slug_unique";
const WORKSPACES_DOMAIN_UNIQUE_CONSTRAINT = "workspaces_domain_unique";
const PG_UNIQUE_VIOLATION = "23505";

/** Drizzle may wrap a pg DatabaseError in `cause`; inspect only a bounded chain. */
export function isUniqueViolationOnConstraint(error: unknown, constraint: string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) return false;
    visited.add(current);
    const candidate = current as {
      readonly code?: unknown;
      readonly constraint?: unknown;
      readonly cause?: unknown;
    };
    if (candidate.code === PG_UNIQUE_VIOLATION && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = Object.freeze({ defaultPageSize: "a4" });

function normalizeStoredSettings(value: unknown): WorkspaceSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_WORKSPACE_SETTINGS;
  const defaultPageSize = (value as { readonly defaultPageSize?: unknown }).defaultPageSize;
  return defaultPageSize === "letter"
    ? Object.freeze({ defaultPageSize: "letter" })
    : DEFAULT_WORKSPACE_SETTINGS;
}

function knownSafePersistedSettings(value: unknown): Record<string, string> {
  const settings: Record<string, string> = { ...normalizeStoredSettings(value) };
  if (typeof value !== "object" || value === null) return settings;
  const persisted = value as {
    readonly accentColor?: unknown;
    readonly scenario?: unknown;
  };
  if (typeof persisted.accentColor === "string" && /^#[0-9a-f]{6}$/iu.test(persisted.accentColor)) {
    settings.accentColor = persisted.accentColor;
  }
  if (typeof persisted.scenario === "string" && /^[a-z0-9_-]{1,64}$/iu.test(persisted.scenario)) {
    settings.scenario = persisted.scenario;
  }
  return settings;
}

interface SummaryFields {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly plan: WorkspacePlan;
  readonly logoUrl: string | null;
  readonly updatedAt: Date;
}

interface DetailFields extends SummaryFields {
  readonly domain: string | null;
  readonly settings: unknown;
  readonly storageLimitBytes: number | null;
  readonly createdById: string;
  readonly createdAt: Date;
}

interface CreateWorkspacesInput {
  readonly principal: AuthenticatedPrincipal;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly domain: string | null;
  readonly settings?: WorkspaceSettings;
  readonly idempotencyKey?: string;
  readonly requestId?: string | null;
}

interface ListWorkspacesInput {
  readonly principal: AuthenticatedPrincipal;
  readonly page: number;
  readonly limit: number;
  readonly name?: string;
  readonly plan?: WorkspacePlan;
  readonly currentUserRole?: WorkspaceRole;
  readonly sortBy: "name" | "createdAt" | "updatedAt";
  readonly sortDirection: "asc" | "desc";
}

interface ReadWorkspacesInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface UpdateWorkspacesInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly domain?: string | null;
  readonly settings?: WorkspaceSettings;
  readonly requestId?: string | null;
}

interface DeleteWorkspacesInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  /** Literal gate: the transport layer must prove explicit confirmation. */
  readonly confirmed: true;
  readonly expectedName?: string;
  readonly requestId?: string | null;
}

/**
 * Owns workspace lifecycle invariants: collision-safe slugs, atomic owner
 * membership creation, settings validation, audit events, and the durable
 * cleanup intent emitted on deletion. Transports stay thin; authorization is
 * delegated to {@link AuthorizationEntryService} for every workspace-scoped
 * operation. Create/list are user-scoped (they cross the user's memberships)
 * and therefore only require authentication, not workspace authorization.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ----------------------------------------------------------------------- //
  // Create
  // ----------------------------------------------------------------------- //

  async create(input: CreateWorkspacesInput): Promise<WorkspaceCreateResult> {
    const workspaceId = randomUUID();
    const settings = this.validateSettings(input.settings);
    const idempotency = createApiIdempotencyIdentity({
      actorUserId: input.principal.userId,
      operation: "workspace.create",
      key: input.idempotencyKey ?? input.requestId ?? randomUUID(),
      payload: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        domain: input.domain,
        settings,
      },
    });
    const context = createTenantContext({
      workspaceId,
      userId: input.principal.userId,
      requestId: input.requestId ?? null,
    });
    return this.tenantContext.run(context, async () => {
      for (let attempt = 0; attempt < WORKSPACE_MAX_SLUG_ATTEMPTS; attempt += 1) {
        const candidateSlug = attempt === 0 ? input.slug : this.suffixedSlug(input.slug, attempt);
        try {
          return await this.database.transaction(async (tx) => {
            await lockApiIdempotency(tx, idempotency);
            const replay = await loadApiIdempotency(tx, idempotency);
            if (replay !== null) {
              assertIdempotencyPayload(replay, idempotency);
              return this.loadCreateReplay(tx, replay.resourceId, input.principal.userId);
            }
            await tx.insert(workspaces).values({
              id: workspaceId,
              name: input.name,
              slug: candidateSlug,
              description: input.description,
              domain: input.domain,
              settings,
              createdById: input.principal.userId,
            });
            // Owner membership in the SAME transaction: workspace + member
            // commit together or neither does (transactionality requirement).
            await tx.insert(workspaceMembers).values({
              id: randomUUID(),
              workspaceId,
              userId: input.principal.userId,
              role: "owner",
            });
            await this.writeAudit(tx, {
              workspaceId,
              userId: input.principal.userId,
              action: WORKSPACE_AUDIT_ACTIONS.create,
              entityId: workspaceId,
              metadata: {},
              requestId: input.requestId,
            });
            await storeApiIdempotency(tx, idempotency, workspaceId);
            const [row] = await tx
              .select()
              .from(workspaces)
              .where(whereWorkspaceId(workspaces, this.tenantContext))
              .limit(1);
            if (row === undefined) {
              throw new Error(
                "Inserted workspace row was not readable within its own transaction.",
              );
            }
            return Object.freeze({
              workspace: Object.freeze(this.toDetail(row, "owner")),
              slug: candidateSlug,
            });
          });
        } catch (error: unknown) {
          if (isUniqueViolationOnConstraint(error, WORKSPACES_SLUG_UNIQUE_CONSTRAINT)) {
            // Retry the entire transaction with a suffixed slug. Each attempt
            // is a fresh transaction; a failed INSERT aborts only that attempt.
            continue;
          }
          if (isUniqueViolationOnConstraint(error, WORKSPACES_DOMAIN_UNIQUE_CONSTRAINT)) {
            throw this.conflict("The workspace domain is already in use.");
          }
          throw error;
        }
      }
      throw this.conflict(
        `Unable to allocate a unique workspace slug after ${WORKSPACE_MAX_SLUG_ATTEMPTS} attempts.`,
      );
    });
  }

  // ----------------------------------------------------------------------- //
  // List (user-scoped, crosses the user's memberships)
  // ----------------------------------------------------------------------- //

  async list(input: ListWorkspacesInput): Promise<WorkspacePage> {
    const conditions: SQL[] = [eq(workspaceMembers.userId, input.principal.userId)];
    if (input.name !== undefined) {
      // Escape LIKE wildcards so user input cannot redefine the pattern.
      const escaped = input.name.replace(/[%_\\]/g, "\\$&");
      conditions.push(ilike(workspaces.name, `%${escaped}%`));
    }
    if (input.plan !== undefined) {
      conditions.push(eq(workspaces.plan, input.plan));
    }
    if (input.currentUserRole !== undefined) {
      conditions.push(eq(workspaceMembers.role, input.currentUserRole));
    }

    const sortColumn =
      input.sortBy === "name"
        ? workspaces.name
        : input.sortBy === "createdAt"
          ? workspaces.createdAt
          : workspaces.updatedAt;
    const orderBy = input.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);

    const offset = (input.page - 1) * input.limit;
    const rows = await this.database.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        description: workspaces.description,
        plan: workspaces.plan,
        logoUrl: workspaces.logoUrl,
        updatedAt: workspaces.updatedAt,
        currentUserRole: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, input.principal.userId),
        ),
      )
      .where(and(...conditions))
      .orderBy(orderBy, asc(workspaces.id))
      .limit(input.limit + 1)
      .offset(offset);

    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) => this.toSummary(row));
    return Object.freeze({
      items: Object.freeze(items),
      page: input.page,
      limit: input.limit,
      hasMore,
    });
  }

  // ----------------------------------------------------------------------- //
  // Read (workspace-scoped; authorization proves membership first)
  // ----------------------------------------------------------------------- //

  async read(input: ReadWorkspacesInput): Promise<WorkspaceDetail> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const [row] = await this.database.db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          description: workspaces.description,
          plan: workspaces.plan,
          logoUrl: workspaces.logoUrl,
          domain: workspaces.domain,
          settings: workspaces.settings,
          storageLimitBytes: workspaces.storageLimitBytes,
          createdById: workspaces.createdById,
          createdAt: workspaces.createdAt,
          updatedAt: workspaces.updatedAt,
          currentUserRole: workspaceMembers.role,
        })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, input.principal.userId),
          ),
        )
        .where(whereWorkspaceId(workspaces, this.tenantContext))
        .limit(1);
      if (row === undefined) return this.notFound();
      return Object.freeze(this.toDetail(row));
    });
  }

  // ----------------------------------------------------------------------- //
  // Update (settings.update)
  // ----------------------------------------------------------------------- //

  async update(input: UpdateWorkspacesInput): Promise<WorkspaceUpdateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      try {
        if (input.slug === undefined) {
          const workspace = await this.applyUpdateTransaction(input, undefined);
          return Object.freeze({ workspace: Object.freeze(workspace) });
        }
        for (let attempt = 0; attempt < WORKSPACE_MAX_SLUG_ATTEMPTS; attempt += 1) {
          const candidateSlug = attempt === 0 ? input.slug : this.suffixedSlug(input.slug, attempt);
          try {
            const workspace = await this.applyUpdateTransaction(input, candidateSlug);
            return Object.freeze({ workspace: Object.freeze(workspace) });
          } catch (error: unknown) {
            if (isUniqueViolationOnConstraint(error, WORKSPACES_SLUG_UNIQUE_CONSTRAINT)) {
              continue;
            }
            throw error;
          }
        }
        throw this.conflict(
          `Unable to allocate a unique workspace slug after ${WORKSPACE_MAX_SLUG_ATTEMPTS} attempts.`,
        );
      } catch (error: unknown) {
        if (isUniqueViolationOnConstraint(error, WORKSPACES_DOMAIN_UNIQUE_CONSTRAINT)) {
          throw this.conflict("The workspace domain is already in use.");
        }
        throw error;
      }
    });
  }

  private async applyUpdateTransaction(
    input: UpdateWorkspacesInput,
    slugOverride: string | undefined,
  ): Promise<WorkspaceDetail> {
    return this.database.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(workspaces)
        .where(whereWorkspaceId(workspaces, this.tenantContext))
        .limit(1);
      if (existing === undefined) return this.notFound();

      const changes: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) changes.name = input.name;
      if (input.description !== undefined) changes.description = input.description;
      if (input.domain !== undefined) changes.domain = input.domain;
      if (input.settings !== undefined) {
        changes.settings = {
          ...knownSafePersistedSettings(existing.settings),
          ...this.validateSettings(input.settings),
        };
      }
      if (slugOverride !== undefined && slugOverride !== existing.slug) {
        changes.slug = slugOverride;
      }

      const changedFields: string[] = [];
      for (const key of Object.keys(changes)) {
        if (key !== "updatedAt") changedFields.push(key);
      }

      if (changedFields.length > 0) {
        await tx
          .update(workspaces)
          .set(changes)
          .where(
            and(eq(workspaces.id, existing.id), whereWorkspaceId(workspaces, this.tenantContext)),
          );
        await this.writeAudit(tx, {
          workspaceId: existing.id,
          userId: input.principal.userId,
          action: WORKSPACE_AUDIT_ACTIONS.update,
          entityId: existing.id,
          metadata: { fields: Object.freeze(changedFields) },
          requestId: input.requestId,
        });
      }

      const [row] = await tx
        .select({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          description: workspaces.description,
          plan: workspaces.plan,
          logoUrl: workspaces.logoUrl,
          domain: workspaces.domain,
          settings: workspaces.settings,
          storageLimitBytes: workspaces.storageLimitBytes,
          createdById: workspaces.createdById,
          createdAt: workspaces.createdAt,
          updatedAt: workspaces.updatedAt,
          currentUserRole: workspaceMembers.role,
        })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, input.principal.userId),
          ),
        )
        .where(
          and(eq(workspaces.id, existing.id), whereWorkspaceId(workspaces, this.tenantContext)),
        )
        .limit(1);
      if (row === undefined) return this.notFound();
      return Object.freeze(this.toDetail(row));
    });
  }

  // ----------------------------------------------------------------------- //
  // Delete (workspace.delete; confirmation + cleanup intent + audit)
  // ----------------------------------------------------------------------- //

  async delete(input: DeleteWorkspacesInput): Promise<WorkspaceDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.delete",
      resource: { kind: "workspaceDeletion" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      return this.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(whereWorkspaceId(workspaces, this.tenantContext))
          .limit(1);
        if (existing === undefined) return this.notFound();

        // Defense-in-depth name cross-check beyond the transport-level
        // confirmation gate.
        if (input.expectedName !== undefined && input.expectedName !== existing.name) {
          throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
            code: "VALIDATION_ERROR",
            message: "The confirmation does not match the workspace name.",
          });
        }

        // Durable cleanup intent FIRST, while the workspace row still exists so
        // the SET NULL cascade has a value to clear. The intent survives the
        // workspace deletion; the Part 40/51 workers consume it later.
        //
        // Preserve the generic completed-cleanup concern, then add the
        // dedicated search purge intent below. Both commit or roll back with
        // the workspace deletion, so neither concern consumes the other.
        await this.scheduleWorkspaceCleanup(tx, {
          workspaceId: existing.id,
          actorId: input.principal.userId,
          requestId: input.requestId,
        });
        await this.scheduleWorkspaceSearchPurge(tx, {
          workspaceId: existing.id,
          actorId: input.principal.userId,
          requestId: input.requestId,
        });
        // The ordinary tenant audit cascades with the workspace. Record a
        // separate identifier-only tombstone with no destructive FK so Part 71
        // can own a unified read/retention policy later.
        await this.writeAudit(tx, {
          workspaceId: existing.id,
          userId: input.principal.userId,
          action: WORKSPACE_AUDIT_ACTIONS.delete,
          entityId: existing.id,
          metadata: {},
          requestId: input.requestId,
        });
        await tx.insert(workspaceDeletionAudits).values({
          deletedWorkspaceId: existing.id,
          actorId: input.principal.userId,
          requestId: input.requestId ?? null,
        });
        await tx
          .delete(workspaces)
          .where(
            and(eq(workspaces.id, existing.id), whereWorkspaceId(workspaces, this.tenantContext)),
          );
        return Object.freeze({ id: existing.id, deleted: true as const });
      });
    });
  }

  // ----------------------------------------------------------------------- //
  // Helpers
  // ----------------------------------------------------------------------- //

  private async loadCreateReplay(
    tx: DatabaseTransaction,
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceCreateResult> {
    const [row] = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        description: workspaces.description,
        plan: workspaces.plan,
        logoUrl: workspaces.logoUrl,
        domain: workspaces.domain,
        settings: workspaces.settings,
        storageLimitBytes: workspaces.storageLimitBytes,
        createdById: workspaces.createdById,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        currentUserRole: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)),
      )
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (row === undefined) {
      throw this.conflict("The idempotent workspace result is no longer available.");
    }
    return Object.freeze({ workspace: Object.freeze(this.toDetail(row)), slug: row.slug });
  }

  private async scheduleWorkspaceCleanup(
    tx: DatabaseTransaction,
    input: {
      readonly workspaceId: string;
      readonly actorId: string;
      readonly requestId?: string | null;
    },
  ): Promise<void> {
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: WORKSPACE_DELETED_JOB_TYPE,
      intentId: outboxId,
      workspaceId: input.workspaceId,
      resourceIds: Object.freeze([input.workspaceId]),
      actorId: input.actorId,
    });
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await tx.insert(jobOutbox).values({
      id: outboxId,
      workspaceId: input.workspaceId,
      queueName: WORKSPACE_DELETED_QUEUE_NAME,
      jobType: WORKSPACE_DELETED_JOB_TYPE,
      payloadVersion: WORKSPACE_DELETED_PAYLOAD_VERSION,
      payload,
      payloadHash,
      idempotencyKey: `${WORKSPACE_DELETED_IDEMPOTENCY_PREFIX}${input.workspaceId}`,
      correlationId: input.requestId ?? null,
    });
  }

  private async scheduleWorkspaceSearchPurge(
    tx: DatabaseTransaction,
    input: {
      readonly workspaceId: string;
      readonly actorId: string;
      readonly requestId?: string | null;
    },
  ): Promise<void> {
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: WORKSPACE_SEARCH_PURGE_JOB_TYPE,
      intentId: outboxId,
      workspaceId: input.workspaceId,
      resourceIds: Object.freeze([input.workspaceId]),
      actorId: input.actorId,
    });
    await tx.insert(jobOutbox).values({
      id: outboxId,
      workspaceId: input.workspaceId,
      queueName: WORKSPACE_SEARCH_PURGE_QUEUE_NAME,
      jobType: WORKSPACE_SEARCH_PURGE_JOB_TYPE,
      payloadVersion: 1,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${WORKSPACE_SEARCH_PURGE_IDEMPOTENCY_PREFIX}${input.workspaceId}`,
      correlationId: input.requestId ?? null,
    });
  }

  private async writeAudit(
    tx: DatabaseTransaction,
    input: {
      readonly workspaceId: string;
      readonly userId: string;
      readonly action: string;
      readonly entityId: string;
      readonly metadata: Record<string, unknown>;
      readonly requestId?: string | null;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.action,
      entityType: WORKSPACE_AUDIT_ENTITY_TYPE,
      entityId: input.entityId,
      metadata: input.metadata,
      requestId: input.requestId ?? null,
    });
  }

  private suffixedSlug(base: string, attempt: number): string {
    // attempt begins at 1; suffix is attempt + 1 so retries read -2, -3, -4, -5
    // (avoiding a misleading trailing -1). Input slugs are validated to <= 63
    // chars, so the suffixed result always fits the 255-char DB column.
    return `${base}-${String(attempt + 1)}`;
  }

  private toSummary(
    row: SummaryFields & { readonly currentUserRole: WorkspaceRole },
  ): WorkspaceSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      plan: row.plan,
      currentUserRole: row.currentUserRole,
      logoUrl: row.logoUrl,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetail(
    row: DetailFields & { readonly currentUserRole?: WorkspaceRole },
    explicitRole?: WorkspaceRole,
  ): WorkspaceDetail {
    const role = explicitRole ?? row.currentUserRole;
    if (role === undefined) {
      throw new Error("Workspace detail mapping requires a resolved membership role.");
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      plan: row.plan,
      currentUserRole: role,
      logoUrl: row.logoUrl,
      domain: row.domain,
      settings: normalizeStoredSettings(row.settings),
      storageLimitBytes: row.storageLimitBytes,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private conflict(message: string): ApiHttpException {
    return new ApiHttpException(HttpStatus.CONFLICT, { code: "CONFLICT", message });
  }

  private validateSettings(settings: WorkspaceSettings | undefined): WorkspaceSettings {
    const parsed = workspaceSettingsSchema.safeParse(settings ?? DEFAULT_WORKSPACE_SETTINGS);
    if (!parsed.success) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The workspace settings are invalid.",
      });
    }
    return Object.freeze(parsed.data);
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
