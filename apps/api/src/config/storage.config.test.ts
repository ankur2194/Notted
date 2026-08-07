import { describe, expect, it } from "vitest";

import { parseStorageConfig } from "./storage.config";

const GIB = 1_024 * 1_024 * 1_024;

describe("parseStorageConfig", () => {
  it("provides the documented Part 45 defaults", () => {
    const config = parseStorageConfig({});

    // Plan quotas. Enterprise is deliberately ABOVE the default
    // `MAX_WORKSPACE_STORAGE_BYTES`, so an operator who has not raised the
    // deployment ceiling sees it clamped rather than honoured.
    expect(config.planDefaultBytes).toEqual({ free: GIB, pro: 10 * GIB, enterprise: 100 * GIB });

    expect(config.abandonedUploadHours).toBe(24);
    // OFF by default: the sweeps delete objects and rows, so an operator reads a
    // dry-run report against their own data before anything runs unattended.
    expect(config.maintenanceEnabled).toBe(false);
    // And report-only by default: destroying bytes takes TWO explicit acts, so
    // enabling the scheduler alone can never hard-delete anything.
    expect(config.maintenanceDryRun).toBe(true);
    expect(config.maintenanceIntervalMs).toBe(3_600_000);
    expect(config.maintenanceBatchLimit).toBe(200);
    expect(config.maintenanceObjectScanLimit).toBe(5_000);
  });

  it("returns a frozen config with a frozen plan table", () => {
    const config = parseStorageConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.planDefaultBytes)).toBe(true);
  });

  it("parses every overridable value", () => {
    const config = parseStorageConfig({
      STORAGE_QUOTA_FREE_BYTES: String(2 * GIB),
      STORAGE_QUOTA_PRO_BYTES: String(50 * GIB),
      STORAGE_QUOTA_ENTERPRISE_BYTES: String(500 * GIB),
      STORAGE_ABANDONED_UPLOAD_HOURS: "6",
      STORAGE_MAINTENANCE_ENABLED: "true",
      STORAGE_MAINTENANCE_DRY_RUN: "true",
      STORAGE_MAINTENANCE_INTERVAL_MS: "900000",
      STORAGE_MAINTENANCE_BATCH_LIMIT: "25",
      STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT: "1000",
    });

    expect(config.planDefaultBytes).toEqual({
      free: 2 * GIB,
      pro: 50 * GIB,
      enterprise: 500 * GIB,
    });
    expect(config.abandonedUploadHours).toBe(6);
    expect(config.maintenanceEnabled).toBe(true);
    expect(config.maintenanceDryRun).toBe(true);
    expect(config.maintenanceIntervalMs).toBe(900_000);
    expect(config.maintenanceBatchLimit).toBe(25);
    expect(config.maintenanceObjectScanLimit).toBe(1_000);
  });

  it("parses booleans strictly, in both directions", () => {
    expect(parseStorageConfig({ STORAGE_MAINTENANCE_ENABLED: "true" }).maintenanceEnabled).toBe(
      true,
    );
    expect(parseStorageConfig({ STORAGE_MAINTENANCE_ENABLED: "false" }).maintenanceEnabled).toBe(
      false,
    );
    expect(parseStorageConfig({ STORAGE_MAINTENANCE_DRY_RUN: "true" }).maintenanceDryRun).toBe(
      true,
    );
    expect(parseStorageConfig({ STORAGE_MAINTENANCE_DRY_RUN: "false" }).maintenanceDryRun).toBe(
      false,
    );
  });

  it.each([
    // A near-miss boolean must not silently read as `false` and quietly leave
    // the sweeps switched off (or, worse, on).
    [{ STORAGE_MAINTENANCE_ENABLED: "1" }, "must be either true or false"],
    [{ STORAGE_MAINTENANCE_ENABLED: "TRUE" }, "must be either true or false"],
    [{ STORAGE_MAINTENANCE_ENABLED: "yes" }, "must be either true or false"],
    [{ STORAGE_MAINTENANCE_DRY_RUN: "0" }, "must be either true or false"],
    // Below the 1 MiB floor nothing is usable.
    [{ STORAGE_QUOTA_FREE_BYTES: "0" }, "must be an integer between 1048576 and"],
    [{ STORAGE_QUOTA_FREE_BYTES: "1024" }, "must be an integer between 1048576 and"],
    [{ STORAGE_QUOTA_PRO_BYTES: "-1" }, "must be an integer between 1048576 and"],
    [{ STORAGE_QUOTA_ENTERPRISE_BYTES: "lots" }, "must be an integer between 1048576 and"],
    [{ STORAGE_ABANDONED_UPLOAD_HOURS: "0" }, "must be an integer between 1 and 8760"],
    [{ STORAGE_ABANDONED_UPLOAD_HOURS: "8761" }, "must be an integer between 1 and 8760"],
    // A sub-minute sweep interval would hammer the database and the bucket.
    [{ STORAGE_MAINTENANCE_INTERVAL_MS: "59999" }, "must be an integer between 60000 and 86400000"],
    [
      { STORAGE_MAINTENANCE_INTERVAL_MS: "86400001" },
      "must be an integer between 60000 and 86400000",
    ],
    // The batch bound is a SAFETY property: it caps how much a mis-selecting
    // sweep can damage before an operator sees the report.
    [{ STORAGE_MAINTENANCE_BATCH_LIMIT: "0" }, "must be an integer between 1 and 5000"],
    [{ STORAGE_MAINTENANCE_BATCH_LIMIT: "5001" }, "must be an integer between 1 and 5000"],
    [{ STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT: "0" }, "must be an integer between 1 and 100000"],
    [
      { STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT: "100001" },
      "must be an integer between 1 and 100000",
    ],
  ])("rejects out-of-bound or malformed values %#", (environment, expectedMessage) => {
    expect(() => parseStorageConfig(environment)).toThrowError(expectedMessage);
  });

  it("wraps every configuration failure with the storage prefix", () => {
    // The prefix is what tells an operator WHICH config file to look at when
    // startup validation fails.
    expect(() => parseStorageConfig({ STORAGE_MAINTENANCE_BATCH_LIMIT: "0" })).toThrowError(
      /^Invalid storage configuration: /u,
    );
    expect(() => parseStorageConfig({ STORAGE_MAINTENANCE_ENABLED: "maybe" })).toThrowError(
      /^Invalid storage configuration: /u,
    );
  });

  it("accepts the exact boundaries of every bounded value", () => {
    const config = parseStorageConfig({
      STORAGE_QUOTA_FREE_BYTES: "1048576",
      STORAGE_ABANDONED_UPLOAD_HOURS: "1",
      STORAGE_MAINTENANCE_INTERVAL_MS: "60000",
      STORAGE_MAINTENANCE_BATCH_LIMIT: "1",
      STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT: "1",
    });
    expect(config.planDefaultBytes.free).toBe(1_048_576);
    expect(config.abandonedUploadHours).toBe(1);
    expect(config.maintenanceIntervalMs).toBe(60_000);
    expect(config.maintenanceBatchLimit).toBe(1);
    expect(config.maintenanceObjectScanLimit).toBe(1);

    const upper = parseStorageConfig({
      STORAGE_ABANDONED_UPLOAD_HOURS: "8760",
      STORAGE_MAINTENANCE_INTERVAL_MS: "86400000",
      STORAGE_MAINTENANCE_BATCH_LIMIT: "5000",
      STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT: "100000",
    });
    expect(upper.abandonedUploadHours).toBe(8_760);
    expect(upper.maintenanceIntervalMs).toBe(86_400_000);
    expect(upper.maintenanceBatchLimit).toBe(5_000);
    expect(upper.maintenanceObjectScanLimit).toBe(100_000);
  });
});
