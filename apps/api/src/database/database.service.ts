import { setTimeout } from "node:timers/promises";

import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";

import { DATABASE, DATABASE_POOL } from "./database.tokens";
import { isRetryableTransactionError } from "./postgres-error-code";

import type { Schema } from "./schema";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction, PgTransactionConfig } from "drizzle-orm/pg-core/session";
import type { Pool } from "pg";

/**
 * Drizzle database handle bound to the Notted schema. Later parts widen this
 * type automatically as tables are appended to the schema barrel.
 */
export type Database = NodePgDatabase<Schema>;

/**
 * Transaction scope handed to {@link DatabaseService.transaction} callers.
 * Mirrors the exact callback type that `db.transaction` expects so the wrapper
 * adds no friction for callers that already know Drizzle.
 */
export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

/** Three tries total: one optimistic, two retries. */
const TRANSACTION_ATTEMPTS = 3;
const RETRY_BASE_MS = 25;
const RETRY_CAP_MS = 200;

/**
 * Thin application wrapper around the Drizzle `db` handle and its `pg.Pool`.
 *
 * Provided as a direct class provider so it is discoverable as a NestJS
 * injectable; the underlying {@link DATABASE_POOL} and {@link DATABASE} tokens
 * are constructed in {@link DatabaseModule}. Owns the pool lifecycle (graceful
 * close on shutdown) and exposes the typed transaction helper required by
 * `AGENTS.md` for multi-table invariants.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(DATABASE) readonly db: Database,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Runs `work` in a transaction, retrying a serialisation failure or a deadlock.
   *
   * PostgreSQL's contract for `serializable` is explicitly "the client retries
   * on 40001", and eighteen call sites in this codebase ask for that isolation
   * level. Nothing implemented the other half: two people creating a folder in
   * the same workspace at the same moment produced a 500 for whichever one lost,
   * for a conflict neither of them caused and both would win on a second try.
   *
   * DEFAULT-ON RATHER THAN OPT-IN. An opt-in flag fixes none of the ~90 call
   * sites until each is edited, and the sites that most need it are the ones
   * nobody is looking at. Retrying a whole transaction is safe here because
   * nothing has committed — and that was checked call site by call site, not
   * assumed: every object-storage write and every queue/socket fan-out already
   * happens OUTSIDE the transaction (ADR 0006 holds in fact, not only on paper),
   * and identifiers minted inside a callback are only ever persisted within that
   * same transaction, so a rollback erases them and the retry re-mints
   * consistently.
   *
   * Logged once on exhaustion, never per attempt: a silent retry layer is an
   * operational blind spot, and a line per attempt is noise.
   *
   * ponytail: three attempts, full jitter, no retry counter — a caller that
   * needs a longer budget gets neither. Bounded on purpose, so genuine hot-row
   * contention surfaces as an error rather than as pool exhaustion. Upgrade
   * path: per-call `{ attempts }`, and a `db_transaction_retry_total` counter
   * beside `poolStats()`.
   */
  async transaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction(work, config);
      } catch (error: unknown) {
        if (!isRetryableTransactionError(error) || attempt >= TRANSACTION_ATTEMPTS) {
          if (isRetryableTransactionError(error)) {
            this.logger.warning(
              { component: "database", outcome: "serialization_retry_exhausted", attempt },
              "Transaction still conflicting after every retry",
            );
          }
          throw error;
        }
        // Full jitter: two transactions that just collided must not agree on
        // when to try again, or they collide identically.
        await setTimeout(Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }

  /**
   * Part 78 — pool saturation, read straight off `pg`'s own in-memory counters.
   *
   * A COUNT-ONLY VIEW rather than exporting `DATABASE_POOL` from
   * `DatabaseModule`: the token is currently a module-private provider (a
   * `@Global()` module makes its EXPORTS global, not its providers), and the
   * fix that widens the module's public surface to hand a metrics collector a
   * live `Pool` — which can `connect`, `query` and `end` — is the wrong one for
   * three numbers. Same reasoning as `QUEUE_METRICS_SOURCE`.
   *
   * `waiting` is the saturation signal: clients queued because `max` is
   * exhausted. It is the number that turns "the API is slow" into "the API is
   * slow because it is waiting for a connection".
   */
  poolStats(): { readonly total: number; readonly idle: number; readonly waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * The pool closes in `onApplicationShutdown`, NOT `onModuleDestroy`.
   *
   * Nest's order is `onModuleDestroy` -> `beforeApplicationShutdown` ->
   * `dispose()` -> `onApplicationShutdown` (`@nestjs/core`'s
   * `nest-application-context.js`), so closing at `onModuleDestroy` shut the
   * database before any other hook had run. That is what made
   * `NoteCollaborationProjectionService` unable to honour ADR 0004's
   * "a pending projection is flushed on graceful shutdown" — its flush could
   * only ever have produced errors against a dead pool.
   *
   * Closing later is strictly safer, and it also makes this consistent with
   * every other infrastructure owner in the codebase — `RedisService`,
   * `MinioService`, `MeilisearchService` and `QueueLifecycleService` all already
   * close here. `DatabaseService` was the outlier.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
