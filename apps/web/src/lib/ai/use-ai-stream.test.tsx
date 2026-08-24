import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ streamAi: vi.fn() }));
vi.mock("./stream", () => mocks);

import { useAiStream } from "./use-ai-stream";

import type { AiStreamCallbacks } from "./stream";

/**
 * `streamAi` is replaced wholesale: its own suite already proves the parsing,
 * and what this hook owns is the state machine around it — which run's
 * callbacks are still allowed to speak, and when the buffered text lands.
 */
interface Run {
  readonly callbacks: AiStreamCallbacks;
  readonly abort: ReturnType<typeof vi.fn>;
}

const runs: Run[] = [];

function run(index: number): Run {
  const entry = runs[index];
  if (entry === undefined) throw new Error(`no stream was started at index ${index}`);
  return entry;
}

const doneInfo = { promptVersion: "summarize.v1", promptTokens: 10, completionTokens: 4 };

describe("useAiStream", () => {
  beforeEach(() => {
    runs.length = 0;
    mocks.streamAi.mockImplementation(
      (_path: string, _body: unknown, callbacks: AiStreamCallbacks) => {
        const abort = vi.fn();
        runs.push({ callbacks, abort });
        return { abort };
      },
    );
    // Synchronous frames keep the assertions about *what* is rendered free of
    // assertions about *when*; the no-frame-clock path is covered separately.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("advances idle -> streaming -> preview and keeps the prompt version", () => {
    const { result } = renderHook(() => useAiStream());
    expect(result.current.phase).toBe("idle");
    expect(result.current.text).toBe("");

    act(() => result.current.start("/ai/summarize", { noteId: "n" }));
    expect(result.current.phase).toBe("streaming");
    expect(mocks.streamAi).toHaveBeenCalledWith(
      "/ai/summarize",
      { noteId: "n" },
      expect.anything(),
    );

    act(() => {
      run(0).callbacks.onDelta("Hello ");
      run(0).callbacks.onDelta("world");
    });
    expect(result.current.text).toBe("Hello world");
    expect(result.current.phase).toBe("streaming");

    act(() => run(0).callbacks.onDone(doneInfo));
    expect(result.current.phase).toBe("preview");
    expect(result.current.text).toBe("Hello world");
    expect(result.current.promptVersion).toBe("summarize.v1");
    expect(result.current.error).toBeNull();
  });

  it("flushes buffered text before the phase changes, so a preview is never short", () => {
    // A frame that never arrives: the delta is still sitting in the buffer when
    // the stream finishes, which is exactly the race the flush-first exists for.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));

    act(() => run(0).callbacks.onDelta("kept"));
    expect(result.current.text).toBe("");

    act(() => run(0).callbacks.onDone(doneInfo));
    expect(result.current.text).toBe("kept");
    expect(result.current.phase).toBe("preview");
  });

  it("appends directly when the environment has no frame clock", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    act(() => run(0).callbacks.onDelta("no raf"));
    expect(result.current.text).toBe("no raf");
  });

  it("aborts the previous run on restart and ignores anything it still emits", () => {
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    act(() => run(0).callbacks.onDelta("first"));

    act(() => result.current.start("/ai/summarize", {}));
    expect(run(0).abort).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("streaming");
    // Regenerate depends on this: the abandoned run's text is gone, and a late
    // delta from it cannot append itself to the replacement.
    expect(result.current.text).toBe("");

    act(() => {
      run(0).callbacks.onDelta(" stale");
      run(0).callbacks.onDone({ ...doneInfo, promptVersion: "stale.v1" });
    });
    expect(result.current.text).toBe("");
    expect(result.current.phase).toBe("streaming");

    act(() => run(1).callbacks.onDelta("second"));
    expect(result.current.text).toBe("second");
  });

  it("moves to error with the copy the stream supplied", () => {
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    act(() => run(0).callbacks.onError("AI is unavailable right now. Try again shortly."));

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("AI is unavailable right now. Try again shortly.");
    expect(result.current.promptVersion).toBeNull();
  });

  it("cancel aborts an in-flight run and returns to idle holding nothing", () => {
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    act(() => run(0).callbacks.onDelta("partial"));

    act(() => result.current.cancel());
    expect(run(0).abort).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("dismiss discards a finished preview", () => {
    const { result } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    act(() => {
      run(0).callbacks.onDelta("draft");
      run(0).callbacks.onDone(doneInfo);
    });

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.promptVersion).toBeNull();
  });

  it("keeps start, cancel, and dismiss stable so callers may depend on them", () => {
    const { result, rerender } = renderHook(() => useAiStream());
    const first = result.current;
    rerender();
    expect(result.current.start).toBe(first.start);
    expect(result.current.cancel).toBe(first.cancel);
    expect(result.current.dismiss).toBe(first.dismiss);
  });

  it("aborts an in-flight run when the panel unmounts", () => {
    const { result, unmount } = renderHook(() => useAiStream());
    act(() => result.current.start("/ai/summarize", {}));
    unmount();
    expect(run(0).abort).toHaveBeenCalledTimes(1);
  });
});
