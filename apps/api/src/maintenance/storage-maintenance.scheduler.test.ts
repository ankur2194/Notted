import { afterEach, describe, expect, it, vi } from "vitest";

import { parseStorageConfig } from "../config/storage.config";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { StorageMaintenanceQueueHandler } from "./storage-maintenance-queue-handler.service";
import {
  STORAGE_MAINTENANCE_IDEMPOTENCY_PREFIX,
  StorageMaintenanceScheduler,
} from "./storage-maintenance.scheduler";

import type { StorageMaintenanceService } from "./storage-maintenance.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";

const config = parseStorageConfig({
  STORAGE_MAINTENANCE_ENABLED: "true",
  STORAGE_MAINTENANCE_INTERVAL_MS: "60000",
  STORAGE_MAINTENANCE_DRY_RUN: "true",
});

afterEach(() => vi.restoreAllMocks());

describe("durable storage maintenance scheduling", () => {
  it("writes strict identifier-only intents with one deterministic key per period", async () => {
    const inserted: unknown[] = [];
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const database = {
      db: {
        insert: () => ({
          values: (value: unknown) => {
            inserted.push(value);
            return { onConflictDoNothing };
          },
        }),
      },
    };
    const scheduler = new StorageMaintenanceScheduler(
      database as unknown as DatabaseService,
      { failure: vi.fn() } as unknown as StructuredLogger,
      config,
    );

    scheduler.kick(new Date("2026-08-11T10:00:01.000Z"));
    scheduler.kick(new Date("2026-08-11T10:00:59.000Z"));
    await Promise.resolve();
    await Promise.resolve();

    expect(inserted).toHaveLength(2);
    const first = inserted[0] as { payload: Record<string, unknown>; idempotencyKey: string };
    const second = inserted[1] as { payload: Record<string, unknown>; idempotencyKey: string };
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toMatch(
      new RegExp(`^${STORAGE_MAINTENANCE_IDEMPOTENCY_PREFIX}\\d+$`, "u"),
    );
    expect(Object.keys(first.payload).sort()).toEqual(["action", "intentId"]);
    expect(first.payload).toMatchObject({ action: "storage.maintenance.sweep" });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
  });

  it("uses a new idempotency key in the next period", async () => {
    const keys: string[] = [];
    const database = {
      db: {
        insert: () => ({
          values: (value: { idempotencyKey: string }) => {
            keys.push(value.idempotencyKey);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        }),
      },
    };
    const scheduler = new StorageMaintenanceScheduler(
      database as unknown as DatabaseService,
      { failure: vi.fn() } as unknown as StructuredLogger,
      config,
    );
    scheduler.kick(new Date("2026-08-11T10:00:59.000Z"));
    scheduler.kick(new Date("2026-08-11T10:01:00.000Z"));
    await Promise.resolve();
    expect(new Set(keys).size).toBe(2);
  });

  it("registers a maintenance-lane handler that takes dry-run authority from server config", async () => {
    const registry = new QueueHandlerRegistry();
    const runSystemSweeps = vi.fn().mockResolvedValue(undefined);
    const handler = new StorageMaintenanceQueueHandler(
      { runSystemSweeps } as unknown as StorageMaintenanceService,
      registry,
      config,
    );
    handler.onModuleInit();
    const binding = registry.lookup("storage.maintenance.sweep");
    expect(binding?.definition.route.physicalQueueName).toBe("notted-maintenance");
    await binding?.handler.handle({
      outboxIntentId: "40000000-0000-4000-8000-000000000001",
      jobType: "storage.maintenance.sweep",
      idempotencyKey: "ignored-by-business-handler",
      signal: new AbortController().signal,
      payload: {
        action: "storage.maintenance.sweep",
        intentId: "40000000-0000-4000-8000-000000000001",
      },
    });
    expect(runSystemSweeps).toHaveBeenCalledWith({ dryRun: true });
  });
});
