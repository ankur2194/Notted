// Part 45: storage quota defaults and the storage-maintenance sweep budget.
//
// Two concerns live in one file because they are two halves of the same policy:
// how much a workspace may store, and how the bytes that nothing points at any
// more get reclaimed. Splitting them would leave an operator tuning quotas in
// one place and the sweeps that make those quotas accurate in another.
//
// Convention (mirrors `security.config.ts` / `retention.config.ts`):
// - `StorageConfig` describes the typed shape.
// - `parseStorageConfig(environment)` reads + validates, returning a frozen value.
// - `StorageConfigProvider` captures `process.env` at construction, so a typo
//   fails startup rather than surfacing as a silently wrong quota.
//
// WHAT IS NOT HERE: `MAX_WORKSPACE_STORAGE_BYTES` stays in `security.config.ts`.
// It is an ABSOLUTE deployment ceiling, not a plan policy — every value below can
// only ever LOWER the effective limit, never raise it past that ceiling.

import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readBoolean, readInteger, wrapConfigError } from "./environment-readers";

import type { WorkspacePlan } from "@notted/shared-types";

export const STORAGE_CONFIG = Symbol("STORAGE_CONFIG");

/**
 * Per-plan default storage allowance, in bytes, applied when
 * `workspaces.storage_limit_bytes IS NULL`.
 *
 * `Notted.md` states the per-plan quota exists but never fixes the byte values,
 * so these numbers are a Part 45 decision recorded in
 * `docs/completed-parts/part-45-storage-quotas-cleanup.md`:
 *
 * - **free — 1 GiB.** Large enough for a real trial of notes with images and a
 *   handful of documents at the 50 MiB per-file ceiling, small enough that an
 *   unpaid workspace cannot become an unbounded object-storage bill.
 * - **pro — 10 GiB.** Ten times free, and equal to the default
 *   `MAX_WORKSPACE_STORAGE_BYTES`, so an out-of-the-box deployment gives a Pro
 *   workspace exactly the deployment ceiling and nothing surprising happens.
 * - **enterprise — 100 GiB.** Deliberately ABOVE the default deployment ceiling.
 *   An operator who has not raised `MAX_WORKSPACE_STORAGE_BYTES` sees enterprise
 *   clamped to 10 GiB, which is the safe direction; raising the ceiling is an
 *   explicit, auditable operator act rather than something a plan column can do
 *   on its own.
 */
export type StoragePlanDefaults = Readonly<Record<WorkspacePlan, number>>;

export interface StorageConfig {
  /** Bytes allowed when the workspace carries no explicit override. */
  readonly planDefaultBytes: StoragePlanDefaults;
  /**
   * How long an attachment row may sit in `pending`/`processing` before the
   * abandoned-upload sweep treats it as dead and releases its reservation.
   *
   * Uploads are synchronous: the request buffers the bytes, writes the objects,
   * and commits `ready` within seconds. A row still in flight a full day later
   * did not "take a while" — the process that owned it is gone. 24 hours leaves
   * a very wide margin over the slowest realistic request while still returning
   * the reserved quota to the workspace within a day.
   */
  readonly abandonedUploadHours: number;
  /**
   * Master switch for the in-process sweep scheduler.
   *
   * DEFAULT `false`, deliberately. The sweeps delete objects and rows, and an
   * operator should read a dry-run report (`pnpm --filter @notted/api
   * storage:report`) against their own data before letting anything run
   * unattended. Production enables it after that review.
   */
  readonly maintenanceEnabled: boolean;
  /**
   * Run the scheduled sweeps in report-only mode. Lets an operator turn the
   * scheduler on and watch the logged counts for a few cycles before it is
   * allowed to delete anything.
   *
   * DEFAULT `true`, deliberately. Destroying bytes requires TWO explicit acts:
   * enabling the scheduler and then clearing this flag. An operator who sets
   * only `STORAGE_MAINTENANCE_ENABLED=true` — in a secrets manager that never
   * saw `.env.example` — gets a report, not an irreversible cascade purge.
   */
  readonly maintenanceDryRun: boolean;
  /** Interval between scheduled sweep passes. */
  readonly maintenanceIntervalMs: number;
  /**
   * Maximum rows any single sweep may act on in one pass.
   *
   * A bound rather than "process everything" is a safety property, not a
   * performance one: if a misconfiguration ever makes a sweep select wrongly, it
   * can damage at most this many rows before an operator sees the report. The
   * sweep reports `truncated: true` so the next pass continues.
   */
  readonly maintenanceBatchLimit: number;
  /**
   * Maximum object keys a single bucket listing may buffer.
   *
   * MinIO's listing API is an unbounded stream; a bucket with ten million
   * objects would otherwise be read into memory. The reconciliation sweep stops
   * at this many keys and reports `truncated: true`.
   */
  readonly maintenanceObjectScanLimit: number;
}

const GIB = 1_024 * 1_024 * 1_024;
const MINIMUM_PLAN_BYTES = 1_024 * 1_024; // 1 MiB — below this nothing is usable.

function readPlanBytes(environment: Environment, key: string, fallback: number): number {
  return readInteger(environment, key, fallback, MINIMUM_PLAN_BYTES, Number.MAX_SAFE_INTEGER);
}

export function parseStorageConfig(environment: Environment): StorageConfig {
  try {
    return Object.freeze({
      planDefaultBytes: Object.freeze({
        free: readPlanBytes(environment, "STORAGE_QUOTA_FREE_BYTES", GIB),
        pro: readPlanBytes(environment, "STORAGE_QUOTA_PRO_BYTES", 10 * GIB),
        enterprise: readPlanBytes(environment, "STORAGE_QUOTA_ENTERPRISE_BYTES", 100 * GIB),
      }),
      abandonedUploadHours: readInteger(
        environment,
        "STORAGE_ABANDONED_UPLOAD_HOURS",
        24,
        1,
        24 * 365,
      ),
      maintenanceEnabled: readBoolean(environment, "STORAGE_MAINTENANCE_ENABLED", false),
      maintenanceDryRun: readBoolean(environment, "STORAGE_MAINTENANCE_DRY_RUN", true),
      maintenanceIntervalMs: readInteger(
        environment,
        "STORAGE_MAINTENANCE_INTERVAL_MS",
        3_600_000,
        60_000,
        24 * 3_600_000,
      ),
      maintenanceBatchLimit: readInteger(
        environment,
        "STORAGE_MAINTENANCE_BATCH_LIMIT",
        200,
        1,
        5_000,
      ),
      maintenanceObjectScanLimit: readInteger(
        environment,
        "STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT",
        5_000,
        1,
        100_000,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid storage configuration", error);
  }
}

@Injectable()
export class StorageConfigProvider {
  readonly value = parseStorageConfig(process.env);
}

export const storageConfigProvider: Provider<StorageConfig> = {
  provide: STORAGE_CONFIG,
  inject: [StorageConfigProvider],
  useFactory: (provider: StorageConfigProvider): StorageConfig => provider.value,
};
