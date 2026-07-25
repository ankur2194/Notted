import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DatabaseService } from "./database.service";

import type { ReadinessCheckResult, ReadinessIndicator } from "../health/readiness-indicator";

/**
 * Maximum time a readiness probe waits for `select 1` before reporting the
 * database as down. Kept well below typical orchestrator probe timeouts so a
 * degraded database surfaces as `down` rather than timing out the probe itself.
 */
const READINESS_QUERY_TIMEOUT_MS = 2_500;

@Injectable()
export class DatabaseReadinessIndicator implements ReadinessIndicator {
  readonly name = "database";

  constructor(private readonly database: DatabaseService) {}

  async check(): Promise<ReadinessCheckResult> {
    try {
      await this.withTimeout(this.database.db.execute(sql`select 1`));
      return { name: this.name, status: "up" };
    } catch {
      // Generic message only: never include the underlying error, which can
      // carry host, port, or credential fragments from the pg driver.
      return {
        name: this.name,
        status: "down",
        message: "database query failed",
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("database readiness query timed out")),
        READINESS_QUERY_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}
