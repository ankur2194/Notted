import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DOMAIN_JOB_TYPES } from "./job-identifiers";
import { registeredJobDefinition } from "./job-registry";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import { PHYSICAL_QUEUE_NAMES } from "./queue-names";
import { QueueWorkerProcessorService } from "./queue-worker-processor.service";

import type {
  QueueInfrastructureService,
  QueueWorkerInvocation,
} from "./queue-infrastructure.service";
import type { QueueOutboxRepository } from "./queue-outbox.repository";
import type { OutboxRuntimeRow } from "./queue-runtime.types";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { QueueConfig } from "../config/queue.config";

const OUTBOX_ID = "10000000-0000-4000-8000-000000000001";
const payload = {
  action: DOMAIN_JOB_TYPES.noteCreated,
  intentId: OUTBOX_ID,
  workspaceId: "20000000-0000-4000-8000-000000000001",
  resourceIds: ["30000000-0000-4000-8000-000000000001"],
  actorId: "40000000-0000-4000-8000-000000000001",
} as const;
const runtimeRow: OutboxRuntimeRow = {
  id: OUTBOX_ID,
  queueName: "note-domain-events",
  jobType: DOMAIN_JOB_TYPES.noteCreated,
  payloadVersion: 1,
  payload,
  payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  idempotencyKey: "note-created:test",
  status: "dispatched",
  attemptCount: 0,
  correlationId: null,
};
const invocation: QueueWorkerInvocation = {
  sourceQueue: PHYSICAL_QUEUE_NAMES.default,
  envelope: { outboxIntentId: OUTBOX_ID },
  bullJobId: OUTBOX_ID,
  attempt: 3,
  maximumAttempts: 3,
};

function config(timeoutMs = 1): QueueConfig {
  const worker = { concurrency: 1, timeoutMs };
  return {
    attempts: 3,
    backoff: { baseMs: 100, maximumMs: 1_000, jitter: 0.2 },
    dispatcher: { intervalMs: 1_000, batchSize: 10, staleClaimMs: 30_000 },
    workers: {
      [PHYSICAL_QUEUE_NAMES.default]: worker,
      [PHYSICAL_QUEUE_NAMES.export]: worker,
      [PHYSICAL_QUEUE_NAMES.ai]: worker,
      [PHYSICAL_QUEUE_NAMES.maintenance]: worker,
    },
    aiProviderLimits: {
      openAi: { maximum: 1, durationMs: 1_000 },
      claude: { maximum: 1, durationMs: 1_000 },
    },
    idempotencyRetentionDays: 30,
    outboxRetentionDays: 30,
    retention: {
      completedAgeSeconds: 60,
      completedCount: 10,
      failedAgeSeconds: 60,
      failedCount: 10,
    },
    shutdownGraceMs: 100,
  };
}

function setup(
  claim: "claimed" | "completed" | "reconciliation_required" = "claimed",
  timeoutMs = 1,
) {
  const repository = {
    load: vi.fn().mockResolvedValue(runtimeRow),
    claimExecution: vi.fn().mockResolvedValue(claim),
    completeExecution: vi.fn().mockResolvedValue(undefined),
    releaseExecution: vi.fn().mockResolvedValue(undefined),
    requireReconciliation: vi.fn().mockResolvedValue(undefined),
    recordRetry: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const infrastructure = { publishDeadLetter: vi.fn().mockResolvedValue(undefined) };
  const handlers = new QueueHandlerRegistry();
  const definition = registeredJobDefinition(DOMAIN_JOB_TYPES.noteCreated);
  if (definition === undefined) throw new Error("test definition missing");
  const handle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  handlers.register({ definition, handler: { jobType: definition.jobType, handle } });
  const processor = new QueueWorkerProcessorService(
    config(timeoutMs),
    repository as unknown as QueueOutboxRepository,
    handlers,
    infrastructure as unknown as QueueInfrastructureService,
    { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
  );
  return { handle, infrastructure, processor, repository };
}

describe("QueueWorkerProcessorService", () => {
  it("short-circuits a completed duplicate without invoking its concrete handler", async () => {
    const context = setup("completed");
    await context.processor.process(invocation);
    expect(context.handle).not.toHaveBeenCalled();
  });

  it("permanently rejects route, version, and payload-hash mismatches", async () => {
    for (const changed of [
      { ...runtimeRow, payloadVersion: 2 },
      { ...runtimeRow, payloadHash: "0".repeat(64) },
    ]) {
      const context = setup("completed");
      context.repository.load.mockResolvedValueOnce(changed);
      await expect(context.processor.process(invocation)).rejects.toThrow();
      expect(context.repository.markFailed).toHaveBeenCalled();
      expect(context.infrastructure.publishDeadLetter).toHaveBeenCalledWith(
        expect.not.objectContaining({ payload: expect.anything(), result: expect.anything() }),
      );
    }
    const wrongRoute = setup("completed");
    await expect(
      wrongRoute.processor.process({
        ...invocation,
        sourceQueue: PHYSICAL_QUEUE_NAMES.export,
      }),
    ).rejects.toThrow();
    expect(wrongRoute.repository.markFailed).toHaveBeenCalledWith(runtimeRow, "route_invalid");
  });

  it("bounds handler waiting, marks retry exhaustion, and emits one redacted DLQ identity", async () => {
    const context = setup();
    context.handle.mockReturnValueOnce(new Promise<void>(() => undefined));

    await expect(context.processor.process(invocation)).rejects.toThrow();
    expect(context.repository.requireReconciliation).toHaveBeenCalledWith(
      runtimeRow,
      "processor_timeout",
    );
    expect(context.infrastructure.publishDeadLetter).toHaveBeenCalledWith({
      sourceQueue: PHYSICAL_QUEUE_NAMES.default,
      outboxIntentId: OUTBOX_ID,
      jobType: DOMAIN_JOB_TYPES.noteCreated,
      reasonCode: "processor_timeout",
      attempts: 3,
      failedAt: expect.any(String),
    });
  });

  it("does not release replay protection when uncancellable work completes after timeout", async () => {
    const context = setup();
    let completeLate: (() => void) | undefined;
    context.handle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        completeLate = resolve;
      }),
    );
    await expect(context.processor.process({ ...invocation, attempt: 1 })).rejects.toThrow();
    completeLate?.();
    await Promise.resolve();
    expect(context.repository.releaseExecution).not.toHaveBeenCalled();
    expect(context.repository.completeExecution).not.toHaveBeenCalled();
    expect(context.repository.requireReconciliation).toHaveBeenCalledTimes(1);
  });
});
