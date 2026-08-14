import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { parseRetentionConfig } from "../config/retention.config";

import { NoteVersionRetentionService } from "./note-version-retention.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";

describe("NoteVersionRetentionService", () => {
  const dialect = new PgDialect();

  it("uses a bounded oldest-first atomic delete that rechecks plan, cutoff, and protections", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "deleted" }] })
      .mockResolvedValueOnce({ rows: [] });
    const info = vi.fn();
    const service = new NoteVersionRetentionService(
      { db: { execute } } as unknown as DatabaseService,
      { info } as unknown as StructuredLogger,
      parseRetentionConfig({}),
    );
    await expect(service.purgeExpired()).resolves.toBe(1);
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0] as never);
    expect(query.sql).toContain("order by version_row.created_at, version_row.id");
    expect(query.sql).toContain("for update of version_row skip locked");
    expect(query.sql).toContain("workspace.plan");
    expect(query.sql).toContain("version_row.version <> note.version");
    expect(query.sql.match(/select min/g)?.length).toBeGreaterThanOrEqual(2);
    expect(query.sql.match(/select max/g)?.length).toBeGreaterThanOrEqual(2);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 1, reason: "plan_window_expired" }),
      expect.any(String),
    );
  });

  it("binds null paid windows so Pro and Enterprise remain unlimited", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new NoteVersionRetentionService(
      { db: { execute } } as unknown as DatabaseService,
      { info: vi.fn() } as unknown as StructuredLogger,
      parseRetentionConfig({}),
    );
    await service.purgeExpired();
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0] as never);
    expect(query.params).toEqual(expect.arrayContaining([30, null, null, 500]));
  });
});
