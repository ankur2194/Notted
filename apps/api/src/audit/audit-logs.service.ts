// Part 71 — the read-only audit REST surface: application service.
//
// TENANT SCOPE. `audit_logs` is workspace-owned, so every statement here
// carries `whereWorkspace(auditLogs, tenantContext)` (ADR 0009). A workspace
// the caller has no membership in is refused by `authorizeUser` before any
// row is read, so its existence never leaks.
//
// ONE QUERY SHAPE FOR BOTH ROUTES. `list` and `exportRows` build their
// `WHERE`/`ORDER BY`/projection through the single private `rows` helper
// below so the CSV can never describe a different slice of the trail than the
// table the admin was looking at — only the `LIMIT`/`OFFSET` differ.

import { Injectable } from "@nestjs/common";
import { AUDIT_LOG_EXPORT_MAX_ROWS } from "@notted/shared-validators";
import { and, asc, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { DatabaseService } from "../database/database.service";
import { auditLogs, users } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import type { AuditLogEntry, AuditLogPage, AuthenticatedPrincipal } from "@notted/shared-types";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

/** The filters shared by the paged list and the bounded CSV export. */
export interface AuditLogFilterInput {
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly userId?: string;
  /** ISO timestamps; the shared query schemas already proved `from <= to`. */
  readonly from?: string;
  readonly to?: string;
}

export interface ListAuditLogsServiceInput extends ScopedInput, AuditLogFilterInput {
  readonly page: number;
  readonly limit: number;
}

export type ExportAuditLogsServiceInput = ScopedInput & AuditLogFilterInput;

/** The projected row shape: `userName` is joined for legibility, never the actor's email. */
interface AuditLogRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(input: ListAuditLogsServiceInput): Promise<AuditLogPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "audit.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.rows(input, input.limit + 1, (input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toEntry(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async exportRows(input: ExportAuditLogsServiceInput): Promise<readonly AuditLogEntry[]> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "audit.export",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      // No offset: the cap IS the bound, not a page inside a larger scan.
      const rows = await this.rows(input, AUDIT_LOG_EXPORT_MAX_ROWS);
      return Object.freeze(rows.map((row) => this.toEntry(row)));
    });
  }

  /**
   * The single query both routes execute. `desc(createdAt), asc(id)` is a
   * deterministic tiebreak — two rows with the same millisecond timestamp
   * still sort consistently, so page N+1 of `list` cannot repeat or skip one.
   */
  private rows(
    filters: AuditLogFilterInput,
    limit: number,
    offset?: number,
  ): Promise<AuditLogRow[]> {
    const query = this.database.db
      .select({
        id: auditLogs.id,
        workspaceId: auditLogs.workspaceId,
        userId: auditLogs.userId,
        userName: users.name,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        userAgent: auditLogs.userAgent,
        requestId: auditLogs.requestId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(and(...this.conditions(filters)))
      .orderBy(desc(auditLogs.createdAt), asc(auditLogs.id))
      .limit(limit);
    return offset === undefined ? query : query.offset(offset);
  }

  private conditions(filters: AuditLogFilterInput): SQL[] {
    const conditions: SQL[] = [whereWorkspace(auditLogs, this.tenantContext)];
    if (filters.action !== undefined) conditions.push(eq(auditLogs.action, filters.action));
    if (filters.entityType !== undefined) {
      conditions.push(eq(auditLogs.entityType, filters.entityType));
    }
    if (filters.entityId !== undefined) conditions.push(eq(auditLogs.entityId, filters.entityId));
    if (filters.userId !== undefined) conditions.push(eq(auditLogs.userId, filters.userId));
    if (filters.from !== undefined) {
      conditions.push(gte(auditLogs.createdAt, new Date(filters.from)));
    }
    if (filters.to !== undefined) conditions.push(lte(auditLogs.createdAt, new Date(filters.to)));
    return conditions;
  }

  private toEntry(row: AuditLogRow): AuditLogEntry {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      userName: row.userName,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: row.metadata,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
