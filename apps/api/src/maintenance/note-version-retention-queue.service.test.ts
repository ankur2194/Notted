import { describe, expect, it, vi } from "vitest";

import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import {
  NOTE_VERSION_RETENTION_KEY_PREFIX,
  NoteVersionRetentionQueueService,
} from "./note-version-retention-queue.service";

import type { NoteVersionRetentionService } from "./note-version-retention.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";

describe("durable note-version retention execution", () => {
  it("records an identifier-only PostgreSQL intent and never purges in the scheduler", async () => {
    const values: Record<string, unknown>[] = [];
    const purgeExpired = vi.fn();
    const service = new NoteVersionRetentionQueueService(
      { purgeExpired } as unknown as NoteVersionRetentionService,
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
      new RegExp(`^${NOTE_VERSION_RETENTION_KEY_PREFIX}\\d+$`, "u"),
    );
    expect(Object.keys(values[0]?.payload as object).sort()).toEqual(["action", "intentId"]);
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it("registers a system handler on maintenance and validates the outbox pointer", async () => {
    const registry = new QueueHandlerRegistry();
    const purgeExpired = vi.fn().mockResolvedValue(3);
    const service = new NoteVersionRetentionQueueService(
      { purgeExpired } as unknown as NoteVersionRetentionService,
      registry,
      {} as DatabaseService,
      {} as StructuredLogger,
    );
    service.onModuleInit();
    const binding = registry.lookup("note.version.retention.sweep");
    expect(binding?.definition).toMatchObject({
      authority: "system",
      route: { physicalQueueName: "notted-maintenance" },
    });
    await binding?.handler.handle({
      outboxIntentId: "40000000-0000-4000-8000-000000000001",
      jobType: "note.version.retention.sweep",
      idempotencyKey: "period",
      signal: new AbortController().signal,
      attempt: 1,
      maximumAttempts: 3,
      payload: {
        action: "note.version.retention.sweep",
        intentId: "40000000-0000-4000-8000-000000000001",
      },
    });
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    service.onApplicationShutdown();
    service.onModuleDestroy();
  });
});
