import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestExportJob: vi.fn() }));
vi.mock("@/lib/api/export-requests", () => mocks);

import { EXPORT_POLL_CEILING_MS, useExportJob } from "./useExportJob";

import type { ExportJob, ExportStatus } from "@notted/shared-types";
import type { ReactNode } from "react";

const workspaceId = "50000000-0000-4000-8000-000000000001";
const exportId = "50000000-0000-4000-8000-000000000002";

function job(status: ExportStatus): ExportJob {
  return {
    id: exportId,
    workspaceId,
    requestedById: "50000000-0000-4000-8000-000000000003",
    format: "pdf",
    status,
    sourceType: "note",
    sourceId: "50000000-0000-4000-8000-000000000004",
    options: {
      includeAttachments: false,
      includeComments: false,
      includeVersionHistory: false,
      headerText: null,
      footerText: null,
      margins: null,
    },
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    completedAt: null,
    downloadExpiresAt: null,
    downloadPath: null,
  };
}

function mount(enabled = true) {
  // No `refetchOnWindowFocus` default here on purpose: TanStack's own default is
  // true, so a focus refetch is only prevented by the hook restating it locally.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return renderHook(() => useExportJob({ workspaceId, exportId, enabled }), { wrapper });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function calls(): number {
  return mocks.requestExportJob.mock.calls.length;
}

/**
 * Advance fake timers in small steps, flushing React between each, until
 * `done()` holds.
 *
 * A fixed `advance(1_000)` is NOT enough to observe a transition: the interval
 * callback fires the fetch, but the resolved promise and the re-render it causes
 * land on later microtask turns, so the hook is still reporting the PREVIOUS
 * status when the assertion runs. Stepping and re-checking flushes those turns.
 *
 * It throws rather than returning quietly, because a silent timeout here would
 * leave the terminal-status assertion passing against a stale value — the exact
 * failure mode this helper exists to remove.
 */
async function advanceUntil(done: () => boolean, budgetMs = 30_000): Promise<void> {
  const step = 250;
  for (let elapsed = 0; elapsed <= budgetMs; elapsed += step) {
    if (done()) return;
    await advance(step);
  }
  throw new Error(`condition still false after ${budgetMs}ms of fake time`);
}

describe("useExportJob", () => {
  beforeEach(() => {
    mocks.requestExportJob.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ready", "failed", "expired", "cancelled"] as const)(
    "stops polling once the job reaches %s",
    async (status) => {
      mocks.requestExportJob
        .mockResolvedValueOnce({ ok: true, data: job("processing") })
        .mockResolvedValue({ ok: true, data: job(status) });
      const { result } = mount();
      // First poll returns `processing`, so the hook is genuinely mid-flight
      // before the terminal one lands. Both transitions are observed.
      await advanceUntil(() => result.current.status === "processing", 5_000);
      expect(result.current.isPolling).toBe(true);

      await advanceUntil(() => result.current.status === status, 10_000);
      expect(result.current.status).toBe(status);
      expect(result.current.isPolling).toBe(false);

      // The reason this hook exists: nothing is asked again once the status is
      // terminal, for two full minutes of the widest (5s) interval.
      const settled = calls();
      await advance(120_000);
      expect(calls()).toBe(settled);
    },
  );

  it("backs off 1s, then 2s, then 5s while the job stays unfinished", async () => {
    mocks.requestExportJob.mockResolvedValue({ ok: true, data: job("processing") });
    mount();
    await advance(0);
    expect(calls()).toBe(1);
    await advance(1_000);
    expect(calls()).toBe(2);
    await advance(1_000);
    expect(calls()).toBe(3);
    // Third poll done: the interval widens to 2s, so 1s buys nothing.
    await advance(1_000);
    expect(calls()).toBe(3);
    await advance(1_000);
    expect(calls()).toBe(4);
    await advance(2_000);
    expect(calls()).toBe(5);
    await advance(2_000);
    expect(calls()).toBe(6);
    // Sixth poll done: 5s thereafter.
    await advance(4_000);
    expect(calls()).toBe(6);
    await advance(1_000);
    expect(calls()).toBe(7);
  });

  it("never polls while it is disabled", async () => {
    mocks.requestExportJob.mockResolvedValue({ ok: true, data: job("processing") });
    const { result } = mount(false);
    await advance(30_000);
    expect(calls()).toBe(0);
    expect(result.current.isPolling).toBe(false);
    expect(result.current.job).toBeNull();
  });

  it("stops at the five-minute ceiling and reports it as timed out, not failed", async () => {
    mocks.requestExportJob.mockResolvedValue({ ok: true, data: job("processing") });
    const { result } = mount();
    await advance(EXPORT_POLL_CEILING_MS);
    expect(result.current.timedOut).toBe(true);
    expect(result.current.isPolling).toBe(false);
    expect(result.current.errorKind).toBeNull();
    const stopped = calls();
    await advance(120_000);
    expect(calls()).toBe(stopped);
  });

  it("does not refetch on window focus", async () => {
    mocks.requestExportJob.mockResolvedValue({ ok: true, data: job("ready") });
    mount();
    await advance(0);
    expect(calls()).toBe(1);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls()).toBe(1);
    focusManager.setFocused(undefined);
  });
});
