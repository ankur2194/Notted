import { Global, Module } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DATABASE_CONFIG, type DatabaseConfig } from "../config/database.config";

import { DatabaseReadinessIndicator } from "./database-readiness.indicator";
import { DatabaseService } from "./database.service";
import { DATABASE, DATABASE_POOL } from "./database.tokens";
import { schema } from "./schema";

function createPool(config: DatabaseConfig, logger: StructuredLogger): Pool {
  // `pg` reads credentials from the connection string; never log them here.
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMaxConnections,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
  });
  // `pg.Pool` emits idle-client failures as `error` events. Without a listener,
  // Node treats a dependency outage as an uncaught exception and terminates the
  // API process. Record only a safe category; readiness owns recovery state.
  pool.on("error", () => {
    logger.failure(
      { dependency: "database", status: "down", durationMs: 0, reason: "connection" },
      "Dependency client error",
    );
  });
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [DATABASE_CONFIG, StructuredLogger],
      useFactory: (config: DatabaseConfig, logger: StructuredLogger): Pool =>
        createPool(config, logger),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    DatabaseService,
    DatabaseReadinessIndicator,
  ],
  exports: [DatabaseService, DatabaseReadinessIndicator],
})
export class DatabaseModule {}
