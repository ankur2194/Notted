import { describe, expect, it, vi } from "vitest";

import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import {
  AUDIT_LOG_RETENTION_KEY_PREFIX,
  AuditLogRetentionQueueService,
} from "./audit-log-retention-queue.service";

import type { AuditLogRetentionService } from "./audit-log-retention.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";

describe("durable audit-log retention execution", () => {
  it("records an identifier-only PostgreSQL intent and never purges in the scheduler", async () => {
    const values: Record<string, unknown>[] = [];
    const purgeExpired = vi.fn();
    const service = new AuditLogRetentionQueueService(
      { purgeExpired } as unknown as AuditLogRetentionService,
      new QueueHandlerRegistry(),
      {
        db: {
          insert: () => ({
            values: (value: Record<string, unknown>) => {
              values.push(value);
              return { onConflictDoNothing: () => Promise.resolve() };
            },
          }),
        },
      } as unknown as DatabaseService,
      { failure: vi.fn() } as unknown as StructuredLogger,
    );
    service.kick(new Date("2026-08-13T12:01:00.000Z"));
    await Promise.resolve();
    expect(values[0]?.idempotencyKey).toMatch(
      new RegExp(`^${AUDIT_LOG_RETENTION_KEY_PREFIX}\\d+$`, "u"),
    );
    expect(Object.keys(values[0]?.payload as object).sort()).toEqual(["action", "intentId"]);
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it("registers a system handler on maintenance and validates the outbox pointer", async () => {
    const registry = new QueueHandlerRegistry();
    const purgeExpired = vi.fn().mockResolvedValue(3);
    const service = new AuditLogRetentionQueueService(
      { purgeExpired } as unknown as AuditLogRetentionService,
      registry,
      {} as DatabaseService,
      {} as StructuredLogger,
    );
    service.onModuleInit();
    const binding = registry.lookup("audit.log.retention.sweep");
    expect(binding?.definition).toMatchObject({
      authority: "system",
      route: { physicalQueueName: "notted-maintenance" },
    });
    await binding?.handler.handle({
      outboxIntentId: "40000000-0000-4000-8000-000000000001",
      jobType: "audit.log.retention.sweep",
      idempotencyKey: "period",
      signal: new AbortController().signal,
      attempt: 1,
      maximumAttempts: 3,
      payload: {
        action: "audit.log.retention.sweep",
        intentId: "40000000-0000-4000-8000-000000000001",
      },
    });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    service.onApplicationShutdown();
    service.onModuleDestroy();
  });

  it("rejects a payload whose intentId does not match the outbox intent", async () => {
    const registry = new QueueHandlerRegistry();
    const purgeExpired = vi.fn();
    const service = new AuditLogRetentionQueueService(
      { purgeExpired } as unknown as AuditLogRetentionService,
      registry,
      {} as DatabaseService,
      {} as StructuredLogger,
    );
    await expect(
      service.handle({
        outboxIntentId: "40000000-0000-4000-8000-000000000001",
        jobType: "audit.log.retention.sweep",
        idempotencyKey: "period",
        signal: new AbortController().signal,
        attempt: 1,
        maximumAttempts: 3,
        payload: {
          action: "audit.log.retention.sweep",
          intentId: "40000000-0000-4000-8000-000000000002",
        },
      }),
    ).rejects.toMatchObject({ reasonCode: "payload_invalid" });
    expect(purgeExpired).not.toHaveBeenCalled();
  });
});
