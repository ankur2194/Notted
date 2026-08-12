import { describe, expect, it, vi } from "vitest";

import { QueueLifecycleService } from "./queue-lifecycle.service";
import { PHYSICAL_QUEUE_NAMES } from "./queue-names";

import type { OutboxDispatcherService } from "./outbox-dispatcher.service";
import type { QueueHandlerRegistry } from "./queue-handler-registry.service";
import type { QueueInfrastructureService } from "./queue-infrastructure.service";
import type { QueueWorkerProcessorService } from "./queue-worker-processor.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { QueueConfig } from "../config/queue.config";

describe("QueueLifecycleService", () => {
  it("rejects malformed injected export concurrency before starting infrastructure", async () => {
    const worker = { concurrency: 1, timeoutMs: 1_000 };
    const config = {
      dispatcher: { intervalMs: 60_000, batchSize: 10, staleClaimMs: 120_000 },
      workers: {
        [PHYSICAL_QUEUE_NAMES.default]: worker,
        [PHYSICAL_QUEUE_NAMES.export]: { ...worker, concurrency: 3 },
        [PHYSICAL_QUEUE_NAMES.ai]: worker,
        [PHYSICAL_QUEUE_NAMES.maintenance]: worker,
      },
      shutdownGraceMs: 100,
    } as QueueConfig;
    const infrastructure = { start: vi.fn() };
    const lifecycle = new QueueLifecycleService(
      config,
      infrastructure as unknown as QueueInfrastructureService,
      { activePhysicalQueues: vi.fn() } as unknown as QueueHandlerRegistry,
      {} as OutboxDispatcherService,
      {} as QueueWorkerProcessorService,
      { failure: vi.fn() } as unknown as StructuredLogger,
    );

    await expect(lifecycle.onApplicationBootstrap()).rejects.toThrow(
      "export concurrency invariant",
    );
    expect(infrastructure.start).not.toHaveBeenCalled();
  });

  it("stops claims before pausing and closes owned resources within shutdown", async () => {
    const calls: string[] = [];
    const worker = { concurrency: 1, timeoutMs: 1_000 };
    const config = {
      dispatcher: { intervalMs: 60_000, batchSize: 10, staleClaimMs: 120_000 },
      workers: {
        [PHYSICAL_QUEUE_NAMES.default]: worker,
        [PHYSICAL_QUEUE_NAMES.export]: { ...worker, concurrency: 2 },
        [PHYSICAL_QUEUE_NAMES.ai]: worker,
        [PHYSICAL_QUEUE_NAMES.maintenance]: worker,
      },
      shutdownGraceMs: 100,
    } as QueueConfig;
    const infrastructure = {
      start: vi.fn().mockResolvedValue(true),
      beginShutdown: vi.fn(() => calls.push("begin")),
      pauseWorkers: vi.fn(async () => calls.push("pause")),
      close: vi.fn(async () => calls.push("close")),
    };
    const dispatcher = {
      dispatchOnce: vi.fn().mockResolvedValue(undefined),
      stopClaiming: vi.fn(() => calls.push("stop-claims")),
    };
    const lifecycle = new QueueLifecycleService(
      config,
      infrastructure as unknown as QueueInfrastructureService,
      { activePhysicalQueues: vi.fn().mockReturnValue([]) } as unknown as QueueHandlerRegistry,
      dispatcher as unknown as OutboxDispatcherService,
      { process: vi.fn() } as unknown as QueueWorkerProcessorService,
      { failure: vi.fn() } as unknown as StructuredLogger,
    );

    await lifecycle.onApplicationBootstrap();
    await lifecycle.onApplicationShutdown();
    expect(calls).toEqual(["stop-claims", "begin", "pause", "close"]);
    expect(infrastructure.close).toHaveBeenCalledOnce();
  });
});
