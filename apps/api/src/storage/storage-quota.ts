// Part 45: the pure half of workspace storage accounting.
//
// Everything here is a total function over plain numbers so the two properties
// that matter — "the deployment ceiling can only ever LOWER the limit" and
// "in-flight uploads count against the quota" — are provable without a database,
// a tenant context, or an object store.
//
// USAGE IS DERIVED, ALWAYS. There is deliberately no `storage_used_bytes`
// column: the authoritative number is `sum(size_bytes)` over the workspace's own
// attachment rows, taken under the workspace row lock on the write path. A
// denormalized counter would need its own transactional maintenance on every
// upload, failure, compensation, cascade delete, and sweep, and every one of
// those paths is a place for the counter to drift away from the rows it claims
// to summarize. Part 40 deferred the counter for exactly this reason and Part 45
// keeps that decision.

import type { StoragePlanDefaults } from "../config/storage.config";
import type { WorkspacePlan } from "@notted/shared-types";

/** The attachment states whose bytes are charged against the quota. */
export const QUOTA_CHARGED_STATUSES = Object.freeze(["pending", "processing", "ready"] as const);

/** The attachment states that are in flight rather than committed. */
export const QUOTA_RESERVED_STATUSES = Object.freeze(["pending", "processing"] as const);

/**
 * Raw aggregate read from `attachments` for one workspace.
 *
 * Split by state so the caller can show a user "you are using X, and Y more is
 * uploading right now" rather than one opaque total.
 */
export interface StorageUsageAggregate {
  /** Bytes of `ready` rows — content the workspace actually has. */
  readonly readyBytes: number;
  /** Bytes of `pending`/`processing` rows — the live reservation. */
  readonly reservedBytes: number;
  /** Number of `ready` attachments. */
  readonly readyCount: number;
}

export interface WorkspaceStorageUsageInput {
  readonly plan: WorkspacePlan;
  /** `workspaces.storage_limit_bytes`; `null` means "the plan default applies". */
  readonly overrideBytes: number | null;
  readonly planDefaults: StoragePlanDefaults;
  /** `SECURITY_CONFIG.maximumWorkspaceStorageBytes` — the deployment ceiling. */
  readonly deploymentCeilingBytes: number;
  readonly aggregate: StorageUsageAggregate;
}

/**
 * Effective quota for a workspace, in bytes.
 *
 * Two rules, in this order:
 *
 * 1. `storage_limit_bytes IS NULL` means the workspace has no override, so the
 *    plan default applies. A non-null override wins over the plan default in
 *    BOTH directions — an operator may grant a free workspace more than the free
 *    default, or hold a pro workspace below the pro default.
 * 2. `MAX_WORKSPACE_STORAGE_BYTES` is an absolute cap that no plan and no
 *    override may exceed. This preserves the Part 40 behaviour exactly and is
 *    what stops a mis-set plan default from writing a cheque the deployment
 *    cannot cash.
 *
 * Non-finite or negative inputs resolve to the deployment ceiling rather than
 * producing `NaN`, because a `NaN` limit compares false against every
 * comparison and would silently disable the quota.
 */
export function resolveEffectiveLimitBytes(input: {
  readonly plan: WorkspacePlan;
  readonly overrideBytes: number | null;
  readonly planDefaults: StoragePlanDefaults;
  readonly deploymentCeilingBytes: number;
}): number {
  const ceiling = safeBytes(input.deploymentCeilingBytes, 0);
  const planDefault = safeBytes(input.planDefaults[input.plan], ceiling);
  const requested =
    input.overrideBytes === null ? planDefault : safeBytes(input.overrideBytes, planDefault);
  return Math.min(requested, ceiling);
}

/**
 * The wire-shaped usage projection.
 *
 * `availableBytes` never goes negative: a workspace whose limit was lowered
 * below its current usage is over quota, not owed bytes, and a negative number
 * on a progress bar reads as a bug rather than as a policy change.
 */
export function buildWorkspaceStorageUsage(input: WorkspaceStorageUsageInput): {
  readonly usedBytes: number;
  readonly pendingBytes: number;
  readonly limitBytes: number;
  readonly availableBytes: number;
  readonly attachmentCount: number;
} {
  const limitBytes = resolveEffectiveLimitBytes(input);
  const usedBytes = safeBytes(input.aggregate.readyBytes, 0);
  const pendingBytes = safeBytes(input.aggregate.reservedBytes, 0);
  const attachmentCount = Math.max(0, Math.floor(input.aggregate.readyCount) || 0);
  return Object.freeze({
    usedBytes,
    pendingBytes,
    limitBytes,
    availableBytes: Math.max(0, limitBytes - usedBytes - pendingBytes),
    attachmentCount,
  });
}

/**
 * Does `additionalBytes` still fit?
 *
 * The charged total is `ready + pending + processing`: the in-flight rows ARE
 * the reservation, which is what makes the quota safe without a counter and
 * without a compensating "release" step that a crash could skip.
 */
export function fitsWithinQuota(input: {
  readonly aggregate: StorageUsageAggregate;
  readonly limitBytes: number;
  readonly additionalBytes: number;
}): boolean {
  const charged =
    safeBytes(input.aggregate.readyBytes, 0) + safeBytes(input.aggregate.reservedBytes, 0);
  return charged + safeBytes(input.additionalBytes, 0) <= safeBytes(input.limitBytes, 0);
}

function safeBytes(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
