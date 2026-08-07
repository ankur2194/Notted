// Part 45 — the unattended sweep driver.
//
// Four behaviours are load-bearing and all four are asserted here:
//
//   - OFF by default, so the sweeps stay out of the test suites and the
//     disposable e2e stack with no test-only branch in production code,
//   - the timer is `unref`'d, so a pending sweep never holds the event loop
//     (and therefore `pnpm test` and a container stop) open,
//   - a re-entrancy flag keeps two passes from overlapping in one process,
//   - a sweep failure is caught and logged WITHOUT interpolating the reason,
//     because a storage client's exception message can carry a key or endpoint.
//
// `setInterval`/`clearInterval` are intercepted so the registered handler,
// the `unref()` call, and the shutdown `clearInterval` are all directly
// observable; one test instead advances genuine fake timers to prove the
// interval really fires.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseStorageConfig } from "../config/storage.config";

import { StorageMaintenanceScheduler } from "./storage-maintenance.scheduler";

import type { StorageMaintenanceService } from "./storage-maintenance.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { StorageMaintenanceReport } from "@notted/shared-types";

const INTERVAL_MS = 60_000;

const enabledEnvironment = {
  STORAGE_MAINTENANCE_ENABLED: "true",
  STORAGE_MAINTENANCE_INTERVAL_MS: String(INTERVAL_MS),
  STORAGE_MAINTENANCE_DRY_RUN: "true",
};

const emptyReport: StorageMaintenanceReport = Object.freeze({
  startedAt: "2026-08-07T12:00:00.000Z",
  finishedAt: "2026-08-07T12:00:00.000Z",
  dryRun: true,
  scope: "system",
  sweeps: Object.freeze([]),
});

/** Microtask drain: the scheduler starts its pass with `void promise.finally()`. */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function build(environment: Readonly<Record<string, string>> = {}) {
  const runSystemSweeps = vi.fn().mockResolvedValue(emptyReport);
  const maintenance = { runSystemSweeps } as unknown as StorageMaintenanceService;
  const logger = { info: vi.fn(), failure: vi.fn(), warn: vi.fn() } as unknown as StructuredLogger;
  const config = parseStorageConfig(environment);
  const scheduler = new StorageMaintenanceScheduler(maintenance, logger, config);
  return { scheduler, runSystemSweeps, logger, config };
}

interface CapturedTimer {
  readonly handler: () => void;
  readonly intervalMs: number;
  unrefCount: number;
}

/**
 * Replaces the timer functions with observable stand-ins. Driving the tick by
 * calling the captured handler keeps every assertion independent of the fake
 * timer implementation's internal timer object.
 */
function captureTimers() {
  const timers: CapturedTimer[] = [];
  const cleared: unknown[] = [];
  const tokens: unknown[] = [];

  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    intervalMs?: number,
  ) => {
    const entry: CapturedTimer = { handler, intervalMs: intervalMs ?? 0, unrefCount: 0 };
    timers.push(entry);
    const token = {
      unref: () => {
        entry.unrefCount += 1;
        return token;
      },
      ref: () => token,
    };
    tokens.push(token);
    return token as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval);

  vi.spyOn(globalThis, "clearInterval").mockImplementation(((token: unknown) => {
    cleared.push(token);
  }) as unknown as typeof globalThis.clearInterval);

  return { timers, cleared, tokens };
}

describe("StorageMaintenanceScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules nothing at all when maintenance is disabled, which is the default", async () => {
    expect(parseStorageConfig({}).maintenanceEnabled).toBe(false);

    const captured = captureTimers();
    const context = build();
    context.scheduler.onModuleInit();

    expect(captured.timers).toEqual([]);
    // A direct kick is refused too, so nothing can start the sweeps by accident.
    context.scheduler.kick();
    await flush();
    expect(context.runSystemSweeps).not.toHaveBeenCalled();
  });

  it("registers one unref'd interval at the configured period", () => {
    const captured = captureTimers();
    const context = build(enabledEnvironment);
    context.scheduler.onModuleInit();

    expect(captured.timers).toHaveLength(1);
    expect(captured.timers[0]?.intervalMs).toBe(INTERVAL_MS);
    // `.unref()` is what keeps a pending timer from holding the event loop open.
    expect(captured.timers[0]?.unrefCount).toBe(1);
  });

  it("does NOT run a destructive pass during boot", async () => {
    const captured = captureTimers();
    const context = build(enabledEnvironment);
    context.scheduler.onModuleInit();
    await flush();

    // Unlike the auth email dispatcher, cleanup is not latency-sensitive, and
    // running it on every boot and rolling restart is the worse trade.
    expect(context.runSystemSweeps).not.toHaveBeenCalled();
    captured.timers[0]?.handler();
    await flush();
    expect(context.runSystemSweeps).toHaveBeenCalledOnce();
  });

  it("actually fires on the interval when real timers advance", async () => {
    // No timer interception here: this proves the registration itself works.
    const context = build(enabledEnvironment);
    context.scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(2);

    context.scheduler.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(2);
  });

  it("passes the configured dry-run mode to every scheduled pass", async () => {
    const captured = captureTimers();
    const reporting = build(enabledEnvironment);
    reporting.scheduler.onModuleInit();
    captured.timers[0]?.handler();
    await flush();
    expect(reporting.runSystemSweeps).toHaveBeenCalledWith({ dryRun: true });

    const destructive = build({ ...enabledEnvironment, STORAGE_MAINTENANCE_DRY_RUN: "false" });
    destructive.scheduler.onModuleInit();
    captured.timers[1]?.handler();
    await flush();
    expect(destructive.runSystemSweeps).toHaveBeenCalledWith({ dryRun: false });
  });

  it("refuses a second pass while one is still in flight", async () => {
    const context = build(enabledEnvironment);
    let release: (() => void) | undefined;
    context.runSystemSweeps.mockImplementation(
      () =>
        new Promise<StorageMaintenanceReport>((resolve) => {
          release = () => resolve(emptyReport);
        }),
    );

    context.scheduler.kick();
    context.scheduler.kick();
    context.scheduler.kick();
    await flush();
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(1);

    // Once the in-flight pass settles the flag is released and the next tick
    // starts a fresh pass.
    release?.();
    await flush();
    context.scheduler.kick();
    await flush();
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(2);
  });

  it("releases the re-entrancy flag even when the pass fails", async () => {
    const context = build(enabledEnvironment);
    context.runSystemSweeps.mockRejectedValue(new Error("boom"));

    context.scheduler.kick();
    await flush();
    context.scheduler.kick();
    await flush();
    expect(context.runSystemSweeps).toHaveBeenCalledTimes(2);
  });

  it("clears the interval on shutdown, and tolerates a shutdown with no interval", () => {
    const captured = captureTimers();
    const context = build(enabledEnvironment);
    context.scheduler.onModuleInit();
    context.scheduler.onApplicationShutdown();
    expect(captured.cleared).toEqual([captured.tokens[0]]);

    // A scheduler that never started (maintenance disabled) must not call
    // `clearInterval(undefined)` on the way down.
    const disabled = build();
    disabled.scheduler.onModuleInit();
    disabled.scheduler.onApplicationShutdown();
    expect(captured.cleared).toHaveLength(1);
  });

  it("swallows a sweep failure and logs it WITHOUT the raw reason", async () => {
    const context = build(enabledEnvironment);
    // A realistic storage exception: the message carries an object key.
    const leaky = new Error(
      "NoSuchKey: w/11111111-1111-4111-8111-111111111111/a/original/deadbeef.png at https://minio.internal:9000",
    );
    context.runSystemSweeps.mockRejectedValue(leaky);

    expect(() => {
      context.scheduler.kick();
    }).not.toThrow();
    await flush();

    const failure = vi.mocked(context.logger.failure);
    expect(failure).toHaveBeenCalledWith(
      { outcome: "error", reason: "storage_maintenance" },
      "Scheduled storage maintenance failed",
    );
    const logged = JSON.stringify(failure.mock.calls);
    for (const fragment of ["NoSuchKey", "w/1111", "deadbeef", "minio.internal", "https://"]) {
      expect(logged).not.toContain(fragment);
    }
  });
});
