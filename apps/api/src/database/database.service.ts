import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";

import { DATABASE, DATABASE_POOL } from "./database.tokens";

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
export class DatabaseService implements OnModuleDestroy {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(DATABASE) readonly db: Database,
  ) {}

  transaction<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    return this.db.transaction(work, config);
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

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
