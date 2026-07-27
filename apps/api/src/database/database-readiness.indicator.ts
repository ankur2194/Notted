import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DATABASE_CONFIG, type DatabaseConfig } from "../config/database.config";
import { DependencyState } from "../infrastructure/dependency-lifecycle";

import { DatabaseService } from "./database.service";

import type { ReadinessCheckResult, ReadinessIndicator } from "../health/readiness-indicator";

/**
 * Maximum time a readiness probe waits for `select 1` before reporting the
 * database as down. Kept well below typical orchestrator probe timeouts so a
 * degraded database surfaces as `down` rather than timing out the probe itself.
 */
@Injectable()
export class DatabaseReadinessIndicator implements ReadinessIndicator, BeforeApplicationShutdown {
  readonly name = "database";
  private readonly state: DependencyState;

  constructor(
    private readonly database: DatabaseService,
    @Inject(DATABASE_CONFIG) private readonly config: DatabaseConfig,
    logger: StructuredLogger,
  ) {
    this.state = new DependencyState(this.name, true, logger);
  }

  async check(): Promise<ReadinessCheckResult> {
    const startedAt = performance.now();
    try {
      await this.withTimeout(this.database.db.execute(sql`select 1`));
      this.state.transition("up", this.elapsed(startedAt));
      return { name: this.name, status: "up" };
    } catch {
      this.state.transition("down", this.elapsed(startedAt));
      // Generic message only: never include the underlying error, which can
      // carry host, port, or credential fragments from the pg driver.
      return {
        name: this.name,
        status: "down",
        message: "database query failed",
      };
    }
  }

  beforeApplicationShutdown(): void {
    this.state.transition("down");
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("database readiness query timed out")),
        this.config.readinessTimeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, Math.round(performance.now() - startedAt));
  }
}
