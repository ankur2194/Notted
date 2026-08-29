/**
 * The SQLSTATE of a PostgreSQL failure, unwrapped from whatever it arrives in.
 *
 * Drizzle wraps driver errors, and `pg` sometimes nests them again, so the code
 * can sit several `cause` levels down. This walks the chain without trusting the
 * shape and guards against a cycle.
 *
 * Deliberately free of imports so the schema-only test suites that pull it in
 * through `test/database-test-helpers.ts` do not drag in `@nestjs/common` and
 * the schema barrel with it.
 */
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

/**
 * SQLSTATEs PostgreSQL defines as "the transaction was aborted through no fault
 * of its own; retry it".
 *
 * `40001` serialization_failure and `40P01` deadlock_detected, and nothing else.
 * A unique violation or a check constraint would fail identically on every
 * attempt, so retrying those would only multiply the work before the same error.
 */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code !== null && RETRYABLE_SQLSTATES.has(code);
}
