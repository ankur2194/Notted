import { describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DatabaseService } from "../database/database.service";
import { SmtpService } from "../infrastructure/smtp/smtp.service";

import { AuthEmailEncryptionService } from "./auth-email-encryption.service";
import { AuthEmailWorkerService } from "./auth-email-worker.service";

import type { AuthEmailQueueConfig } from "../config/auth-email-queue.config";

describe("AuthEmailWorkerService duplicate protection", () => {
  it("does not decrypt or send an already terminal delivery", async () => {
    const row = {
      intent: {
        id: "00000000-0000-4000-8000-000000000021",
        status: "sent",
        expiresAt: new Date(Date.now() + 60_000),
      },
      delivery: { id: "00000000-0000-4000-8000-000000000022" },
    };
    const limit = vi.fn().mockResolvedValue([row]);
    const database = {
      db: {
        select: () => ({
          from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }),
        }),
      },
    };
    const encryption = { decrypt: vi.fn() };
    const smtp = { send: vi.fn() };
    const logger = { info: vi.fn(), failure: vi.fn() };
    const config: AuthEmailQueueConfig = {
      queueName: "auth-email",
      payloadVersion: 1,
      dispatcherIntervalMs: 1_000,
      concurrency: 1,
      attempts: 3,
      retryBackoffMs: 1_000,
      idempotencyRetentionDays: 7,
    };
    const worker = new AuthEmailWorkerService(
      database as unknown as DatabaseService,
      encryption as unknown as AuthEmailEncryptionService,
      smtp as unknown as SmtpService,
      logger as unknown as StructuredLogger,
      config,
    );

    await worker.process(row.intent.id, false);
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
  });
});
