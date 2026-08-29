import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { NoteCollaborationProvider } from "./note-collaboration-provider";

import type { Socket } from "socket.io-client";

/**
 * The protocol, proven without a socket.
 *
 * A hand-rolled fake rather than a server or `msw`: every case here is about
 * ordering, epochs, and what is in the bytes, and all three are easier to state
 * as "this ack came back" than as "this server was running". Fake timers make
 * the 200 ms batching window and the 1500 ms handshake budget exact.
 */

const READY = "realtime:ready";
const JOIN = "realtime:room:join";
const SYNC = "realtime:note:sync";
const UPDATE = "realtime:note:update";
const REMOTE = "realtime:note:remote";
const RESET = "realtime:note:reset";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "00000000-0000-4000-8000-000000000002";

type SocketListener = (...args: unknown[]) => void;
type AckCallback = (response: unknown) => void;

interface EmittedFrame {
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly ack: AckCallback | null;
}

function fakeSocket() {
  const listeners = new Map<string, Set<SocketListener>>();
  const emitted: EmittedFrame[] = [];
  const state = { connected: true };

  const socket = {
    get connected() {
      return state.connected;
    },
    get disconnected() {
      return !state.connected;
    },
    emit: vi.fn((event: string, payload: unknown, ack?: AckCallback) => {
      emitted.push({
        event,
        payload: (payload ?? {}) as Record<string, unknown>,
        ack: ack ?? null,
      });
    }),
    on: vi.fn((event: string, listener: SocketListener) => {
      const registered = listeners.get(event) ?? new Set<SocketListener>();
      registered.add(listener);
      listeners.set(event, registered);
    }),
    off: vi.fn((event: string, listener: SocketListener) => {
      listeners.get(event)?.delete(listener);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const frames = (event: string): EmittedFrame[] => {
    return emitted.filter((frame) => frame.event === event);
  };

  const last = (event: string): EmittedFrame => {
    const matching = frames(event);
    const frame = matching[matching.length - 1];
    if (!frame) {
      throw new Error(`No "${event}" frame was emitted`);
    }
    return frame;
  };

  return {
    socket: socket as unknown as Socket,
    emitted,
    frames,
    last,
    events(): string[] {
      return emitted.map((frame) => frame.event);
    },
    ack(event: string, response: unknown): void {
      const frame = last(event);
      if (!frame.ack) {
        throw new Error(`"${event}" was emitted without an ack callback`);
      }
      frame.ack(response);
    },
    fire(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    },
    setConnected(next: boolean): void {
      state.connected = next;
    },
  };
}

type Harness = ReturnType<typeof fakeSocket>;

/** Drains the microtask queue without moving the clock. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function seed(text: string): { update: Uint8Array; stateVector: Uint8Array } {
  const doc = new Y.Doc();
  if (text.length > 0) {
    doc.getText("body").insert(0, text);
  }
  return { update: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}

function createProvider(harness: Harness): NoteCollaborationProvider {
  return new NoteCollaborationProvider({
    socket: harness.socket,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
    user: { id: "user-1", name: "Ada" },
  });
}

async function completeHandshake(
  harness: Harness,
  options: { epoch: number; update: Uint8Array; stateVector: Uint8Array },
): Promise<void> {
  harness.ack(JOIN, { ok: true });
  await flush();
  harness.ack(SYNC, {
    ok: true,
    epoch: options.epoch,
    revision: 1,
    schemaVersion: 1,
    update: options.update,
    stateVector: options.stateVector,
  });
  await flush();
}

describe("NoteCollaborationProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins before syncing and applies the server document", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const server = seed("hello");

    const connected = provider.connect();
    expect(harness.events()).toEqual([JOIN]);

    harness.ack(JOIN, { ok: true });
    await flush();
    expect(harness.events()).toEqual([JOIN, SYNC]);
    expect(harness.last(SYNC).payload.stateVector).toBeInstanceOf(Uint8Array);
    expect(harness.last(SYNC).payload.schemaVersion).toBe(1);

    harness.ack(SYNC, {
      ok: true,
      epoch: 1,
      revision: 9,
      schemaVersion: 1,
      update: server.update,
      stateVector: server.stateVector,
    });
    await flush();

    await expect(connected).resolves.toBe(true);
    expect(provider.document.getText("body").toString()).toBe("hello");
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 1,
      errorReason: null,
    });
    // Identical state vectors: nothing of ours is missing, so nothing is sent.
    expect(harness.frames(UPDATE)).toHaveLength(0);

    provider.destroy();
  });

  it("discards the document and re-handshakes when an update is stale", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    const firstDoc = provider.document;
    firstDoc.getText("body").insert(0, "rebased away");
    await vi.advanceTimersByTimeAsync(200);

    harness.ack(UPDATE, { ok: false, error: "stale" });
    await flush();

    expect(harness.frames(JOIN)).toHaveLength(2);
    harness.ack(JOIN, { ok: true });
    await flush();
    harness.ack(SYNC, {
      ok: true,
      epoch: 2,
      revision: 1,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();

    expect(provider.document).not.toBe(firstDoc);
    expect(provider.document.getText("body").toString()).toBe("");
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 2,
      generation: 2,
      errorReason: null,
    });

    provider.destroy();
  });

  it("moves the generation on a stale re-handshake that lands on the same epoch", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    const firstDoc = provider.document;
    firstDoc.getText("body").insert(0, "rebased away");
    await vi.advanceTimersByTimeAsync(200);

    harness.ack(UPDATE, { ok: false, error: "stale" });
    await flush();
    harness.ack(JOIN, { ok: true });
    await flush();
    // The SAME epoch comes back. Nothing about the epoch tells the editor its
    // document was replaced, so a remount keyed on the epoch would not happen and
    // TipTap would keep writing into `firstDoc`, which is already destroyed.
    harness.ack(SYNC, {
      ok: true,
      epoch: 1,
      revision: 4,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();

    expect(provider.document).not.toBe(firstDoc);
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 2,
      errorReason: null,
    });

    provider.destroy();
  });

  it("applies a remote frame that arrived between the join and the sync ack", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);

    // What the server had when it read state, and what a peer committed after
    // that read but before the ack came back. The gateway joins the room first
    // precisely so the second one is relayed rather than lost.
    const atRead = new Y.Doc();
    atRead.getText("body").insert(0, "server");
    const server = {
      update: Y.encodeStateAsUpdate(atRead),
      stateVector: Y.encodeStateVector(atRead),
    };

    const peer = new Y.Doc();
    Y.applyUpdate(peer, server.update);
    let inWindow: Uint8Array = new Uint8Array();
    peer.on("update", (update: Uint8Array) => {
      inWindow = update;
    });
    peer.getText("body").insert(6, " and peer");

    const connected = provider.connect();
    harness.ack(JOIN, { ok: true });
    await flush();

    harness.fire(REMOTE, { noteId: NOTE_ID, epoch: 1, revision: 8, update: inWindow });
    await flush();

    harness.ack(SYNC, {
      ok: true,
      epoch: 1,
      revision: 7,
      schemaVersion: 1,
      update: server.update,
      stateVector: server.stateVector,
    });
    await flush();
    await connected;

    // Dropping the in-window frame left this at "server" with nothing pending
    // and no gap for Yjs to heal — a silent divergence for the whole session.
    expect(provider.document.getText("body").toString()).toBe("server and peer");

    provider.destroy();
  });

  it("ignores an in-window frame belonging to an epoch the sync ack did not confirm", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const stray = new Y.Doc();
    stray.getText("body").insert(0, "other history");

    const connected = provider.connect();
    harness.ack(JOIN, { ok: true });
    await flush();

    harness.fire(REMOTE, {
      noteId: NOTE_ID,
      epoch: 4,
      revision: 1,
      update: Y.encodeStateAsUpdate(stray),
    });
    await flush();

    harness.ack(SYNC, {
      ok: true,
      epoch: 5,
      revision: 1,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();
    await connected;

    expect(provider.document.getText("body").toString()).toBe("");

    provider.destroy();
  });

  it("replays edits made while disconnected on the next handshake", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    harness.setConnected(false);
    harness.fire("disconnect", "transport close");
    provider.document.getText("body").insert(0, "written offline");
    await vi.advanceTimersByTimeAsync(300);

    expect(provider.snapshot.status).toBe("reconnecting");
    expect(harness.frames(UPDATE)).toHaveLength(0);
    // The queue is HELD, not dropped: it is the only evidence the writer has
    // work the server has never seen, and what arms the unload prompt.
    expect(provider.hasUnacknowledgedWork).toBe(true);

    harness.setConnected(true);
    // The SERVER's readiness, not the client's `connect`: the note handlers are
    // registered inside `handleConnection`, so a join emitted on `connect` can
    // reach a socket that has no listener for it yet.
    harness.fire(READY, { ok: true });
    await flush();

    harness.ack(JOIN, { ok: true });
    await flush();
    expect(harness.last(SYNC).payload.stateVector).toBeInstanceOf(Uint8Array);

    harness.ack(SYNC, {
      ok: true,
      epoch: 1,
      revision: 4,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();

    const delta = harness.last(UPDATE).payload.update;
    expect(delta).toBeInstanceOf(Uint8Array);

    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, delta as Uint8Array);
    expect(mirror.getText("body").toString()).toBe("written offline");

    harness.ack(UPDATE, { ok: true, epoch: 1, revision: 5 });
    await flush();
    // Acknowledged: the tab no longer owes the server anything, so closing it
    // must stop prompting.
    expect(provider.hasUnacknowledgedWork).toBe(false);

    provider.destroy();
  });

  /*
   * A `stale` update ack rebuilds the document. The re-handshake then runs
   * against a fresh `Y.Doc`, and a peer committing during that round trip sends
   * a frame at the NEW epoch — which used to be compared against the OLD epoch
   * this provider still held, take the `epoch !== this.epoch` discard branch,
   * and be lost until the reader reloaded the page. The sync ack cannot cover
   * it either: it carries state as of the server's read, which is before that
   * commit.
   */
  it("applies a peer frame that arrives while a stale re-handshake is reading", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    provider.document.getText("body").insert(0, "local");
    await vi.advanceTimersByTimeAsync(300);
    harness.ack(UPDATE, { ok: false, error: "stale" });
    await flush();

    // Rebuilt, and therefore unsynced: epoch 0 is this file's word for that.
    expect(provider.snapshot.epoch).toBe(0);

    const peer = seed("peer paragraph");
    harness.ack(JOIN, { ok: true });
    await flush();
    harness.fire(REMOTE, {
      noteId: NOTE_ID,
      epoch: 2,
      revision: 7,
      update: peer.update,
    });
    await flush();

    harness.ack(SYNC, {
      ok: true,
      epoch: 2,
      revision: 7,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();

    expect(provider.document.getText("body").toString()).toContain("peer paragraph");

    provider.destroy();
  });

  /*
   * The server declares `epoch` a POSITIVE integer and acks anything else
   * `invalid`, which `requeue` counts as a strike — five and realtime is dead
   * for the session. After a reset the editor stays mounted and editable for the
   * whole re-handshake, so a burst of typing lands in `flushUpdates` at epoch 0.
   */
  it("sends no update tagged with an epoch no handshake established", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    const before = harness.frames(UPDATE).length;
    harness.fire(RESET, { noteId: NOTE_ID, epoch: 5 });
    await flush();
    expect(provider.snapshot.epoch).toBe(0);

    provider.document.getText("body").insert(0, "typed during the re-handshake");
    await vi.advanceTimersByTimeAsync(300);
    expect(harness.frames(UPDATE)).toHaveLength(before);

    // Once the handshake names an epoch, the held work goes out under it.
    harness.ack(JOIN, { ok: true });
    await flush();
    harness.ack(SYNC, {
      ok: true,
      epoch: 5,
      revision: 9,
      schemaVersion: 1,
      update: empty.update,
      stateVector: empty.stateVector,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    const sent = harness.frames(UPDATE);
    expect(sent.length).toBeGreaterThan(before);
    expect(sent[sent.length - 1]!.payload.epoch).toBe(5);

    provider.destroy();
  });

  it("reports epoch 0 while the document it adopted has not synced", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 2, ...empty });
    await connected;

    harness.fire(RESET, { noteId: NOTE_ID, epoch: 3 });
    await flush();
    expect(provider.snapshot).toEqual({
      status: "connecting",
      epoch: 0,
      generation: 2,
      errorReason: null,
    });

    // A refused re-handshake leaves the editor showing a blank document. The
    // epoch stays 0, which is what tells the surface not to hand the pen to it.
    harness.ack(JOIN, { ok: false, error: "denied" });
    await flush();
    expect(provider.snapshot).toEqual({
      status: "error",
      epoch: 0,
      generation: 2,
      errorReason: "denied",
    });

    provider.destroy();
  });

  it("waits for the server's readiness before joining", async () => {
    const harness = fakeSocket();
    harness.setConnected(false);
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    // The client's own `connect` event is deliberately NOT a handshake trigger:
    // it fires as soon as the namespace is accepted, which is before
    // `handleConnection` has registered the note handlers.
    harness.setConnected(true);
    harness.fire("connect");
    await flush();
    expect(harness.frames(JOIN)).toHaveLength(0);

    harness.fire(READY, { ok: true });
    await flush();
    expect(harness.frames(JOIN)).toHaveLength(1);

    await completeHandshake(harness, { epoch: 1, ...empty });
    await expect(connected).resolves.toBe(true);

    provider.destroy();
  });

  it("promotes a session whose readiness arrived after the first attempt gave up", async () => {
    const harness = fakeSocket();
    harness.setConnected(false);
    const provider = createProvider(harness);
    const empty = seed("");
    const statuses: string[] = [];
    provider.subscribe((snapshot) => statuses.push(snapshot.status));

    const connected = provider.connect();
    // Past the readiness budget with nothing from the server.
    await vi.advanceTimersByTimeAsync(2500);
    await expect(connected).resolves.toBe(false);
    expect(harness.frames(JOIN)).toHaveLength(0);

    harness.setConnected(true);
    harness.fire(READY, { ok: true });
    await flush();
    await completeHandshake(harness, { epoch: 1, ...empty });

    // The one-shot result said "no"; the subscription is what promotes.
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 1,
      errorReason: null,
    });
    expect(statuses).toContain("synced");

    provider.destroy();
  });

  it("retries a handshake that raced the server's handler registration", async () => {
    const harness = fakeSocket();
    // `socket.connected` turns true when the namespace is accepted, which is
    // BEFORE the server has registered its note handlers. A join emitted in that
    // window is dropped without an ack — the exact race that latched every real
    // browser session to solo.
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    expect(harness.frames(JOIN)).toHaveLength(1);

    // No ack: the handler did not exist yet.
    await vi.advanceTimersByTimeAsync(1500);
    await expect(connected).resolves.toBe(false);

    harness.fire(READY, { ok: true });
    await flush();
    await vi.advanceTimersByTimeAsync(600);

    // The retry is a NEW handshake, not the doomed one returned by the in-flight
    // dedupe in `runHandshake`.
    expect(harness.frames(JOIN)).toHaveLength(2);
    await completeHandshake(harness, { epoch: 1, ...empty });
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 1,
      errorReason: null,
    });

    provider.destroy();
  });

  it("reports offline from the browser rather than waiting for the ping timeout", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;
    expect(provider.snapshot.status).toBe("synced");

    // Socket.io does not notice a dropped network until its ping timeout — tens
    // of seconds of "Live editing" over a dead connection. The socket here is
    // deliberately still `connected`, exactly as it would be in that window.
    window.dispatchEvent(new Event("offline"));
    expect(provider.snapshot.status).toBe("offline");

    window.dispatchEvent(new Event("online"));
    await flush();
    expect(harness.frames(JOIN)).toHaveLength(2);

    provider.destroy();
  });

  it("re-sends a refused update instead of dropping it", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    provider.document.getText("body").insert(0, "kept");
    await vi.advanceTimersByTimeAsync(200);
    expect(harness.frames(UPDATE)).toHaveLength(1);

    // A dropped delta would leave a causal gap: every later update from this
    // tab depends on it, so the server would buffer them forever.
    harness.ack(UPDATE, { ok: false, error: "unavailable" });
    await flush();
    await vi.advanceTimersByTimeAsync(400);

    const retried = harness.frames(UPDATE);
    expect(retried).toHaveLength(2);
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, retried[1]?.payload.update as Uint8Array);
    expect(mirror.getText("body").toString()).toBe("kept");

    harness.ack(UPDATE, { ok: true, epoch: 1, revision: 2 });
    await flush();
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 1,
      errorReason: null,
    });

    provider.destroy();
  });

  it("gives up on realtime only after the retry budget, and reports it", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const empty = seed("");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...empty });
    await connected;

    provider.document.getText("body").insert(0, "rate limited");
    await vi.advanceTimersByTimeAsync(200);

    // `limited` is the per-session frame budget, shared across tabs and notes.
    // It clears by itself, so it must not stop the session on the first strike.
    const backoff = [400, 800, 1600, 3200];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      harness.ack(UPDATE, { ok: false, error: "limited" });
      await flush();
      const delay = backoff[attempt];
      if (delay !== undefined) {
        await vi.advanceTimersByTimeAsync(delay);
      }
    }

    expect(harness.frames(UPDATE)).toHaveLength(5);
    expect(provider.snapshot).toEqual({
      status: "error",
      epoch: 1,
      generation: 1,
      errorReason: "limited",
    });

    // Stopped means stopped: no further frames until the cool-down.
    provider.document.getText("body").insert(0, "more");
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.frames(UPDATE)).toHaveLength(5);

    // ...and the cool-down re-handshakes rather than abandoning the note.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.frames(JOIN).length).toBeGreaterThan(1);

    // Bounded, though: an unanswered handshake stops retrying rather than
    // hammering a server that is not going to answer.
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = harness.frames(JOIN).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.frames(JOIN)).toHaveLength(settled);

    provider.destroy();
  });

  it("survives the reset the first sync of a note announces to its own room", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const server = seed("hello");

    const connected = provider.connect();
    harness.ack(JOIN, { ok: true });
    await flush();

    // The server had no persisted state, so the sync rebuilt it and announced
    // epoch 1 to the room this client is already in — the reset arrives while
    // that client's own handshake is still reading. Acting on it discarded the
    // document the ack was about to fill and abandoned the handshake silently.
    harness.fire(RESET, { noteId: NOTE_ID, epoch: 1 });
    await flush();
    expect(harness.frames(JOIN)).toHaveLength(1);

    harness.ack(SYNC, {
      ok: true,
      epoch: 1,
      revision: 1,
      schemaVersion: 1,
      update: server.update,
      stateVector: server.stateVector,
    });
    await flush();

    await expect(connected).resolves.toBe(true);
    expect(provider.snapshot).toEqual({
      status: "synced",
      epoch: 1,
      generation: 1,
      errorReason: null,
    });
    expect(provider.document.getText("body").toString()).toBe("hello");

    provider.destroy();
  });

  it("ignores a redelivered reset frame instead of discarding the document", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const server = seed("hello");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 2, ...server });
    await connected;

    const document = provider.document;
    // Already applied (equal) and stale (lower): both are redeliveries, and both
    // would otherwise throw away a correct document for the whole room.
    harness.fire(RESET, { noteId: NOTE_ID, epoch: 2 });
    harness.fire(RESET, { noteId: NOTE_ID, epoch: 1 });
    await flush();

    expect(provider.document).toBe(document);
    expect(provider.document.getText("body").toString()).toBe("hello");
    expect(harness.frames(JOIN)).toHaveLength(1);

    // A genuinely newer epoch still resets.
    harness.fire(RESET, { noteId: NOTE_ID, epoch: 3 });
    await flush();
    expect(provider.document).not.toBe(document);
    expect(harness.frames(JOIN)).toHaveLength(2);

    provider.destroy();
  });

  it("falls back to solo when the sync is unavailable", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);

    const connected = provider.connect();
    harness.ack(JOIN, { ok: true });
    await flush();
    harness.ack(SYNC, { ok: false, error: "unavailable" });
    await flush();

    await expect(connected).resolves.toBe(false);
    expect(provider.snapshot).toEqual({
      status: "reconnecting",
      epoch: 0,
      generation: 1,
      errorReason: null,
    });

    provider.destroy();
  });

  it("drops malformed remote frames and accepts ArrayBuffer payloads", async () => {
    const harness = fakeSocket();
    const provider = createProvider(harness);
    const server = seed("hello");

    const connected = provider.connect();
    await completeHandshake(harness, { epoch: 1, ...server });
    await connected;

    const valid = new Y.Doc();
    Y.applyUpdate(valid, server.update);
    valid.getText("body").insert(5, "!");
    const delta = Y.encodeStateAsUpdate(valid, server.stateVector);

    expect(() => {
      harness.fire(REMOTE, null);
      harness.fire(REMOTE, "not a frame");
      harness.fire(REMOTE, { noteId: NOTE_ID, epoch: 1, revision: 2 });
      harness.fire(REMOTE, { noteId: NOTE_ID, epoch: 1, revision: 2, update: "not binary" });
      harness.fire(REMOTE, { noteId: NOTE_ID, epoch: 1.5, revision: 2, update: delta });
      // Right shape, wrong history.
      harness.fire(REMOTE, { noteId: NOTE_ID, epoch: 9, revision: 3, update: delta });
      // Right shape, right epoch, ANOTHER NOTE. One Socket.io connection is
      // shared by the whole app and dispatches by event name, not by room, so
      // this frame reaches this provider's handler. Epochs are per-note and
      // collide freely: without the `noteId` guard this would be applied here
      // and silently corrupt the document.
      harness.fire(REMOTE, {
        noteId: "00000000-0000-4000-8000-0000000000ff",
        epoch: 1,
        revision: 3,
        update: delta,
      });
      // Identity missing entirely.
      harness.fire(REMOTE, { epoch: 1, revision: 3, update: delta });
    }).not.toThrow();
    expect(provider.document.getText("body").toString()).toBe("hello");

    // Some browser builds deliver binary as an ArrayBuffer.
    harness.fire(REMOTE, {
      noteId: NOTE_ID,
      epoch: 1,
      revision: 4,
      update: new Uint8Array(delta).buffer,
    });
    expect(provider.document.getText("body").toString()).toBe("hello!");

    provider.destroy();
  });

  /**
   * `setLocalName` is the non-destructive half of the fix for the editor
   * remount race: the display name arrives late from the member directory, and
   * before this existed the only way to publish it was to rebuild the session.
   *
   * These four cases exist because the browser probe cannot see them. That
   * probe counts editor mounts, so gutting this method to `{ return; }` leaves
   * it green while every peer's caret silently reads the placeholder name
   * forever. What is destructive is guarded there; what is published is
   * guarded here.
   */
  describe("setLocalName", () => {
    it("publishes the name through awareness without touching the session", async () => {
      const harness = fakeSocket();
      const provider = createProvider(harness);
      const connected = provider.connect();
      await completeHandshake(harness, { epoch: 1, ...seed("hello") });
      await connected;

      const documentBefore = provider.document;
      const { epoch, generation } = provider.snapshot;
      const color = provider.binding.user.color;

      provider.setLocalName("Grace");

      // (a) the binding reports the new name — through the getter, so a
      // consumer that captured the binding earlier still reads current state.
      expect(provider.binding.user.name).toBe("Grace");
      // (b) awareness carries it, and `color` survives the field rewrite.
      expect(provider.awareness.getLocalState()?.user).toEqual({
        name: "Grace",
        color,
      });
      // (c) nothing about the session moved. An epoch or generation change is
      // exactly what tears the editor down and loses keystrokes.
      expect(provider.snapshot.epoch).toBe(epoch);
      expect(provider.snapshot.generation).toBe(generation);
      expect(provider.document).toBe(documentBefore);
      expect(provider.document.getText("body").toString()).toBe("hello");

      provider.destroy();
    });

    it("does not emit a document frame", async () => {
      const harness = fakeSocket();
      const provider = createProvider(harness);
      const connected = provider.connect();
      await completeHandshake(harness, { epoch: 1, ...seed("hello") });
      await connected;

      const before = harness.events().length;
      provider.setLocalName("Grace");
      await flush();
      expect(harness.events().length).toBe(before);

      provider.destroy();
    });

    it("no-ops when the name is unchanged", async () => {
      const harness = fakeSocket();
      const provider = createProvider(harness);
      const connected = provider.connect();
      await completeHandshake(harness, { epoch: 1, ...seed("hello") });
      await connected;

      const stateBefore = provider.awareness.getLocalState()?.user;
      provider.setLocalName("Ada");
      expect(provider.awareness.getLocalState()?.user).toEqual(stateBefore);

      provider.destroy();
    });

    it("no-ops after destroy", async () => {
      const harness = fakeSocket();
      const provider = createProvider(harness);
      const connected = provider.connect();
      await completeHandshake(harness, { epoch: 1, ...seed("hello") });
      await connected;

      provider.destroy();
      expect(() => provider.setLocalName("Grace")).not.toThrow();
    });
  });
});
