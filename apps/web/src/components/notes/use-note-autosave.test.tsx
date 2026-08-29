import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateNote: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => ({ updateNote: mocks.updateNote }));

import { useNoteAutosave } from "./useNoteAutosave";

import type { PageSize } from "@notted/shared-types";
import type { NoteDocument } from "@notted/shared-validators";

import { AUTOSAVE_DEBOUNCE_MS } from "@/lib/notes/autosave-machine";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";

function doc(text: string): NoteDocument {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function ok(version: number, pageSize: PageSize = "a4") {
  return { ok: true, data: { note: { version, pageSize } } };
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function mount(options: { canUpdate?: boolean; version?: number; pageSize?: PageSize } = {}) {
  return renderHook(
    (props: { version: number; pageSize: PageSize }) =>
      useNoteAutosave({
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        initialVersion: props.version,
        initialPageSize: props.pageSize,
        canUpdate: options.canUpdate ?? true,
      }),
    { initialProps: { version: options.version ?? 3, pageSize: options.pageSize ?? "a4" } },
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useNoteAutosave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.updateNote.mockResolvedValue(ok(4));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid typing into a single request and adopts the returned version", async () => {
    const { result } = mount();
    act(() => {
      result.current.onDocumentChange(doc("h"));
      result.current.onDocumentChange(doc("he"));
      result.current.onDocumentChange(doc("hello"));
    });
    expect(mocks.updateNote).not.toHaveBeenCalled();
    expect(result.current.status).toBe("dirty");

    await advance(AUTOSAVE_DEBOUNCE_MS);

    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, content: doc("hello") },
      { keepalive: false },
    );
    expect(result.current.status).toBe("saved");
    expect(result.current.version).toBe(4);
    expect(result.current.hasUnsavedWork).toBe(false);
  });

  it("keeps one request on the wire while a slow response is outstanding", async () => {
    const slow = deferred<unknown>();
    mocks.updateNote.mockReturnValueOnce(slow.promise);
    const { result } = mount();

    act(() => result.current.onDocumentChange(doc("first")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    act(() => result.current.onDocumentChange(doc("first and second")));
    await advance(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saving");

    await act(async () => {
      slow.resolve(ok(4));
      await slow.promise;
    });
    await advance(AUTOSAVE_DEBOUNCE_MS);

    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    expect(mocks.updateNote).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 4, content: doc("first and second") },
      { keepalive: false },
    );
  });

  it("retries a transient failure on a backoff timer and then recovers", async () => {
    mocks.updateNote.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    mocks.updateNote.mockResolvedValueOnce(ok(4));
    const { result } = mount();

    act(() => result.current.onDocumentChange(doc("draft")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(result.current.status).toBe("retrying");
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("saved");
  });

  it("waits the server-advised delay when one is supplied", async () => {
    mocks.updateNote.mockResolvedValueOnce({
      ok: false,
      kind: "unavailable",
      retryable: true,
      retryAfterMs: 5_000,
    });
    const { result } = mount();

    act(() => result.current.onDocumentChange(doc("draft")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    await advance(4_000);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
  });

  it("flushes with a keepalive request when the document becomes hidden", async () => {
    const { result } = mount();
    act(() => result.current.onDocumentChange(doc("half written")));
    expect(mocks.updateNote).not.toHaveBeenCalled();

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();

    // Immediately, without waiting out the debounce, and marked so the browser
    // may finish it after the page goes away.
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, content: doc("half written") },
      { keepalive: true },
    );
  });

  it("ignores a visibility change back to visible", async () => {
    const { result } = mount();
    act(() => result.current.onDocumentChange(doc("half written")));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("asks for the browser's leave prompt only while something is unacknowledged", async () => {
    const { result } = mount();

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    act(() => result.current.onDocumentChange(doc("draft")));
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    await advance(AUTOSAVE_DEBOUNCE_MS);
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });

  /*
   * In collaborative mode this machine is deliberately unbound: it never
   * receives a `document-changed`, so it reports "nothing pending" while the tab
   * holds unsent Yjs updates that exist only in memory — under a status line
   * telling the writer they will sync. The probe is how the other writer's work
   * reaches the one `beforeunload` guard the app has.
   *
   * The machine stays idle for the whole test, so the probe is provably the only
   * thing that can arm the prompt.
   */
  it("asks for the leave prompt while a collaborative session holds unacknowledged work", () => {
    const { result } = mount();
    let unsent = false;

    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    let unregister = () => undefined as void;
    act(() => {
      unregister = result.current.registerUnsavedWorkProbe(() => unsent);
    });

    const stillClean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(stillClean);
    expect(stillClean.defaultPrevented).toBe(false);

    unsent = true;
    const holding = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(holding);
    expect(holding.defaultPrevented).toBe(true);

    unsent = false;
    const flushed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(flushed);
    expect(flushed.defaultPrevented).toBe(false);

    // A withdrawn probe must stop speaking for an editor that has unmounted.
    unsent = true;
    act(() => unregister());
    const withdrawn = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(withdrawn);
    expect(withdrawn.defaultPrevented).toBe(false);
  });

  it("queues while offline and resumes when the connection returns", async () => {
    const { result } = mount();
    act(() => {
      window.dispatchEvent(new Event("offline"));
      result.current.onDocumentChange(doc("written on a train"));
    });
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(mocks.updateNote).not.toHaveBeenCalled();
    expect(result.current.status).toBe("offline");
    expect(result.current.hasUnsavedWork).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saved");
  });

  it("starts offline when the browser already reports no connection", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = mount();
    act(() => result.current.onDocumentChange(doc("draft")));
    await advance(AUTOSAVE_DEBOUNCE_MS);

    expect(mocks.updateNote).not.toHaveBeenCalled();
    expect(result.current.status).toBe("offline");
    online.mockRestore();
  });

  it("offers reload on a version conflict and refreshes the server render", async () => {
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    const { result } = mount();
    act(() => result.current.onDocumentChange(doc("mine")));
    await advance(AUTOSAVE_DEBOUNCE_MS);

    expect(result.current.status).toBe("conflict");
    expect(result.current.description.canReload).toBe(true);

    act(() => result.current.retry());
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    // A retry must never resolve a conflict: that is the overwrite.
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-seeds from a newer server render and drops the stale queue", async () => {
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    const { result, rerender } = mount();
    act(() => result.current.onDocumentChange(doc("mine")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(result.current.status).toBe("conflict");

    mocks.updateNote.mockResolvedValue(ok(10));
    rerender({ version: 9, pageSize: "a4" });
    expect(result.current.status).toBe("idle");
    expect(result.current.version).toBe(9);
    expect(result.current.hasUnsavedWork).toBe(false);

    act(() => result.current.onDocumentChange(doc("rewritten")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(mocks.updateNote).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 9, content: doc("rewritten") },
      { keepalive: false },
    );
  });

  it("sends a page-size change immediately and coalesces pending text into it", async () => {
    mocks.updateNote.mockResolvedValue(ok(4, "letter"));
    const { result } = mount();

    act(() => {
      result.current.onDocumentChange(doc("body"));
      result.current.requestPageSize("letter");
    });

    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, content: doc("body"), pageSize: "letter" },
      { keepalive: false },
    );
  });

  it("writes nothing at all without edit permission", async () => {
    const { result } = mount({ canUpdate: false });
    act(() => {
      result.current.onDocumentChange(doc("draft"));
      result.current.requestPageSize("letter");
    });
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("surfaces a contract rejection from the editor instead of going quiet", () => {
    const { result } = mount();
    act(() => result.current.onDocumentRejected(true));
    expect(result.current.documentRejected).toBe(true);
    act(() => result.current.onDocumentRejected(false));
    expect(result.current.documentRejected).toBe(false);
  });

  it("removes every listener and timer it registered when it unmounts", async () => {
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const { unmount } = mount();

    unmount();

    const removedFromWindow = windowRemove.mock.calls.map(([name]) => name);
    expect(removedFromWindow).toEqual(
      expect.arrayContaining(["online", "offline", "beforeunload"]),
    );
    expect(documentRemove.mock.calls.map(([name]) => name)).toContain("visibilitychange");

    // Nothing was queued, so teardown is silent rather than issuing a write.
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(mocks.updateNote).not.toHaveBeenCalled();

    windowRemove.mockRestore();
    documentRemove.mockRestore();
  });

  it("flushes a pending patch when an in-app navigation unmounts the page", async () => {
    const { result, unmount } = mount();
    act(() => result.current.onDocumentChange(doc("half written")));
    expect(mocks.updateNote).not.toHaveBeenCalled();

    // A client-side route change fires neither `beforeunload` nor
    // `visibilitychange`, so an un-elapsed debounce would take the writing
    // with it.
    unmount();

    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, content: doc("half written") },
      { keepalive: true },
    );

    // The debounce timer is still cancelled, so it cannot fire a second write.
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
  });

  it("does not re-send a patch that is already on the wire when it unmounts", async () => {
    const slow = deferred<unknown>();
    mocks.updateNote.mockReturnValueOnce(slow.promise);
    const { result, unmount } = mount();

    act(() => result.current.onDocumentChange(doc("draft")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    slow.resolve(ok(4));
  });

  /**
   * CHARACTERIZATION TEST OF A KNOWN LIMITATION — this asserts what the code
   * does today, not what it ought to do. See "Known Limitations" in
   * `docs/completed-parts/part-39-reliable-save.md`.
   *
   * The unmount flush goes through `canSaveNow`, which requires
   * `inFlight === null`. So text typed *while* a save is on the wire is dropped
   * when an in-app navigation unmounts the page, and client-side routing fires
   * no `beforeunload` to warn about it.
   *
   * A naive re-send is not the fix: the in-flight save will bump `version`, so
   * the second write would be issued under a stale `expectedVersion` and 409.
   * The Plan's invariant — never lose *acknowledged* content — still holds,
   * because the dropped patch was never acknowledged.
   */
  it("characterizes a known limitation: drops a patch queued behind an in-flight save on unmount", async () => {
    const slow = deferred<unknown>();
    mocks.updateNote.mockReturnValueOnce(slow.promise);
    const { result, unmount } = mount();

    act(() => result.current.onDocumentChange(doc("first")));
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    // Newer text, typed before the first save answered.
    act(() => result.current.onDocumentChange(doc("first and second")));
    expect(result.current.status).toBe("saving");
    expect(result.current.hasUnsavedWork).toBe(true);

    unmount();

    // No second request: the flush refuses to issue one while a save is open.
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, content: doc("first") },
      { keepalive: false },
    );

    slow.resolve(ok(4));
    await advance(AUTOSAVE_DEBOUNCE_MS * 4);
    // And the late acknowledgement cannot revive it either: the machine is gone.
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);
  });
});
