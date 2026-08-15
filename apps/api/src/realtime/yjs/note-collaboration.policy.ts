// Part 58 — WHEN to compact the Yjs update log, and how long to wait before
// projecting it back into `notes.content`.
//
// This module is PURE for the same reason `note-version-checkpoint.policy.ts`
// is: it owns cadence decisions and nothing else. No Yjs, no Socket.io, no
// Redis, no NestJS injectable, no clock. The room service supplies the counters
// it already tracks and gets back a boolean.
//
// TWO SEPARATE CADENCES, and conflating them is the bug this module prevents:
//
//   1. COMPACTION collapses many `note_collaboration_updates` rows into one
//      `snapshot` row and bumps the epoch. It is a STORAGE decision: the log
//      grows one row per accepted keystroke batch, and an uncompacted room
//      makes every reconnect replay the entire edit history. It is triggered by
//      volume (rows or bytes), never by wall-clock.
//
//   2. PROJECTION rewrites `notes.content` from the Yjs state so every
//      non-collaborative reader (search, export, print, the REST API) sees the
//      current text. It is a VISIBILITY decision, and it is debounced: writing
//      the JSON projection per keystroke would rewrite a multi-kilobyte `jsonb`
//      column hundreds of times a minute for no reader benefit.
//
// Neither is the DURABLE HISTORY decision — that stays with
// `decideCollaborativeCheckpoint` in `note-version-checkpoint.policy.ts`, which
// this module deliberately does not import or duplicate. Compaction is a
// `forcedBoundary` INPUT to that decision; it is not that decision.
//
// WHY EXPORTED CONSTANTS RATHER THAN CONFIG KNOBS. Same precedent as
// `CHECKPOINT_MIN_INTERVAL_MS`: these four values change the SHAPE of the
// persisted log and the projection, so a per-deployment override would mean two
// installations whose stored rooms behave differently under the same code —
// with no way to reproduce a report. They are exported so tests and the room
// service reference one definition instead of re-hardcoding a literal, and a
// change to any of them is a reviewed code change with a migration story, not
// an environment variable someone can turn to zero at 3am.

/**
 * Compact once this many `update` rows have accumulated since the last
 * snapshot. Sized so a normal typing burst never compacts mid-sentence while a
 * long editing session still cannot accumulate an unbounded replay log.
 */
export const COMPACTION_MIN_UPDATES = 64;

/**
 * Compact once the pending updates total this many bytes (128 KiB), even when
 * the row count is low. A few large paste/import updates bloat the replay cost
 * exactly as many small ones do, so the byte bound is an independent trigger
 * rather than a secondary condition on the row bound.
 */
export const COMPACTION_MIN_BYTES = 131_072;

/**
 * Quiet period after the last accepted update before projecting to
 * `notes.content`. Two seconds is below the threshold at which a collaborator
 * would notice a stale read elsewhere in the product, and far above typing
 * cadence, so a continuous typist produces no projection writes at all.
 */
export const PROJECTION_DEBOUNCE_MS = 2_000;

/**
 * Hard ceiling on how long the debounce may keep deferring. Without it, a room
 * with a steady stream of edits would never reach a quiet period and
 * `notes.content` would stay stale for the whole session — invisible to search,
 * export, and every REST reader.
 */
export const PROJECTION_MAX_WAIT_MS = 30_000;

/**
 * Inputs to the compaction decision. The caller supplies counters it already
 * maintains for the current epoch; this function performs no I/O.
 */
export interface CompactionInput {
  /** `update` rows accepted since the last snapshot for this note. */
  readonly pendingUpdates: number;
  /** Sum of `payload_bytes` across those pending rows. */
  readonly pendingBytes: number;
  /**
   * True at a boundary that must compact regardless of volume: an orderly
   * final-room shutdown, or a version restore that invalidates the log.
   */
  readonly forcedBoundary: boolean;
}

/**
 * Decide whether the room should compact its update log now. PURE: the same
 * inputs always yield the same answer.
 *
 * A `forcedBoundary` with NOTHING pending is deliberately `false`. Writing a
 * snapshot row that encodes no new information would grow the log on every
 * room close, and each empty snapshot bumps the epoch and forces every
 * reconnecting client to reload for no reason.
 */
export function shouldCompact(input: CompactionInput): boolean {
  return (
    (input.forcedBoundary && input.pendingUpdates > 0) ||
    input.pendingUpdates >= COMPACTION_MIN_UPDATES ||
    input.pendingBytes >= COMPACTION_MIN_BYTES
  );
}
