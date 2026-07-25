import { Global, Module } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DATABASE_CONFIG, type DatabaseConfig } from "../config/database.config";

import { DatabaseReadinessIndicator } from "./database-readiness.indicator";
import { DatabaseService } from "./database.service";
import { DATABASE, DATABASE_POOL } from "./database.tokens";
import { schema } from "./schema";

function createPool(config: DatabaseConfig): Pool {
  // `pg` reads credentials from the connection string; never log them here.
  return new Pool({
    connectionString: config.connectionString,
    max: config.poolMaxConnections,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
  });
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [DATABASE_CONFIG],
      useFactory: (config: DatabaseConfig): Pool => createPool(config),
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
