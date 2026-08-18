"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { ApiRequestFailureKind, ApiRequestResult } from "@/lib/api/request-json";
import type { ExportJob, ExportStatus } from "@notted/shared-types";

import { requestExportJob } from "@/lib/api/export-requests";
import { exportQueryKeys } from "@/lib/exports/query-keys";

/*
 * Part 64 — the FIRST `refetchInterval` anywhere in this tree.
 *
 * Every other query here is fetched once and invalidated by a mutation or a
 * realtime frame. An export has no such signal: the render happens in a BullMQ
 * worker, so the browser has to ask. That makes this hook the place where the
 * rules a polling query needs are written down, because nothing else in the
 * codebase has had to answer them yet:
 *
 *  - it must stop on EVERY terminal status, not just `ready`;
 *  - it must back off, because a `zip` of a large note is not a 1s job;
 *  - it must stop asking eventually, so a stuck queue cannot spin a tab
 *    forever;
 *  - it must never be resurrected by a window focus.
 */

/** No further transition is possible from these; polling stops on all four. */
export const TERMINAL_EXPORT_STATUSES: readonly ExportStatus[] = Object.freeze([
  "ready",
  "failed",
  "expired",
  "cancelled",
]);

export function isTerminalExportStatus(status: ExportStatus): boolean {
  return TERMINAL_EXPORT_STATUSES.includes(status);
}

/**
 * Hard ceiling on how long one export is polled: 5 minutes.
 *
 * The API's own render timeout is `EXPORT_RENDER_TIMEOUT_MS` (30s by default),
 * and a job can wait in the queue behind other work before that clock even
 * starts. 5 minutes is comfortably above render + realistic queue latency while
 * still being a bound — past it the job is either stuck or the worker is down,
 * and neither is fixed by asking again every 5 seconds for the rest of the day.
 * Reaching the ceiling is reported as `timedOut`, NOT as failure: the job may
 * still complete, and the UI says so.
 */
export const EXPORT_POLL_CEILING_MS = 300_000;

/**
 * 1s → 2s → 5s.
 *
 * The first three polls land 1s apart, because a `txt`/`markdown` export of an
 * ordinary note is usually ready inside that window and a fast path is the
 * whole point. The next three are 2s apart, covering a `pdf` that has to boot a
 * renderer. Everything after that is 5s: past ~10s the job is queued behind
 * real work and a tighter interval only adds load without adding information.
 */
export function exportPollIntervalMs(completedPolls: number): number {
  if (completedPolls < 3) return 1_000;
  if (completedPolls < 6) return 2_000;
  return 5_000;
}

export interface ExportJobPoll {
  readonly job: ExportJob | null;
  readonly status: ExportStatus | null;
  /** True while the hook still intends to ask again. */
  readonly isPolling: boolean;
  /** The hard stop fired while the job was still unfinished. */
  readonly timedOut: boolean;
  /** Why the last poll failed, or `null`. `unavailable` does not stop polling. */
  readonly errorKind: ApiRequestFailureKind | null;
  /** Server-advised wait from the last `unavailable` failure, when it gave one. */
  readonly retryAfterMs: number | undefined;
  /** Restart the backoff and the ceiling, then poll immediately. */
  readonly retry: () => void;
}

export function useExportJob({
  workspaceId,
  exportId,
  enabled,
}: {
  readonly workspaceId: string;
  readonly exportId: string | null;
  /** False while the dialog is closed: a closed dialog must not hold a poll open. */
  readonly enabled: boolean;
}): ExportJobPoll {
  const polls = useRef(0);
  const [ceilingReached, setCeilingReached] = useState(false);
  // Bumped by `retry()` so the ceiling timer and the backoff both restart; a
  // plain state reset would not re-run the effect below.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    polls.current = 0;
    setCeilingReached(false);
    if (!enabled || exportId === null) return;
    const timer = setTimeout(() => setCeilingReached(true), EXPORT_POLL_CEILING_MS);
    return () => clearTimeout(timer);
  }, [enabled, exportId, attempt]);

  const query = useQuery({
    // The key is only reachable while `enabled` is true and `exportId` is a
    // real id, so the placeholder segment can never address a cached job.
    queryKey: exportQueryKeys.detail(workspaceId, exportId ?? "pending"),
    enabled: enabled && exportId !== null,
    // A poll that serves cache is not a poll.
    staleTime: 0,
    // Deliberately restated locally. `ReactQueryProvider` already defaults this
    // to false, but a future change to that default must not be able to start a
    // focus-triggered refetch on a query that is deciding its own cadence.
    refetchOnWindowFocus: false,
    // Failures are returned as data rather than thrown, so `refetchInterval`
    // below can read the failure `kind` and decide whether asking again could
    // ever help. It also keeps the provider's `retry: 1` out of the loop.
    retry: false,
    queryFn: async (): Promise<ApiRequestResult<ExportJob>> => {
      if (exportId === null) return { ok: false, kind: "invalid" };
      polls.current += 1;
      return requestExportJob(workspaceId, exportId);
    },
    refetchInterval: (poll) => {
      if (ceilingReached) return false;
      const result = poll.state.data;
      if (result === undefined) return exportPollIntervalMs(polls.current);
      if (!result.ok) {
        // Only an outage is worth repeating. A revoked grant or an unparsable
        // response fails identically forever, so the poll stops and the UI says
        // which one it was.
        if (result.kind !== "unavailable") return false;
        return Math.max(result.retryAfterMs ?? 0, exportPollIntervalMs(polls.current));
      }
      return isTerminalExportStatus(result.data.status)
        ? false
        : exportPollIntervalMs(polls.current);
    },
  });

  const result = query.data;
  const job = result?.ok === true ? result.data : null;
  const errorKind = result !== undefined && !result.ok ? result.kind : null;
  const finished = job !== null && isTerminalExportStatus(job.status);
  const stopped = finished || (errorKind !== null && errorKind !== "unavailable");
  return {
    job,
    status: job?.status ?? null,
    isPolling: enabled && exportId !== null && !stopped && !ceilingReached,
    timedOut: ceilingReached && !finished,
    errorKind,
    retryAfterMs: result !== undefined && !result.ok ? result.retryAfterMs : undefined,
    retry: () => {
      setAttempt((value) => value + 1);
      void query.refetch();
    },
  };
}
