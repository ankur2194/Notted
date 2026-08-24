"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { streamAi } from "./stream";

import type { AiStreamHandle } from "./stream";

/**
 * Part 68 — the AI panel's state machine over a single {@link streamAi} run.
 *
 * The panel never applies a generation on its own: a finished run lands in
 * `preview`, where the author reads it and chooses insert, replace, regenerate,
 * or discard. That is the whole reason this is a four-state machine rather than
 * a loading boolean — "streaming" and "there is text you have not accepted yet"
 * are different situations with different controls.
 *
 * ONE RUN AT A TIME, and regenerate depends on it. `start` aborts whatever is in
 * flight before it begins, and every callback is stamped with the run that
 * registered it, so a delta still in the queue from the abandoned request can
 * never append itself to the new one's text.
 */

export type AiStreamPhase = "idle" | "streaming" | "preview" | "error";

export interface UseAiStreamResult {
  readonly phase: AiStreamPhase;
  /** Accumulated deltas. Non-empty in `streaming` and `preview`. */
  readonly text: string;
  /** User-facing copy; non-null only in `error`. */
  readonly error: string | null;
  readonly promptVersion: string | null;
  /** Aborts any run in flight, clears state, then starts a new one. */
  start: (path: string, body: unknown) => void;
  /** Abort an in-flight run and return to `idle`, keeping nothing. */
  cancel: () => void;
  /** Discard a finished preview or error and return to `idle`. */
  dismiss: () => void;
}

export function useAiStream(): UseAiStreamResult {
  const [phase, setPhase] = useState<AiStreamPhase>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [promptVersion, setPromptVersion] = useState<string | null>(null);

  const mounted = useRef(true);
  const runId = useRef(0);
  const handle = useRef<AiStreamHandle | null>(null);
  const pending = useRef("");
  const scheduled = useRef(false);

  /**
   * Move the buffered deltas into state.
   *
   * A token is a handful of characters, so a `setState` per delta re-renders the
   * whole panel dozens of times a second for text the browser paints once a
   * frame anyway. Buffering in a ref and flushing on the frame keeps the
   * rendered result identical at a fraction of the work.
   */
  const flush = useCallback(() => {
    scheduled.current = false;
    const next = pending.current;
    if (next === "" || !mounted.current) return;
    pending.current = "";
    setText((current) => current + next);
  }, []);

  /** Abandon the current run: nothing it still emits may touch state. */
  const stop = useCallback(() => {
    runId.current += 1;
    handle.current?.abort();
    handle.current = null;
    pending.current = "";
  }, []);

  const start = useCallback(
    (path: string, body: unknown) => {
      stop();
      const id = runId.current;
      const current = (): boolean => mounted.current && runId.current === id;

      pending.current = "";
      setText("");
      setError(null);
      setPromptVersion(null);
      setPhase("streaming");

      handle.current = streamAi(path, body, {
        onDelta: (delta) => {
          if (!current()) return;
          pending.current += delta;
          // Some test environments (and any non-browser render) have no frame
          // clock; a direct flush there keeps the hook behaviour identical.
          if (typeof requestAnimationFrame === "undefined") {
            flush();
            return;
          }
          // The flag is raised BEFORE the request, not from its return value: a
          // frame callback that runs synchronously would otherwise be undone by
          // the assignment that follows it, and no later delta would schedule.
          if (!scheduled.current) {
            scheduled.current = true;
            requestAnimationFrame(flush);
          }
        },
        onDone: (info) => {
          if (!current()) return;
          // Before the phase changes, so `preview` never shows text missing its
          // last unflushed tokens.
          flush();
          handle.current = null;
          setPromptVersion(info.promptVersion);
          setPhase("preview");
        },
        onError: (message) => {
          if (!current()) return;
          flush();
          handle.current = null;
          setError(message);
          setPhase("error");
        },
      });
    },
    [flush, stop],
  );

  /**
   * `cancel` and `dismiss` are the same operation and share one implementation:
   * both end at `idle` holding nothing, and aborting a run that already finished
   * is a no-op. They stay two names because they are two different things to
   * label a button — "Stop" while streaming, "Discard" over a preview.
   */
  const reset = useCallback(() => {
    stop();
    setText("");
    setError(null);
    setPromptVersion(null);
    setPhase("idle");
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      handle.current?.abort();
      handle.current = null;
    };
  }, []);

  return { phase, text, error, promptVersion, start, cancel: reset, dismiss: reset };
}
