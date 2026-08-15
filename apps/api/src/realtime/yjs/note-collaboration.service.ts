// Part 58 — the application service behind live collaborative editing. It owns
// the transactions, the invariants and the policy calls; the gateway is a thin
// transport over it and the repository is dumb SQL under it.
//
// THE SPINE. `note_collaboration_states.projected_note_version` records the
// `notes.version` that the persisted Yjs state corresponds to. Two consequences,
// and everything else in this file follows from them:
//
//   - On load, `notes.version !== projected_note_version` means a NON-
//     collaborative writer (`NotesService.update`, restore, import) committed
//     since the last projection. The Yjs state is therefore behind authority, so
//     it is discarded and rebuilt from `notes.content` under a bumped epoch.
//   - On projection, the `notes` write is `WHERE id = $1 AND version = $projected`
//     — a compare-and-set structurally identical to the autosave
//     `expectedVersion` check. Zero rows means a non-collaborative writer won the
//     race, so the projection aborts and the room is rebuilt instead.
//
// That gives EXACTLY ONE durable writer at any instant with no distributed lock
// and no Redis on the note-write path: PostgreSQL row-level CAS is the
// serialisation point, and `NotesService.update` is not modified at all.
//
// THE SERVER HOLDS NO LONG-LIVED `Y.Doc`. A document is materialised in exactly
// two places — the sync handshake and the projection — always single-shot from
// PostgreSQL and always discarded immediately. A live update is NEVER applied to
// a server-side doc: it is validated, persisted, then relayed. Convergence is
// the clients' CRDT property (Yjs updates are commutative and idempotent), so
// two API instances cannot diverge — their only shared state is PostgreSQL
// (serialised by the CAS) and the Socket.io Redis adapter (fan-out only).
//
// REBUILD IS ALWAYS FROM `notes.content`, never from client JSON. `notes.content`
// is the last projection that passed `safeParseNoteDocument`; trusting a client
// document here would let one participant rewrite the room for everyone (ADR
// 0004). If a projection ever yields JSON the contract rejects, the write is
// refused and the update log is left intact — nothing is lost and the next
// projection retries.
//
// TENANT ISOLATION. Neither collaboration table carries `workspace_id` (matching
// `note_versions`), so every entry point runs `assertActiveWorkspace` and then
// proves the parent note belongs to the active workspace IN THE SAME
// TRANSACTION, exactly as `NoteVersionsService.recordAcceptedState` does. A note
// from another workspace is refused with the same error a missing note produces,
// so there is no cross-workspace existence leak.

import { randomUUID } from "node:crypto";

import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  countChecklist,
  extractNoteContentPlain,
  safeParseNoteDocument,
} from "@notted/shared-validators";
import { and, eq, sql } from "drizzle-orm";
import * as Y from "yjs";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { REALTIME_CONFIG, type RealtimeConfig } from "../../config/realtime.config";
import { DatabaseService, type DatabaseTransaction } from "../../database/database.service";
import { notes } from "../../database/schema";
import { decideCollaborativeCheckpoint } from "../../notes/note-version-checkpoint.policy";
import { NoteVersionsService } from "../../notes/note-versions.service";
import { NOTE_DOMAIN_EVENTS } from "../../notes/notes.constants";
import { MentionNotificationProducer } from "../../notifications/mention-notification.producer";
import { NoteEmbeddingProducer } from "../../search/note-embedding-producer";
import { NoteSearchIndexProducer } from "../../search/note-search-index-producer";
import { assertActiveWorkspace, createTenantContext, TenantContextService } from "../../tenant";
import { tenantWorkspaceMismatch } from "../../tenant/tenant-errors";
import { RealtimeRoomService } from "../realtime-room.service";
import { NOTE_COLLABORATION_SCHEMA_VERSION, REALTIME_EVENTS } from "../realtime.contracts";

import { shouldCompact } from "./note-collaboration.policy";
import {
  NoteCollaborationRepository,
  type CollaborationDb,
  type CollaborationRecordRow,
  type CollaborationStateRow,
} from "./note-collaboration.repository";
import { noteDocumentToYDoc, yDocToNoteDocument } from "./note-yjs-document";

export interface NoteCollaborationSelector {
  readonly workspaceId: string;
  readonly noteId: string;
}

export interface NoteCollaborationSyncInput extends NoteCollaborationSelector {
  /** The client's Yjs state vector. An undecodable one falls back to full state. */
  readonly stateVector: Uint8Array;
}

export interface NoteCollaborationSyncResult {
  readonly ok: true;
  readonly epoch: number;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
}

export interface NoteCollaborationApplyInput extends NoteCollaborationSelector {
  readonly epoch: number;
  readonly update: Uint8Array;
  readonly actorId: string;
}

export type NoteCollaborationApplyResult =
  | { readonly ok: true; readonly epoch: number; readonly revision: number }
  | { readonly ok: false; readonly error: "invalid" | "limited" | "stale" | "unavailable" };

export interface NoteCollaborationProjectInput extends NoteCollaborationSelector {
  /**
   * True at a boundary that must checkpoint regardless of cadence: the last
   * participant leaving a room, or a version restore.
   */
  readonly forcedBoundary: boolean;
}

export interface NoteCollaborationResetInput extends NoteCollaborationSelector {
  /** The restored TipTap document that is now authoritative. */
  readonly document: unknown;
  /** The `notes.version` the restore wrote. */
  readonly noteVersion: number;
  readonly actorId: string;
}

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly content: unknown;
  readonly contentPlain: string | null;
  readonly version: number;
  readonly updatedById: string | null;
  readonly createdById: string;
}

type RoomRebuildReason = "missing" | "version_mismatch" | "decode_failed";

/** Rebuilds tolerated per load before the room is declared unusable. */
const MAX_ROOM_REBUILDS = 2;

interface LoadedRoom {
  readonly note: NoteRow;
  readonly state: CollaborationStateRow;
  readonly records: readonly CollaborationRecordRow[];
  readonly doc: Y.Doc;
  /** Epoch to announce once the caller's transaction commits, if it rebuilt. */
  readonly resetEpoch: number | null;
}

type ProjectionOutcome =
  | { readonly kind: "reset"; readonly epoch: number | null }
  | { readonly kind: "committed"; readonly noteVersion: number; readonly revision: number };

/** Raised to roll a projection transaction back when its revision CAS loses. */
class ProjectionSupersededError extends Error {
  constructor() {
    super("projection superseded");
    this.name = "ProjectionSupersededError";
  }
}

const noteSelection = {
  id: notes.id,
  title: notes.title,
  content: notes.content,
  // Carried so the session-boundary checkpoint can snapshot the CURRENT
  // accepted state without recomputing a plain-text projection that
  // `notes.content_plain` already holds.
  contentPlain: notes.contentPlain,
  version: notes.version,
  updatedById: notes.updatedById,
  createdById: notes.createdById,
};

@Injectable()
export class NoteCollaborationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: NoteCollaborationRepository,
    private readonly tenantContext: TenantContextService,
    private readonly noteVersions: NoteVersionsService,
    private readonly searchIndexProducer: NoteSearchIndexProducer,
    private readonly rooms: RealtimeRoomService,
    private readonly logger: StructuredLogger,
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    @Optional() private readonly embeddingProducer?: NoteEmbeddingProducer,
    // Part 60. Optional for the same reason as `embeddingProducer`: the unit
    // tests construct this service by hand, without the notification module.
    @Optional() private readonly mentionProducer?: MentionNotificationProducer,
  ) {}

  /**
   * The handshake. Materialises the room from PostgreSQL once, answers the
   * client's state vector with the diff it is missing, and returns the server's
   * own state vector so the client can reply with what the server is missing.
   */
  async sync(input: NoteCollaborationSyncInput): Promise<NoteCollaborationSyncResult> {
    return this.inTenant(input, async () => {
      const room = await this.database.transaction((tx) => this.loadOrRebuild(tx, input));
      if (room.resetEpoch !== null) this.announceReset(input, room.resetEpoch);
      this.logger.info(
        {
          noteId: input.noteId,
          workspaceId: input.workspaceId,
          epoch: room.state.epoch,
          revision: room.state.lastRevision,
          stateBytes: room.state.stateBytes,
        },
        "collaboration.session.opened",
      );
      return Object.freeze({
        ok: true as const,
        epoch: room.state.epoch,
        revision: room.state.lastRevision,
        schemaVersion: NOTE_COLLABORATION_SCHEMA_VERSION,
        update: this.diffFor(room.doc, input.stateVector),
        stateVector: Y.encodeStateVector(room.doc),
      });
    });
  }

  /**
   * Validate, allocate a revision and persist ONE client update. Never throws:
   * the transport turns the typed failure straight into an ack, and a client
   * that is not acknowledged keeps the update in its own `Y.Doc` so the next
   * successful sync carries it.
   */
  async applyUpdate(input: NoteCollaborationApplyInput): Promise<NoteCollaborationApplyResult> {
    if (input.update.byteLength === 0 || !this.decodable(input.update)) {
      this.logger.info(
        { noteId: input.noteId, reason: "invalid" },
        "collaboration.update.rejected",
      );
      return { ok: false, error: "invalid" };
    }
    try {
      return await this.inTenant(input, () =>
        this.database.transaction<NoteCollaborationApplyResult>(async (tx) => {
          await this.assertNote(tx, input);
          const allocated = await this.repository.allocateRevision(tx, {
            noteId: input.noteId,
            epoch: input.epoch,
            bytes: input.update.byteLength,
            maxStateBytes: this.config.maxCollaborationStateBytes,
          });
          if (allocated === null) {
            // ONE follow-up read disambiguates the two ways the single atomic
            // allocation statement can match zero rows.
            const state = await this.repository.loadState(tx, input.noteId);
            const error = state === null || state.epoch !== input.epoch ? "stale" : "limited";
            this.logger.info(
              { noteId: input.noteId, reason: error },
              "collaboration.update.rejected",
            );
            return { ok: false, error };
          }
          await this.repository.appendUpdate(tx, {
            noteId: input.noteId,
            epoch: allocated.epoch,
            revision: allocated.revision,
            kind: "update",
            payload: input.update,
            createdById: input.actorId,
          });
          return { ok: true, epoch: allocated.epoch, revision: allocated.revision };
        }),
      );
    } catch {
      this.logger.info(
        { noteId: input.noteId, reason: "unavailable" },
        "collaboration.update.rejected",
      );
      return { ok: false, error: "unavailable" };
    }
  }

  /**
   * Fold the accepted update log back into `notes.content` so every
   * non-collaborative reader (search, export, print, REST) sees current text,
   * then compact and checkpoint if the policies say so.
   *
   * Idempotent and revision-checked, so a duplicate projection from another
   * instance is harmless: the loser's CAS matches zero rows and it abandons.
   */
  async project(input: NoteCollaborationProjectInput): Promise<void> {
    const requestId = randomUUID();
    await this.inTenant(input, async () => {
      const outcome = await this.projectPending(input, requestId);
      /*
       * A FORCED BOUNDARY OWES A CHECKPOINT WHATEVER THE PROJECTION ABOVE DID.
       * A projection that COMMITTED already wrote one inside its own
       * transaction — `decideCollaborativeCheckpoint` always says yes at a
       * forced boundary — so the note and its history commit together and no
       * reader can observe one without the other. Every other outcome leaves
       * the debt unpaid and is settled here:
       *
       *   - nothing to project, because the debounce already ran 2 s after the
       *     last keystroke — the NORMAL close, and the case Part 55's "forced
       *     checkpoint at orderly final-room shutdown" was losing entirely;
       *   - the projection lost the `notes.version` compare-and-set to another
       *     API instance's debounce, rebuilt the epoch and returned superseded;
       *   - the document contract refused the projection, so `notes.content`
       *     still holds the last state that passed it — which is exactly the
       *     state worth checkpointing.
       *
       * The state is re-read rather than reused: after a lost CAS the
       * authoritative content is the one the OTHER instance just wrote, and
       * that is what Part 55 wants recorded.
       */
      if (!input.forcedBoundary || outcome === "committed") return;
      const settled = await this.database.transaction((tx) => this.loadOrRebuild(tx, input));
      if (settled.resetEpoch !== null) this.announceReset(input, settled.resetEpoch);
      await this.settleBoundary(input, settled);
    });
  }

  /**
   * The debounced half of {@link project}: fold the log, compact, checkpoint.
   * `"committed"` means a `notes` row was written in this run — and therefore,
   * at a forced boundary, that its checkpoint was written with it.
   */
  private async projectPending(
    input: NoteCollaborationProjectInput,
    requestId: string,
  ): Promise<"committed" | "skipped"> {
    const room = await this.database.transaction((tx) => this.loadOrRebuild(tx, input));
    if (room.resetEpoch !== null) this.announceReset(input, room.resetEpoch);
    if (room.state.projectedRevision >= room.state.lastRevision) {
      return "skipped";
    }

    const parsed = safeParseNoteDocument(yDocToNoteDocument(room.doc));
    if (!parsed.success) {
      // Refuse the write and leave the log intact: nothing is lost, and the
      // last good `notes.content` stays authoritative for every reader.
      this.logger.warning({ noteId: input.noteId }, "collaboration.projection.rejected");
      return "skipped";
    }
    const document = parsed.doc;
    const contentPlain = extractNoteContentPlain(document);
    const checklist = countChecklist(document);
    const author = this.projectionAuthor(room, room.note);

    let outcome: ProjectionOutcome;
    try {
      outcome = await this.database.transaction<ProjectionOutcome>(async (tx) => {
        const [updated] = await tx
          .update(notes)
          .set({
            content: document,
            contentPlain,
            checklistDone: checklist.done,
            checklistTotal: checklist.total,
            updatedById: author,
            updatedAt: new Date(),
            version: sql`${notes.version} + 1`,
          })
          .where(
            and(
              eq(notes.id, input.noteId),
              eq(notes.workspaceId, input.workspaceId),
              eq(notes.version, room.state.projectedNoteVersion),
            ),
          )
          .returning({ version: notes.version, title: notes.title });
        // A non-collaborative writer committed since this projection was read.
        // Authority is `notes.content`, so bump the epoch and make every live
        // collaborator reload onto it.
        if (updated === undefined) {
          return { kind: "reset", epoch: await this.rebuild(tx, input, "version_mismatch") };
        }
        return {
          kind: "committed",
          noteVersion: updated.version,
          revision: await this.commitProjection(tx, input, room, {
            document,
            contentPlain,
            title: updated.title,
            noteVersion: updated.version,
            author,
            requestId,
          }),
        };
      });
    } catch (error: unknown) {
      if (!(error instanceof ProjectionSupersededError)) throw error;
      this.logger.info(
        { noteId: input.noteId, reason: "revision_cas" },
        "collaboration.projection.superseded",
      );
      return "skipped";
    }

    // After commit only (ADR 0006).
    if (outcome.kind === "reset") {
      this.logger.info(
        { noteId: input.noteId, reason: "note_version_cas" },
        "collaboration.projection.superseded",
      );
      if (outcome.epoch !== null) this.announceReset(input, outcome.epoch);
      return "skipped";
    }
    this.rooms.emit(
      { kind: "note", workspaceId: input.workspaceId, noteId: input.noteId },
      REALTIME_EVENTS.noteProjected,
      {
        // `noteId` is part of every server -> room frame: one shared socket
        // dispatches by event name, not by room, so a client in two note
        // rooms needs the identity to route the frame.
        noteId: input.noteId,
        version: outcome.noteVersion,
        revision: outcome.revision,
        epoch: room.state.epoch,
      },
    );
    return "committed";
  }

  /**
   * Part 56 obligation: reconcile a restored PostgreSQL TipTap projection with
   * the persisted Yjs authority WITHOUT adding a second write authority. Runs
   * inside `NotesService.restoreVersion`'s serializable transaction, so the
   * restored note and the new Yjs generation commit together or not at all.
   *
   * A no-op when the note has never been edited collaboratively. Otherwise the
   * epoch changes, live collaborators discard their `Y.Doc` and remount on the
   * restored state; unsent local edits are deliberately discarded, which is what
   * "restore this version" means.
   */
  async resetToDocument(
    tx: DatabaseTransaction,
    input: NoteCollaborationResetInput,
  ): Promise<void> {
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "note_collaboration");
    const state = await this.repository.loadState(tx, input.noteId);
    if (state === null) return;
    await this.assertNote(tx, input);
    const epoch = state.epoch + 1;
    const written = await this.repository.resetEpoch(tx, {
      noteId: input.noteId,
      expectedEpoch: state.epoch,
      epoch,
      revision: state.lastRevision + 1,
      projectedNoteVersion: input.noteVersion,
      schemaVersion: NOTE_COLLABORATION_SCHEMA_VERSION,
      snapshot: Y.encodeStateAsUpdate(noteDocumentToYDoc(input.document)),
      createdById: input.actorId,
    });
    if (!written) return;
    this.logger.info(
      { noteId: input.noteId, epoch, reason: "version_mismatch" },
      "collaboration.state.rebuilt",
    );
    // ponytail: the reset is announced at end-of-work rather than strictly
    // post-commit, because this runs inside the caller's transaction and the
    // service has no commit hook to attach to. Safe in both directions — a
    // spurious reset costs one re-sync and cannot lose data, and a LOST reset is
    // recovered on the next load by the `projected_note_version` mismatch. Add a
    // post-commit dispatcher to `DatabaseService.transaction` if a third caller
    // ever needs one.
    this.announceReset(input, epoch);
  }

  // ------------------------------------------------------------------------ //
  // Internals
  // ------------------------------------------------------------------------ //

  /**
   * Establish server-side tenant scope for a socket-driven or timer-driven call.
   * Neither has a request context, and `workspaceId` here is the one the gateway
   * already authorised, never a client value that reaches SQL unchecked.
   */
  private inTenant<T>(selector: NoteCollaborationSelector, work: () => Promise<T>): Promise<T> {
    return this.tenantContext.run(
      createTenantContext({ workspaceId: selector.workspaceId, userId: null }),
      work,
    );
  }

  private async assertNote(
    db: CollaborationDb,
    selector: NoteCollaborationSelector,
  ): Promise<NoteRow> {
    assertActiveWorkspace(selector.workspaceId, this.tenantContext, "note_collaboration");
    const [row] = await db
      .select(noteSelection)
      .from(notes)
      .where(
        and(
          eq(notes.id, selector.noteId),
          eq(notes.workspaceId, selector.workspaceId),
          eq(notes.isDeleted, false),
        ),
      )
      .limit(1);
    // Same error for "wrong workspace" and "does not exist": no existence leak.
    if (row === undefined) throw tenantWorkspaceMismatch("note_collaboration.note_id");
    return row;
  }

  /**
   * Recovery, one path, three cases:
   *   state is null                                  -> seed    (epoch 1)
   *   notes.version !== state.projected_note_version -> rebuild (epoch + 1)
   *   applying the epoch's records throws            -> rebuild (epoch + 1)
   * Every rebuild reads `notes.content`, and every rebuild is a compare-and-set,
   * so two instances racing produce exactly ONE new epoch and the loser re-reads.
   */
  private async loadOrRebuild(
    tx: DatabaseTransaction,
    selector: NoteCollaborationSelector,
  ): Promise<LoadedRoom> {
    let resetEpoch: number | null = null;

    // Every rebuild is followed by a read. The earlier shape ran a fixed two
    // passes each ending in a rebuild, so a rebuild performed on the last pass
    // was discarded un-read and the handshake failed even though that rebuild
    // had already repaired the room — reachable as `version_mismatch` (whose CAS
    // lost to another instance) followed by `decode_failed`.
    for (let rebuilds = 0; ; rebuilds += 1) {
      const outcome = await this.readRoom(tx, selector, resetEpoch);
      if (typeof outcome !== "string") return outcome;
      if (rebuilds >= MAX_ROOM_REBUILDS) {
        throw new Error(`Note collaboration state could not be loaded: ${outcome}`);
      }
      resetEpoch = (await this.rebuild(tx, selector, outcome)) ?? resetEpoch;
    }
  }

  /** One read pass. A string result names why the room has to be rebuilt. */
  private async readRoom(
    tx: DatabaseTransaction,
    selector: NoteCollaborationSelector,
    resetEpoch: number | null,
  ): Promise<LoadedRoom | RoomRebuildReason> {
    const note = await this.assertNote(tx, selector);
    const state = await this.repository.loadState(tx, selector.noteId);
    if (state === null) return "missing";
    if (state.projectedNoteVersion !== note.version) return "version_mismatch";

    const records = await this.repository.loadEpochRecords(tx, selector.noteId, state.epoch);
    const doc = this.materialise(records);

    return doc === null ? "decode_failed" : { note, state, records, doc, resetEpoch };
  }

  /** Replay one epoch into a throwaway doc. `null` means the log is undecodable. */
  private materialise(records: readonly CollaborationRecordRow[]): Y.Doc | null {
    const doc = new Y.Doc();
    try {
      Y.transact(doc, () => {
        for (const record of records) Y.applyUpdate(doc, record.payload);
      });
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Discard the persisted Yjs state and start a new generation from
   * `notes.content` — the last projection that passed the document contract.
   * NEVER from client JSON (ADR 0004).
   *
   * @returns the new epoch, or `null` when another writer rebuilt first.
   */
  private async rebuild(
    tx: DatabaseTransaction,
    selector: NoteCollaborationSelector,
    reason: RoomRebuildReason,
  ): Promise<number | null> {
    const note = await this.assertNote(tx, selector);
    const state = await this.repository.loadState(tx, selector.noteId);
    const epoch = (state?.epoch ?? 0) + 1;
    const written = await this.repository.resetEpoch(tx, {
      noteId: selector.noteId,
      expectedEpoch: state?.epoch ?? null,
      epoch,
      revision: (state?.lastRevision ?? 0) + 1,
      projectedNoteVersion: note.version,
      schemaVersion: NOTE_COLLABORATION_SCHEMA_VERSION,
      snapshot: Y.encodeStateAsUpdate(noteDocumentToYDoc(note.content)),
      createdById: note.updatedById,
    });
    if (!written) return null;
    this.logger.info({ noteId: selector.noteId, epoch, reason }, "collaboration.state.rebuilt");
    return epoch;
  }

  private announceReset(selector: NoteCollaborationSelector, epoch: number): void {
    this.rooms.emit(
      { kind: "note", workspaceId: selector.workspaceId, noteId: selector.noteId },
      REALTIME_EVENTS.noteReset,
      { noteId: selector.noteId, epoch },
    );
  }

  /**
   * Pay the checkpoint a forced boundary owes, against whatever is authoritative
   * by the time it runs.
   *
   * The last participant leaving is the one moment Part 55 guarantees durable
   * history for a collaborative session, and by then `notes.content` is normally
   * already current — projected 2 s after the final keystroke, long before the
   * tab closed, possibly by a different API instance. So this writes no `notes`
   * row and allocates no revision: it folds the epoch's log if the compaction
   * policy says so, and asks `decideCollaborativeCheckpoint` about the state
   * that is already authoritative. Nothing here is a second write authority; the
   * note itself is untouched.
   *
   * IDEMPOTENT BY THE SAME UNIQUE INDEX THAT MAKES IT NECESSARY. A room with
   * three participants schedules three forced boundaries, so the checkpoint is
   * suppressed once `note_versions` already holds this note at this version
   * rather than aborting the transaction on `note_versions_note_version_unique`.
   */
  private async settleBoundary(
    input: NoteCollaborationProjectInput,
    room: LoadedRoom,
  ): Promise<void> {
    const pending = room.records.filter((record) => record.kind === "update");
    await this.database.transaction(async (tx) => {
      // Re-read inside the boundary transaction: a non-collaborative writer may
      // have committed since `loadOrRebuild`, and checkpointing the version we
      // read then would record a state that is no longer the accepted one. The
      // next load rebuilds from `notes.content` either way, so abandoning is
      // free.
      const note = await this.assertNote(tx, input);
      if (note.version !== room.state.projectedNoteVersion) return;
      const author = this.projectionAuthor(room, note);

      if (
        shouldCompact({
          pendingUpdates: pending.length,
          pendingBytes: pending.reduce((total, record) => total + record.payload.byteLength, 0),
          forcedBoundary: true,
        })
      ) {
        const snapshot = Y.encodeStateAsUpdate(room.doc);
        const compacted = await this.repository.writeSnapshotAndPrune(tx, {
          noteId: input.noteId,
          epoch: room.state.epoch,
          projectedRevision: room.state.lastRevision,
          snapshot,
          createdById: author,
        });
        if (compacted !== null) {
          this.logger.info(
            {
              noteId: input.noteId,
              prunedRows: compacted.prunedRows,
              snapshotBytes: snapshot.byteLength,
            },
            "collaboration.compaction",
          );
        }
      }

      // The policy stays the single owner of the cadence even though a forced
      // boundary always answers `true`: inlining the answer here is exactly how
      // the two checkpoint sources drift apart.
      const decision = decideCollaborativeCheckpoint({
        now: new Date(),
        lastDurableCheckpointAt: await this.repository.lastCheckpointAt(tx, input.noteId),
        forcedBoundary: true,
      });
      if (!decision.checkpoint) return;
      if (await this.repository.hasCheckpoint(tx, input.noteId, note.version)) return;
      await this.noteVersions.recordAcceptedState(tx, {
        noteId: input.noteId,
        workspaceId: input.workspaceId,
        version: note.version,
        title: note.title,
        content: note.content,
        // Nullable on `notes`; a snapshot of an empty projection is faithful,
        // and recomputing it here would re-derive text nobody changed.
        contentPlain: note.contentPlain ?? "",
        createdById: author,
      });
      this.logger.info(
        { noteId: input.noteId, noteVersion: note.version, checkpointReason: decision.reason },
        "collaboration.checkpoint.boundary",
      );
    });
  }

  /**
   * Who a projection or boundary checkpoint is attributed to: the last
   * collaborator whose update it folds, falling back to the note's own
   * last-writer. A merged CRDT state has no single author, so this is the same
   * last-writer attribution the search, embedding and mention intents use.
   */
  private projectionAuthor(room: LoadedRoom, note: NoteRow): string {
    return room.records.at(-1)?.createdById ?? note.updatedById ?? note.createdById;
  }

  /**
   * Steps 3-6 of the projection pipeline, inside the projection transaction.
   *
   * @returns the revision `notes.content` now reflects.
   */
  private async commitProjection(
    tx: DatabaseTransaction,
    input: NoteCollaborationProjectInput,
    room: LoadedRoom,
    written: {
      readonly document: unknown;
      readonly contentPlain: string;
      readonly title: string;
      readonly noteVersion: number;
      readonly author: string;
      readonly requestId: string;
    },
  ): Promise<number> {
    const advanced = await this.repository.markProjected(tx, {
      noteId: input.noteId,
      epoch: room.state.epoch,
      revision: room.state.lastRevision,
      noteVersion: written.noteVersion,
    });
    // A newer update landed while this projection was being computed. Roll the
    // WHOLE transaction back rather than leave `notes` ahead of
    // `projected_note_version` — that mismatch would rebuild from the JSON just
    // written and silently drop the update that raced. The next debounce covers
    // it, because nothing was consumed.
    if (!advanced) throw new ProjectionSupersededError();

    const pending = room.records.filter((record) => record.kind === "update");
    let compacted: { readonly revision: number; readonly prunedRows: number } | null = null;
    if (
      shouldCompact({
        pendingUpdates: pending.length,
        pendingBytes: pending.reduce((total, record) => total + record.payload.byteLength, 0),
        forcedBoundary: input.forcedBoundary,
      })
    ) {
      // Only encode the full state when the log is actually being folded — the
      // projection itself never needs it.
      const snapshot = Y.encodeStateAsUpdate(room.doc);
      compacted = await this.repository.writeSnapshotAndPrune(tx, {
        noteId: input.noteId,
        epoch: room.state.epoch,
        projectedRevision: room.state.lastRevision,
        snapshot,
        createdById: written.author,
      });
      if (compacted !== null) {
        this.logger.info(
          {
            noteId: input.noteId,
            prunedRows: compacted.prunedRows,
            snapshotBytes: snapshot.byteLength,
          },
          "collaboration.compaction",
        );
      }
    }

    const decision = decideCollaborativeCheckpoint({
      now: new Date(),
      lastDurableCheckpointAt: await this.repository.lastCheckpointAt(tx, input.noteId),
      forcedBoundary: compacted !== null || input.forcedBoundary,
    });
    if (decision.checkpoint) {
      await this.noteVersions.recordAcceptedState(tx, {
        noteId: input.noteId,
        workspaceId: input.workspaceId,
        version: written.noteVersion,
        title: written.title,
        content: written.document,
        contentPlain: written.contentPlain,
        createdById: written.author,
      });
    }

    // Same transaction as the projection, exactly as `restoreVersion` does: the
    // intents commit with the content they describe or not at all (ADR 0006).
    const options = {
      mutation: NOTE_DOMAIN_EVENTS.update,
      correlationId: written.requestId,
      actorId: written.author,
    };
    const ids = [input.noteId];
    await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, ids, options);
    await this.embeddingProducer?.scheduleGeneration(tx, input.workspaceId, ids, options);
    // Part 60. Without this, a mention typed in a LIVE COLLABORATIVE session
    // would never notify anyone: the projection writes `notes.content` directly
    // and never passes through `NotesService.update`, which is where the other
    // mention seam lives. `room.note.content` is the pre-projection document —
    // the projection UPDATE is a CAS on `room.state.projectedNoteVersion`, so
    // whenever it succeeds nothing changed `notes` in between and that read is
    // exactly the previous state. The actor is `written.author`, the same
    // last-writer attribution the search, embedding, and version-checkpoint
    // intents above already use, so a merged CRDT projection attributes the
    // mention consistently with everything else on this path.
    await this.mentionProducer?.scheduleMentionNotifications(tx, input.workspaceId, {
      noteId: input.noteId,
      previousContent: room.note.content,
      nextContent: written.document,
      actorId: written.author,
      correlationId: written.requestId,
    });

    const revision = compacted?.revision ?? room.state.lastRevision;
    this.logger.info(
      {
        noteId: input.noteId,
        revision,
        noteVersion: written.noteVersion,
        checkpointReason: decision.reason,
        compacted: compacted !== null,
      },
      "collaboration.projection.committed",
    );
    return revision;
  }

  /**
   * Trust boundary: refuse bytes that are not a decodable Yjs update BEFORE they
   * reach the log. Persisting garbage would poison every future replay and force
   * a rebuild that discards the room's real edits.
   */
  private decodable(update: Uint8Array): boolean {
    try {
      Y.decodeUpdate(update);
      return true;
    } catch {
      return false;
    }
  }

  /** The diff the client is missing. An undecodable state vector gets the lot. */
  private diffFor(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
    try {
      return Y.encodeStateAsUpdate(doc, stateVector);
    } catch {
      return Y.encodeStateAsUpdate(doc);
    }
  }
}
