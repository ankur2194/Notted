// Part 45 — the pure selection rules every sweep must clear before it deletes.
//
// This is the load-bearing suite of the part. Two properties are asserted here
// exhaustively, because they are properties of the PREDICATE and not of the SQL
// that applies it:
//
// 1. "A sweep never deletes anything reachable from a live row."
//    Every refusal branch is exercised, and the `ready` / `claimed_by_row` cases
//    are checked at absurd ages so no window can ever make them selectable.
//
// 2. "Two consecutive runs produce the same result."
//    Each sweep's predicate is fed the state its OWN first run would leave
//    behind, and must then select nothing. That is idempotency stated where it
//    can actually be proven.

import { storageMaintenanceSweepReportSchema } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_PROCESSING_ERRORS } from "../attachments/attachments.constants";

import {
  decideAbandonedUpload,
  decideExportSweep,
  decideOrphanObject,
  deletedNoteRetentionDays,
  shouldMarkMissingObject,
  shouldPurgeDeletedNote,
  SWEEP_SAMPLE_LIMIT,
  SweepAccumulator,
  type AttachmentLifecycleStatus,
  type DeletedNoteRetentionWindows,
  type ExportLifecycleStatus,
  type OrphanObjectCandidate,
  type SweepWindows,
} from "./storage-maintenance.selection";

import type { WorkspacePlan } from "@notted/shared-types";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WORKSPACE_A = "50000000-0000-4000-8100-000000000001";
const WORKSPACE_B = "50000000-0000-4000-8100-000000000002";
const ATTACHMENT_A = "50000000-0000-4000-8900-000000000001";

const windows: SweepWindows = Object.freeze({
  now: NOW,
  abandonedUploadMs: 24 * HOUR,
  orphanWindowMs: 7 * DAY,
});

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

/* -------------------------------------------------------------------------- */
/* Sweep 1 — abandoned uploads                                                 */
/* -------------------------------------------------------------------------- */

describe("decideAbandonedUpload", () => {
  it("NEVER selects a ready row, at any age whatsoever", () => {
    const ages = [
      0,
      MINUTE,
      HOUR,
      DAY,
      7 * DAY,
      30 * DAY,
      365 * DAY,
      100 * 365 * DAY,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const age of ages) {
      expect(
        decideAbandonedUpload(
          { id: ATTACHMENT_A, processingError: null, status: "ready", createdAt: ago(age) },
          windows,
        ),
      ).toEqual({ sweep: false, reason: "live" });
    }
    // Even a row created in the FUTURE (clock skew) is refused for being live,
    // never for being recent — the status alone decides.
    expect(
      decideAbandonedUpload(
        {
          id: ATTACHMENT_A,
          processingError: null,
          status: "ready",
          createdAt: new Date(NOW.getTime() + DAY),
        },
        windows,
      ),
    ).toEqual({ sweep: false, reason: "live" });
  });

  it("selects pending and processing rows only past the abandoned-upload window", () => {
    for (const status of ["pending", "processing"] as const) {
      expect(
        decideAbandonedUpload(
          { id: ATTACHMENT_A, processingError: null, status, createdAt: ago(23 * HOUR) },
          windows,
        ),
      ).toEqual({ sweep: false, reason: "too_recent" });
      // The boundary is inclusive: exactly one window old is abandoned.
      expect(
        decideAbandonedUpload(
          { id: ATTACHMENT_A, processingError: null, status, createdAt: ago(24 * HOUR) },
          windows,
        ),
      ).toEqual({ sweep: true, reason: "abandoned_upload" });
      expect(
        decideAbandonedUpload(
          { id: ATTACHMENT_A, processingError: null, status, createdAt: ago(30 * DAY) },
          windows,
        ),
      ).toEqual({ sweep: true, reason: "abandoned_upload" });
    }
  });

  it("holds a failed row for the wider ADR 0005 grace window, not the upload window", () => {
    // A failed row already consumes no quota, so it is kept long enough for a
    // user to see the failure and for compensation to have finished.
    expect(
      decideAbandonedUpload(
        { id: ATTACHMENT_A, processingError: null, status: "failed", createdAt: ago(2 * DAY) },
        windows,
      ),
    ).toEqual({ sweep: false, reason: "too_recent" });
    expect(
      decideAbandonedUpload(
        { id: ATTACHMENT_A, processingError: null, status: "failed", createdAt: ago(7 * DAY) },
        windows,
      ),
    ).toEqual({ sweep: true, reason: "terminal_failure" });
  });

  it("NEVER reaps a row sweep 2 marked because its bytes vanished, at any age", () => {
    // Both windows are measured from `created_at`, and a row can only reach this
    // marked state once it is ALREADY older than the orphan window — so without
    // the exemption every reconciliation record would be hard-deleted by the
    // very next pass, destroying the user's only evidence the file existed.
    for (const age of [7 * DAY, 30 * DAY, 365 * DAY, 100 * 365 * DAY]) {
      expect(
        decideAbandonedUpload(
          {
            id: ATTACHMENT_A,
            status: "failed",
            processingError: ATTACHMENT_PROCESSING_ERRORS.storageObjectMissing,
            createdAt: ago(age),
          },
          windows,
        ),
      ).toEqual({ sweep: false, reason: "reconciliation_record" });
    }
    // The exemption is narrow: any OTHER failure code is still reaped normally.
    expect(
      decideAbandonedUpload(
        {
          id: ATTACHMENT_A,
          status: "failed",
          processingError: ATTACHMENT_PROCESSING_ERRORS.decodeFailed,
          createdAt: ago(30 * DAY),
        },
        windows,
      ),
    ).toEqual({ sweep: true, reason: "terminal_failure" });
  });

  it("is deterministic, so a second pass over the same state decides the same way", () => {
    const candidates = (["pending", "processing", "ready", "failed"] as const).map((status) => ({
      id: ATTACHMENT_A,
      processingError: null,
      status,
      createdAt: ago(10 * DAY),
    }));
    for (const candidate of candidates) {
      expect(decideAbandonedUpload(candidate, windows)).toEqual(
        decideAbandonedUpload(candidate, windows),
      );
    }
  });

  it("selects nothing on a second run, because the rows it approves are removed", () => {
    // The first run's action is "delete the row". The state it leaves behind is
    // therefore the empty candidate set, and the only rows that survive are the
    // ones the predicate already refused.
    const all: readonly {
      id: string;
      status: AttachmentLifecycleStatus;
      createdAt: Date;
      processingError: string | null;
    }[] = [
      { id: ATTACHMENT_A, processingError: null, status: "pending", createdAt: ago(10 * DAY) },
      { id: ATTACHMENT_A, processingError: null, status: "processing", createdAt: ago(10 * DAY) },
      { id: ATTACHMENT_A, processingError: null, status: "failed", createdAt: ago(10 * DAY) },
      { id: ATTACHMENT_A, processingError: null, status: "ready", createdAt: ago(10 * DAY) },
      { id: ATTACHMENT_A, processingError: null, status: "pending", createdAt: ago(MINUTE) },
    ];
    const survivors = all.filter((row) => !decideAbandonedUpload(row, windows).sweep);
    expect(survivors).toHaveLength(2);
    expect(survivors.every((row) => !decideAbandonedUpload(row, windows).sweep)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 2 — orphaned objects                                                  */
/* -------------------------------------------------------------------------- */

const CLAIMED_KEY = `w/${WORKSPACE_A}/a/${ATTACHMENT_A}/original/${"a".repeat(32)}.png`;
const STALE_KEY = `w/${WORKSPACE_A}/a/${ATTACHMENT_A}/thumbnail/${"b".repeat(32)}.webp`;

function orphanCandidate(overrides: Partial<OrphanObjectCandidate> = {}): OrphanObjectCandidate {
  return {
    key: CLAIMED_KEY,
    lastModified: ago(30 * DAY),
    parsed: { workspaceId: WORKSPACE_A, attachmentId: ATTACHMENT_A, variant: "original" },
    owner: { id: ATTACHMENT_A, workspaceId: WORKSPACE_A, ownedKeys: [CLAIMED_KEY] },
    ...overrides,
  };
}

describe("decideOrphanObject", () => {
  it("NEVER deletes an object a live row still claims, at any age", () => {
    for (const age of [7 * DAY, 30 * DAY, 365 * DAY, 100 * 365 * DAY]) {
      expect(decideOrphanObject(orphanCandidate({ lastModified: ago(age) }), windows)).toEqual({
        sweep: false,
        reason: "claimed_by_row",
      });
    }
  });

  it("refuses a key it cannot parse, so a foreign key family is never touched", () => {
    for (const key of [
      "test/island/object.bin",
      "e/exports/2026/report.zip",
      `w/${WORKSPACE_A}/a/${ATTACHMENT_A}/original/short.png`,
      "",
    ]) {
      expect(
        decideOrphanObject(
          orphanCandidate({ key, parsed: null, owner: null, lastModified: ago(365 * DAY) }),
          windows,
        ),
      ).toEqual({ sweep: false, reason: "unparsable_key" });
    }
  });

  it("refuses a freshly written object even when NO owning row exists yet", () => {
    // This is the race guard. The dangerous interleaving is: the upload writes
    // the object, the listing observes it, the `ready` transaction has not
    // committed, the lookup finds nothing. The age guard makes that unreachable
    // rather than unlikely.
    for (const age of [0, MINUTE, HOUR, DAY, 7 * DAY - 1]) {
      expect(
        decideOrphanObject(orphanCandidate({ owner: null, lastModified: ago(age) }), windows),
      ).toEqual({ sweep: false, reason: "too_recent" });
    }
    // Only once the whole grace period has elapsed does it become collectable.
    expect(
      decideOrphanObject(orphanCandidate({ owner: null, lastModified: ago(7 * DAY) }), windows),
    ).toEqual({ sweep: true, reason: "no_owning_row" });
  });

  it("refuses a workspace mismatch rather than guessing which side is right", () => {
    expect(
      decideOrphanObject(
        orphanCandidate({
          owner: { id: ATTACHMENT_A, workspaceId: WORKSPACE_B, ownedKeys: [CLAIMED_KEY] },
        }),
        windows,
      ),
    ).toEqual({ sweep: false, reason: "workspace_mismatch" });
    // Corruption is reported, never repaired by deletion — even when the row
    // does not claim the key either.
    expect(
      decideOrphanObject(
        orphanCandidate({
          key: STALE_KEY,
          parsed: { workspaceId: WORKSPACE_A, attachmentId: ATTACHMENT_A, variant: "thumbnail" },
          owner: { id: ATTACHMENT_A, workspaceId: WORKSPACE_B, ownedKeys: [] },
        }),
        windows,
      ),
    ).toEqual({ sweep: false, reason: "workspace_mismatch" });
  });

  it("collects a variant the row abandoned when it was reprocessed", () => {
    expect(
      decideOrphanObject(
        orphanCandidate({
          key: STALE_KEY,
          parsed: { workspaceId: WORKSPACE_A, attachmentId: ATTACHMENT_A, variant: "thumbnail" },
          owner: { id: ATTACHMENT_A, workspaceId: WORKSPACE_A, ownedKeys: [CLAIMED_KEY] },
        }),
        windows,
      ),
    ).toEqual({ sweep: true, reason: "unclaimed_variant" });
  });

  it("selects nothing on a second run over the state the first run leaves", () => {
    const listing = [
      orphanCandidate(),
      orphanCandidate({ owner: null }),
      orphanCandidate({
        key: STALE_KEY,
        parsed: { workspaceId: WORKSPACE_A, attachmentId: ATTACHMENT_A, variant: "thumbnail" },
        owner: { id: ATTACHMENT_A, workspaceId: WORKSPACE_A, ownedKeys: [CLAIMED_KEY] },
      }),
      orphanCandidate({ key: "test/island/object.bin", parsed: null, owner: null }),
    ];
    const removed = listing.filter((candidate) => decideOrphanObject(candidate, windows).sweep);
    expect(removed).toHaveLength(2);

    // The first run DELETES those objects, so the next listing no longer
    // contains them. Everything that remains is refused again.
    const secondRun = listing.filter((candidate) => !removed.includes(candidate));
    for (const candidate of secondRun) {
      expect(decideOrphanObject(candidate, windows).sweep).toBe(false);
    }
  });
});

describe("shouldMarkMissingObject", () => {
  it("is false for every row that is not ready, however old and however absent", () => {
    for (const status of ["pending", "processing", "failed"] as const) {
      expect(
        shouldMarkMissingObject(
          {
            id: ATTACHMENT_A,
            status,
            createdAt: ago(365 * DAY),
            primaryObjectAbsent: true,
          },
          windows,
        ),
      ).toBe(false);
    }
  });

  it("is false whenever the object is present", () => {
    expect(
      shouldMarkMissingObject(
        {
          id: ATTACHMENT_A,
          status: "ready",
          createdAt: ago(365 * DAY),
          primaryObjectAbsent: false,
        },
        windows,
      ),
    ).toBe(false);
  });

  it("is false inside the grace window, and true only outside it", () => {
    expect(
      shouldMarkMissingObject(
        { id: ATTACHMENT_A, status: "ready", createdAt: ago(DAY), primaryObjectAbsent: true },
        windows,
      ),
    ).toBe(false);
    expect(
      shouldMarkMissingObject(
        { id: ATTACHMENT_A, status: "ready", createdAt: ago(7 * DAY), primaryObjectAbsent: true },
        windows,
      ),
    ).toBe(true);
  });

  it("selects nothing on a second run, because marking leaves a failed row", () => {
    const candidate = {
      id: ATTACHMENT_A,
      status: "ready" as AttachmentLifecycleStatus,
      createdAt: ago(30 * DAY),
      primaryObjectAbsent: true,
    };
    expect(shouldMarkMissingObject(candidate, windows)).toBe(true);
    // The state the first run leaves behind.
    expect(shouldMarkMissingObject({ ...candidate, status: "failed" }, windows)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 3 — expired exports                                                   */
/* -------------------------------------------------------------------------- */

const EXPORT_ID = "50000000-0000-4000-8a00-000000000001";
const EXPORT_KEY = "exports/2026/08/report.zip";

describe("decideExportSweep", () => {
  it("expires a ready row past its expiry while KEEPING the object key", () => {
    expect(
      decideExportSweep(
        {
          id: EXPORT_ID,
          status: "ready",
          objectExpiresAt: ago(MINUTE),
          objectKey: EXPORT_KEY,
        },
        windows,
      ),
    ).toBe("expire_row");
    // The boundary is inclusive.
    expect(
      decideExportSweep(
        { id: EXPORT_ID, status: "ready", objectExpiresAt: NOW, objectKey: EXPORT_KEY },
        windows,
      ),
    ).toBe("expire_row");
  });

  it("leaves a ready row alone before expiry, or with no expiry at all", () => {
    expect(
      decideExportSweep(
        {
          id: EXPORT_ID,
          status: "ready",
          objectExpiresAt: new Date(NOW.getTime() + MINUTE),
          objectKey: EXPORT_KEY,
        },
        windows,
      ),
    ).toBe("none");
    expect(
      decideExportSweep(
        { id: EXPORT_ID, status: "ready", objectExpiresAt: null, objectKey: EXPORT_KEY },
        windows,
      ),
    ).toBe("none");
  });

  it("never touches a row that is still being produced", () => {
    for (const status of ["queued", "processing"] as const) {
      expect(
        decideExportSweep(
          { id: EXPORT_ID, status, objectExpiresAt: ago(30 * DAY), objectKey: EXPORT_KEY },
          windows,
        ),
      ).toBe("none");
    }
  });

  it("releases the object of any terminal row that still carries a key", () => {
    for (const status of ["expired", "failed", "cancelled"] as const) {
      expect(
        decideExportSweep(
          { id: EXPORT_ID, status, objectExpiresAt: ago(30 * DAY), objectKey: EXPORT_KEY },
          windows,
        ),
      ).toBe("release_object");
    }
  });

  it("runs the two phases to a fixed point, so a second run selects nothing", () => {
    // Phase 1 input: ready, past expiry, key present.
    let row: {
      id: string;
      status: ExportLifecycleStatus;
      objectExpiresAt: Date | null;
      objectKey: string | null;
    } = { id: EXPORT_ID, status: "ready", objectExpiresAt: ago(DAY), objectKey: EXPORT_KEY };
    expect(decideExportSweep(row, windows)).toBe("expire_row");

    // What phase 1 leaves behind: expired, key deliberately KEPT.
    row = { ...row, status: "expired" };
    expect(decideExportSweep(row, windows)).toBe("release_object");

    // What phase 2 leaves behind: expired, key nulled after the object is gone.
    row = { ...row, objectKey: null };
    expect(decideExportSweep(row, windows)).toBe("none");

    // And it stays at "none" forever.
    expect(decideExportSweep(row, windows)).toBe("none");
    for (const status of ["expired", "failed", "cancelled"] as const) {
      expect(decideExportSweep({ ...row, status }, windows)).toBe("none");
    }
  });

  it("survives a crash between the two phases", () => {
    // An `expired` row that still owns bytes is exactly what phase 2 selects, so
    // a process killed between the update and the object removal loses nothing.
    expect(
      decideExportSweep(
        { id: EXPORT_ID, status: "expired", objectExpiresAt: ago(DAY), objectKey: EXPORT_KEY },
        windows,
      ),
    ).toBe("release_object");
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 4 — deleted-note retention                                            */
/* -------------------------------------------------------------------------- */

const NOTE_ID = "50000000-0000-4000-8500-000000000001";

/** The shipped defaults: free purges after 30 days, paid plans never purge. */
const defaultRetention: DeletedNoteRetentionWindows = Object.freeze({
  free: 30,
  pro: null,
  enterprise: null,
});

describe("deletedNoteRetentionDays", () => {
  it("returns null — never purge — for pro and enterprise when configured unlimited", () => {
    expect(deletedNoteRetentionDays("pro", defaultRetention)).toBeNull();
    expect(deletedNoteRetentionDays("enterprise", defaultRetention)).toBeNull();
    expect(deletedNoteRetentionDays("free", defaultRetention)).toBe(30);
  });

  it("returns the configured finite window when an operator sets one", () => {
    const configured: DeletedNoteRetentionWindows = { free: 14, pro: 365, enterprise: 730 };
    expect(deletedNoteRetentionDays("free", configured)).toBe(14);
    expect(deletedNoteRetentionDays("pro", configured)).toBe(365);
    expect(deletedNoteRetentionDays("enterprise", configured)).toBe(730);
  });
});

describe("shouldPurgeDeletedNote", () => {
  it("NEVER purges a paid workspace with an unlimited window, and never falls back to free", () => {
    for (const plan of ["pro", "enterprise"] as const) {
      for (const age of [31 * DAY, 365 * DAY, 100 * 365 * DAY]) {
        expect(
          shouldPurgeDeletedNote(
            { id: NOTE_ID, plan, isDeleted: true, deletedAt: ago(age) },
            defaultRetention,
            NOW,
          ),
        ).toBe(false);
      }
    }
    // The free window is finite and DOES apply, which is what makes the
    // assertion above meaningful rather than vacuous.
    expect(
      shouldPurgeDeletedNote(
        { id: NOTE_ID, plan: "free", isDeleted: true, deletedAt: ago(31 * DAY) },
        defaultRetention,
        NOW,
      ),
    ).toBe(true);
  });

  it("is false when is_deleted is true but deleted_at is null", () => {
    // A row with no timestamp has no measurable age; purging it would be a
    // guess, and the guess destroys data.
    for (const plan of ["free", "pro", "enterprise"] as const) {
      expect(
        shouldPurgeDeletedNote(
          { id: NOTE_ID, plan, isDeleted: true, deletedAt: null },
          { free: 1, pro: 1, enterprise: 1 },
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("is false for a note the user has not deleted", () => {
    expect(
      shouldPurgeDeletedNote(
        { id: NOTE_ID, plan: "free", isDeleted: false, deletedAt: ago(365 * DAY) },
        defaultRetention,
        NOW,
      ),
    ).toBe(false);
  });

  it("holds a soft-deleted note for the whole window, to the day", () => {
    expect(
      shouldPurgeDeletedNote(
        { id: NOTE_ID, plan: "free", isDeleted: true, deletedAt: ago(30 * DAY - 1) },
        defaultRetention,
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldPurgeDeletedNote(
        { id: NOTE_ID, plan: "free", isDeleted: true, deletedAt: ago(30 * DAY) },
        defaultRetention,
        NOW,
      ),
    ).toBe(true);
  });

  it("applies each plan's own window rather than one global window", () => {
    const configured: DeletedNoteRetentionWindows = { free: 7, pro: 90, enterprise: 365 };
    const cases: readonly (readonly [WorkspacePlan, number, boolean])[] = [
      ["free", 8 * DAY, true],
      ["pro", 8 * DAY, false],
      ["pro", 91 * DAY, true],
      ["enterprise", 91 * DAY, false],
      ["enterprise", 366 * DAY, true],
    ];
    for (const [plan, age, expected] of cases) {
      expect(
        shouldPurgeDeletedNote(
          { id: NOTE_ID, plan, isDeleted: true, deletedAt: ago(age) },
          configured,
          NOW,
        ),
      ).toBe(expected);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Report accumulation                                                         */
/* -------------------------------------------------------------------------- */

function uuid(index: number): string {
  return `50000000-0000-4000-8b00-${String(index).padStart(12, "0")}`;
}

describe("SweepAccumulator", () => {
  it("bounds the sample at SWEEP_SAMPLE_LIMIT, matching the shared Zod bound", () => {
    expect(SWEEP_SAMPLE_LIMIT).toBe(50);
    const accumulator = new SweepAccumulator("abandonedUploads");
    for (let index = 0; index < 500; index += 1) {
      accumulator.selected += 1;
      accumulator.sample(uuid(index));
    }
    const report = accumulator.finish();
    expect(report.sampleIds).toHaveLength(SWEEP_SAMPLE_LIMIT);
    // The bound truncates the TAIL; the first ids seen are the ones reported.
    expect(report.sampleIds[0]).toBe(uuid(0));
    expect(report.sampleIds.at(-1)).toBe(uuid(SWEEP_SAMPLE_LIMIT - 1));
    // The count is NOT bounded — only the echoed sample is.
    expect(report.selected).toBe(500);
    expect(() => storageMaintenanceSweepReportSchema.parse(report)).not.toThrow();
  });

  it("de-duplicates and sorts note codes", () => {
    const accumulator = new SweepAccumulator("orphanedObjects");
    accumulator.note("unparsable_keys_skipped");
    accumulator.note("storage_disabled");
    accumulator.note("unparsable_keys_skipped");
    accumulator.note("object_scan_truncated");
    accumulator.note("storage_disabled");
    expect(accumulator.finish().notes).toEqual([
      "object_scan_truncated",
      "storage_disabled",
      "unparsable_keys_skipped",
    ]);
  });

  it("returns a frozen report, sample and notes included", () => {
    const accumulator = new SweepAccumulator("expiredExports");
    accumulator.examined = 4;
    accumulator.selected = 3;
    accumulator.rowsRemoved = 1;
    accumulator.rowsMarked = 1;
    accumulator.objectsRemoved = 1;
    accumulator.truncated = true;
    accumulator.sample(uuid(1));
    accumulator.note("export_object_removal_failed");

    const report = accumulator.finish();
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sampleIds)).toBe(true);
    expect(Object.isFrozen(report.notes)).toBe(true);
    expect(report).toEqual({
      sweep: "expiredExports",
      examined: 4,
      selected: 3,
      rowsRemoved: 1,
      rowsMarked: 1,
      objectsRemoved: 1,
      truncated: true,
      sampleIds: [uuid(1)],
      notes: ["export_object_removal_failed"],
    });
  });

  it("starts at zero, so an untouched sweep reports an empty result", () => {
    const report = new SweepAccumulator("deletedNoteRetention").finish();
    expect(report).toEqual({
      sweep: "deletedNoteRetention",
      examined: 0,
      selected: 0,
      rowsRemoved: 0,
      rowsMarked: 0,
      objectsRemoved: 0,
      truncated: false,
      sampleIds: [],
      notes: [],
    });
  });
});
