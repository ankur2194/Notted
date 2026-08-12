import { describe, expect, it, vi } from "vitest";

import { QueueAdminRemediationService } from "./queue-admin-remediation.service";

import type { QueueInfrastructureService } from "./queue-infrastructure.service";
import type { DatabaseService } from "../database/database.service";

const principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  method: "opaque-session" as const,
  assurance: "single-factor" as const,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  authenticatedAt: new Date().toISOString(),
  isFresh: true,
};

describe("QueueAdminRemediationService", () => {
  it("validates the physical failed job and transactionally audits and reopens durable state", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "job-1", idempotencyKey: "safe-key", jobType: "note.created" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "33333333-3333-4333-8333-333333333333" }] })
      .mockResolvedValue({ rows: [] });
    const database = {
      transaction: (work: (tx: { execute: typeof execute }) => unknown) => work({ execute }),
    } as unknown as DatabaseService;
    const infrastructure = {
      administrativeJobState: vi.fn().mockResolvedValue("failed"),
    } as unknown as QueueInfrastructureService;
    const service = new QueueAdminRemediationService(database, infrastructure);

    await expect(
      service.prepareRetry({
        queueName: "notted-default",
        jobId: "job-1",
        requestId: "44444444-4444-4444-8444-444444444444",
        operator: principal,
      }),
    ).resolves.toEqual({
      requestId: "44444444-4444-4444-8444-444444444444",
      auditId: "33333333-3333-4333-8333-333333333333",
    });
    expect(infrastructure.administrativeJobState).toHaveBeenCalledWith("notted-default", "job-1");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("denies cleanup/DLQ replay and missing physical failed jobs before PostgreSQL mutation", async () => {
    const database = { transaction: vi.fn() } as unknown as DatabaseService;
    const infrastructure = {
      administrativeJobState: vi.fn().mockResolvedValue("completed"),
    } as unknown as QueueInfrastructureService;
    const service = new QueueAdminRemediationService(database, infrastructure);
    await expect(
      service.prepareRetry({
        queueName: "notted-dead-letter",
        jobId: "job-1",
        requestId: "44444444-4444-4444-8444-444444444444",
        operator: principal,
      }),
    ).rejects.toThrow("DENIED");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
