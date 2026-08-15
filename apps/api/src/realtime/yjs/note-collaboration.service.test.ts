import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createTenantContext, TenantContextService } from "../../tenant";

import { NoteCollaborationService } from "./note-collaboration.service";
import { noteDocumentToYDoc } from "./note-yjs-document";

const workspaceId = "40000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "40000000-0000-4000-8000-000000000002";
const noteId = "40000000-0000-4000-8500-000000000003";
const userId = "40000000-0000-4000-8000-000000000004";

const document = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};
const snapshot = Y.encodeStateAsUpdate(noteDocumentToYDoc(document));

/** A real Yjs update, so the service's decode guard exercises the real decoder. */
function realUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  const element = new Y.XmlElement("paragraph");
  doc.getXmlFragment("default").insert(0, [element]);
  const inner = new Y.XmlText();
  element.insert(0, [inner]);
  inner.insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

const noteRow = {
  id: noteId,
  title: "Launch overview",
  content: document,
  contentPlain: "hello",
  version: 5,
  updatedById: userId,
  createdById: userId,
};

const state = {
  noteId,
  epoch: 3,
  lastRevision: 2,
  projectedRevision: 1,
  projectedNoteVersion: 5,
  schemaVersion: 1,
  stateBytes: snapshot.byteLength,
};

const records = [
  { kind: "snapshot" as const, revision: 1, payload: snapshot, createdById: userId },
  { kind: "update" as const, revision: 2, payload: realUpdate("hello"), createdById: userId },
];

type Mocked = Record<string, ReturnType<typeof vi.fn>>;

function harness(options: {
  readonly noteRows?: readonly unknown[];
  readonly updateRows?: readonly unknown[];
  readonly repository?: Mocked;
}) {
  const repository: Mocked = {
    loadState: vi.fn().mockResolvedValue(state),
    allocateRevision: vi.fn().mockResolvedValue(null),
    appendUpdate: vi.fn().mockResolvedValue(undefined),
    loadEpochRecords: vi.fn().mockResolvedValue(records),
    markProjected: vi.fn().mockResolvedValue(true),
    writeSnapshotAndPrune: vi.fn().mockResolvedValue(null),
    resetEpoch: vi.fn().mockResolvedValue(true),
    lastCheckpointAt: vi.fn().mockResolvedValue(null),
    hasCheckpoint: vi.fn().mockResolvedValue(false),
    ...options.repository,
  };
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([...(options.noteRows ?? [noteRow])]) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([...(options.updateRows ?? [])]) }),
      }),
    }),
  };
  const rollbacks: unknown[] = [];
  const database = {
    transaction: async (work: (value: unknown) => Promise<unknown>) => {
      try {
        return await work(tx);
      } catch (error: unknown) {
        rollbacks.push(error);
        throw error;
      }
    },
  };
  const tenant = new TenantContextService();
  const noteVersions = { recordAcceptedState: vi.fn().mockResolvedValue(undefined) };
  const search = { scheduleSearchSync: vi.fn().mockResolvedValue(undefined) };
  const rooms = { room: vi.fn().mockReturnValue("room"), emit: vi.fn() };
  const service = new NoteCollaborationService(
    database as never,
    repository as never,
    tenant,
    noteVersions as never,
    search as never,
    rooms as never,
    { info: vi.fn(), warn: vi.fn(), warning: vi.fn() } as never,
    { maxCollaborationStateBytes: 4_194_304 } as never,
  );
  return { service, tenant, tx, repository, noteVersions, search, rooms, rollbacks };
}

describe("NoteCollaborationService.applyUpdate", () => {
  it("rejects a stale epoch so the client discards its doc and re-syncs", async () => {
    const test = harness({
      repository: { loadState: vi.fn().mockResolvedValue({ ...state, epoch: 9 }) },
    });
    await expect(
      test.service.applyUpdate({
        workspaceId,
        noteId,
        epoch: 3,
        update: realUpdate("a"),
        actorId: userId,
      }),
    ).resolves.toEqual({ ok: false, error: "stale" });
    expect(test.repository.appendUpdate).not.toHaveBeenCalled();
  });

  it("reports the size ceiling separately from a stale epoch", async () => {
    // Same zero-row allocation, same follow-up read — only whether the epoch
    // still agrees separates "your generation is gone" from "this note is full".
    const test = harness({});
    await expect(
      test.service.applyUpdate({
        workspaceId,
        noteId,
        epoch: 3,
        update: realUpdate("a"),
        actorId: userId,
      }),
    ).resolves.toEqual({ ok: false, error: "limited" });
    expect(test.repository.appendUpdate).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not a decodable Yjs update before they reach the log", async () => {
    const test = harness({});
    await expect(
      test.service.applyUpdate({
        workspaceId,
        noteId,
        epoch: 3,
        update: new Uint8Array([9, 9, 9, 9]),
        actorId: userId,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid" });
    expect(test.repository.allocateRevision).not.toHaveBeenCalled();
  });

  it("persists each accepted update at the revision PostgreSQL allocated", async () => {
    const test = harness({
      repository: {
        allocateRevision: vi
          .fn()
          .mockResolvedValueOnce({ epoch: 3, revision: 4, stateBytes: 10 })
          .mockResolvedValueOnce({ epoch: 3, revision: 5, stateBytes: 20 }),
      },
    });
    const first = await test.service.applyUpdate({
      workspaceId,
      noteId,
      epoch: 3,
      update: realUpdate("a"),
      actorId: userId,
    });
    const second = await test.service.applyUpdate({
      workspaceId,
      noteId,
      epoch: 3,
      update: realUpdate("b"),
      actorId: userId,
    });
    expect(first).toEqual({ ok: true, epoch: 3, revision: 4 });
    expect(second).toEqual({ ok: true, epoch: 3, revision: 5 });
    expect(test.repository.appendUpdate).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ revision: 4, kind: "update", createdById: userId }),
    );
    expect(test.repository.appendUpdate).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ revision: 5 }),
    );
  });

  it("refuses a note that belongs to another workspace without allocating anything", async () => {
    // The collaboration tables carry no workspace_id, so the parent note's
    // workspace is proven in the SAME transaction. A foreign note id must behave
    // exactly like a missing one — no existence leak, no revision consumed.
    const test = harness({ noteRows: [] });
    await expect(
      test.service.applyUpdate({
        workspaceId,
        noteId,
        epoch: 3,
        update: realUpdate("a"),
        actorId: userId,
      }),
    ).resolves.toEqual({ ok: false, error: "unavailable" });
    expect(test.repository.allocateRevision).not.toHaveBeenCalled();
    expect(test.repository.appendUpdate).not.toHaveBeenCalled();
  });
});

describe("NoteCollaborationService.project", () => {
  it("commits the projection and delegates the checkpoint decision", async () => {
    const test = harness({ updateRows: [{ version: 6, title: "Launch overview" }] });
    await test.service.project({ workspaceId, noteId, forcedBoundary: false });

    expect(test.repository.markProjected).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ epoch: 3, revision: 2, noteVersion: 6 }),
    );
    // `lastCheckpointAt` is null, so `decideCollaborativeCheckpoint` returns
    // `first_checkpoint` and the pipeline records a durable baseline.
    expect(test.noteVersions.recordAcceptedState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ noteId, workspaceId, version: 6, createdById: userId }),
    );
    expect(test.search.scheduleSearchSync).toHaveBeenCalledOnce();
    expect(test.rooms.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "note", noteId }),
      "realtime:note:projected",
      { noteId, version: 6, revision: 2, epoch: 3 },
    );
  });

  it("skips the checkpoint when the cadence has not elapsed and nothing forced it", async () => {
    const test = harness({
      updateRows: [{ version: 6, title: "Launch overview" }],
      repository: { lastCheckpointAt: vi.fn().mockResolvedValue(new Date()) },
    });
    await test.service.project({ workspaceId, noteId, forcedBoundary: false });
    expect(test.noteVersions.recordAcceptedState).not.toHaveBeenCalled();
  });

  it("aborts and rebuilds when a non-collaborative writer won the notes CAS", async () => {
    const test = harness({ updateRows: [] });
    await test.service.project({ workspaceId, noteId, forcedBoundary: false });

    expect(test.repository.markProjected).not.toHaveBeenCalled();
    expect(test.noteVersions.recordAcceptedState).not.toHaveBeenCalled();
    expect(test.repository.resetEpoch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedEpoch: 3, epoch: 4, projectedNoteVersion: 5 }),
    );
    expect(test.rooms.emit).toHaveBeenCalledWith(expect.anything(), "realtime:note:reset", {
      noteId,
      epoch: 4,
    });
  });

  it("rolls the whole transaction back when a newer update wins the revision CAS", async () => {
    // Abandoning without a rollback would leave `notes` ahead of
    // `projected_note_version`, and the next load would rebuild from the JSON
    // just written — silently dropping the update that raced.
    const test = harness({
      updateRows: [{ version: 6, title: "Launch overview" }],
      repository: { markProjected: vi.fn().mockResolvedValue(false) },
    });
    await test.service.project({ workspaceId, noteId, forcedBoundary: false });

    expect(test.rollbacks).toHaveLength(1);
    expect(test.noteVersions.recordAcceptedState).not.toHaveBeenCalled();
    expect(test.search.scheduleSearchSync).not.toHaveBeenCalled();
    expect(test.rooms.emit).not.toHaveBeenCalled();
  });

  it("does nothing when every accepted revision is already projected", async () => {
    const test = harness({
      repository: { loadState: vi.fn().mockResolvedValue({ ...state, projectedRevision: 2 }) },
    });
    await test.service.project({ workspaceId, noteId, forcedBoundary: false });
    expect(test.repository.markProjected).not.toHaveBeenCalled();
    expect(test.repository.writeSnapshotAndPrune).not.toHaveBeenCalled();
    expect(test.noteVersions.recordAcceptedState).not.toHaveBeenCalled();
  });

  it("still checkpoints at a forced boundary the debounce already projected", async () => {
    // THE NORMAL CLOSE. The debounce fires 2 s after the last keystroke, so by
    // the time the last participant leaves there is usually nothing pending —
    // and returning early there meant an orderly room shutdown wrote no
    // `note_versions` row at all, which is exactly what Part 55 promises it
    // will.
    const test = harness({
      repository: { loadState: vi.fn().mockResolvedValue({ ...state, projectedRevision: 2 }) },
    });
    await test.service.project({ workspaceId, noteId, forcedBoundary: true });

    // `notes` is untouched and no revision is consumed: this is not a second
    // write authority, it is a checkpoint of the state already projected.
    expect(test.repository.markProjected).not.toHaveBeenCalled();
    expect(test.repository.writeSnapshotAndPrune).toHaveBeenCalledOnce();
    expect(test.noteVersions.recordAcceptedState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        noteId,
        workspaceId,
        version: 5,
        title: "Launch overview",
        contentPlain: "hello",
        createdById: userId,
      }),
    );
  });

  it("suppresses the second forced boundary instead of violating the version index", async () => {
    // A room with three participants schedules three forced boundaries. The
    // `(note_id, version)` index is UNIQUE and `recordAcceptedState` offers no
    // upsert, so the follow-ups must find the first row rather than abort.
    const test = harness({
      repository: {
        loadState: vi.fn().mockResolvedValue({ ...state, projectedRevision: 2 }),
        hasCheckpoint: vi.fn().mockResolvedValue(true),
      },
    });
    await test.service.project({ workspaceId, noteId, forcedBoundary: true });
    expect(test.noteVersions.recordAcceptedState).not.toHaveBeenCalled();
    expect(test.rollbacks).toHaveLength(0);
  });
});

describe("NoteCollaborationService.resetToDocument", () => {
  it("bumps the epoch onto the restored document and tells the room to reload", async () => {
    const test = harness({});
    await test.tenant.run(createTenantContext({ workspaceId, userId }), () =>
      test.service.resetToDocument(test.tx as never, {
        workspaceId,
        noteId,
        document,
        noteVersion: 7,
        actorId: userId,
      }),
    );
    expect(test.repository.resetEpoch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedEpoch: 3,
        epoch: 4,
        revision: 3,
        projectedNoteVersion: 7,
        createdById: userId,
      }),
    );
    expect(test.rooms.emit).toHaveBeenCalledWith(expect.anything(), "realtime:note:reset", {
      noteId,
      epoch: 4,
    });
  });

  it("is a no-op for a note that has never been edited collaboratively", async () => {
    const test = harness({ repository: { loadState: vi.fn().mockResolvedValue(null) } });
    await test.tenant.run(createTenantContext({ workspaceId, userId }), () =>
      test.service.resetToDocument(test.tx as never, {
        workspaceId,
        noteId,
        document,
        noteVersion: 7,
        actorId: userId,
      }),
    );
    expect(test.repository.resetEpoch).not.toHaveBeenCalled();
    expect(test.rooms.emit).not.toHaveBeenCalled();
  });

  it("rejects a workspace that disagrees with the active tenant context", async () => {
    const test = harness({});
    await expect(
      test.tenant.run(createTenantContext({ workspaceId, userId }), () =>
        test.service.resetToDocument(test.tx as never, {
          workspaceId: otherWorkspaceId,
          noteId,
          document,
          noteVersion: 7,
          actorId: userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "tenant.workspace_mismatch" });
    expect(test.repository.loadState).not.toHaveBeenCalled();
  });
});
