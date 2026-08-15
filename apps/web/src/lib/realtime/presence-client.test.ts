import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The hook must reach the tab's one shared socket through `getRealtimeSocket`,
// so the fake is injected there rather than passed in: this file also proves
// that the hook opens no connection of its own.
const { socketRef } = vi.hoisted(() => ({
  socketRef: { current: null as Socket | null },
}));
vi.mock("@/lib/collaboration/realtime-socket", () => ({
  getRealtimeSocket: () => socketRef.current,
}));

import { useNotePresence } from "./presence-client";
import { clearPresence, getPresenceRoster } from "./presence-store";

import type { PresenceRoster } from "./presence-store";
import type { Socket } from "socket.io-client";

/**
 * The presence wiring, proven without a server.
 *
 * A hand-rolled fake rather than `msw`: every case here is about which frames
 * are trusted, which are dropped, and what leaves the tab — all easier to state
 * as "this frame arrived" than as "this server was running".
 */

const ANNOUNCE = "realtime:presence:announce";
const JOINED = "realtime:presence:joined";
const LEFT = "realtime:presence:left";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-000000000003";
const AWARENESS_CLIENT_ID = 4242;

type SocketListener = (...args: unknown[]) => void;
type AckCallback = (response: unknown) => void;

interface EmittedFrame {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

function fakeSocket(announceAck: unknown) {
  const listeners = new Map<string, Set<SocketListener>>();
  const emitted: EmittedFrame[] = [];
  /** Kept so a test can answer an emit LATER than the emit itself. */
  const acks: AckCallback[] = [];
  const state = { connected: true, ack: announceAck };

  const socket = {
    get connected() {
      return state.connected;
    },
    get disconnected() {
      return !state.connected;
    },
    // The ack fires synchronously: the server's answer is the only thing that
    // populates the roster, so every test would otherwise need a timer.
    emit: vi.fn((event: string, payload: unknown, ack?: AckCallback) => {
      emitted.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
      if (ack) acks.push(ack);
      if (ack && state.ack !== undefined) ack(state.ack);
    }),
    on: vi.fn((event: string, listener: SocketListener) => {
      const registered = listeners.get(event) ?? new Set<SocketListener>();
      registered.add(listener);
      listeners.set(event, registered);
    }),
    off: vi.fn((event: string, listener: SocketListener) => {
      listeners.get(event)?.delete(listener);
    }),
  };

  return {
    socket: socket as unknown as Socket,
    emitted,
    frames(event: string): EmittedFrame[] {
      return emitted.filter((frame) => frame.event === event);
    },
    fire(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    setAck(response: unknown): void {
      state.ack = response;
    },
    /** The ack callback of the most recent emit, for answering it out of band. */
    lastAck(): AckCallback | undefined {
      return acks.at(-1);
    },
    onEvents(): string[] {
      return socket.on.mock.calls.map(([event]) => event);
    },
    offEvents(): string[] {
      return socket.off.mock.calls.map(([event]) => event);
    },
  };
}

type Harness = ReturnType<typeof fakeSocket>;

function viewerFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    presenceId: "p1",
    userId: "user-1",
    colorIndex: 2,
    awarenessClientId: 11,
    ...overrides,
  };
}

/** The ack shape the server sends when the announce is accepted. */
function okAck(viewers: Record<string, unknown>[] = [viewerFrame()]): unknown {
  return { ok: true, presence: viewers[0], viewers, viewerCount: viewers.length };
}

function mount(
  harness: Harness,
  options: { enabled?: boolean; awarenessClientId?: number | null; synced?: boolean } = {},
) {
  socketRef.current = harness.socket;

  const awarenessClientId =
    options.awarenessClientId === undefined ? AWARENESS_CLIENT_ID : options.awarenessClientId;

  return renderHook(
    (props: { synced: boolean }): PresenceRoster =>
      useNotePresence({
        enabled: options.enabled ?? true,
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        awarenessClientId,
        synced: props.synced,
      }),
    { initialProps: { synced: options.synced ?? true } },
  );
}

afterEach(() => {
  clearPresence(NOTE_ID);
  clearPresence(OTHER_NOTE_ID);
  socketRef.current = null;
  vi.clearAllMocks();
});

describe("useNotePresence announce", () => {
  it("sends only the room selector and the awareness client id", () => {
    const harness = fakeSocket(okAck());
    mount(harness);

    const frames = harness.frames(ANNOUNCE);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual({
      selector: { kind: "note", workspaceId: WORKSPACE_ID, noteId: NOTE_ID },
      awarenessClientId: AWARENESS_CLIENT_ID,
    });

    // The server mints the identity; a client that could name itself could
    // impersonate any member of the workspace.
    for (const key of ["presenceId", "userId", "name", "color", "colorIndex"]) {
      expect(frames[0]?.payload).not.toHaveProperty(key);
    }
  });

  it("publishes the roster the ack returned", () => {
    const harness = fakeSocket(
      okAck([viewerFrame(), viewerFrame({ presenceId: "p2", awarenessClientId: 12 })]),
    );
    const { result } = mount(harness);

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1", "p2"]);
    expect(result.current.selfPresenceId).toBe("p1");
    expect(result.current.viewerCount).toBe(2);
    expect(result.current.overflow).toBe(false);
  });

  /**
   * A Socket.io ack has no deadline of its own, so without one this callback
   * stays armed for the life of the socket and a very late answer repaints a
   * roster that describes the room as it was minutes ago.
   */
  it("ignores an announce ack that arrives after the deadline", () => {
    vi.useFakeTimers();
    try {
      // `undefined` means the fake accepts the emit and never answers it.
      const harness = fakeSocket(undefined);
      const { result } = mount(harness);
      expect(result.current.viewers).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      act(() => {
        harness.lastAck()?.(okAck());
      });

      expect(result.current.viewers).toHaveLength(0);
      expect(result.current.selfPresenceId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires nothing when disabled", () => {
    const harness = fakeSocket(okAck());
    mount(harness, { enabled: false });

    expect(harness.emitted).toHaveLength(0);
    expect(harness.onEvents()).toEqual([]);
  });

  it("wires nothing before the collaborative binding exists", () => {
    const harness = fakeSocket(okAck());
    mount(harness, { awarenessClientId: null });

    expect(harness.emitted).toHaveLength(0);
    expect(harness.onEvents()).toEqual([]);
  });

  it("waits for the room before announcing", () => {
    const harness = fakeSocket(okAck());
    mount(harness, { synced: false });

    // The gateway denies an announce from a socket that does not hold the note
    // room yet. Announcing on the socket's own `connect` event would race the
    // asynchronous Part 58 handshake and be refused every time.
    expect(harness.emitted).toHaveLength(0);
    expect(harness.onEvents()).toEqual([]);
  });

  it("re-announces once the room is re-joined after a reconnect", () => {
    const harness = fakeSocket(okAck());
    const view = mount(harness);

    expect(harness.frames(ANNOUNCE)).toHaveLength(1);

    // A drop: the server-side entry died with the old socket session, and the
    // provider goes back to reconnecting until its handshake lands again.
    act(() => {
      view.rerender({ synced: false });
    });
    expect(harness.frames(ANNOUNCE)).toHaveLength(1);

    act(() => {
      view.rerender({ synced: true });
    });
    expect(harness.frames(ANNOUNCE)).toHaveLength(2);
  });

  it("reports the count without names when the room is over the listing cap", () => {
    const harness = fakeSocket({ ok: false, error: "limited", viewerCount: 73 });
    const { result } = mount(harness);

    expect(result.current.viewers).toHaveLength(0);
    expect(result.current.viewerCount).toBe(73);
    expect(result.current.overflow).toBe(true);
    expect(result.current.selfPresenceId).toBeNull();
  });

  it("stays silent when the announce is refused", () => {
    const harness = fakeSocket({ ok: false, error: "denied" });
    const { result } = mount(harness);

    expect(result.current.viewers).toHaveLength(0);
    expect(result.current.viewerCount).toBe(0);
    expect(result.current.overflow).toBe(false);
  });

  it("drops a malformed ack without throwing", () => {
    const harness = fakeSocket({ ok: true, presence: null, viewers: "nope" });
    const { result } = mount(harness);

    expect(result.current.viewers).toHaveLength(0);
  });
});

describe("useNotePresence inbound frames", () => {
  it("applies a joined frame for this note", () => {
    const harness = fakeSocket(okAck());
    const { result } = mount(harness);

    act(() => {
      harness.fire(JOINED, {
        noteId: NOTE_ID,
        presence: viewerFrame({ presenceId: "p2", awarenessClientId: 12 }),
      });
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1", "p2"]);
  });

  it("drops a joined frame addressed to a different note", () => {
    const harness = fakeSocket(okAck());
    const { result } = mount(harness);

    // One socket serves every open note and Socket.io dispatches by event name,
    // so this well-formed frame really does reach this handler.
    act(() => {
      harness.fire(JOINED, {
        noteId: OTHER_NOTE_ID,
        presence: viewerFrame({ presenceId: "intruder", awarenessClientId: 99 }),
      });
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);
    expect(getPresenceRoster(OTHER_NOTE_ID).viewers).toHaveLength(0);
  });

  it("applies a left frame for this note", () => {
    const harness = fakeSocket(
      okAck([viewerFrame(), viewerFrame({ presenceId: "p2", awarenessClientId: 12 })]),
    );
    const { result } = mount(harness);

    act(() => {
      harness.fire(LEFT, { noteId: NOTE_ID, presenceId: "p2" });
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);
  });

  it("drops a left frame addressed to a different note", () => {
    const harness = fakeSocket(okAck());
    const { result } = mount(harness);

    act(() => {
      harness.fire(LEFT, { noteId: OTHER_NOTE_ID, presenceId: "p1" });
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);
  });

  it("drops malformed frames without throwing", () => {
    const harness = fakeSocket(okAck());
    const { result } = mount(harness);

    act(() => {
      harness.fire(JOINED, null);
      harness.fire(JOINED, { noteId: NOTE_ID });
      harness.fire(JOINED, { noteId: NOTE_ID, presence: { presenceId: "p9" } });
      harness.fire(JOINED, {
        noteId: NOTE_ID,
        presence: viewerFrame({ presenceId: 7, awarenessClientId: "twelve" }),
      });
      harness.fire(LEFT, undefined);
      harness.fire(LEFT, { noteId: NOTE_ID });
      harness.fire(LEFT, { noteId: NOTE_ID, presenceId: 12 });
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);
  });

  it("clamps a colour index that would fall off the palette", () => {
    const harness = fakeSocket(okAck([viewerFrame({ colorIndex: 900 })]));
    const { result } = mount(harness);

    expect(result.current.viewers[0]?.colorIndex).toBe(7);

    act(() => {
      harness.fire(JOINED, {
        noteId: NOTE_ID,
        presence: viewerFrame({ presenceId: "p2", awarenessClientId: 12, colorIndex: -5 }),
      });
    });

    expect(result.current.viewers.find((entry) => entry.presenceId === "p2")?.colorIndex).toBe(0);
  });
});

describe("useNotePresence teardown", () => {
  it("removes every listener it added and clears the roster", () => {
    const harness = fakeSocket(okAck());
    const { unmount } = mount(harness);

    expect(harness.onEvents().sort()).toEqual([JOINED, LEFT].sort());

    unmount();

    expect(harness.offEvents().sort()).toEqual(harness.onEvents().sort());
    expect(getPresenceRoster(NOTE_ID).viewers).toHaveLength(0);
  });

  it("emits no leave frame: the room leave and the server cleanup already cover it", () => {
    const harness = fakeSocket(okAck());
    const { unmount } = mount(harness);

    unmount();

    expect(harness.emitted.map((frame) => frame.event)).toEqual([ANNOUNCE]);
  });

  it("ignores a frame that arrives after unmount", () => {
    const harness = fakeSocket(okAck());
    const { unmount } = mount(harness);

    unmount();
    harness.fire(JOINED, {
      noteId: NOTE_ID,
      presence: viewerFrame({ presenceId: "late", awarenessClientId: 13 }),
    });

    expect(getPresenceRoster(NOTE_ID).viewers).toHaveLength(0);
  });
});
