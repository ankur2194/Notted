import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { UNCONSUMED_JOB_TYPES } from "../queue/job-registry";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import {
  JOB_IDEMPOTENCY_CLEANUP_KEY_PREFIX,
  JobIdempotencyCleanupQueueService,
} from "./job-idempotency-cleanup-queue.service";
import {
  JobIdempotencyCleanupRepository,
  JobIdempotencyCleanupService,
} from "./job-idempotency-cleanup.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { QueueConfig } from "../config/queue.config";
import type { DatabaseService } from "../database/database.service";
import type { SQL } from "drizzle-orm";

describe("expired job idempotency cleanup", () => {
  it("deletes only expired replay rows whose durable intent is terminal", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ rows: [{ id: "10000000-0000-4000-8000-000000000001" }] });
    const repository = new JobIdempotencyCleanupRepository({
      db: { execute },
    } as unknown as DatabaseService);

    await expect(repository.deleteExpiredBatch(500)).resolves.toBe(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain("delete from job_idempotency");
    expect(query.sql).toContain("expires_at <= now()");
    expect(query.sql).toContain("for update skip locked");
    expect(query.sql).toContain("left join job_outbox");
    expect(query.sql).toContain("intent.status = 'completed'");
    expect(query.sql).toContain("intent.status = 'cancelled'");
    expect(query.params).toContain(500);
  });

  it("stops after ten full batches and logs counts without keys or payloads", async () => {
    const deleteExpiredBatch = vi.fn().mockResolvedValue(500);
    const info = vi.fn();
    const service = new JobIdempotencyCleanupService(
      {
        deleteExpiredBatch,
        cancelUnconsumedBatch: vi.fn().mockResolvedValue(0),
        deleteTerminalOutboxBatch: vi.fn().mockResolvedValue(0),
      } as unknown as JobIdempotencyCleanupRepository,
      { info } as unknown as StructuredLogger,
      { outboxRetentionDays: 30 } as QueueConfig,
    );

    await expect(service.deleteExpired()).resolves.toBe(5_000);
    expect(deleteExpiredBatch).toHaveBeenCalledTimes(10);
    expect(info).toHaveBeenCalledWith(
      {
        maintenance: "job_idempotency",
        outcome: "completed",
        deleted: 5_000,
        batches: 10,
        outboxCancelled: 0,
        outboxDeleted: 0,
        outboxRetentionDays: 30,
      },
      expect.any(String),
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/payload|idempotencyKey|redis/u);
  });

  it("cancels aged intents of types nothing consumes, and only those", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ rows: [{ id: "10000000-0000-4000-8000-000000000002" }] });
    const repository = new JobIdempotencyCleanupRepository({
      db: { execute },
    } as unknown as DatabaseService);

    await expect(repository.cancelUnconsumedBatch(500, 30)).resolves.toBe(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain("set status = 'cancelled'");
    expect(query.sql).toContain("status in ('pending', 'dispatching', 'dispatched')");
    expect(query.sql).toContain("created_at <= now()");
    expect(query.sql).toContain("for update skip locked");
    // The static marker, not the per-process handler registry. Asserting the
    // single `$n::text[]` placeholder matters: drizzle spreads a bare array
    // into one placeholder per element, which builds invalid SQL here.
    expect(query.sql).toMatch(/job_type = any\(\$\d+::text\[\]\)/u);
    expect(query.params).toContainEqual([...UNCONSUMED_JOB_TYPES]);
    expect(query.params).toContain(30);
    expect(query.params).toContain(500);
  });

  it("deletes only aged terminal intents, leaving failed rows for remediation", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new JobIdempotencyCleanupRepository({
      db: { execute },
    } as unknown as DatabaseService);

    await expect(repository.deleteTerminalOutboxBatch(500, 30)).resolves.toBe(0);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0] as SQL);
    expect(query.sql).toContain("delete from job_outbox");
    expect(query.sql).toContain("status in ('completed', 'cancelled')");
    expect(query.sql).not.toContain("'failed'");
    expect(query.sql).toContain("updated_at <= now()");
  });

  it("retires intents before pruning the replay keys that reference them", async () => {
    const order: string[] = [];
    const service = new JobIdempotencyCleanupService(
      {
        cancelUnconsumedBatch: vi.fn(() => {
          order.push("cancel");
          return Promise.resolve(0);
        }),
        deleteTerminalOutboxBatch: vi.fn(() => {
          order.push("delete-intent");
          return Promise.resolve(0);
        }),
        deleteExpiredBatch: vi.fn(() => {
          order.push("delete-replay");
          return Promise.resolve(0);
        }),
      } as unknown as JobIdempotencyCleanupRepository,
      { info: vi.fn() } as unknown as StructuredLogger,
      { outboxRetentionDays: 30 } as QueueConfig,
    );

    await service.deleteExpired();
    expect(order).toEqual(["cancel", "delete-intent", "delete-replay"]);
  });

  it("records one identifier-only durable cleanup intent per period", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const database = {
      db: {
        insert: () => ({
          values: (value: Record<string, unknown>) => {
            inserted.push(value);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    };
    const service = new JobIdempotencyCleanupQueueService(
      { deleteExpired: vi.fn() } as unknown as JobIdempotencyCleanupService,
      new QueueHandlerRegistry(),
      database as unknown as DatabaseService,
      { failure: vi.fn() } as unknown as StructuredLogger,
    );

    service.kick(new Date("2026-08-11T10:00:01.000Z"));
    service.kick(new Date("2026-08-11T10:59:59.000Z"));
    await Promise.resolve();
    await Promise.resolve();

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.idempotencyKey).toBe(inserted[1]?.idempotencyKey);
    expect(inserted[0]?.idempotencyKey).toMatch(
      new RegExp(`^${JOB_IDEMPOTENCY_CLEANUP_KEY_PREFIX}\\d+$`, "u"),
    );
    expect(Object.keys(inserted[0]?.payload as object).sort()).toEqual(["action", "intentId"]);
  });

  it("registers on the maintenance lane and lets cleanup failure reach shared retries", async () => {
    const registry = new QueueHandlerRegistry();
    const deleteExpired = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    const service = new JobIdempotencyCleanupQueueService(
      { deleteExpired } as unknown as JobIdempotencyCleanupService,
      registry,
      {} as DatabaseService,
      { failure: vi.fn() } as unknown as StructuredLogger,
    );
    service.onModuleInit();
    const binding = registry.lookup("queue.idempotency.cleanup");

    expect(binding?.definition.route.physicalQueueName).toBe("notted-maintenance");
    await expect(
      binding?.handler.handle({
        outboxIntentId: "40000000-0000-4000-8000-000000000001",
        jobType: "queue.idempotency.cleanup",
        idempotencyKey: "safe-test-key",
        signal: new AbortController().signal,
        attempt: 1,
        maximumAttempts: 3,
        payload: {
          action: "queue.idempotency.cleanup",
          intentId: "40000000-0000-4000-8000-000000000001",
        },
      }),
    ).rejects.toThrow("cleanup failed");
    service.onApplicationShutdown();
    service.onModuleDestroy();
  });
});
