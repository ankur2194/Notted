import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { Socket } from "socket.io-client";

import { presenceColorForUser } from "@/lib/collaboration/user-color";

/**
 * The Yjs client protocol for one note (Part 58).
 *
 * Plain class, no React: every decision here — handshake order, epoch
 * invalidation, outbound batching, awareness throttling, inbound validation —
 * is provable without a DOM, and `useNoteCollaboration` is only the adapter that
 * turns it into state. The socket is injected rather than imported so a test can
 * hand it a fake and so a caller decides how many notes share one connection.
 *
 * The contract with the server is fixed: JOIN, then SYNC, then a stream of
 * updates carrying the epoch the sync established. The epoch is the server's
 * "everything you know is wrong" signal — when it moves, this provider throws
 * its `Y.Doc` away rather than trying to reconcile, because a document rebased
 * onto a different history is worse than a document reloaded.
 */

const EVENT = {
  ready: "realtime:ready",
  join: "realtime:room:join",
  leave: "realtime:room:leave",
  noteSync: "realtime:note:sync",
  noteUpdate: "realtime:note:update",
  noteAwareness: "realtime:note:awareness",
  noteRemote: "realtime:note:remote",
  noteReset: "realtime:note:reset",
  noteProjected: "realtime:note:projected",
} as const;

/** The transaction origin marking everything that arrived from the server. */
const REMOTE_ORIGIN = "remote";

const SCHEMA_VERSION = 1;
const DEFAULT_SYNC_TIMEOUT_MS = 1500;
/**
 * How long to wait for the server's `realtime:ready`, which is emitted only
 * once `handleConnection` has revalidated the session, taken its socket lease
 * and REGISTERED THE NOTE HANDLERS. The client's own `connect` event fires as
 * soon as the namespace is accepted, which is strictly earlier: a join emitted
 * on `connect` can reach a socket that has no `realtime:room:join` listener yet
 * and is dropped without an ack. Its own budget, not a slice of the handshake's.
 */
const DEFAULT_READY_TIMEOUT_MS = 2000;
/** One burst of typing becomes one insert. */
const UPDATE_FLUSH_MS = 200;
/**
 * Consecutive failed update acks before realtime is declared dead for this
 * session. A dropped delta leaves a causal gap the server can never close, so
 * the merged update is re-queued and re-sent rather than discarded.
 */
const MAX_FLUSH_ATTEMPTS = 5;
const MAX_FLUSH_BACKOFF_MS = 5000;
/**
 * A handshake that failed while the transport is still up is retried, because
 * the commonest cause is a race it cannot see: `socket.connected` turns true
 * when the namespace is accepted, which is BEFORE `handleConnection` registers
 * the note handlers, so a join emitted in that window is dropped without an ack.
 * Without this the in-flight dedupe in `runHandshake` would absorb the
 * `realtime:ready` retry into the doomed attempt and the session would latch
 * solo for good.
 */
const MAX_HANDSHAKE_ATTEMPTS = 5;
const HANDSHAKE_RETRY_MS = 300;
/**
 * How long a session that exhausted its retries waits before trying again. Only
 * `denied` is permanent; a rate limit or an unreachable server is a condition
 * that clears on its own, and the Part 39 autosave holds the pen meanwhile.
 */
const STOPPED_COOLDOWN_MS = 30_000;
/** Server ceiling is 900 awareness frames a minute; 10/s stays well inside it. */
const AWARENESS_THROTTLE_MS = 100;

/**
 * Ceiling on the frames held while the first sync ack is in flight. The window
 * is the join-to-ack gap — well under two seconds — so this is only ever reached
 * by a room editing furiously through a slow handshake. Overflowing is not a
 * data-loss path: the buffer is dropped and the handshake is re-run, and the
 * state-vector exchange delivers exactly the frames that were discarded.
 */
const MAX_WINDOW_FRAME_BYTES = 1_048_576;
/** Mirrors the server's REALTIME_MAX_AWARENESS_BYTES. */
const MAX_AWARENESS_BYTES = 8192;

export type NoteCollaborationStatus =
  "connecting" | "synced" | "reconnecting" | "offline" | "error";

export interface NoteCollaborationUser {
  readonly name: string;
  readonly color: string;
}

export interface NoteCollaborationBinding {
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly user: NoteCollaborationUser;
}

export interface NoteCollaborationPeer {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
}

export interface NoteCollaborationSnapshot {
  readonly status: NoteCollaborationStatus;
  readonly epoch: number;
  /**
   * Bumped every time the provider adopts a fresh `Y.Doc`. The editor keys its
   * remount on this rather than on `epoch`, because the two reset paths do not
   * agree about epochs: a server reset raises the epoch first, but a `stale`
   * update ack replaces the document while the epoch it knows is still the old
   * one. Keying on the epoch left the editor mounted over a destroyed document
   * for the length of the re-handshake, and every keystroke typed into it went
   * nowhere.
   */
  readonly generation: number;
  readonly errorReason: "limited" | "denied" | "unavailable" | null;
}

export interface NoteCollaborationProviderOptions {
  readonly socket: Socket;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly syncTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}

export interface NoteProjectedPayload {
  readonly version: number;
  readonly revision: number;
  readonly epoch: number;
}

interface NoteRoomSelector {
  readonly kind: "note";
  readonly workspaceId: string;
  readonly noteId: string;
}

type AckError = "denied" | "invalid" | "limited" | "stale" | "unavailable";

const ACK_ERRORS: readonly string[] = ["denied", "invalid", "limited", "stale", "unavailable"];

type AckOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AckError };

interface SyncAck {
  readonly epoch: number;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
}

interface UpdateAck {
  readonly epoch: number;
  readonly revision: number;
}

/* ------------------------------------------------------------------------- *
 * Trust boundary
 *
 * Everything below arrives over a socket and is `unknown` until proven
 * otherwise. A frame that does not parse is dropped, never applied: feeding a
 * malformed buffer to `Y.applyUpdate` corrupts the document for everyone in the
 * room, and the writer's own text is the thing being protected.
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Socket.IO frames binary natively, but some browser builds hand the payload
 * back as an `ArrayBuffer` rather than a `Uint8Array`. Normalise that one case;
 * reject everything else, including strings that merely look like base64.
 */
function asBinary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return null;
}

function parseAck<T>(
  raw: unknown,
  parseValue: (record: Record<string, unknown>) => T | null,
): AckOutcome<T> {
  const record = asRecord(raw);

  if (record === null) {
    return { ok: false, error: "invalid" };
  }

  if (record.ok !== true) {
    const error = record.error;

    return {
      ok: false,
      error:
        typeof error === "string" && ACK_ERRORS.includes(error) ? (error as AckError) : "invalid",
    };
  }

  const value = parseValue(record);

  return value === null ? { ok: false, error: "invalid" } : { ok: true, value };
}

function parseSyncAck(record: Record<string, unknown>): SyncAck | null {
  const epoch = asInteger(record.epoch);
  const revision = asInteger(record.revision);
  const schemaVersion = asInteger(record.schemaVersion);
  const update = asBinary(record.update);
  const stateVector = asBinary(record.stateVector);

  if (
    epoch === null ||
    revision === null ||
    schemaVersion === null ||
    update === null ||
    stateVector === null
  ) {
    return null;
  }

  return { epoch, revision, schemaVersion, update, stateVector };
}

function parseUpdateAck(record: Record<string, unknown>): UpdateAck | null {
  const epoch = asInteger(record.epoch);
  const revision = asInteger(record.revision);

  return epoch === null || revision === null ? null : { epoch, revision };
}

/**
 * One Socket.io connection is shared by the whole app, and Socket.io dispatches
 * by EVENT NAME, not by room: a socket that holds two note rooms receives both
 * notes' frames on this provider's handlers. Every server -> room frame carries
 * `noteId` so each provider can drop the ones that are not its own. Filtering on
 * `epoch` alone would not do it — epochs are per-note and collide freely, so a
 * frame for another note would be applied to this document.
 */
function isForNote(record: Record<string, unknown>, noteId: string): boolean {
  return record.noteId === noteId;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) {
      return false;
    }
  }

  return true;
}

export class NoteCollaborationProvider {
  private readonly socket: Socket;
  private readonly selector: NoteRoomSelector;
  /**
   * Mutable ON PURPOSE (Part 75 residual). The display name is awareness
   * metadata, not session identity: it arrives from the member directory
   * whenever that request happens to land, and rebuilding the session for it
   * discarded the live `Y.Doc` — see `setLocalName`.
   */
  private localUser: NoteCollaborationUser;
  private readonly syncTimeoutMs: number;
  private readonly readyTimeoutMs: number;

  // Assigned by `adoptDocument()`, which the constructor calls and every epoch
  // reset calls again. Always the three together: a document, its awareness,
  // and the binding that hands both to the editor.
  private doc!: Y.Doc;
  private awarenessInstance!: Awareness;
  private currentBinding!: NoteCollaborationBinding;

  private epoch = 0;
  private generation = 0;
  private currentSnapshot: NoteCollaborationSnapshot = Object.freeze({
    status: "connecting" as NoteCollaborationStatus,
    epoch: 0,
    generation: 0,
    errorReason: null,
  });

  private destroyed = false;
  /** Set when the server refuses our writes; cleared by the cool-down retry. */
  private stopped = false;
  /**
   * Whether the SERVER has finished accepting this connection. A socket that is
   * `connected` may still have no note handlers registered — see
   * `DEFAULT_READY_TIMEOUT_MS`. A socket that was already connected when this
   * provider was constructed (the second note in a tab) has necessarily passed
   * that point, which is why the field starts from `socket.connected`.
   */
  private ready: boolean;

  private pending: Uint8Array[] = [];
  /**
   * Remote frames that arrived before the very first sync ack landed.
   *
   * The gateway joins the room BEFORE it reads state, precisely so an update
   * committed during the read is relayed rather than lost. Dropping those frames
   * on the client gave the loss back: the ack carries state as of the read, the
   * in-window update is in neither, and Yjs cannot heal a gap it was never told
   * about. They are held here and applied once the ack establishes which epoch
   * they had to belong to.
   */
  private windowFrames: { epoch: number; update: Uint8Array }[] = [];
  private windowFrameBytes = 0;
  /** Set when the window overflowed and the gap has to be closed by re-syncing. */
  private resyncAfterHandshake = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushAttempts = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeAttempts = 0;
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessQueue = new Set<number>();
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeInFlight: Promise<boolean> | null = null;
  private readonly readyWaiters = new Set<(ready: boolean) => void>();

  private readonly snapshotListeners = new Set<(snapshot: NoteCollaborationSnapshot) => void>();
  private readonly peerListeners = new Set<(peers: readonly NoteCollaborationPeer[]) => void>();
  private readonly projectedListeners = new Set<(payload: NoteProjectedPayload) => void>();

  constructor(options: NoteCollaborationProviderOptions) {
    this.socket = options.socket;
    this.selector = {
      kind: "note",
      workspaceId: options.workspaceId,
      noteId: options.noteId,
    };
    this.localUser = Object.freeze({
      name: options.user.name,
      color: presenceColorForUser(options.user.id),
    });
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.ready = options.socket.connected;

    this.adoptDocument();

    this.socket.on(EVENT.noteRemote, this.handleRemoteFrame);
    this.socket.on(EVENT.noteReset, this.handleResetFrame);
    this.socket.on(EVENT.noteProjected, this.handleProjectedFrame);
    this.socket.on(EVENT.noteAwareness, this.handleAwarenessFrame);
    this.socket.on(EVENT.ready, this.handleServerReady);
    this.socket.on("disconnect", this.handleSocketDisconnect);
    this.socket.on("connect_error", this.handleSocketConnectError);

    // The BROWSER knows the network dropped long before the socket does:
    // Socket.io only notices at its ping timeout, which is tens of seconds of a
    // status line claiming "Live editing" over a connection that is already
    // dead. `navigator.onLine` was already consulted on every failure path; this
    // is the same fact delivered as an event instead of waited for.
    if (typeof window !== "undefined") {
      window.addEventListener("offline", this.handleBrowserOffline);
      window.addEventListener("online", this.handleBrowserOnline);
    }
  }

  /**
   * An accessor rather than a plain field: an epoch reset replaces the document
   * *and* its awareness, and the two must always belong together.
   */
  get awareness(): Awareness {
    return this.awarenessInstance;
  }

  get document(): Y.Doc {
    return this.doc;
  }

  /**
   * Part 75 residual — the fix for the `note-images.spec.ts` flake.
   *
   * A writer's display name is resolved from the workspace member directory,
   * which lands whenever it lands. It used to be part of the identity this
   * provider was CONSTRUCTED with, so resolving it tore the session down,
   * remounted the editor onto a fresh `Y.Doc`, and dropped every keystroke that
   * had not yet reached the server. Nothing about the name belongs to the
   * session: it never goes on the wire as identity, it decides no authorization,
   * and the only thing that reads it is the awareness state peers render as a
   * caret label. So it is published in place here, touching neither the
   * document, nor the epoch, nor the generation.
   *
   * `CollaborationCursor` writes the same awareness field ONCE, when the editor
   * is created, and never re-asserts it, so a later call here is not clobbered.
   */
  setLocalName(name: string): void {
    if (this.destroyed || name === this.localUser.name) return;
    this.localUser = Object.freeze({ ...this.localUser, name });
    this.awarenessInstance.setLocalStateField("user", {
      name: this.localUser.name,
      color: this.localUser.color,
    });
  }

  get binding(): NoteCollaborationBinding {
    return this.currentBinding;
  }

  get snapshot(): NoteCollaborationSnapshot {
    return this.currentSnapshot;
  }

  /**
   * Resolves `true` only when the room is joined and synced inside the budget.
   *
   * `false` is NOT a verdict on the session: the server's `realtime:ready` runs
   * the handshake again whenever the connection is (re-)accepted, and a later
   * success publishes `"synced"`. Callers must therefore treat this as "not yet"
   * and follow `subscribe`, never latch on it.
   */
  async connect(): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }

    this.publish("connecting", null);

    if (this.socket.disconnected) {
      this.socket.connect();
    }

    // Transport first, on its own budget. Starting the join/sync clock at the
    // same moment as `socket.connect()` made that clock cover the TCP handshake,
    // the session revalidation and the socket lease as well, so a perfectly
    // healthy server routinely missed it. No `await` on the ready path: the join
    // frame goes out in this tick when the server is already accepting.
    if (this.ready) {
      return this.runHandshake();
    }

    if (!(await this.awaitReady())) {
      this.publish(this.isOffline() ? "offline" : "reconnecting", null);
      return false;
    }

    return this.runHandshake();
  }

  /** Resolves `false` on timeout rather than rejecting; the caller degrades. */
  private awaitReady(): Promise<boolean> {
    if (this.destroyed) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const settle = (value: boolean): void => {
        clearTimeout(timer);
        this.readyWaiters.delete(settle);
        resolve(value);
      };
      const timer = setTimeout(() => settle(false), this.readyTimeoutMs);

      this.readyWaiters.add(settle);
    });
  }

  subscribe(listener: (snapshot: NoteCollaborationSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);

    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  subscribeToPeers(listener: (peers: readonly NoteCollaborationPeer[]) => void): () => void {
    this.peerListeners.add(listener);
    listener(this.readPeers());

    return () => {
      this.peerListeners.delete(listener);
    };
  }

  onProjected(listener: (payload: NoteProjectedPayload) => void): () => void {
    this.projectedListeners.add(listener);

    return () => {
      this.projectedListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.awarenessTimer !== null) {
      clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.handshakeRetryTimer !== null) {
      clearTimeout(this.handshakeRetryTimer);
      this.handshakeRetryTimer = null;
    }
    for (const settle of [...this.readyWaiters]) {
      settle(false);
    }

    // Last write wins the race with unmount: emitted without waiting for the
    // ack, because there is nothing left alive to handle one.
    if (this.pending.length > 0 && !this.stopped && this.socket.connected) {
      this.socket.emit(EVENT.noteUpdate, {
        selector: this.selector,
        epoch: this.epoch,
        update: Y.mergeUpdates(this.pending),
      });
    }
    this.pending = [];
    this.windowFrames = [];
    this.windowFrameBytes = 0;

    const clientId = this.awarenessInstance.clientID;
    removeAwarenessStates(this.awarenessInstance, [clientId], "local");
    if (this.socket.connected) {
      this.socket.emit(EVENT.noteAwareness, {
        selector: this.selector,
        update: encodeAwarenessUpdate(this.awarenessInstance, [clientId]),
      });
    }

    this.socket.off(EVENT.noteRemote, this.handleRemoteFrame);
    this.socket.off(EVENT.noteReset, this.handleResetFrame);
    this.socket.off(EVENT.noteProjected, this.handleProjectedFrame);
    this.socket.off(EVENT.noteAwareness, this.handleAwarenessFrame);
    this.socket.off(EVENT.ready, this.handleServerReady);
    this.socket.off("disconnect", this.handleSocketDisconnect);
    if (typeof window !== "undefined") {
      window.removeEventListener("offline", this.handleBrowserOffline);
      window.removeEventListener("online", this.handleBrowserOnline);
    }
    this.socket.off("connect_error", this.handleSocketConnectError);

    if (this.socket.connected) {
      this.socket.emit(EVENT.leave, { selector: this.selector });
    }

    this.teardownDocument();
    this.snapshotListeners.clear();
    this.peerListeners.clear();
    this.projectedListeners.clear();
  }

  /* ----------------------------------------------------------------------- *
   * Handshake
   * ----------------------------------------------------------------------- */

  private runHandshake(): Promise<boolean> {
    // `connect()` and the socket's own `connect` event both want to sync. One
    // handshake at a time, or the room is joined twice on every reconnect.
    const inFlight = this.handshakeInFlight;
    if (inFlight !== null) {
      return inFlight;
    }

    const started = this.performHandshake();
    this.handshakeInFlight = started;
    void started.finally(() => {
      if (this.handshakeInFlight === started) {
        this.handshakeInFlight = null;
      }
    });

    return started;
  }

  private async performHandshake(): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }

    const deadline = Date.now() + this.syncTimeoutMs;
    const joined = await this.emitAck(
      EVENT.join,
      { selector: this.selector },
      this.syncTimeoutMs,
      () => true,
    );

    if (!joined.ok) {
      this.failHandshake(joined.error);
      return false;
    }
    if (this.destroyed) {
      return false;
    }

    // Join first, then sync. A sync against a room we are not in is either
    // refused or — worse — answered for a room we have no authorization on.
    const doc = this.doc;
    const synced = await this.emitAck(
      EVENT.noteSync,
      {
        selector: this.selector,
        schemaVersion: SCHEMA_VERSION,
        stateVector: Y.encodeStateVector(doc),
      },
      Math.max(deadline - Date.now(), 1),
      parseSyncAck,
    );

    if (!synced.ok) {
      this.failHandshake(synced.error);
      return false;
    }
    // A reset while the ack was in flight already replaced the document; the
    // handshake it started owns the outcome.
    if (this.destroyed || this.doc !== doc) {
      return false;
    }

    this.epoch = synced.value.epoch;
    Y.applyUpdate(doc, synced.value.update, REMOTE_ORIGIN);
    this.stopped = false;
    this.handshakeAttempts = 0;
    // Before `publish`, so the editor never renders a document that is one
    // in-window update short of the room's.
    this.drainWindowFrames();
    this.publish("synced", null);

    // Whatever the server is missing — including everything typed while
    // offline — goes out through the ordinary outbound path. Equal state
    // vectors mean there is no delta at all, which is the common case and the
    // one worth not paying for.
    const localVector = Y.encodeStateVector(doc);
    if (!sameBytes(localVector, synced.value.stateVector)) {
      this.queueUpdate(Y.encodeStateAsUpdate(doc, synced.value.stateVector));
      void this.flushUpdates();
    }

    // Presence does not survive a reconnect on the server, so re-announce.
    this.queueAwareness([this.awarenessInstance.clientID]);

    return true;
  }

  private failHandshake(error: AckError): void {
    this.scheduleHandshakeRetry(error);

    if (this.isOffline()) {
      this.publish("offline", null);
      return;
    }

    switch (error) {
      case "denied":
        this.publish("error", "denied");
        return;
      case "limited":
        this.publish("error", "limited");
        return;
      case "unavailable":
        // Includes the timeout case. The socket keeps its own bounded
        // reconnection running, so this is a wait, not a dead end — the caller
        // falls back to solo saving in the meantime.
        this.publish("reconnecting", null);
        return;
      default:
        this.publish("error", "unavailable");
    }
  }

  /**
   * Try the handshake again while the transport is up. Bounded, and never for
   * `denied` — a refused room does not become allowed by asking twice.
   */
  private scheduleHandshakeRetry(error: AckError): void {
    if (error === "denied" || this.destroyed || this.handshakeRetryTimer !== null) {
      return;
    }

    this.handshakeAttempts += 1;
    if (this.handshakeAttempts >= MAX_HANDSHAKE_ATTEMPTS) {
      return;
    }

    const delay = Math.min(HANDSHAKE_RETRY_MS * 2 ** this.handshakeAttempts, MAX_FLUSH_BACKOFF_MS);
    this.handshakeRetryTimer = setTimeout(() => {
      this.handshakeRetryTimer = null;
      // A disconnected socket needs no retry here: `realtime:ready` runs the
      // handshake again the moment the server accepts the new connection.
      if (this.destroyed || !this.socket.connected) return;
      void this.runHandshake();
    }, delay);
  }

  /* ----------------------------------------------------------------------- *
   * Outbound document updates
   * ----------------------------------------------------------------------- */

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    this.queueUpdate(update);
  };

  private queueUpdate(update: Uint8Array): void {
    if (this.destroyed || this.stopped) {
      return;
    }

    this.pending.push(update);

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushUpdates();
      }, UPDATE_FLUSH_MS);
    }
  }

  private async flushUpdates(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.destroyed || this.stopped || this.pending.length === 0) {
      return;
    }

    // Nothing to re-queue when the socket is down: the structs are already in
    // the document, so the next sync's state-vector delta carries them.
    if (!this.socket.connected) {
      this.pending = [];
      this.publish(this.isOffline() ? "offline" : "reconnecting", null);
      return;
    }

    const update = Y.mergeUpdates(this.pending);
    this.pending = [];

    const ack = await this.emitAck(
      EVENT.noteUpdate,
      { selector: this.selector, epoch: this.epoch, update },
      this.syncTimeoutMs,
      parseUpdateAck,
    );

    if (this.destroyed) {
      return;
    }

    if (ack.ok) {
      this.flushAttempts = 0;
      this.epoch = ack.value.epoch;
      this.publish("synced", null);
      return;
    }

    switch (ack.error) {
      case "stale":
        await this.resetDocument();
        return;
      case "denied":
        // The only permanently fatal ack: permission is gone and no amount of
        // retrying brings it back.
        this.stopped = true;
        this.pending = [];
        this.publish("error", "denied");
        return;
      default:
        // "limited" / "unavailable" / "invalid" / timeout are all transient —
        // `limited` is the per-session frame budget, shared across tabs and
        // notes, which clears by itself. Dropping the merged update here would
        // leave a causal gap: every later update from this tab depends on it,
        // so the server would buffer them forever while each flush still acked
        // `ok`. It goes back on the queue instead.
        this.requeue(update, ack.error);
    }
  }

  /** Puts a refused update back in causal order and re-arms with backoff. */
  private requeue(update: Uint8Array, error: AckError): void {
    this.pending.unshift(update);
    this.flushAttempts += 1;

    if (this.flushAttempts >= MAX_FLUSH_ATTEMPTS) {
      // Realtime is not taking this session's writes. Say so — `error` is what
      // makes `NoteEditorSurface` hand the pen back to the Part 39 autosave, so
      // the note has a writer rather than a status line claiming it is live —
      // and try again once the condition has had time to clear.
      this.stopped = true;
      this.pending = [];
      this.publish("error", error === "limited" ? "limited" : "unavailable");
      this.scheduleCooldownRetry();
      return;
    }

    this.publish("reconnecting", null);

    if (this.flushTimer !== null) {
      return;
    }
    const delay = Math.min(UPDATE_FLUSH_MS * 2 ** this.flushAttempts, MAX_FLUSH_BACKOFF_MS);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushUpdates();
    }, delay);
  }

  /**
   * One bounded second chance after a stopped session. Nothing was lost while
   * stopped: the structs are in the `Y.Doc`, so the re-handshake's state-vector
   * delta carries them.
   */
  private scheduleCooldownRetry(): void {
    if (this.cooldownTimer !== null) {
      return;
    }

    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      if (this.destroyed || !this.stopped) {
        return;
      }
      this.stopped = false;
      this.flushAttempts = 0;
      void this.runHandshake();
    }, STOPPED_COOLDOWN_MS);
  }

  /* ----------------------------------------------------------------------- *
   * Awareness
   * ----------------------------------------------------------------------- */

  private readonly handleAwarenessChange = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    this.publishPeers();

    // Relaying a state we were just told about would loop it back around the
    // room and burn the frame budget for nothing.
    if (origin === REMOTE_ORIGIN) {
      return;
    }

    this.queueAwareness([...changes.added, ...changes.updated, ...changes.removed]);
  };

  private queueAwareness(clients: readonly number[]): void {
    if (this.destroyed || clients.length === 0) {
      return;
    }

    for (const clientId of clients) {
      this.awarenessQueue.add(clientId);
    }

    if (this.awarenessTimer !== null) {
      return;
    }

    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.flushAwareness();
    }, AWARENESS_THROTTLE_MS);
  }

  private flushAwareness(): void {
    if (this.destroyed || this.awarenessQueue.size === 0) {
      return;
    }
    // Held, not dropped: presence is re-announced by the next handshake.
    if (this.currentSnapshot.status !== "synced" || !this.socket.connected) {
      return;
    }

    const clients = [...this.awarenessQueue];
    this.awarenessQueue.clear();

    const update = encodeAwarenessUpdate(this.awarenessInstance, clients);
    if (update.byteLength > MAX_AWARENESS_BYTES) {
      // Presence is disposable; never spend a rate-limit strike on it.
      return;
    }

    this.socket.emit(EVENT.noteAwareness, { selector: this.selector, update });
  }

  private readPeers(): readonly NoteCollaborationPeer[] {
    const peers: NoteCollaborationPeer[] = [];

    for (const [clientId, state] of this.awarenessInstance.getStates()) {
      if (clientId === this.awarenessInstance.clientID) {
        continue;
      }

      const user = asRecord(asRecord(state)?.user);
      const name = user === null ? null : user.name;
      const color = user === null ? null : user.color;

      if (typeof name !== "string" || typeof color !== "string") {
        continue;
      }

      peers.push({ clientId, name, color });
    }

    return peers;
  }

  private publishPeers(): void {
    if (this.peerListeners.size === 0) {
      return;
    }

    const peers = this.readPeers();
    for (const listener of this.peerListeners) {
      listener(peers);
    }
  }

  /* ----------------------------------------------------------------------- *
   * Inbound frames
   * ----------------------------------------------------------------------- */

  private readonly handleRemoteFrame = (payload: unknown): void => {
    const record = asRecord(payload);
    if (record === null || !isForNote(record, this.selector.noteId)) {
      return;
    }

    const epoch = asInteger(record.epoch);
    const revision = asInteger(record.revision);
    const update = asBinary(record.update);

    if (epoch === null || revision === null || update === null) {
      return;
    }

    // Epoch 0 is "the first sync ack has not landed yet", so this frame cannot
    // be judged against an epoch we do not have. It is held, not dropped — see
    // `windowFrames`.
    if (this.epoch === 0) {
      this.holdWindowFrame(epoch, update);
      return;
    }

    // A frame from a history we no longer share.
    if (epoch !== this.epoch) {
      return;
    }

    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  };

  private holdWindowFrame(epoch: number, update: Uint8Array): void {
    if (this.resyncAfterHandshake) {
      return;
    }

    this.windowFrameBytes += update.byteLength;
    if (this.windowFrameBytes > MAX_WINDOW_FRAME_BYTES) {
      this.resyncAfterHandshake = true;
      this.windowFrames = [];
      this.windowFrameBytes = 0;
      return;
    }

    this.windowFrames.push({ epoch, update });
  }

  /**
   * Applies the frames that arrived between the join and the ack, now that the
   * ack has said which epoch is ours. Yjs updates are commutative and idempotent,
   * so applying them after the ack's state is the same document as applying them
   * in arrival order would have been.
   */
  private drainWindowFrames(): void {
    const frames = this.windowFrames;
    const resync = this.resyncAfterHandshake;

    this.windowFrames = [];
    this.windowFrameBytes = 0;
    this.resyncAfterHandshake = false;

    for (const frame of frames) {
      if (frame.epoch === this.epoch) {
        Y.applyUpdate(this.doc, frame.update, REMOTE_ORIGIN);
      }
    }

    // The buffer was thrown away rather than filled. Another handshake round
    // trip exchanges state vectors and pulls back exactly what was discarded;
    // routed through the ordinary bounded retry so it cannot recurse into the
    // handshake that is still unwinding above this call.
    if (resync) {
      this.scheduleHandshakeRetry("unavailable");
    }
  }

  private readonly handleResetFrame = (payload: unknown): void => {
    const record = asRecord(payload);
    if (record === null || !isForNote(record, this.selector.noteId)) {
      return;
    }

    const epoch = asInteger(record.epoch);
    /*
     * Server epochs are strictly monotonic, so a frame at or below ours is a
     * redelivery — or the reset we already handled. Acting on it again would
     * throw away a correct document, plus everything typed in the 200 ms flush
     * window, for every member of the room at once.
     *
     * Epoch 0 is "never synced", and a reset then is not merely wasteful, it is
     * the bug that latched every first session on a note to solo: the FIRST
     * sync of a note rebuilds the server state and announces epoch 1 to the
     * room, so the client that triggered it received a reset for the very epoch
     * its own handshake was about to deliver — and tearing the document down
     * underneath that handshake made it abandon without publishing `"synced"`.
     * There is nothing to invalidate before the first sync.
     */
    if (epoch === null || this.epoch === 0 || epoch <= this.epoch) {
      return;
    }

    // Adopted before the rebuild so a redelivery of the same frame is caught by
    // the guard above rather than resetting a second time.
    this.epoch = epoch;
    void this.resetDocument();
  };

  private readonly handleProjectedFrame = (payload: unknown): void => {
    const record = asRecord(payload);
    if (record === null || !isForNote(record, this.selector.noteId)) {
      return;
    }

    const version = asInteger(record.version);
    const revision = asInteger(record.revision);
    const epoch = asInteger(record.epoch);

    if (version === null || revision === null || epoch === null) {
      return;
    }

    const projected: NoteProjectedPayload = { version, revision, epoch };
    for (const listener of this.projectedListeners) {
      listener(projected);
    }
  };

  private readonly handleAwarenessFrame = (payload: unknown): void => {
    const record = asRecord(payload);
    if (record === null || !isForNote(record, this.selector.noteId)) {
      return;
    }

    const update = asBinary(record.update);
    if (update === null) {
      return;
    }

    applyAwarenessUpdate(this.awarenessInstance, update, REMOTE_ORIGIN);
  };

  /**
   * The server finished accepting this connection and the note handlers exist.
   * This — never the client's `connect` event — is what starts a handshake.
   */
  private readonly handleServerReady = (): void => {
    this.ready = true;
    // A fresh connection gets a fresh budget, and any handshake still pending
    // from before the server announced itself is superseded by the retry rather
    // than absorbed into `runHandshake`'s in-flight dedupe.
    this.handshakeAttempts = 0;
    for (const settle of [...this.readyWaiters]) {
      settle(true);
    }
    void this.runHandshake();
  };

  private readonly handleSocketDisconnect = (): void => {
    this.ready = false;
    this.handshakeAttempts = 0;
    this.publish(this.isOffline() ? "offline" : "reconnecting", null);
  };

  private readonly handleSocketConnectError = (): void => {
    this.publish(this.isOffline() ? "offline" : "reconnecting", null);
  };

  private readonly handleBrowserOffline = (): void => {
    if (this.destroyed) return;
    this.publish("offline", null);
  };

  /**
   * Back on the network. The socket may never have noticed it was gone — its
   * ping timeout can outlast the outage entirely — so a handshake is run
   * directly rather than waiting for a reconnect that will not happen.
   */
  private readonly handleBrowserOnline = (): void => {
    if (this.destroyed) return;
    this.handshakeAttempts = 0;
    if (this.socket.disconnected) {
      this.socket.connect();
      return;
    }
    void this.runHandshake();
  };

  /* ----------------------------------------------------------------------- *
   * Document lifecycle
   * ----------------------------------------------------------------------- */

  private adoptDocument(): void {
    this.generation += 1;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for the binding's `user` getter, which must not rebind `this`.
    const provider = this;

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    doc.on("update", this.handleDocUpdate);
    awareness.on("update", this.handleAwarenessChange);

    this.doc = doc;
    this.awarenessInstance = awareness;
    // `user` is a GETTER, not a snapshot: `setLocalName` must reach every holder
    // of this binding, including a `TiptapEditor` that captured it at creation.
    // A replaced binding object would leave that editor configuring
    // `CollaborationCursor` from a name that is already stale.
    this.currentBinding = Object.freeze({
      document: doc,
      awareness,
      get user(): NoteCollaborationUser {
        return provider.localUser;
      },
    });

    // Announced only once the fields are swapped: the awareness listener reads
    // them back, and mid-swap it would read the document that was just thrown
    // away.
    awareness.setLocalStateField("user", {
      name: this.localUser.name,
      color: this.localUser.color,
    });
  }

  private teardownDocument(): void {
    this.awarenessInstance.off("update", this.handleAwarenessChange);
    this.doc.off("update", this.handleDocUpdate);
    this.awarenessInstance.destroy();
    this.doc.destroy();
  }

  /**
   * The epoch moved: the server's history is not ours. Everything local is
   * discarded — never merged — and the React layer remounts the editor against
   * the new binding, keyed by the new epoch.
   *
   * ponytail: offline durability across a page reload (`y-indexeddb`) is
   * deliberately NOT shipped. Unsent edits live in the tab's `Y.Doc` and in the
   * Part 39 autosave, so a reload before reconnecting loses only the realtime
   * copy; add the IndexedDB persistence provider when true offline editing is a
   * requirement rather than a nicety.
   */
  private async resetDocument(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const clientId = this.awarenessInstance.clientID;
    removeAwarenessStates(this.awarenessInstance, [clientId], "local");
    this.teardownDocument();

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = [];
    this.windowFrames = [];
    this.windowFrameBytes = 0;
    this.resyncAfterHandshake = false;
    this.awarenessQueue.clear();
    this.stopped = false;
    this.flushAttempts = 0;

    this.adoptDocument();

    // SUPERSEDE, never join. Any handshake still in flight was reading into the
    // document just discarded, so it will abandon at its own `this.doc !== doc`
    // check — and `runHandshake`'s dedupe would hand that doomed promise back
    // instead of starting the handshake this reset exists to run.
    this.handshakeInFlight = null;

    this.publish("connecting", null);
    await this.runHandshake();
  }

  /* ----------------------------------------------------------------------- *
   * Plumbing
   * ----------------------------------------------------------------------- */

  private emitAck<T>(
    event: string,
    payload: object,
    timeoutMs: number,
    parseValue: (record: Record<string, unknown>) => T | null,
  ): Promise<AckOutcome<T>> {
    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ ok: false, error: "unavailable" });
      }, timeoutMs);

      this.socket.emit(event, payload, (raw: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(parseAck(raw, parseValue));
      });
    });
  }

  private publish(
    status: NoteCollaborationStatus,
    errorReason: NoteCollaborationSnapshot["errorReason"],
  ): void {
    const current = this.currentSnapshot;

    if (
      current.status === status &&
      current.epoch === this.epoch &&
      current.generation === this.generation &&
      current.errorReason === errorReason
    ) {
      return;
    }

    const next: NoteCollaborationSnapshot = Object.freeze({
      status,
      epoch: this.epoch,
      generation: this.generation,
      errorReason,
    });
    this.currentSnapshot = next;

    for (const listener of this.snapshotListeners) {
      listener(next);
    }
  }

  private isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }
}
