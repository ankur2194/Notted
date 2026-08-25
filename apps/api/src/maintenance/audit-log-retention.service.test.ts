import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { parseRetentionConfig } from "../config/retention.config";

import { AuditLogRetentionService } from "./audit-log-retention.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";

describe("AuditLogRetentionService", () => {
  const dialect = new PgDialect();

  it("sets the transaction-local purge flag before deleting, and the delete carries skip-locked and the configured window", async () => {
    const calls: string[] = [];
    const execute = vi.fn().mockImplementation((query: unknown) => {
      const { sql } = dialect.sqlToQuery(query as never);
      calls.push(sql);
      if (sql.includes("select set_config")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: "deleted" }] });
    });
    const transaction = vi.fn().mockImplementation(async (work: (tx: unknown) => unknown) => {
      return work({ execute });
    });
    const info = vi.fn();
    const service = new AuditLogRetentionService(
      { db: { execute: vi.fn() }, transaction } as unknown as DatabaseService,
      { info } as unknown as StructuredLogger,
      parseRetentionConfig({ RETENTION_AUDIT_LOG_DAYS: "90" }),
    );
    await service.purgeExpired();

    expect(calls[0]).toContain("select set_config");
    expect(calls[1]).toContain("for update skip locked");
    const deleteQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0] as never);
    expect(deleteQuery.params).toContain(90);
  });

  it("stops early when a batch returns fewer than 500 rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // set_config
      .mockResolvedValueOnce({ rows: [{ id: "a" }] }); // delete, short batch
    const transaction = vi.fn().mockImplementation(async (work: (tx: unknown) => unknown) => {
      return work({ execute });
    });
    const service = new AuditLogRetentionService(
      { db: { execute: vi.fn() }, transaction } as unknown as DatabaseService,
      { info: vi.fn() } as unknown as StructuredLogger,
      parseRetentionConfig({}),
    );
    const deleted = await service.purgeExpired();
    expect(deleted).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("stops after 10 batches even when every batch is full", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({ id: `row-${index}` }));
    const execute = vi.fn().mockImplementation((query: unknown) => {
      const { sql } = dialect.sqlToQuery(query as never);
      if (sql.includes("select set_config")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows });
    });
    const transaction = vi.fn().mockImplementation(async (work: (tx: unknown) => unknown) => {
      return work({ execute });
    });
    const info = vi.fn();
    const service = new AuditLogRetentionService(
      { db: { execute: vi.fn() }, transaction } as unknown as DatabaseService,
      { info } as unknown as StructuredLogger,
      parseRetentionConfig({}),
    );
    const deleted = await service.purgeExpired();
    expect(deleted).toBe(5_000);
    expect(transaction).toHaveBeenCalledTimes(10);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ batches: 10, deleted: 5_000 }),
      expect.any(String),
    );
  });

  it("dryRun counts candidates without deleting and never opens a transaction", async () => {
    // The count goes through the Drizzle query builder (not raw `execute`), so
    // the stub mirrors `.select().from().where()` and captures the predicate.
    const where = vi.fn().mockResolvedValue([{ count: 7 }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const transaction = vi.fn();
    const info = vi.fn();
    const service = new AuditLogRetentionService(
      { db: { select }, transaction } as unknown as DatabaseService,
      { info } as unknown as StructuredLogger,
      parseRetentionConfig({}),
    );
    const deleted = await service.purgeExpired({ dryRun: true });
    expect(deleted).toBe(7);
    expect(transaction).not.toHaveBeenCalled();
    const projection = dialect.sqlToQuery(
      (select.mock.calls[0]?.[0] as { count: unknown }).count as never,
    );
    expect(projection.sql).toContain("count(*)");
    const predicate = dialect.sqlToQuery(where.mock.calls[0]?.[0] as never);
    expect(predicate.sql).toContain("make_interval");
    expect(predicate.sql).not.toContain("delete");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, deleted: 7 }),
      expect.any(String),
    );
  });
});
