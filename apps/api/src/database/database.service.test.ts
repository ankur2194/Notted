import { describe, expect, it, vi } from "vitest";

import { DatabaseService, type Database } from "./database.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { Pool } from "pg";

function createService(transaction: ReturnType<typeof vi.fn>): {
  service: DatabaseService;
  pool: Pool;
  db: Database;
  logger: { warning: ReturnType<typeof vi.fn> };
} {
  const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
  const db = { transaction } as unknown as Database;
  const logger = { warning: vi.fn() };
  const service = new DatabaseService(pool, db, logger as unknown as StructuredLogger);
  return { service, pool, db, logger };
}

/** SQLSTATE-carrying failures, shaped the way `pg` actually throws them. */
function sqlstate(code: string): Error {
  return Object.assign(new Error(`postgres error ${code}`), { code });
}

describe("DatabaseService", () => {
  it("delegates transactions to the underlying drizzle handle", async () => {
    const transaction = vi.fn(async (work: (tx: never) => Promise<number>) => work({} as never));
    const { service, db } = createService(transaction);

    const result = await service.transaction(async () => 42);

    expect(result).toBe(42);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("forwards the optional transaction config", async () => {
    const transaction = vi.fn(async (work: (tx: never) => Promise<void>, config?: unknown) => {
      void work;
      void config;
    });
    const { service } = createService(transaction);

    await service.transaction(async () => undefined, { isolationLevel: "serializable" });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
    });
  });

  /*
   * The pool closes in the LAST shutdown phase, not the first.
   *
   * Nest runs `onModuleDestroy` -> `beforeApplicationShutdown` -> `dispose` ->
   * `onApplicationShutdown`. Closing at `onModuleDestroy` shut the database
   * before any other hook had run, which is why
   * `NoteCollaborationProjectionService` could not honour ADR 0004's
   * flush-on-shutdown rule — its flush could only ever have hit a dead pool.
   */
  it("closes the pool in the last shutdown phase, not the first", async () => {
    const transaction = vi.fn();
    const { service, pool } = createService(transaction);

    await service.onApplicationShutdown();

    expect(pool.end).toHaveBeenCalledTimes(1);
    // The old hook must be gone, or both fire and the ordering means nothing.
    expect((service as unknown as { onModuleDestroy?: unknown }).onModuleDestroy).toBeUndefined();
  });
});

describe("DatabaseService serialisation retry", () => {
  /*
   * THE DEFECT THIS BLOCK EXISTS FOR. Eighteen call sites ask for `serializable`,
   * whose contract is explicitly "the client retries on 40001" — and nothing
   * implemented the client half. Two people creating a folder in the same
   * workspace at the same moment produced a 500 for whichever lost, over a
   * conflict neither caused and both would win on a second attempt.
   */
  it("retries a serialisation failure and returns the second attempt's result", async () => {
    let calls = 0;
    const transaction = vi.fn(async (work: (tx: never) => Promise<string>) => {
      calls += 1;
      if (calls === 1) throw sqlstate("40001");
      return work({} as never);
    });
    const { service, db } = createService(transaction);

    await expect(service.transaction(async () => "ok")).resolves.toBe("ok");
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it("retries a deadlock the same way", async () => {
    let calls = 0;
    const transaction = vi.fn(async (work: (tx: never) => Promise<string>) => {
      calls += 1;
      if (calls === 1) throw sqlstate("40P01");
      return work({} as never);
    });
    const { service, db } = createService(transaction);

    await expect(service.transaction(async () => "ok")).resolves.toBe("ok");
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  /** Bounded, so hot-row contention surfaces as an error, not pool exhaustion. */
  it("gives up after three attempts and reports the exhaustion once", async () => {
    const transaction = vi.fn(async () => {
      throw sqlstate("40001");
    });
    const { service, db, logger } = createService(transaction);

    await expect(service.transaction(async () => "never")).rejects.toMatchObject({ code: "40001" });
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(logger.warning).toHaveBeenCalledTimes(1);
  });

  /*
   * A unique violation would fail identically on every attempt, so retrying it
   * only multiplies the work before the same error — and hides a real conflict
   * behind a delay.
   */
  it("does not retry an error the transaction caused itself", async () => {
    const transaction = vi.fn(async () => {
      throw sqlstate("23505");
    });
    const { service, db, logger } = createService(transaction);

    await expect(service.transaction(async () => "never")).rejects.toMatchObject({ code: "23505" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(logger.warning).not.toHaveBeenCalled();
  });
});
