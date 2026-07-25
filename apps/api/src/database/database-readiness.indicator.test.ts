import { describe, expect, it, vi } from "vitest";

import { DatabaseReadinessIndicator } from "./database-readiness.indicator";

import type { DatabaseService } from "./database.service";

function createIndicator(execute: ReturnType<typeof vi.fn>): DatabaseReadinessIndicator {
  const database = { db: { execute } } as unknown as DatabaseService;
  return new DatabaseReadinessIndicator(database);
}

describe("DatabaseReadinessIndicator", () => {
  it("reports up when the health query resolves", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const indicator = createIndicator(execute);

    const result = await indicator.check();

    expect(result).toEqual({ name: "database", status: "up" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports down with a generic message when the health query rejects", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432 password="leak"'));
    const indicator = createIndicator(execute);

    const result = await indicator.check();

    expect(result).toEqual({
      name: "database",
      status: "down",
      message: "database query failed",
    });
  });

  it("does not leak the underlying error message", async () => {
    const sensitiveMessage = 'password="super-secret"';
    const execute = vi.fn().mockRejectedValue(new Error(sensitiveMessage));
    const indicator = createIndicator(execute);

    const result = await indicator.check();

    expect(JSON.stringify(result)).not.toContain(sensitiveMessage);
  });
});
