import { Inject, Injectable } from "@nestjs/common";
import { lt, sql } from "drizzle-orm";

import { allowAuditDelete } from "../audit/audit-record";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { RETENTION_CONFIG, type RetentionConfig } from "../config/retention.config";
import { DatabaseService } from "../database/database.service";
import { auditLogs } from "../database/schema/audit-logs";

const RETENTION_BATCH_SIZE = 500;
const MAX_BATCHES_PER_SWEEP = 10;

@Injectable()
export class AuditLogRetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  /**
   * `dryRun` counts expired rows without deleting (and without needing the
   * append-only trigger's purge flag — a plain SELECT is never refused).
   * Otherwise deletes in batches, each in its own transaction that opens
   * `allowAuditDelete` first, so the migration 0021 trigger's one sanctioned
   * DELETE exception is exercised for real, not bypassed.
   */
  async purgeExpired(options: { readonly dryRun?: boolean } = {}): Promise<number> {
    const dryRun = options.dryRun ?? false;
    const startedAt = Date.now();
    let deleted = 0;
    let batches = 0;
    if (dryRun) {
      deleted = await this.countExpired();
    } else {
      while (batches < MAX_BATCHES_PER_SWEEP) {
        const batchDeleted = await this.deleteBatch();
        deleted += batchDeleted;
        batches += 1;
        if (batchDeleted < RETENTION_BATCH_SIZE) break;
      }
    }
    this.logger.info(
      {
        maintenance: "audit_log_retention",
        outcome: "completed",
        reason: "retention_window_expired",
        deleted,
        batches,
        dryRun,
        durationMs: Date.now() - startedAt,
      },
      "Expired audit logs cleaned",
    );
    return deleted;
  }

  /**
   * Cutoff predicate shared by the dry-run count and the delete batch, so both
   * read the same database clock (never a drifting JS `Date.now()`).
   */
  private get expiredBefore() {
    return sql`now() - make_interval(days => ${this.config.auditLogRetentionDays}::integer)`;
  }

  private async countExpired(): Promise<number> {
    const rows = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(lt(auditLogs.createdAt, this.expiredBefore));
    return rows[0]?.count ?? 0;
  }

  /**
   * ponytail: batches are capped at `MAX_BATCHES_PER_SWEEP`, so a very large
   * backlog drains over several 6-hour sweeps rather than in one. The
   * `(created_at, id)` scan itself is indexed (`audit_logs_retention_scan_idx`,
   * migration 0023) exactly as Part 55 did for `note_versions`; raise the batch
   * ceiling only if the backlog is observed to outpace the cadence.
   */
  private async deleteBatch(): Promise<number> {
    return this.database.transaction(async (tx) => {
      // Transaction-local: must be set in the same transaction as the delete
      // below, and it reverts automatically on commit or rollback.
      await allowAuditDelete(tx);
      const result = await tx.execute(sql`
        with candidates as (
          select id
          from audit_logs
          where created_at < ${this.expiredBefore}
          order by created_at, id
          for update skip locked
          limit ${RETENTION_BATCH_SIZE}
        )
        delete from audit_logs
        using candidates
        where audit_logs.id = candidates.id
        returning audit_logs.id
      `);
      return (result as { readonly rows?: readonly unknown[] }).rows?.length ?? 0;
    });
  }
}
