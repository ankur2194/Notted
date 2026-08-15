// Part 58 — every statement that touches `note_collaboration_states` and
// `note_collaboration_updates` lives here, and nothing else does.
//
// This module owns NO policy and opens NO transaction: it takes the caller's
// `DatabaseTransaction` (or the plain db handle) so the collaboration service
// can compose these statements with the `notes` write that must commit
// atomically with them. Tenant proof is likewise the caller's job — neither
// table carries `workspace_id` (see the schema module comment), so the service
// proves the parent note's workspace in the same transaction before calling in.
//
// The two compare-and-set statements below ARE the concurrency control for the
// whole feature. PostgreSQL, not a distributed lock, is the serialisation
// point: `allocateRevision` is one atomic statement, and every other mutation
// is guarded by `epoch` (generation) plus `last_revision` (position).

import { Injectable } from "@nestjs/common";
import { and, asc, eq, lt, max, ne, sql } from "drizzle-orm";

import {
  noteCollaborationStates,
  noteCollaborationUpdates,
  noteVersions,
} from "../../database/schema";

import type { DatabaseTransaction } from "../../database/database.service";

/**
 * The subset of the Drizzle query builder these statements need. Structural, so
 * both `DatabaseTransaction` and the plain `Database` handle satisfy it — the
 * same trick `NotesService`'s `VersionDatabase` uses for its read paths.
 */
export type CollaborationDb = Pick<DatabaseTransaction, "select" | "insert" | "update" | "delete">;

export interface CollaborationStateRow {
  readonly noteId: string;
  readonly epoch: number;
  readonly lastRevision: number;
  readonly projectedRevision: number;
  readonly projectedNoteVersion: number;
  readonly schemaVersion: number;
  readonly stateBytes: number;
}

export interface CollaborationRecordRow {
  readonly kind: "snapshot" | "update";
  readonly revision: number;
  readonly payload: Uint8Array;
  readonly createdById: string | null;
}

export interface AllocateRevisionInput {
  readonly noteId: string;
  /** Epoch the client believes it is writing against. A mismatch allocates nothing. */
  readonly epoch: number;
  readonly bytes: number;
  readonly maxStateBytes: number;
}

export interface AppendUpdateInput {
  readonly noteId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly kind: "snapshot" | "update";
  readonly payload: Uint8Array;
  readonly createdById: string | null;
}

export interface ResetEpochInput {
  readonly noteId: string;
  /** `null` seeds a brand-new room; otherwise the epoch the reset must replace. */
  readonly expectedEpoch: number | null;
  readonly epoch: number;
  /**
   * Revision the snapshot occupies. Revisions are globally monotonic per note
   * (the unique index spans every epoch), so a new epoch continues the sequence
   * rather than restarting it.
   */
  readonly revision: number;
  readonly projectedNoteVersion: number;
  readonly schemaVersion: number;
  readonly snapshot: Uint8Array;
  readonly createdById: string | null;
}

export interface WriteSnapshotInput {
  readonly noteId: string;
  readonly epoch: number;
  /** The revision the projection just committed; the CAS guard for this write. */
  readonly projectedRevision: number;
  readonly snapshot: Uint8Array;
  readonly createdById: string | null;
}

export interface MarkProjectedInput {
  readonly noteId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly noteVersion: number;
}

const stateSelection = {
  noteId: noteCollaborationStates.noteId,
  epoch: noteCollaborationStates.epoch,
  lastRevision: noteCollaborationStates.lastRevision,
  projectedRevision: noteCollaborationStates.projectedRevision,
  projectedNoteVersion: noteCollaborationStates.projectedNoteVersion,
  schemaVersion: noteCollaborationStates.schemaVersion,
  stateBytes: noteCollaborationStates.stateBytes,
};

@Injectable()
export class NoteCollaborationRepository {
  async loadState(db: CollaborationDb, noteId: string): Promise<CollaborationStateRow | null> {
    const [row] = await db
      .select(stateSelection)
      .from(noteCollaborationStates)
      .where(eq(noteCollaborationStates.noteId, noteId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Claim the next revision for `epoch` in ONE statement. Zero rows is
   * deliberately ambiguous — a stale epoch and the size ceiling both fail the
   * same `WHERE` — and the caller disambiguates with a single follow-up read
   * rather than paying for a second statement on the hot path.
   */
  async allocateRevision(
    db: CollaborationDb,
    input: AllocateRevisionInput,
  ): Promise<{
    readonly epoch: number;
    readonly revision: number;
    readonly stateBytes: number;
  } | null> {
    const [row] = await db
      .update(noteCollaborationStates)
      .set({
        lastRevision: sql`${noteCollaborationStates.lastRevision} + 1`,
        stateBytes: sql`${noteCollaborationStates.stateBytes} + ${input.bytes}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(noteCollaborationStates.noteId, input.noteId),
          eq(noteCollaborationStates.epoch, input.epoch),
          sql`${noteCollaborationStates.stateBytes} + ${input.bytes} <= ${input.maxStateBytes}`,
        ),
      )
      .returning({
        epoch: noteCollaborationStates.epoch,
        revision: noteCollaborationStates.lastRevision,
        stateBytes: noteCollaborationStates.stateBytes,
      });
    return row ?? null;
  }

  async appendUpdate(db: CollaborationDb, input: AppendUpdateInput): Promise<void> {
    await db.insert(noteCollaborationUpdates).values({
      noteId: input.noteId,
      epoch: input.epoch,
      revision: input.revision,
      kind: input.kind,
      payload: input.payload,
      payloadBytes: input.payload.byteLength,
      createdById: input.createdById,
    });
  }

  /** Every record of the CURRENT epoch, in replay order (snapshot first). */
  async loadEpochRecords(
    db: CollaborationDb,
    noteId: string,
    epoch: number,
  ): Promise<CollaborationRecordRow[]> {
    return db
      .select({
        kind: noteCollaborationUpdates.kind,
        revision: noteCollaborationUpdates.revision,
        payload: noteCollaborationUpdates.payload,
        createdById: noteCollaborationUpdates.createdById,
      })
      .from(noteCollaborationUpdates)
      .where(
        and(eq(noteCollaborationUpdates.noteId, noteId), eq(noteCollaborationUpdates.epoch, epoch)),
      )
      .orderBy(asc(noteCollaborationUpdates.revision));
  }

  /**
   * Advance the projection cursor. The `last_revision` guard is what makes the
   * whole pipeline safe: it proves no update landed between the read that
   * produced the projection and this write.
   */
  async markProjected(db: CollaborationDb, input: MarkProjectedInput): Promise<boolean> {
    const rows = await db
      .update(noteCollaborationStates)
      .set({
        projectedRevision: input.revision,
        projectedNoteVersion: input.noteVersion,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(noteCollaborationStates.noteId, input.noteId),
          eq(noteCollaborationStates.epoch, input.epoch),
          eq(noteCollaborationStates.lastRevision, input.revision),
        ),
      )
      .returning({ noteId: noteCollaborationStates.noteId });
    return rows.length === 1;
  }

  /**
   * Fold the epoch's log into one snapshot row. Allocates one further revision
   * under the same `last_revision` CAS, inserts the snapshot at it, then prunes
   * every superseded row. Compaction deliberately does NOT bump the epoch: the
   * state is unchanged, so no connected client has to reload.
   *
   * @returns pruned row count, or `null` when the CAS lost.
   */
  async writeSnapshotAndPrune(
    db: CollaborationDb,
    input: WriteSnapshotInput,
  ): Promise<{ readonly revision: number; readonly prunedRows: number } | null> {
    const [state] = await db
      .update(noteCollaborationStates)
      .set({
        lastRevision: sql`${noteCollaborationStates.lastRevision} + 1`,
        projectedRevision: sql`${noteCollaborationStates.projectedRevision} + 1`,
        stateBytes: input.snapshot.byteLength,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(noteCollaborationStates.noteId, input.noteId),
          eq(noteCollaborationStates.epoch, input.epoch),
          eq(noteCollaborationStates.lastRevision, input.projectedRevision),
        ),
      )
      .returning({ revision: noteCollaborationStates.lastRevision });
    if (state === undefined) return null;
    await this.appendUpdate(db, {
      noteId: input.noteId,
      epoch: input.epoch,
      revision: state.revision,
      kind: "snapshot",
      payload: input.snapshot,
      createdById: input.createdById,
    });
    const pruned = await db
      .delete(noteCollaborationUpdates)
      .where(
        and(
          eq(noteCollaborationUpdates.noteId, input.noteId),
          eq(noteCollaborationUpdates.epoch, input.epoch),
          lt(noteCollaborationUpdates.revision, state.revision),
        ),
      )
      .returning({ id: noteCollaborationUpdates.id });
    return { revision: state.revision, prunedRows: pruned.length };
  }

  /**
   * Start a new generation from an authoritative snapshot: seed a missing room
   * (`expectedEpoch === null`) or replace an existing one. Both forms are a
   * compare-and-set, so two instances racing to rebuild produce exactly ONE new
   * epoch and the loser re-reads.
   *
   * @returns `false` when the CAS lost (someone else already reset).
   */
  async resetEpoch(db: CollaborationDb, input: ResetEpochInput): Promise<boolean> {
    if (input.expectedEpoch === null) {
      const seeded = await db
        .insert(noteCollaborationStates)
        .values({
          noteId: input.noteId,
          epoch: input.epoch,
          lastRevision: input.revision,
          projectedRevision: input.revision,
          projectedNoteVersion: input.projectedNoteVersion,
          schemaVersion: input.schemaVersion,
          stateBytes: input.snapshot.byteLength,
        })
        .onConflictDoNothing({ target: noteCollaborationStates.noteId })
        .returning({ noteId: noteCollaborationStates.noteId });
      if (seeded.length !== 1) return false;
    } else {
      const reset = await db
        .update(noteCollaborationStates)
        .set({
          epoch: input.epoch,
          lastRevision: input.revision,
          projectedRevision: input.revision,
          projectedNoteVersion: input.projectedNoteVersion,
          schemaVersion: input.schemaVersion,
          stateBytes: input.snapshot.byteLength,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(noteCollaborationStates.noteId, input.noteId),
            eq(noteCollaborationStates.epoch, input.expectedEpoch),
          ),
        )
        .returning({ noteId: noteCollaborationStates.noteId });
      if (reset.length !== 1) return false;
    }
    // Every superseded generation goes at once: a stale epoch's rows can never
    // be replayed again, and leaving them would violate the (note_id, revision)
    // unique index the moment the new epoch reaches their revision numbers.
    await db
      .delete(noteCollaborationUpdates)
      .where(
        and(
          eq(noteCollaborationUpdates.noteId, input.noteId),
          ne(noteCollaborationUpdates.epoch, input.epoch),
        ),
      );
    await this.appendUpdate(db, {
      noteId: input.noteId,
      epoch: input.epoch,
      revision: input.revision,
      kind: "snapshot",
      payload: input.snapshot,
      createdById: input.createdById,
    });
    return true;
  }

  /**
   * Wall-clock of the newest durable checkpoint for this note, feeding
   * `decideCollaborativeCheckpoint`. Served by `note_versions_note_created_idx`;
   * no column on the collaboration tables duplicates it.
   */
  async lastCheckpointAt(db: CollaborationDb, noteId: string): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: max(noteVersions.createdAt) })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    return row?.createdAt ?? null;
  }

  /**
   * Whether durable history already holds this note at this exact version.
   *
   * The session-boundary checkpoint needs it because `(note_id, version)` is
   * UNIQUE and `recordAcceptedState` deliberately offers no upsert: a room with
   * two participants schedules one forced boundary per departing socket, and
   * the second must find the first's row rather than abort its transaction on a
   * constraint violation. Served by `note_versions_note_version_unique`.
   */
  async hasCheckpoint(db: CollaborationDb, noteId: string, version: number): Promise<boolean> {
    const rows = await db
      .select({ id: noteVersions.id })
      .from(noteVersions)
      .where(and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)))
      .limit(1);
    return rows.length === 1;
  }
}
