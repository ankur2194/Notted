import { describe, expect, it, vi } from "vitest";

import { DatabaseService, type Database } from "./database.service";

import type { Pool } from "pg";

function createService(transaction: ReturnType<typeof vi.fn>): {
  service: DatabaseService;
  pool: Pool;
  db: Database;
} {
  const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
  const db = { transaction } as unknown as Database;
  const service = new DatabaseService(pool, db);
  return { service, pool, db };
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

  it("closes the pool on module destruction", async () => {
    const transaction = vi.fn();
    const { service, pool } = createService(transaction);

    await service.onModuleDestroy();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
