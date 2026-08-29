// Part 45: the pure selection rules for every storage-maintenance sweep.
//
// WHY THESE ARE PURE FUNCTIONS
// The two acceptance properties of this part — "a sweep never deletes anything
// reachable from a live row" and "two consecutive runs produce the same result"
// — are properties of the PREDICATE, not of the SQL that applies it. Keeping the
// predicates here means both can be proven exhaustively in a unit test with no
// PostgreSQL, no MinIO, and no clock.
//
// The service below is then deliberately boring: select candidates, ask a
// function here whether each one may be touched, act. A candidate that no
// function here approves is never deleted, no matter what the query returned.

import { ATTACHMENT_PROCESSING_ERRORS } from "../attachments/attachments.constants";

import type {
  StorageMaintenanceSweepName,
  StorageMaintenanceSweepReport,
  WorkspacePlan,
} from "@notted/shared-types";

/** Attachment lifecycle states, mirrored from the schema enum. */
export type AttachmentLifecycleStatus = "pending" | "processing" | "ready" | "failed";

/** Export lifecycle states, mirrored from the schema enum. */
export type ExportLifecycleStatus =
  "queued" | "processing" | "ready" | "failed" | "expired" | "cancelled";

export interface SweepWindows {
  /** Evaluation instant. Passed in so every predicate is deterministic in tests. */
  readonly now: Date;
  /** How long a `pending`/`processing` row may live before it is abandoned. */
  readonly abandonedUploadMs: number;
  /**
   * ADR 0005's reconciliation grace period (`RETENTION_ORPHANED_OBJECT_DAYS`).
   * Bounds BOTH object-side reconciliation and the removal of terminal `failed`
   * rows.
   */
  readonly orphanWindowMs: number;
}

/* -------------------------------------------------------------------------- */
/* Sweep 1 — abandoned uploads                                                 */
/* -------------------------------------------------------------------------- */

export interface AbandonedUploadCandidate {
  readonly id: string;
  readonly status: AttachmentLifecycleStatus;
  readonly createdAt: Date;
  /** `attachments.processing_error`; identifies WHY a `failed` row failed. */
  readonly processingError: string | null;
}

export type AbandonedUploadDecision =
  | { readonly sweep: false; readonly reason: "live" | "too_recent" | "reconciliation_record" }
  | { readonly sweep: true; readonly reason: "abandoned_upload" | "terminal_failure" };

/**
 * May this attachment row be removed as an upload that never became content?
 *
 * Plan Part 45 asks for a sweep of "abandoned multipart uploads". The API
 * performs no S3 multipart upload — `uploadImage`/`uploadFile` buffer the whole
 * payload and issue a single `putObject` — so the equivalent abandoned state in
 * this system is an attachment ROW that reserved quota and then never reached
 * `ready`. That is what this sweep reclaims.
 *
 * Two selectable shapes, and nothing else:
 *
 * - `pending` / `processing` older than `abandonedUploadMs`. Uploads are
 *   synchronous and complete in seconds, so a row still in flight a day later is
 *   owned by a process that no longer exists. Its bytes are charged against the
 *   workspace quota, which is why this window is much tighter than the object
 *   reconciliation window.
 * - `failed` older than `orphanWindowMs`. A failed row is already excluded from
 *   the quota and is shown to the user as a failed upload; after the ADR 0005
 *   grace period it is removed together with any bytes `compensate` did not
 *   manage to delete.
 *
 * A `ready` row is NEVER selectable here, at any age. That is the "never delete
 * anything reachable from a live row" property in its most direct form.
 *
 * ONE `failed` ROW IS EXEMPT, AND THE EXEMPTION IS PERMANENT.
 * Sweep 2 marks a row `storage_object_missing` when a `ready` row's bytes
 * turned out to be gone. Both windows are measured from `created_at`, and that
 * marking is only reachable once the row is ALREADY older than
 * `orphanWindowMs` — so without this guard 100% of reconciliation-marked rows
 * would be hard-deleted by the very next pass, spending a grace period that was
 * exhausted before it began. That would turn "your file is broken" into "your
 * file never happened", which is precisely the outcome sweep 2 exists to
 * prevent, and it would break the "repeated runs produce the same safe result"
 * property (pass N marks, pass N+1 destroys). These rows carry no reclaimable
 * bytes by definition — their object is the thing that vanished — so keeping
 * them costs a row and buys the user's record of the loss.
 */
export function decideAbandonedUpload(
  candidate: AbandonedUploadCandidate,
  windows: SweepWindows,
): AbandonedUploadDecision {
  if (candidate.status === "ready") return { sweep: false, reason: "live" };
  const ageMs = windows.now.getTime() - candidate.createdAt.getTime();
  if (candidate.status === "failed") {
    if (candidate.processingError === ATTACHMENT_PROCESSING_ERRORS.storageObjectMissing) {
      return { sweep: false, reason: "reconciliation_record" };
    }
    return ageMs >= windows.orphanWindowMs
      ? { sweep: true, reason: "terminal_failure" }
      : { sweep: false, reason: "too_recent" };
  }
  return ageMs >= windows.abandonedUploadMs
    ? { sweep: true, reason: "abandoned_upload" }
    : { sweep: false, reason: "too_recent" };
}

/* -------------------------------------------------------------------------- */
/* Sweep 2 — orphaned objects and rows                                         */
/* -------------------------------------------------------------------------- */

/**
 * What the sweep knows about the attachment row an object key points at.
 * `null` means no row with that id exists in the scanned scope.
 */
export interface ObjectOwnerFacts {
  readonly id: string;
  readonly workspaceId: string;
  /** Every key this row currently claims, from `attachmentObjectKeys`. */
  readonly ownedKeys: readonly string[];
}

export interface OrphanObjectCandidate {
  readonly key: string;
  readonly lastModified: Date;
  /**
   * The workspace and owning row parsed out of the key; `null` when the key is
   * not ours.
   *
   * Deliberately generic over the key FAMILY. `decideOrphanObject` never reads
   * anything beyond `workspaceId`, so the same age guard, the same
   * `workspace_mismatch` rule and the same `claimed_by_row` rule serve both the
   * `attachments` bucket (`w/<workspace>/<attachment>/<variant>`) and the
   * `exports` bucket (`<workspace>/<export>.<ext>`). Two decision functions
   * would be two places to forget the age window.
   */
  readonly parsed: {
    readonly workspaceId: string;
    readonly ownerId: string;
  } | null;
  readonly owner: ObjectOwnerFacts | null;
}

export type OrphanObjectDecision =
  | {
      readonly sweep: false;
      readonly reason: "unparsable_key" | "too_recent" | "claimed_by_row" | "workspace_mismatch";
    }
  | { readonly sweep: true; readonly reason: "no_owning_row" | "unclaimed_variant" };

/**
 * May this stored object be deleted?
 *
 * THE RACE, AND WHY THE AGE GUARD CLOSES IT
 * A bucket listing is a snapshot taken over time, and the database is queried
 * afterwards. The dangerous interleaving is: an upload writes an object, the
 * listing observes it, the upload's `ready` transaction has not committed yet,
 * the sweep looks the row up, sees nothing, and deletes bytes that a live row is
 * about to claim.
 *
 * The age guard makes that interleaving unreachable rather than unlikely. An
 * object written during this run has `lastModified ≈ now`, so its age is
 * ~0 and it is refused for `too_recent`. Nothing younger than
 * `orphanWindowMs` (7 days by default) can be deleted at all, and no upload
 * takes seven days to commit its row. There is no lock, no listing-versus-query
 * ordering requirement, and no need for the listing to be consistent.
 *
 * The reverse interleaving — a row is deleted after the listing but before the
 * lookup — makes the sweep SKIP a genuine orphan. That is the safe direction and
 * the next pass collects it.
 *
 * Four refusals and two approvals:
 *
 * - `unparsable_key` — the key is not in the Part 40 attachment layout. It could
 *   belong to a future key family, a test island, or an operator's own upload.
 *   Never deleted; only counted.
 * - `too_recent` — inside the grace window (the race guard above).
 * - `claimed_by_row` — a live row lists this exact key. Never deleted.
 * - `workspace_mismatch` — the key's workspace partition disagrees with the
 *   row's `workspace_id`. That is a corruption signal, not a cleanup task; the
 *   sweep refuses and reports rather than guessing which one is right.
 * - `no_owning_row` — nothing in the database owns the attachment id.
 * - `unclaimed_variant` — a row exists but no longer lists this key, which is
 *   what reprocessing leaves behind (variant keys are immutable, so a rewrite
 *   produces new keys and abandons the old ones).
 *
 * NOTE: the key is used only to ATTRIBUTE an object to a candidate row. It is
 * never an authorization input (ADR 0005) — the row, inside its workspace, is
 * still the sole authority for anything a user can reach.
 */
export function decideOrphanObject(
  candidate: OrphanObjectCandidate,
  windows: SweepWindows,
): OrphanObjectDecision {
  if (candidate.parsed === null) return { sweep: false, reason: "unparsable_key" };
  const ageMs = windows.now.getTime() - candidate.lastModified.getTime();
  if (ageMs < windows.orphanWindowMs) return { sweep: false, reason: "too_recent" };
  if (candidate.owner === null) return { sweep: true, reason: "no_owning_row" };
  if (candidate.owner.workspaceId !== candidate.parsed.workspaceId) {
    return { sweep: false, reason: "workspace_mismatch" };
  }
  return candidate.owner.ownedKeys.includes(candidate.key)
    ? { sweep: false, reason: "claimed_by_row" }
    : { sweep: true, reason: "unclaimed_variant" };
}

export interface MissingObjectCandidate {
  readonly id: string;
  readonly status: AttachmentLifecycleStatus;
  readonly createdAt: Date;
  /** `true` only when storage answered "this key does not exist" (a 404). */
  readonly primaryObjectAbsent: boolean;
}

/**
 * Should a `ready` row be marked failed because its bytes are gone?
 *
 * Only `ready` rows qualify (a `pending` row legitimately has no object yet),
 * only outside the grace window, and only when storage positively answered
 * "absent". Any other storage error propagates and aborts the sweep rather than
 * being read as absence — a misconfigured endpoint must never be able to mark a
 * workspace's whole library as broken.
 */
export function shouldMarkMissingObject(
  candidate: MissingObjectCandidate,
  windows: SweepWindows,
): boolean {
  if (candidate.status !== "ready" || !candidate.primaryObjectAbsent) return false;
  return windows.now.getTime() - candidate.createdAt.getTime() >= windows.orphanWindowMs;
}

/* -------------------------------------------------------------------------- */
/* Sweep 3 — expired exports                                                   */
/* -------------------------------------------------------------------------- */

export interface ExportCandidate {
  readonly id: string;
  readonly status: ExportLifecycleStatus;
  readonly objectExpiresAt: Date | null;
  readonly objectKey: string | null;
}

export type ExportSweepAction = "expire_row" | "release_object" | "none";

/**
 * Which of the two export cleanup phases applies to this row.
 *
 * The phases are deliberately separate, and the ORDER between them is what makes
 * the sweep crash-safe and idempotent:
 *
 * 1. `expire_row` — a `ready` row past `object_expires_at` is flipped to
 *    `expired` while KEEPING its `object_key`. The row stops being downloadable
 *    immediately, and the key survives as the durable record of bytes still owed
 *    a deletion.
 * 2. `release_object` — any terminal row that still carries an `object_key` has
 *    its object removed, then the column nulled.
 *
 * A crash between the two leaves an `expired` row with a key, which is exactly
 * the input phase 2 selects on the next pass. Deleting the object first would
 * risk a `ready` row pointing at bytes that no longer exist; nulling the key
 * first would lose the only pointer to bytes nothing can ever reclaim, because
 * export keys are not in the attachment key family that sweep 2 understands.
 *
 * A second run therefore selects nothing: phase 1 finds no `ready` rows past
 * expiry, and phase 2 finds no terminal rows with a key.
 */
export function decideExportSweep(
  candidate: ExportCandidate,
  windows: SweepWindows,
): ExportSweepAction {
  const terminal =
    candidate.status === "expired" ||
    candidate.status === "failed" ||
    candidate.status === "cancelled";
  if (terminal) {
    return candidate.objectKey === null ? "none" : "release_object";
  }
  if (candidate.status !== "ready") return "none";
  if (candidate.objectExpiresAt === null) return "none";
  return candidate.objectExpiresAt.getTime() <= windows.now.getTime() ? "expire_row" : "none";
}

/* -------------------------------------------------------------------------- */
/* Sweep 4 — deleted-note retention                                            */
/* -------------------------------------------------------------------------- */

export interface DeletedNoteRetentionWindows {
  readonly free: number;
  readonly pro: number | null;
  readonly enterprise: number | null;
}

export interface DeletedNoteCandidate {
  readonly id: string;
  readonly plan: WorkspacePlan;
  readonly isDeleted: boolean;
  readonly deletedAt: Date | null;
}

/**
 * Retention window for a plan, in days, or `null` for "never purge".
 *
 * Pro and Enterprise default to unlimited (`RETENTION_DELETED_NOTE_DAYS_PRO` /
 * `..._ENTERPRISE` accept the literal `unlimited`), and `null` MUST mean the
 * sweep skips those workspaces entirely rather than falling back to the free
 * window — silently applying a 30-day purge to a paid workspace would destroy
 * data the plan promises to keep.
 */
export function deletedNoteRetentionDays(
  plan: WorkspacePlan,
  windows: DeletedNoteRetentionWindows,
): number | null {
  if (plan === "pro") return windows.pro;
  if (plan === "enterprise") return windows.enterprise;
  return windows.free;
}

/**
 * May this soft-deleted note be hard-deleted?
 *
 * Requires all four: the note is soft-deleted, it carries a `deleted_at` (a
 * `is_deleted = true` row with a null timestamp has no measurable age and is
 * never purged), its plan has a finite window, and that window has elapsed.
 */
export function shouldPurgeDeletedNote(
  candidate: DeletedNoteCandidate,
  windows: DeletedNoteRetentionWindows,
  now: Date,
): boolean {
  if (!candidate.isDeleted || candidate.deletedAt === null) return false;
  const days = deletedNoteRetentionDays(candidate.plan, windows);
  if (days === null) return false;
  const ageMs = now.getTime() - candidate.deletedAt.getTime();
  return ageMs >= days * 24 * 60 * 60 * 1_000;
}

/* -------------------------------------------------------------------------- */
/* Report accumulation                                                         */
/* -------------------------------------------------------------------------- */

/** Maximum UUIDs echoed back per sweep; matches the shared Zod bound. */
export const SWEEP_SAMPLE_LIMIT = 50;

/**
 * Mutable accumulator for one sweep. Kept separate from the frozen wire shape so
 * the service can count as it goes without rebuilding an immutable object per
 * row.
 */
export class SweepAccumulator {
  examined = 0;
  selected = 0;
  rowsRemoved = 0;
  rowsMarked = 0;
  objectsRemoved = 0;
  truncated = false;
  private readonly samples: string[] = [];
  private readonly noteCodes = new Set<string>();

  constructor(private readonly sweep: StorageMaintenanceSweepName) {}

  /** Record a selected resource id, bounded so a huge sweep cannot bloat a response. */
  sample(id: string): void {
    if (this.samples.length < SWEEP_SAMPLE_LIMIT) this.samples.push(id);
  }

  /** Record a fixed-vocabulary observation. Never accepts an error message. */
  note(code: string): void {
    this.noteCodes.add(code);
  }

  finish(): StorageMaintenanceSweepReport {
    return Object.freeze({
      sweep: this.sweep,
      examined: this.examined,
      selected: this.selected,
      rowsRemoved: this.rowsRemoved,
      rowsMarked: this.rowsMarked,
      objectsRemoved: this.objectsRemoved,
      truncated: this.truncated,
      sampleIds: Object.freeze([...this.samples]),
      notes: Object.freeze([...this.noteCodes].sort()),
    });
  }
}
