// Part 55 — WHEN to checkpoint a note_versions row.
//
// This module is PURE on purpose: it owns the two checkpoint-cadence decisions
// for note version snapshots and imports NOTHING transport-related — no Yjs, no
// Socket.io, no presence, no Redis, no NestJS injectable. The future Part 58
// collaborative pipeline calls `decideCollaborativeCheckpoint` after persisting
// a Yjs projection, and the synchronous Part 55 note-mutation paths call
// `NoteVersionsService.recordAcceptedState` directly (see decision 4 below).
//
// There are two distinct checkpoint SOURCES, and conflating them is the bug
// this module exists to prevent:
//
//   1. NON-COLLABORATIVE (synchronous, owned here and by NotesService). Every
//      accepted create / copy / content|title|pageSize|tag-or-settings update
//      that goes through `NotesService.{create,copy,update}` writes exactly ONE
//      snapshot inside that mutation's transaction. Structural mutations
//      (move, trash/restore, permanentDelete, folder ops, board-column-only
//      moves) bump `notes.version` but do NOT change recoverable
//      title/content/plain, so they MUST NOT snapshot — a snapshot of a moved
//      note would be a misleading, repetitive history entry. The single source
//      of truth for that eligibility rule is
//      `NON_COLLABORATIVE_CHECKPOINT_MUTATIONS` below; Part 58 may extend it.
//
//   2. COLLABORATIVE (asynchronous, owned by Part 58). High-frequency Yjs edits
//      are NOT snapshotted per keystroke: that would write a version row per
//      character. The future Part 58 projection pipeline instead calls
//      `decideCollaborativeCheckpoint` to decide whether a just-persisted
//      projection is durable enough to also record as a `note_versions` row.
//      The SAFE DEFAULT cadence is "at least `CHECKPOINT_MIN_INTERVAL_MS` of
//      elapsed wall-clock since the last durable version checkpoint", PLUS
//      forced checkpoints at durable persistence/compaction boundaries and at
//      orderly final-room shutdown. A data-loss-safe default (favor fewer
//      checkpoints over lost history) takes precedence over throughput
//      (ADR 0004).
//
// This module is the ONLY collaborative-facing surface Part 55 ships. It does
// not implement transport, rooms, or presence; it only decides cadence.

/**
 * Safe default minimum elapsed wall-clock between two durable collaborative
 * checkpoints for the same note. Five minutes bounds the worst-case "how much
 * collaborative history can a restore lose" gap while keeping `note_versions`
 * append volume far below one-row-per-keystroke. The value is exported so
 * tests and the future Part 58 projection pipeline can reference it without
 * re-hardcoding the constant; runtime tuning will land with Part 58.
 */
export const CHECKPOINT_MIN_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Documentation/testing vocabulary for synchronous mutations that checkpoint.
 * The actual write sites remain explicit in NotesService create/copy/update so
 * no stringly-typed runtime gate can silently disable persistence. Structural
 * mutations are deliberately absent.
 */
export const NON_COLLABORATIVE_CHECKPOINT_MUTATIONS: ReadonlySet<string> = new Set([
  "create",
  "copy",
  "update",
]);

/** True when a synchronous mutation kind is eligible to write a snapshot. */
export function isCheckpointEligibleMutation(mutation: string): boolean {
  return NON_COLLABORATIVE_CHECKPOINT_MUTATIONS.has(mutation);
}

/**
 * Inputs to the collaborative checkpoint cadence decision. The caller (Part 58)
 * supplies authoritative values it already tracks; this function performs no
 * I/O and reads no clocks beyond `now`.
 */
export interface CollaborativeCheckpointInput {
  /** Current wall-clock. The caller passes the authoritative "now". */
  readonly now: Date;
  /**
   * Wall-clock of the most recent durable `note_versions` checkpoint for this
   * note, or `null` when no checkpoint has ever been recorded. The first
   * collaborative persistence always checkpoints so a baseline exists.
   */
  readonly lastDurableCheckpointAt: Date | null;
  /**
   * True when the caller has reached a durable boundary that must checkpoint
   * regardless of cadence: a durable Yjs persistence/compaction, or an orderly
   * final-room shutdown. This is the "do not lose history at a graceful close"
   * override.
   */
  readonly forcedBoundary: boolean;
}

/** Reason a checkpoint decision was reached. Stable for logging/diagnostics. */
export type CollaborativeCheckpointReason =
  "first_checkpoint" | "cadence" | "forced_boundary" | "skip";

export interface CollaborativeCheckpointDecision {
  readonly checkpoint: boolean;
  readonly reason: CollaborativeCheckpointReason;
}

/**
 * Decide whether the collaborative pipeline should write a durable version
 * checkpoint now. PURE: same inputs always yield the same decision.
 *
 * Precedence (data-loss-safe default wins):
 *   1. `forcedBoundary` → checkpoint (a graceful close must not lose history).
 *   2. no prior checkpoint → checkpoint (establish a baseline).
 *   3. elapsed ≥ `CHECKPOINT_MIN_INTERVAL_MS` → checkpoint (cadence).
 *   4. otherwise → skip (avoid a version per keystroke).
 *
 * The function intentionally takes elapsed WALL-CLOCK rather than a byte/change
 * metric: the cadence bounds the recoverable-history gap in human time, which
 * is the property restore UX reasons about, and it keeps the contract
 * independent of any specific Yjs update encoding.
 */
export function decideCollaborativeCheckpoint(
  input: CollaborativeCheckpointInput,
): CollaborativeCheckpointDecision {
  if (input.forcedBoundary) {
    return { checkpoint: true, reason: "forced_boundary" };
  }
  if (input.lastDurableCheckpointAt === null) {
    return { checkpoint: true, reason: "first_checkpoint" };
  }
  const elapsed = input.now.getTime() - input.lastDurableCheckpointAt.getTime();
  if (elapsed >= CHECKPOINT_MIN_INTERVAL_MS) {
    return { checkpoint: true, reason: "cadence" };
  }
  return { checkpoint: false, reason: "skip" };
}
