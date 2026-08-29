// Part 58 — WHEN a room's accepted update log gets folded back into
// `notes.content`. A per-note trailing debounce, and nothing else.
//
// WHY NOT A BullMQ JOB. ADR 0004 permits "an idempotent, revision-checked
// follow-up job", and `NoteCollaborationService.project` is exactly that: every
// step is guarded by a compare-and-set, so a duplicate projection from a second
// API instance is not a race, it is a no-op for whichever instance loses.
// Enqueueing a job per keystroke burst would put Redis on the note-write path
// and buy nothing the CAS does not already give — the queue's own delivery
// guarantee is weaker than the guarantee the CAS provides.
//
// WHY IN-PROCESS STATE IS SAFE HERE. The debounce map is a hint about when to
// try, never a source of truth about what to write. Losing it (process restart,
// failover) costs at most a delayed projection: the next update, the next
// handshake, or the next participant leaving re-schedules one, and until then
// `notes.content` simply lags — which is the same window the debounce already
// permits by design.
//
// LAST LEAVE NEEDS NO CROSS-INSTANCE SOCKET COUNT. `leave` and disconnect
// schedule a `forcedBoundary` projection per note room the socket held. When
// that socket was not the last participant the projection is simply a redundant,
// idempotent one; when it was, the room closes with its content projected and a
// durable checkpoint written.

import { Injectable, type BeforeApplicationShutdown } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { TenantError } from "../../tenant/tenant-errors";

import { PROJECTION_DEBOUNCE_MS, PROJECTION_MAX_WAIT_MS } from "./note-collaboration.policy";
import {
  NoteCollaborationService,
  type NoteCollaborationProjectInput,
} from "./note-collaboration.service";

interface PendingProjection {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly firstQueuedAt: number;
  forcedBoundary: boolean;
  timer?: NodeJS.Timeout;
}

@Injectable()
export class NoteCollaborationProjectionService implements BeforeApplicationShutdown {
  private readonly pending = new Map<string, PendingProjection>();

  constructor(
    private readonly collaboration: NoteCollaborationService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Ask for a projection of this note after the quiet period. Repeated calls
   * collapse into one run, and `PROJECTION_MAX_WAIT_MS` bounds how long a
   * continuously edited note can defer — without it, a steady typist would keep
   * `notes.content` stale for the whole session.
   */
  schedule(input: NoteCollaborationProjectInput): void {
    const key = `${input.workspaceId}\0${input.noteId}`;
    const now = Date.now();
    const entry = this.pending.get(key) ?? {
      workspaceId: input.workspaceId,
      noteId: input.noteId,
      firstQueuedAt: now,
      forcedBoundary: false,
    };
    // A forced boundary anywhere in the collapsed window forces the whole run:
    // a checkpoint that was owed must not be lost to a later ordinary update.
    entry.forcedBoundary ||= input.forcedBoundary;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const delay = Math.max(
      0,
      Math.min(PROJECTION_DEBOUNCE_MS, entry.firstQueuedAt + PROJECTION_MAX_WAIT_MS - now),
    );
    entry.timer = setTimeout(() => {
      this.pending.delete(key);
      void this.run(entry);
    }, delay);
    // Never hold the event loop open: a pending projection must not delay a
    // shutdown, and the CAS makes the missed run recoverable.
    entry.timer.unref();
    this.pending.set(key, entry);
  }

  /**
   * ADR 0004: "A pending projection is flushed on graceful shutdown rather than
   * discarded, because a note nobody reopens would otherwise keep a stale
   * projection indefinitely."
   *
   * This used to clear the timers and drop the work, with a comment explaining
   * that flushing could not work because the pool closed first. The premise was
   * inverted. Nest's real order (`@nestjs/core`'s `nest-application-context.js`,
   * `close()`) is:
   *
   *     onModuleDestroy -> beforeApplicationShutdown -> dispose -> onApplicationShutdown
   *
   * so `beforeApplicationShutdown` runs AFTER `onModuleDestroy`, and moving the
   * flush here alone would have fixed nothing. The fix is the pair: this hook
   * flushes, and `DatabaseService` now closes its pool in
   * `onApplicationShutdown` instead. The guarantee is then cross-PHASE, ordered
   * by Nest's own `await` sequence, rather than resting on module-distance
   * ordering between two modules — which Nest does not document as a contract.
   *
   * `dispose()` closes the Socket.IO server AFTER this hook, so `rooms.emit`
   * inside `project()` still reaches live clients during the flush.
   *
   * If someone later reverts the pool hook, `run()` catches and logs
   * `collaboration.projection.failed` — i.e. it degrades to exactly the old
   * behaviour. No new failure mode, and nothing durable is at risk either way:
   * the Yjs log is in PostgreSQL and the projection is re-derivable.
   *
   * ponytail: the flush is unbounded, so a large `pending` map delays
   * `app.close()` and could in principle exceed a SIGTERM grace period. Accepted
   * because `pending` holds one entry per note being actively edited ON THIS
   * INSTANCE and each run is two short transactions. Upgrade path if a
   * deployment starts getting SIGKILLed: race the flush against a deadline
   * derived from the container's stop timeout.
   */
  async beforeApplicationShutdown(): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.pending.clear();
    // `run` already swallows and logs its own failures, so `allSettled` is about
    // one slow note not stranding the others rather than about error handling.
    await Promise.allSettled(entries.map((entry) => this.run(entry)));
  }

  private async run(entry: PendingProjection): Promise<void> {
    try {
      await this.collaboration.project({
        workspaceId: entry.workspaceId,
        noteId: entry.noteId,
        forcedBoundary: entry.forcedBoundary,
      });
    } catch (error: unknown) {
      // ITS OWN EVENT NAME. This used to share
      // `collaboration.projection.rejected` with the service's "the document
      // contract refused this projection" branch, which is a completely
      // different condition: that one means the Yjs state produced JSON the
      // note contract rejects, this one means the projection never ran at all.
      // An operator seeing one name could not tell which, and the thrown reason
      // was discarded entirely.
      //
      // The commonest cause here is entirely benign and must stay quiet at
      // `warn`: the last participant leaves, and by the time the debounce fires
      // the note (or its workspace) has been trashed or hard-deleted, so
      // `assertNote` raises `tenant.workspace_mismatch`. Nothing is lost — the
      // note it would have projected into no longer exists.
      //
      // Identifiers and a bounded code only: a projection failure must never
      // log document content.
      this.logger.warning(
        { noteId: entry.noteId, reason: reasonOf(error) },
        "collaboration.projection.failed",
      );
    }
  }
}

/** Bounded, code-authored diagnostic. Never an error MESSAGE: those quote data. */
function reasonOf(error: unknown): string {
  if (error instanceof TenantError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}
