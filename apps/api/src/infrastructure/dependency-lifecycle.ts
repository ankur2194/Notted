import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { ReadinessCheckResult } from "../health/readiness-indicator";

export type DependencyStatus = ReadinessCheckResult["status"];

export class DependencyState {
  private status: DependencyStatus | undefined;
  private readonly enabled: boolean;

  constructor(
    private readonly dependency: string,
    enabled: boolean,
    private readonly logger: StructuredLogger,
  ) {
    this.enabled = enabled;
    this.status = enabled ? undefined : "disabled";
  }

  result(message?: string): ReadinessCheckResult {
    const status = this.status ?? (this.enabled ? "down" : "disabled");
    return message === undefined
      ? { name: this.dependency, status }
      : { name: this.dependency, status, message };
  }

  transition(status: DependencyStatus, durationMs = 0): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    const metadata = { dependency: this.dependency, status, durationMs };
    if (status === "down") {
      this.logger.failure(metadata, "Dependency readiness changed");
      return;
    }
    this.logger.info(metadata, "Dependency readiness changed");
  }
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dependency operation timed out")), timeoutMs);
  });

  return Promise.race([operation(), timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export async function retryBounded<T>(
  operation: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < attempts) {
        await wait(delayMs * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("dependency operation failed");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
