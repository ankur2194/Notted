import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPresenceJoined,
  applyPresenceLeft,
  clearPresence,
  EMPTY_PRESENCE_ROSTER,
  getPresenceRoster,
  PRESENCE_ROSTER_MAX,
  setPresenceRoster,
  subscribeToPresence,
  usePresence,
} from "./presence-store";

import type { PresenceViewer } from "./presence-store";

/**
 * The roster, proven without a socket.
 *
 * The store is module-level state, so every test clears both notes afterwards;
 * a leaked roster would make the next test's assertions depend on file order.
 */

const NOTE_A = "00000000-0000-4000-8000-00000000000a";
const NOTE_B = "00000000-0000-4000-8000-00000000000b";

function viewer(overrides: Partial<PresenceViewer> & { presenceId: string }): PresenceViewer {
  return {
    userId: `user-${overrides.presenceId}`,
    colorIndex: 0,
    awarenessClientId: 1,
    ...overrides,
  };
}

afterEach(() => {
  clearPresence(NOTE_A);
  clearPresence(NOTE_B);
});

describe("presence roster", () => {
  it("returns the shared empty singleton for an unknown note", () => {
    expect(getPresenceRoster(NOTE_A)).toBe(EMPTY_PRESENCE_ROSTER);
  });

  it("adds a joined viewer", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewers).toHaveLength(1);
    expect(roster.viewerCount).toBe(1);
    expect(roster.overflow).toBe(false);
  });

  it("removes a viewer on leave", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p2", awarenessClientId: 12 }));
    applyPresenceLeft(NOTE_A, "p1");

    expect(getPresenceRoster(NOTE_A).viewers.map((entry) => entry.presenceId)).toEqual(["p2"]);
    expect(getPresenceRoster(NOTE_A).viewerCount).toBe(1);
  });

  it("replaces an entry with the same presenceId instead of duplicating it", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 99, colorIndex: 3 }));

    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewers).toHaveLength(1);
    expect(roster.viewerCount).toBe(1);
    expect(roster.viewers[0]?.colorIndex).toBe(3);
    expect(roster.viewers[0]?.awarenessClientId).toBe(99);
  });

  it("drops a stale entry that kept the same awarenessClientId after an epoch reset", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "old", awarenessClientId: 11 }));
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "new", awarenessClientId: 11 }));

    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewers.map((entry) => entry.presenceId)).toEqual(["new"]);
    expect(roster.viewerCount).toBe(1);
  });

  it("sorts viewers by presenceId regardless of arrival order", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "c", awarenessClientId: 3 }));
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "a", awarenessClientId: 1 }));
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "b", awarenessClientId: 2 }));

    expect(getPresenceRoster(NOTE_A).viewers.map((entry) => entry.presenceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("caps the listed viewers but keeps counting past the cap", () => {
    for (let index = 0; index < PRESENCE_ROSTER_MAX + 1; index += 1) {
      applyPresenceJoined(
        NOTE_A,
        viewer({ presenceId: `p${String(index).padStart(3, "0")}`, awarenessClientId: index }),
      );
    }

    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewers).toHaveLength(PRESENCE_ROSTER_MAX);
    expect(roster.viewerCount).toBe(PRESENCE_ROSTER_MAX + 1);
    expect(roster.overflow).toBe(true);
  });

  it("clears overflow once the hidden viewer is accounted for", () => {
    for (let index = 0; index < PRESENCE_ROSTER_MAX + 1; index += 1) {
      applyPresenceJoined(
        NOTE_A,
        viewer({ presenceId: `p${String(index).padStart(3, "0")}`, awarenessClientId: index }),
      );
    }

    // A listed viewer leaving shrinks both numbers: the hidden tail is still
    // there, so the badge stays.
    applyPresenceLeft(NOTE_A, "p000");
    expect(getPresenceRoster(NOTE_A).viewers).toHaveLength(PRESENCE_ROSTER_MAX - 1);
    expect(getPresenceRoster(NOTE_A).overflow).toBe(true);

    // The hidden viewer's departure arrives as an id we never listed. It is the
    // only signal that the tail shrank, so it clears the badge.
    applyPresenceLeft(NOTE_A, "never-listed");
    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewerCount).toBe(roster.viewers.length);
    expect(roster.overflow).toBe(false);
  });

  it("keeps rosters separate per note", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    expect(getPresenceRoster(NOTE_B)).toBe(EMPTY_PRESENCE_ROSTER);
    expect(getPresenceRoster(NOTE_B).viewers).toHaveLength(0);

    applyPresenceJoined(NOTE_B, viewer({ presenceId: "p2", awarenessClientId: 22 }));

    expect(getPresenceRoster(NOTE_A).viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);
    expect(getPresenceRoster(NOTE_B).viewers.map((entry) => entry.presenceId)).toEqual(["p2"]);
  });

  it("returns a referentially stable snapshot between mutations", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    const first = getPresenceRoster(NOTE_A);
    expect(getPresenceRoster(NOTE_A)).toBe(first);

    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p2", awarenessClientId: 12 }));

    expect(getPresenceRoster(NOTE_A)).not.toBe(first);
  });

  it("ignores a leave for an unknown presenceId without notifying", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    const listener = vi.fn();
    const unsubscribe = subscribeToPresence(NOTE_A, listener);
    const before = getPresenceRoster(NOTE_A);

    applyPresenceLeft(NOTE_A, "ghost");

    expect(listener).not.toHaveBeenCalled();
    expect(getPresenceRoster(NOTE_A)).toBe(before);
    unsubscribe();
  });

  it("does not notify a listener subscribed to a different note", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPresence(NOTE_B, listener);

    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("clears a roster and notifies", () => {
    setPresenceRoster(NOTE_A, {
      viewers: [viewer({ presenceId: "p1", awarenessClientId: 11 })],
      selfPresenceId: "p1",
      viewerCount: 1,
      overflow: false,
    });

    const listener = vi.fn();
    const unsubscribe = subscribeToPresence(NOTE_A, listener);

    clearPresence(NOTE_A);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPresenceRoster(NOTE_A)).toBe(EMPTY_PRESENCE_ROSTER);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    subscribeToPresence(NOTE_A, listener)();

    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the server's overflow flag and floors the count at the listed rows", () => {
    setPresenceRoster(NOTE_A, {
      viewers: [],
      selfPresenceId: null,
      viewerCount: 120,
      overflow: true,
    });

    const roster = getPresenceRoster(NOTE_A);
    expect(roster.viewers).toHaveLength(0);
    expect(roster.viewerCount).toBe(120);
    expect(roster.overflow).toBe(true);
  });

  it("writes nothing to browser storage", () => {
    applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("usePresence", () => {
  it("re-renders when the store changes outside React", () => {
    const { result } = renderHook(() => usePresence(NOTE_A));

    expect(result.current).toBe(EMPTY_PRESENCE_ROSTER);

    act(() => {
      applyPresenceJoined(NOTE_A, viewer({ presenceId: "p1", awarenessClientId: 11 }));
    });

    expect(result.current.viewers.map((entry) => entry.presenceId)).toEqual(["p1"]);

    act(() => {
      clearPresence(NOTE_A);
    });

    expect(result.current).toBe(EMPTY_PRESENCE_ROSTER);
  });

  it("only observes its own note", () => {
    const { result } = renderHook(() => usePresence(NOTE_A));

    act(() => {
      applyPresenceJoined(NOTE_B, viewer({ presenceId: "p2", awarenessClientId: 22 }));
    });

    expect(result.current).toBe(EMPTY_PRESENCE_ROSTER);
  });
});
