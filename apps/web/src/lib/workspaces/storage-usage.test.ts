import { describe, expect, it } from "vitest";

import type { WorkspaceStorageUsage } from "@notted/shared-types";

import { storageSeverityMessage, summarizeStorageUsage } from "@/lib/workspaces/storage-usage";

const GIB = 1_024 * 1_024 * 1_024;
const workspaceId = "20000000-0000-4000-8000-000000000001";

/**
 * Builds a self-consistent aggregate the way the API would emit it: the server
 * floors `availableBytes` at zero, so the fixture derives it rather than letting
 * a test hand-write a combination the API could never produce.
 */
function usage(overrides: Partial<WorkspaceStorageUsage> = {}): WorkspaceStorageUsage {
  const base = {
    workspaceId,
    plan: "free",
    usedBytes: 0,
    pendingBytes: 0,
    limitBytes: GIB,
    attachmentCount: 0,
    limitSource: "plan",
    availableBytes: 0,
  } satisfies WorkspaceStorageUsage;
  const merged = { ...base, ...overrides } as WorkspaceStorageUsage;
  return {
    ...merged,
    availableBytes:
      overrides.availableBytes ??
      Math.max(0, merged.limitBytes - merged.usedBytes - merged.pendingBytes),
  };
}

describe("summarizeStorageUsage", () => {
  it("derives segment widths from the limit and sums the charged bytes", () => {
    const summary = summarizeStorageUsage(
      usage({ usedBytes: GIB / 4, pendingBytes: GIB / 4, limitBytes: GIB }),
    );

    expect(summary.chargedBytes).toBe(GIB / 2);
    expect(summary.usedPercent).toBe(25);
    expect(summary.pendingPercent).toBe(25);
    expect(summary.hasPending).toBe(true);
    expect(summary.severity).toBe("ok");
  });

  it("never lets the two segments exceed a full track", () => {
    // Over-committed state: used alone already fills the bar and an upload is
    // still in flight. A naive sum would render a 125 %-wide bar.
    const summary = summarizeStorageUsage(
      usage({ usedBytes: GIB, pendingBytes: GIB / 4, limitBytes: GIB, availableBytes: 0 }),
    );

    expect(summary.usedPercent).toBe(100);
    expect(summary.pendingPercent).toBe(0);
    expect(summary.usedPercent + summary.pendingPercent).toBeLessThanOrEqual(100);
  });

  it("treats an exhausted quota as full using the server's availableBytes, not a re-derivation", () => {
    // `availableBytes === 0` is the authority. Charged bytes below the limit
    // must still read as full when the server says there is no room, so the UI
    // cannot disagree with the API that will reject the next upload.
    const summary = summarizeStorageUsage(
      usage({ usedBytes: GIB / 2, limitBytes: GIB, availableBytes: 0 }),
    );

    expect(summary.severity).toBe("full");
    expect(summary.valueText).toContain("Storage full.");
  });

  // Round decimal byte counts here rather than powers of two: the threshold is a
  // ratio comparison, and exact integers keep the assertion about the boundary
  // itself instead of about floating-point division.
  it("warns at the 90 % threshold and not just below it", () => {
    const atThreshold = summarizeStorageUsage(usage({ usedBytes: 900, limitBytes: 1_000 }));
    const belowThreshold = summarizeStorageUsage(usage({ usedBytes: 890, limitBytes: 1_000 }));

    expect(atThreshold.severity).toBe("nearly-full");
    expect(belowThreshold.severity).toBe("ok");
  });

  it("counts in-flight uploads toward the warning threshold", () => {
    // Pending bytes are already reserved against the quota, so a workspace that
    // is only nearly full because of an upload in progress must still be warned.
    const summary = summarizeStorageUsage(
      usage({ usedBytes: 500, pendingBytes: 450, limitBytes: 1_000 }),
    );

    expect(summary.severity).toBe("nearly-full");
  });

  it("does not call a zero limit full, and renders no segments for it", () => {
    const summary = summarizeStorageUsage(usage({ limitBytes: 0, availableBytes: 0 }));

    expect(summary.severity).toBe("ok");
    expect(summary.usedPercent).toBe(0);
    expect(summary.pendingPercent).toBe(0);
  });

  it("states exact byte counts in the value text so the bar is not the only source", () => {
    const summary = summarizeStorageUsage(
      usage({ usedBytes: 1_048_576, pendingBytes: 1_024, limitBytes: GIB }),
    );

    // Exact counts, not the rounded display value, are what a screen reader gets.
    expect(summary.valueText).toContain("1,049,600");
    expect(summary.valueText).toContain("1,073,741,824");
    expect(summary.valueText).toContain("still uploading");
  });

  it("omits the uploading clause when nothing is in flight", () => {
    const summary = summarizeStorageUsage(usage({ usedBytes: 1_024, limitBytes: GIB }));

    expect(summary.valueText).not.toContain("still uploading");
    expect(summary.hasPending).toBe(false);
  });

  it("distinguishes a per-workspace override from a plan default in the label", () => {
    expect(
      summarizeStorageUsage(usage({ limitSource: "plan", plan: "free" })).limitSourceLabel,
    ).toBe("Limit of 1 GiB from the free plan default.");
    expect(
      summarizeStorageUsage(usage({ limitSource: "override", plan: "pro" })).limitSourceLabel,
    ).toBe("Limit of 1 GiB set for this workspace, overriding the pro plan default.");
  });
});

describe("storageSeverityMessage", () => {
  it("returns a sentence only when there is something to warn about", () => {
    expect(storageSeverityMessage("ok")).toBeNull();
    expect(storageSeverityMessage("nearly-full")).toBe("Storage almost full.");
    expect(storageSeverityMessage("full")).toBe(
      "Storage full. New uploads are rejected until files are removed.",
    );
  });
});
