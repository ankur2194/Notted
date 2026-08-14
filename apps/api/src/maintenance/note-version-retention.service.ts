import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { RETENTION_CONFIG, type RetentionConfig } from "../config/retention.config";
import { DatabaseService } from "../database/database.service";

const RETENTION_BATCH_SIZE = 500;
const MAX_BATCHES_PER_SWEEP = 10;

@Injectable()
export class NoteVersionRetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
  ) {}

  async purgeExpired(): Promise<number> {
    const startedAt = Date.now();
    let deleted = 0;
    let batches = 0;
    while (batches < MAX_BATCHES_PER_SWEEP) {
      const batchDeleted = await this.deleteBatch();
      deleted += batchDeleted;
      batches += 1;
      if (batchDeleted < RETENTION_BATCH_SIZE) break;
    }
    this.logger.info(
      {
        maintenance: "note_version_retention",
        outcome: "completed",
        reason: "plan_window_expired",
        deleted,
        batches,
        durationMs: Date.now() - startedAt,
      },
      "Expired note versions cleaned",
    );
    return deleted;
  }

  private async deleteBatch(): Promise<number> {
    const result = await this.database.db.execute(sql`
      with policy(plan, retention_days) as (
        values
          ('free'::workspace_plan, ${this.config.noteVersionRetentionDaysFree}::integer),
          ('pro'::workspace_plan, ${this.config.noteVersionRetentionDaysPro}::integer),
          ('enterprise'::workspace_plan, ${this.config.noteVersionRetentionDaysEnterprise}::integer)
      ), candidates as (
        select version_row.id
        from note_versions version_row
        join notes note on note.id = version_row.note_id
        join workspaces workspace on workspace.id = note.workspace_id
        join policy on policy.plan = workspace.plan
        where policy.retention_days is not null
          and version_row.created_at < now() - make_interval(days => policy.retention_days)
          and version_row.version <> note.version
          and version_row.version <> (
            select min(earliest.version) from note_versions earliest
            where earliest.note_id = version_row.note_id
          )
          and version_row.version <> (
            select max(latest.version) from note_versions latest
            where latest.note_id = version_row.note_id
          )
        order by version_row.created_at, version_row.id
        for update of version_row skip locked
        limit ${RETENTION_BATCH_SIZE}
      )
      delete from note_versions version_row
      using candidates, notes note, workspaces workspace, policy
      where version_row.id = candidates.id
        and note.id = version_row.note_id
        and workspace.id = note.workspace_id
        and policy.plan = workspace.plan
        and policy.retention_days is not null
        and version_row.created_at < now() - make_interval(days => policy.retention_days)
        and version_row.version <> note.version
        and version_row.version <> (
          select min(earliest.version) from note_versions earliest
          where earliest.note_id = version_row.note_id
        )
        and version_row.version <> (
          select max(latest.version) from note_versions latest
          where latest.note_id = version_row.note_id
        )
      returning version_row.id
    `);
    return (result as { readonly rows?: readonly unknown[] }).rows?.length ?? 0;
  }
}
