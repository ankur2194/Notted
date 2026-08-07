// Part 45 — the pure half of workspace storage accounting.
//
// Everything here is a total function over plain numbers, so the two properties
// that matter can be proven without a database, a tenant context, or a clock:
//
// 1. the deployment ceiling can only ever LOWER the effective limit, and
// 2. in-flight (`pending`/`processing`) bytes are charged against the quota.
//
// The plan defaults are read from the REAL config parser rather than restated
// here, so a change to `STORAGE_QUOTA_*_BYTES` cannot make this file agree with
// itself while disagreeing with the deployment.

import { describe, expect, it } from "vitest";

import { parseStorageConfig, type StoragePlanDefaults } from "../config/storage.config";

import {
  buildWorkspaceStorageUsage,
  fitsWithinQuota,
  QUOTA_CHARGED_STATUSES,
  QUOTA_RESERVED_STATUSES,
  resolveEffectiveLimitBytes,
  type StorageUsageAggregate,
} from "./storage-quota";

import type { WorkspacePlan } from "@notted/shared-types";

const GIB = 1_024 * 1_024 * 1_024;

/** The documented deployment default of `MAX_WORKSPACE_STORAGE_BYTES`. */
const DEFAULT_CEILING = 10 * GIB;

/** A ceiling high enough that a clamp can never be mistaken for a plan default. */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

const PLAN_DEFAULTS: StoragePlanDefaults = parseStorageConfig({}).planDefaultBytes;

function aggregate(overrides: Partial<StorageUsageAggregate> = {}): StorageUsageAggregate {
  return Object.freeze({ readyBytes: 0, reservedBytes: 0, readyCount: 0, ...overrides });
}

function limitFor(
  plan: WorkspacePlan,
  overrideBytes: number | null,
  deploymentCeilingBytes: number,
  planDefaults: StoragePlanDefaults = PLAN_DEFAULTS,
): number {
  return resolveEffectiveLimitBytes({
    plan,
    overrideBytes,
    planDefaults,
    deploymentCeilingBytes,
  });
}

describe("resolveEffectiveLimitBytes", () => {
  it("resolves the per-plan default from config when storage_limit_bytes is null", () => {
    // The Part 45 decision, stated once in `storage.config.ts` and read here.
    expect(PLAN_DEFAULTS).toEqual({ free: GIB, pro: 10 * GIB, enterprise: 100 * GIB });

    const cases: readonly (readonly [WorkspacePlan, number])[] = [
      ["free", GIB],
      ["pro", 10 * GIB],
      ["enterprise", 100 * GIB],
    ];
    for (const [plan, expected] of cases) {
      expect(limitFor(plan, null, UNCAPPED)).toBe(expected);
    }
  });

  it("clamps the enterprise default of 100 GiB to a 10 GiB deployment ceiling", () => {
    // The load-bearing case: the shipped enterprise default is deliberately
    // ABOVE the shipped `MAX_WORKSPACE_STORAGE_BYTES`, so an operator who has
    // not raised the ceiling gets the safe direction and nothing surprising.
    expect(PLAN_DEFAULTS.enterprise).toBeGreaterThan(DEFAULT_CEILING);
    expect(limitFor("enterprise", null, DEFAULT_CEILING)).toBe(DEFAULT_CEILING);
    // Pro is exactly the default ceiling, so an out-of-the-box Pro workspace
    // sees its plan default unchanged.
    expect(limitFor("pro", null, DEFAULT_CEILING)).toBe(10 * GIB);
    expect(limitFor("free", null, DEFAULT_CEILING)).toBe(GIB);
  });

  it("lets a non-null override win over the plan default in BOTH directions", () => {
    // Upward: an operator grants a free workspace more than the free default.
    expect(limitFor("free", 4 * GIB, UNCAPPED)).toBe(4 * GIB);
    expect(limitFor("free", 4 * GIB, UNCAPPED)).toBeGreaterThan(PLAN_DEFAULTS.free);

    // Downward: an operator holds a pro workspace below the pro default.
    expect(limitFor("pro", 512 * 1_024 * 1_024, UNCAPPED)).toBe(512 * 1_024 * 1_024);
    expect(limitFor("pro", 512 * 1_024 * 1_024, UNCAPPED)).toBeLessThan(PLAN_DEFAULTS.pro);

    // Zero is a real override ("this workspace may store nothing"), not "unset".
    expect(limitFor("enterprise", 0, UNCAPPED)).toBe(0);
  });

  it("still clamps a generous override to the deployment ceiling", () => {
    expect(limitFor("free", Number.MAX_SAFE_INTEGER, DEFAULT_CEILING)).toBe(DEFAULT_CEILING);
    expect(limitFor("enterprise", 900 * GIB, DEFAULT_CEILING)).toBe(DEFAULT_CEILING);
    // A LOWER override is never raised to the ceiling.
    expect(limitFor("enterprise", 1_024, DEFAULT_CEILING)).toBe(1_024);
  });

  it("falls back safely instead of producing NaN, in every input position", () => {
    // A NaN limit compares false against every comparison, which would silently
    // DISABLE the quota. Every fallback below is checked to be a finite number.
    const nanDefaults: StoragePlanDefaults = Object.freeze({
      free: Number.NaN,
      pro: Number.POSITIVE_INFINITY,
      enterprise: -1,
    });

    // A broken plan default resolves to the ceiling, never to NaN.
    for (const plan of ["free", "pro", "enterprise"] as const) {
      const resolved = limitFor(plan, null, DEFAULT_CEILING, nanDefaults);
      expect(Number.isFinite(resolved)).toBe(true);
      expect(resolved).toBe(DEFAULT_CEILING);
    }

    // A broken override falls back to the plan default.
    for (const override of [Number.NaN, Number.POSITIVE_INFINITY, -1, -Number.MAX_SAFE_INTEGER]) {
      expect(limitFor("free", override, UNCAPPED)).toBe(PLAN_DEFAULTS.free);
    }

    // A broken CEILING closes the quota rather than opening it: the safe
    // direction is "store nothing", never "store anything".
    for (const ceiling of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const resolved = limitFor("enterprise", null, ceiling);
      expect(Number.isFinite(resolved)).toBe(true);
      expect(resolved).toBe(0);
    }
  });

  it("floors fractional byte counts so a limit is always a whole number of bytes", () => {
    expect(limitFor("free", 1_024.9, UNCAPPED)).toBe(1_024);
    expect(Number.isInteger(limitFor("free", null, DEFAULT_CEILING + 0.5))).toBe(true);
  });
});

describe("QUOTA_CHARGED_STATUSES", () => {
  it("charges pending and processing but never failed", () => {
    expect([...QUOTA_CHARGED_STATUSES]).toEqual(["pending", "processing", "ready"]);
    expect([...QUOTA_CHARGED_STATUSES]).not.toContain("failed");
    expect([...QUOTA_RESERVED_STATUSES]).toEqual(["pending", "processing"]);
    expect(Object.isFrozen(QUOTA_CHARGED_STATUSES)).toBe(true);
    expect(Object.isFrozen(QUOTA_RESERVED_STATUSES)).toBe(true);
  });
});

describe("buildWorkspaceStorageUsage", () => {
  it("reports in-flight bytes as pending and subtracts them from availableBytes", () => {
    const usage = buildWorkspaceStorageUsage({
      plan: "free",
      overrideBytes: 1_000,
      planDefaults: PLAN_DEFAULTS,
      deploymentCeilingBytes: UNCAPPED,
      aggregate: aggregate({ readyBytes: 400, reservedBytes: 250, readyCount: 3 }),
    });

    expect(usage).toEqual({
      usedBytes: 400,
      pendingBytes: 250,
      limitBytes: 1_000,
      availableBytes: 350,
      attachmentCount: 3,
    });
  });

  it("floors availableBytes at zero when the limit is lowered below current usage", () => {
    const usage = buildWorkspaceStorageUsage({
      plan: "pro",
      // An operator drops the override far below what the workspace already holds.
      overrideBytes: 1_000,
      planDefaults: PLAN_DEFAULTS,
      deploymentCeilingBytes: UNCAPPED,
      aggregate: aggregate({ readyBytes: 9_000, reservedBytes: 500, readyCount: 12 }),
    });

    // Over quota is not "owed bytes": a negative number on a progress bar reads
    // as a bug rather than as a policy change.
    expect(usage.availableBytes).toBe(0);
    expect(usage.usedBytes).toBe(9_000);
    expect(usage.pendingBytes).toBe(500);
    expect(usage.limitBytes).toBe(1_000);
  });

  it("never emits NaN or a negative field for a corrupt aggregate", () => {
    const usage = buildWorkspaceStorageUsage({
      plan: "free",
      overrideBytes: null,
      planDefaults: PLAN_DEFAULTS,
      deploymentCeilingBytes: DEFAULT_CEILING,
      aggregate: {
        readyBytes: Number.NaN,
        reservedBytes: -5,
        readyCount: Number.NaN,
      },
    });

    for (const value of Object.values(usage)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(usage.usedBytes).toBe(0);
    expect(usage.pendingBytes).toBe(0);
    expect(usage.attachmentCount).toBe(0);
    expect(usage.availableBytes).toBe(PLAN_DEFAULTS.free);
  });

  it("returns a frozen projection", () => {
    const usage = buildWorkspaceStorageUsage({
      plan: "free",
      overrideBytes: null,
      planDefaults: PLAN_DEFAULTS,
      deploymentCeilingBytes: DEFAULT_CEILING,
      aggregate: aggregate(),
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });
});

describe("fitsWithinQuota", () => {
  it("ALLOWS an addition that exactly fills the remaining quota", () => {
    // The boundary is `charged + additional === limit`. Refusing it here would
    // make the last byte of every workspace unusable.
    expect(
      fitsWithinQuota({
        aggregate: aggregate({ readyBytes: 600, reservedBytes: 300 }),
        limitBytes: 1_000,
        additionalBytes: 100,
      }),
    ).toBe(true);
    expect(
      fitsWithinQuota({
        aggregate: aggregate(),
        limitBytes: 1_000,
        additionalBytes: 1_000,
      }),
    ).toBe(true);
  });

  it("REFUSES one byte past the limit", () => {
    expect(
      fitsWithinQuota({
        aggregate: aggregate({ readyBytes: 600, reservedBytes: 300 }),
        limitBytes: 1_000,
        additionalBytes: 101,
      }),
    ).toBe(false);
  });

  it("charges reserved bytes exactly as it charges ready bytes", () => {
    // The same total, split differently between committed and in-flight, must
    // produce the same answer — that identity is what makes the quota safe
    // without a denormalized counter and without a compensating release step.
    const split = fitsWithinQuota({
      aggregate: aggregate({ readyBytes: 400, reservedBytes: 600 }),
      limitBytes: 1_000,
      additionalBytes: 1,
    });
    const committed = fitsWithinQuota({
      aggregate: aggregate({ readyBytes: 1_000, reservedBytes: 0 }),
      limitBytes: 1_000,
      additionalBytes: 1,
    });
    const inFlight = fitsWithinQuota({
      aggregate: aggregate({ readyBytes: 0, reservedBytes: 1_000 }),
      limitBytes: 1_000,
      additionalBytes: 1,
    });
    expect([split, committed, inFlight]).toEqual([false, false, false]);

    // `failed` bytes never reach the aggregate at all, so a workspace whose
    // only other rows are failed uploads still has its whole quota available.
    expect(
      fitsWithinQuota({
        aggregate: aggregate({ readyBytes: 0, reservedBytes: 0 }),
        limitBytes: 1_000,
        additionalBytes: 1_000,
      }),
    ).toBe(true);
  });

  it("treats a corrupt limit as zero rather than silently allowing the write", () => {
    for (const limitBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(fitsWithinQuota({ aggregate: aggregate(), limitBytes, additionalBytes: 1 })).toBe(
        false,
      );
    }
    // A corrupt aggregate is charged as zero, which is the only reading that
    // does not deadlock every upload in the workspace.
    expect(
      fitsWithinQuota({
        aggregate: { readyBytes: Number.NaN, reservedBytes: -1, readyCount: Number.NaN },
        limitBytes: 1_000,
        additionalBytes: 1_000,
      }),
    ).toBe(true);
  });
});
