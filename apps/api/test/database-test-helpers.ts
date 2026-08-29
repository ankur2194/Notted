import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { expect } from "vitest";

/*
 * The shared PostgreSQL gate for every database-backed suite.
 *
 * THE DEFECT THIS REPLACES. Thirty-three files had each copied their own
 * `reachable` / `isDatabaseReachable`, all with a 2 000 ms connect budget and
 * all ending `catch { return false }` then `skip(...)`. That collapses two
 * different situations into one green result:
 *
 *   DATABASE_URL unset            -> "no stack here"   -> skipping is RIGHT
 *   DATABASE_URL set, no answer   -> "stack is broken" -> skipping is a LIE
 *
 * On a memory-capped host the second is routine: a cold `postgres` container
 * answers in well over 2 000 ms, so the probe failed where the database would
 * have worked, and a full test pyramid quietly reduced to its unit layer while
 * the run still printed green. `test/integration-gates.test.ts` named this
 * exact helper as the fix.
 *
 * So the two layers stay, and the second one inverts:
 *
 *   describe.skipIf(!HAS_DATABASE)   -> not configured at all
 *   await requireDatabase()          -> configured but silent: THROW
 *
 * 10 000 ms, not 2 000: the probe runs once per file in `beforeAll`, and
 * `vitest.config.ts` sets `fileParallelism: !hasDatabase`, so with a database
 * configured the files serialize and at most one probe is ever in flight — the
 * worst case is 10 s for the whole run, not 10 s per file. `hookTimeout` is
 * 180 000 ms, so this still fails fast against a genuinely dead database.
 */

const DATABASE_URL = (process.env.DATABASE_URL ?? "").trim();
const PROBE_TIMEOUT_MS = 10_000;

/** True when a database is configured at all. The `describe.skipIf` predicate. */
export const HAS_DATABASE = DATABASE_URL !== "";

/**
 * Resolves to the configured connection string once PostgreSQL has answered.
 *
 * Throws — never skips — when `DATABASE_URL` is set and the server does not
 * answer, because at that point the suite was meant to run and did not.
 */
export async function requireDatabase(): Promise<string> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return DATABASE_URL;
  } catch (cause) {
    throw new Error(
      `DATABASE_URL is set but PostgreSQL did not answer within ${PROBE_TIMEOUT_MS} ms. ` +
        "The stack is meant to be up (`pnpm infra:up:ports`); a skipped suite here would " +
        "report green for tests that never ran.",
      { cause },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Normalize inline `.primaryKey()` columns and table-level composite keys. */
export function primaryKeyColumns(table: PgTable): string[][] {
  const config = getTableConfig(table);
  const inline = config.columns.filter((column) => column.primary).map((column) => [column.name]);
  const tableLevel = config.primaryKeys.map((key) => key.columns.map((column) => column.name));
  return [...inline, ...tableLevel];
}

/*
 * Re-exported, not duplicated. This moved to `src/database/postgres-error-code.ts`
 * when `DatabaseService.transaction` started needing it to recognise a
 * retryable serialisation failure — the same unwrapping, and two copies of it
 * would drift the moment one learned about a new nesting level.
 */
export { postgresErrorCode } from "../src/database/postgres-error-code";

import { postgresErrorCode } from "../src/database/postgres-error-code";

export async function expectPostgresErrorCode(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected PostgreSQL error ${expectedCode}, but the operation succeeded.`);
  } catch (error: unknown) {
    const actualCode = postgresErrorCode(error);
    if (actualCode === null) {
      throw error;
    }
    expect(actualCode).toBe(expectedCode);
  }
}
