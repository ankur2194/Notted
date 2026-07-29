import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { expect } from "vitest";

/** Normalize inline `.primaryKey()` columns and table-level composite keys. */
export function primaryKeyColumns(table: PgTable): string[][] {
  const config = getTableConfig(table);
  const inline = config.columns.filter((column) => column.primary).map((column) => [column.name]);
  const tableLevel = config.primaryKeys.map((key) => key.columns.map((column) => column.name));
  return [...inline, ...tableLevel];
}

/** Drizzle wraps driver failures; walk nested causes without trusting shape. */
export function postgresErrorCode(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<object>();

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

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
