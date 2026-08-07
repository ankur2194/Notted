// Part 45: the one place workspace storage usage is computed.
//
// WHY IT LIVES IN `src/storage/` RATHER THAN `src/attachments/`
// Two modules need it and neither should own the other. `AttachmentsService`
// needs the WRITE path (reserve under a row lock, inside its upload
// transaction); the workspace storage transport needs the READ path (no lock,
// no transaction). Had this stayed in `attachments/`, `WorkspacesModule` and
// the storage transport would have to import `AttachmentsModule` to ask a
// question that has nothing to do with uploading a file. A neutral module both
// sides import keeps the dependency arrows one-directional.
//
// TWO PATHS, ONE SQL SHAPE, DIFFERENT LOCKING
// - `reserve(tx, bytes)` takes `SELECT ... FOR UPDATE` on the workspace row.
//   That lock is the entire concurrency story: two simultaneous uploads
//   serialize on it, so the second one reads the first one's already-inserted
//   `pending` row and cannot double-spend the quota.
// - `readUsage(...)` takes NO lock and opens NO transaction. A settings page
//   refreshing its usage bar must never be able to block an upload, and a
//   slightly stale read is the correct trade for a display value.

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { STORAGE_CONFIG, type StorageConfig } from "../config/storage.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { attachments, workspaces } from "../database/schema";
import { activeWorkspaceId, TenantContextService, whereWorkspace } from "../tenant";

import {
  buildWorkspaceStorageUsage,
  fitsWithinQuota,
  QUOTA_CHARGED_STATUSES,
  resolveEffectiveLimitBytes,
  type StorageUsageAggregate,
} from "./storage-quota";

import type {
  AuthenticatedPrincipal,
  WorkspacePlan,
  WorkspaceStorageUsage,
} from "@notted/shared-types";

export interface ReadWorkspaceStorageUsageInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface WorkspaceQuotaRow {
  readonly plan: WorkspacePlan;
  readonly overrideBytes: number | null;
}

@Injectable()
export class StorageQuotaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
  ) {}

  /**
   * WRITE PATH. Serialize concurrent uploads for one workspace on the workspace
   * row, then derive usage from the attachment rows themselves.
   *
   * `pending`/`processing` rows ARE the reservation, which is why no
   * `storage_used_bytes` column is needed and why no reservation can be lost by
   * a crash: the row that holds the reservation is the same row the
   * abandoned-upload sweep later reclaims.
   *
   * MUST be called inside the caller's transaction — the row lock is only
   * meaningful for the lifetime of that transaction.
   */
  async reserve(tx: DatabaseTransaction, additionalBytes: number): Promise<void> {
    const workspace = await this.lockWorkspace(tx);
    const aggregate = await this.readAggregate(tx);
    const limitBytes = this.effectiveLimit(workspace);
    if (!fitsWithinQuota({ aggregate, limitBytes, additionalBytes })) {
      throw new ApiHttpException(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: "PAYLOAD_TOO_LARGE",
        message: "The workspace storage quota is exhausted.",
      });
    }
  }

  /**
   * READ PATH. Authorized workspace usage for the settings and overview
   * surfaces.
   *
   * Authorized as `settings.read` against the `settings` resource: usage is
   * workspace configuration, every role may see it read-only, and the central
   * policy already binds that action to that resource kind. All SQL runs inside
   * the authorized tenant context, so a caller can never read another
   * workspace's totals by passing its id.
   */
  async readUsage(input: ReadWorkspaceStorageUsageInput): Promise<WorkspaceStorageUsage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.read",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const workspace = await this.readWorkspace();
      const aggregate = await this.readAggregate();
      const usage = buildWorkspaceStorageUsage({
        plan: workspace.plan,
        overrideBytes: workspace.overrideBytes,
        planDefaults: this.storage.planDefaultBytes,
        deploymentCeilingBytes: this.security.maximumWorkspaceStorageBytes,
        aggregate,
      });
      return Object.freeze({
        workspaceId: activeWorkspaceId(this.tenantContext),
        plan: workspace.plan,
        ...usage,
        limitSource: workspace.overrideBytes === null ? ("plan" as const) : ("override" as const),
      });
    });
  }

  /**
   * Effective quota for an already-loaded workspace row. Exposed so the
   * maintenance sweeps can report a limit without re-reading the row.
   */
  effectiveLimit(workspace: WorkspaceQuotaRow): number {
    return resolveEffectiveLimitBytes({
      plan: workspace.plan,
      overrideBytes: workspace.overrideBytes,
      planDefaults: this.storage.planDefaultBytes,
      deploymentCeilingBytes: this.security.maximumWorkspaceStorageBytes,
    });
  }

  private async lockWorkspace(tx: DatabaseTransaction): Promise<WorkspaceQuotaRow> {
    const [row] = await tx
      .select({ plan: workspaces.plan, overrideBytes: workspaces.storageLimitBytes })
      .from(workspaces)
      .where(eq(workspaces.id, activeWorkspaceId(this.tenantContext)))
      .limit(1)
      .for("update");
    if (row === undefined) return this.notFound();
    return row;
  }

  private async readWorkspace(): Promise<WorkspaceQuotaRow> {
    const [row] = await this.database.db
      .select({ plan: workspaces.plan, overrideBytes: workspaces.storageLimitBytes })
      .from(workspaces)
      .where(eq(workspaces.id, activeWorkspaceId(this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  /**
   * One pass over the workspace's attachment rows, split by lifecycle state.
   *
   * `::bigint` (int8) arrives from pg as a *string*, so each expression needs an
   * explicit decoder; `sql<number>` alone would be a type lie the way a bare
   * `sql<Date>` timestamp aggregate is (see `database/sql-aggregates`).
   *
   * The `inArray` predicate keeps `failed` rows out of the scan entirely: a
   * failed upload owns no committed bytes and must not consume quota.
   */
  private async readAggregate(tx?: DatabaseTransaction): Promise<StorageUsageAggregate> {
    const [row] = await (tx ?? this.database.db)
      .select({
        readyBytes:
          sql`coalesce(sum(${attachments.sizeBytes}) filter (where ${attachments.processingStatus} = 'ready'), 0)::bigint`.mapWith(
            Number,
          ),
        reservedBytes:
          sql`coalesce(sum(${attachments.sizeBytes}) filter (where ${attachments.processingStatus} in ('pending', 'processing')), 0)::bigint`.mapWith(
            Number,
          ),
        readyCount: sql`count(*) filter (where ${attachments.processingStatus} = 'ready')`.mapWith(
          Number,
        ),
      })
      .from(attachments)
      .where(
        and(
          inArray(attachments.processingStatus, [...QUOTA_CHARGED_STATUSES]),
          whereWorkspace(attachments, this.tenantContext),
        ),
      );
    return Object.freeze({
      readyBytes: row?.readyBytes ?? 0,
      reservedBytes: row?.reservedBytes ?? 0,
      readyCount: row?.readyCount ?? 0,
    });
  }

  /** One shared shape for "absent" and "not yours" — no existence leak. */
  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
