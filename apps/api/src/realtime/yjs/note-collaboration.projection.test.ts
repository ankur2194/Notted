import { describe, expect, it, vi } from "vitest";

import { NoteCollaborationProjectionService } from "./note-collaboration.projection";

import type { NoteCollaborationService } from "./note-collaboration.service";
import type { StructuredLogger } from "../../common/logging/structured-logger.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";

function harness(project: ReturnType<typeof vi.fn>): NoteCollaborationProjectionService {
  const logger = {
    info: vi.fn(),
    warning: vi.fn(),
    failure: vi.fn(),
  } as unknown as StructuredLogger;
  return new NoteCollaborationProjectionService(
    { project } as unknown as NoteCollaborationService,
    logger,
  );
}

describe("NoteCollaborationProjectionService shutdown", () => {
  /*
   * ADR 0004: "A pending projection is flushed on graceful shutdown rather than
   * discarded, because a note nobody reopens would otherwise keep a stale
   * projection indefinitely."
   *
   * The class did the opposite — it cleared its timers and dropped the work —
   * and justified it with an inverted claim about Nest's lifecycle. Nest's real
   * order is `onModuleDestroy` -> `beforeApplicationShutdown` -> `dispose` ->
   * `onApplicationShutdown`, so flushing in `beforeApplicationShutdown` runs
   * while `DatabaseService` (now closing at `onApplicationShutdown`) still has
   * its pool open.
   */
  it("flushes a pending projection instead of dropping it", async () => {
    const project = vi.fn().mockResolvedValue(undefined);
    const service = harness(project);

    service.schedule({ workspaceId: WORKSPACE_ID, noteId: NOTE_ID, forcedBoundary: true });
    expect(project).not.toHaveBeenCalled();

    await service.beforeApplicationShutdown();

    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: NOTE_ID, forcedBoundary: true }),
    );
  });

  /** The hook must await the work, not merely start it before the pool closes. */
  it("does not resolve until every pending projection has settled", async () => {
    let settled = false;
    const project = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10);
        }),
    );
    const service = harness(project);
    service.schedule({ workspaceId: WORKSPACE_ID, noteId: NOTE_ID, forcedBoundary: false });

    await service.beforeApplicationShutdown();

    expect(settled).toBe(true);
  });

  /** One failing note must not strand the others. */
  it("flushes the remaining notes when one projection rejects", async () => {
    const project = vi.fn(async (input: { readonly noteId: string }) => {
      if (input.noteId === NOTE_ID) throw new Error("projection failed");
    });
    const service = harness(project);
    service.schedule({ workspaceId: WORKSPACE_ID, noteId: NOTE_ID, forcedBoundary: false });
    service.schedule({
      workspaceId: WORKSPACE_ID,
      noteId: "33333333-0000-4000-8000-000000000003",
      forcedBoundary: false,
    });

    await expect(service.beforeApplicationShutdown()).resolves.toBeUndefined();
    expect(project).toHaveBeenCalledTimes(2);
  });
});
