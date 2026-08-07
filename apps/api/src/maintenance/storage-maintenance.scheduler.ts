// Part 45: the unattended sweep driver.
//
// Deliberately the SAME shape as `auth/auth-email-dispatcher.service.ts`:
// `setInterval(...).unref()`, a `running` re-entrancy flag, and
// `clearInterval` in `onApplicationShutdown`. There is no `@nestjs/schedule`
// and no generic queue module in this codebase yet — Part 50 introduces the
// BullMQ maintenance queue this work eventually belongs on — so copying the one
// established in-process pattern keeps the surface small and the shutdown
// behaviour identical to the scheduler that already exists.
//
// `.unref()` matters: it keeps a pending timer from holding the event loop open,
// so `pnpm test` and a container stop both exit promptly.
//
// OFF BY DEFAULT. `STORAGE_MAINTENANCE_ENABLED` defaults to `false`, which is
// what keeps the sweeps out of the test suites and the disposable e2e stack
// without any test-only branch. Production turns it on after an operator has
// reviewed a dry-run report; `STORAGE_MAINTENANCE_DRY_RUN=true` is the
// intermediate step that runs the schedule in report-only mode first.

import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { STORAGE_CONFIG, type StorageConfig } from "../config/storage.config";

import { StorageMaintenanceService } from "./storage-maintenance.service";

@Injectable()
export class StorageMaintenanceScheduler implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly maintenance: StorageMaintenanceService,
    private readonly logger: StructuredLogger,
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.maintenanceEnabled) return;
    this.timer = setInterval(() => this.kick(), this.config.maintenanceIntervalMs);
    this.timer.unref();
    // Deliberately NOT kicked at startup, unlike the auth email dispatcher. That
    // dispatcher is latency-sensitive (a queued verification email should not
    // wait a tick); a cleanup sweep is not, and running destructive work during
    // every boot and every rolling restart is a much worse trade than waiting
    // one interval.
  }

  /**
   * Start a pass unless one is already in flight.
   *
   * The re-entrancy flag is the only concurrency control inside a process. It is
   * enough here because every sweep is idempotent and bounded, so even a second
   * process running the same pass concurrently duplicates work rather than
   * corrupting state — deleting an already-deleted row returns zero rows and
   * removing an already-removed object succeeds.
   */
  kick(): void {
    if (this.running || !this.config.maintenanceEnabled) return;
    this.running = true;
    void this.runOnce().finally(() => {
      this.running = false;
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.maintenance.runSystemSweeps({ dryRun: this.config.maintenanceDryRun });
    } catch {
      // The reason is deliberately not interpolated: an exception message from a
      // storage client can carry a key or an endpoint. The per-sweep structured
      // logs written inside the service carry the counts an operator needs.
      this.logger.failure(
        { outcome: "error", reason: "storage_maintenance" },
        "Scheduled storage maintenance failed",
      );
    }
  }
}
