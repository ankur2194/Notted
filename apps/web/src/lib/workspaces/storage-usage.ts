import type { WorkspaceStorageUsage } from "@notted/shared-types";

import { exactByteLabel, formatBinaryBytes } from "@/lib/notes/format-bytes";

/**
 * Presentation-ready projection of the Part 45 storage aggregate.
 *
 * Kept out of the component so the arithmetic — which is the part that can be
 * wrong in a way a reader would not notice — is unit-testable on its own, and so
 * the server-rendered overview and the client settings island cannot drift into
 * two different readings of the same numbers.
 *
 * Nothing here recomputes the quota. `availableBytes` is the server's own
 * floored subtraction and is the sole authority on whether there is room left;
 * this module only derives widths and wording from values it was handed.
 */

/** Fraction of the limit at which the UI starts warning. */
const NEARLY_FULL_RATIO = 0.9;

export type StorageUsageSeverity = "ok" | "nearly-full" | "full";

export interface StorageUsageSummary {
  /** `usedBytes + pendingBytes` — everything charged against the quota. */
  readonly chargedBytes: number;
  /** Track width for finished uploads, 0-100, clamped. */
  readonly usedPercent: number;
  /** Track width for in-flight uploads, clamped so the pair never exceeds 100. */
  readonly pendingPercent: number;
  readonly severity: StorageUsageSeverity;
  /** True when any upload is in flight, i.e. the pending segment is meaningful. */
  readonly hasPending: boolean;
  /** Full sentence for `aria-valuetext`, in exact bytes rather than rounded. */
  readonly valueText: string;
  /** Visible sentence describing which limit applies. */
  readonly limitSourceLabel: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 100 ? 100 : value;
}

/** The state sentence, reused verbatim by `aria-valuetext` and the visible notice. */
export function storageSeverityMessage(severity: StorageUsageSeverity): string | null {
  if (severity === "full") {
    return "Storage full. New uploads are rejected until files are removed.";
  }
  if (severity === "nearly-full") return "Storage almost full.";
  return null;
}

export function summarizeStorageUsage(usage: WorkspaceStorageUsage): StorageUsageSummary {
  const chargedBytes = usage.usedBytes + usage.pendingBytes;

  // A zero limit is not treated as "full": a workspace with no quota configured
  // and nothing stored has not hit anything, and shouting at it would be a lie.
  const hasLimit = usage.limitBytes > 0;
  const usedPercent = hasLimit ? clampPercent((usage.usedBytes / usage.limitBytes) * 100) : 0;
  const pendingPercent = hasLimit
    ? Math.min(clampPercent((usage.pendingBytes / usage.limitBytes) * 100), 100 - usedPercent)
    : 0;

  // `availableBytes` is already floored at zero by the API, so "no room left" is
  // exactly `availableBytes === 0` — not a client-side re-derivation that could
  // disagree with the server that will actually reject the next upload.
  const severity: StorageUsageSeverity =
    hasLimit && usage.availableBytes === 0
      ? "full"
      : hasLimit && chargedBytes / usage.limitBytes >= NEARLY_FULL_RATIO
        ? "nearly-full"
        : "ok";

  const pendingClause =
    usage.pendingBytes > 0
      ? `, including ${exactByteLabel(usage.pendingBytes)} still uploading`
      : "";
  const stateClause = storageSeverityMessage(severity);
  const limitLabel = formatBinaryBytes(usage.limitBytes);

  return {
    chargedBytes,
    usedPercent,
    pendingPercent,
    severity,
    hasPending: usage.pendingBytes > 0,
    valueText: `${exactByteLabel(chargedBytes)} of ${exactByteLabel(usage.limitBytes)} used${pendingClause}.${
      stateClause === null ? "" : ` ${stateClause}`
    }`,
    limitSourceLabel:
      usage.limitSource === "override"
        ? `Limit of ${limitLabel} set for this workspace, overriding the ${usage.plan} plan default.`
        : `Limit of ${limitLabel} from the ${usage.plan} plan default.`,
  };
}
