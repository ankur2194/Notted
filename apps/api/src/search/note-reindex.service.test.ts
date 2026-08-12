import { describe, expect, it, vi } from "vitest";

import { TenantContextService } from "../tenant";

import { NoteReindexService } from "./note-reindex.service";

import type { NoteIndexDocument } from "./note-index.document";
import type { NoteIndexRepository } from "./note-index.repository";
import type { NoteProjectionRepository } from "./note-projection.repository";
import type { WorkspaceSearchRepository } from "./workspace-search.repository";
import type { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const ORPHAN = "33333333-3333-4333-8333-333333333333";
const NOTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STALE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function document(id: string, workspaceId = WORKSPACE_A): NoteIndexDocument {
  return {
    id,
    workspaceId,
    title: "safe fixture",
    content: "body",
    tags: [],
    projectId: null,
    authorId: "44444444-4444-4444-8444-444444444444",
    createdAt: 1,
    updatedAt: 2,
    hasAttachments: false,
  };
}

function fixture(enabled = true) {
  const projection = {
    loadWorkspacePage: vi.fn().mockResolvedValue({
      documents: [document(NOTE_A)],
      limit: 500,
    }),
    loadDocumentsForNoteIds: vi.fn().mockResolvedValue([]),
  };
  const noteIndex = {
    indexUid: "notted_test_notes_v1",
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    updateDocuments: vi.fn().mockResolvedValue(undefined),
    deleteDocuments: vi.fn().mockResolvedValue(undefined),
    deleteWorkspaceDocuments: vi.fn().mockResolvedValue(undefined),
    listWorkspaceDocumentIds: vi.fn().mockResolvedValue({
      ids: [NOTE_A, STALE],
      offset: 0,
      limit: 500,
      total: 2,
    }),
    listDocumentWorkspaceReferences: vi.fn().mockResolvedValue({
      documents: [
        { id: NOTE_A, workspaceId: WORKSPACE_A },
        { id: STALE, workspaceId: ORPHAN },
      ],
      offset: 0,
      limit: 500,
      total: 2,
    }),
  };
  const workspaces = {
    listWorkspaceIdsPage: vi.fn().mockResolvedValue([WORKSPACE_A, WORKSPACE_B]),
    existingWorkspaceIds: vi.fn().mockResolvedValue(new Set([WORKSPACE_A])),
  };
  const meilisearch = { isEnabled: () => enabled };
  const subject = new NoteReindexService(
    projection as unknown as NoteProjectionRepository,
    noteIndex as unknown as NoteIndexRepository,
    workspaces as unknown as WorkspaceSearchRepository,
    meilisearch as unknown as MeilisearchService,
    new TenantContextService(),
  );
  return { subject, projection, noteIndex, workspaces };
}

describe("NoteReindexService", () => {
  it("pages a tenant, upserts authority, and deletes only that tenant's stale IDs", async () => {
    const { subject, noteIndex } = fixture();
    const result = await subject.reindexWorkspace(WORKSPACE_A);
    expect(result).toMatchObject({ projected: 1, staleDeleted: 1, workspaceId: WORKSPACE_A });
    expect(noteIndex.listWorkspaceDocumentIds).toHaveBeenCalledWith(WORKSPACE_A, {
      offset: 0,
      limit: 500,
    });
    expect(noteIndex.deleteDocuments).toHaveBeenCalledWith([STALE]);
    expect(noteIndex.deleteWorkspaceDocuments).not.toHaveBeenCalled();
  });

  it("advances bounded PostgreSQL and filtered index pages", async () => {
    const { subject, projection, noteIndex } = fixture();
    const firstDocuments = Array.from({ length: 500 }, () => document(NOTE_A));
    projection.loadWorkspacePage
      .mockResolvedValueOnce({
        documents: firstDocuments,
        limit: 500,
        nextCursor: { updatedAt: new Date(2), id: NOTE_A },
      })
      .mockResolvedValueOnce({
        documents: [document(STALE)],
        limit: 500,
      });
    noteIndex.listWorkspaceDocumentIds
      .mockResolvedValueOnce({ ids: Array(500).fill(NOTE_A), offset: 0, limit: 500, total: 501 })
      .mockResolvedValueOnce({ ids: [STALE], offset: 500, limit: 500, total: 501 });
    await subject.reindexWorkspace(WORKSPACE_A);
    expect(projection.loadWorkspacePage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        after: { updatedAt: new Date(2), id: NOTE_A },
        limit: 500,
      }),
    );
    expect(noteIndex.listWorkspaceDocumentIds).toHaveBeenNthCalledWith(2, WORKSPACE_A, {
      offset: 500,
      limit: 500,
    });
    expect(noteIndex.updateDocuments.mock.calls.every(([docs]) => docs.length <= 500)).toBe(true);
  });

  it("is interruption-safe and a rerun resumes from PostgreSQL authority", async () => {
    const { subject, noteIndex } = fixture();
    noteIndex.updateDocuments.mockRejectedValueOnce(new Error("safe test interruption"));
    await expect(subject.reindexWorkspace(WORKSPACE_A)).rejects.toThrow();
    await expect(subject.reindexWorkspace(WORKSPACE_A)).resolves.toMatchObject({
      status: "completed",
    });
    expect(noteIndex.ensureIndex).toHaveBeenCalledTimes(2);
  });

  it("rechecks drift candidates so a concurrent create is upserted rather than deleted", async () => {
    const { subject, projection, noteIndex } = fixture();
    projection.loadDocumentsForNoteIds.mockResolvedValueOnce([document(STALE)]);
    await subject.reindexWorkspace(WORKSPACE_A);
    expect(noteIndex.updateDocuments).toHaveBeenCalledWith([document(STALE)]);
    expect(noteIndex.deleteDocuments).not.toHaveBeenCalled();
  });

  it("repairs a delete/recreate race after the idempotent delete", async () => {
    const { subject, projection, noteIndex } = fixture();
    projection.loadDocumentsForNoteIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([document(STALE)]);
    await subject.reindexWorkspace(WORKSPACE_A);
    expect(noteIndex.deleteDocuments).toHaveBeenCalledWith([STALE]);
    expect(noteIndex.updateDocuments).toHaveBeenLastCalledWith([document(STALE)]);
  });

  it("eventually applies a concurrent edit when its incremental retry or a rerun rereads authority", async () => {
    const { subject, projection, noteIndex } = fixture();
    const edited = { ...document(NOTE_A), title: "concurrent authoritative edit", updatedAt: 3 };
    await subject.reindexWorkspace(WORKSPACE_A);
    projection.loadWorkspacePage.mockResolvedValue({
      documents: [edited],
      limit: 500,
    });
    await subject.reindexWorkspace(WORKSPACE_A);
    expect(noteIndex.updateDocuments).toHaveBeenLastCalledWith([edited]);
  });

  it("reindexes authoritative workspaces then purges only indexed orphan tenants for --all", async () => {
    const { subject, noteIndex, workspaces } = fixture();
    const result = await subject.reindexAllWorkspaces();
    expect(result).toMatchObject({ workspacesReindexed: 2, orphanWorkspacesPurged: 1 });
    expect(workspaces.existingWorkspaceIds).toHaveBeenCalledWith([WORKSPACE_A, ORPHAN]);
    expect(noteIndex.deleteWorkspaceDocuments).toHaveBeenCalledTimes(1);
    expect(noteIndex.deleteWorkspaceDocuments).toHaveBeenCalledWith(ORPHAN);
  });

  it("does no provider or database work when search is disabled", async () => {
    const { subject, noteIndex, projection, workspaces } = fixture(false);
    await expect(subject.reindexWorkspace(WORKSPACE_A)).resolves.toMatchObject({
      status: "disabled",
    });
    await expect(subject.reindexAllWorkspaces()).resolves.toMatchObject({ status: "disabled" });
    expect(noteIndex.ensureIndex).not.toHaveBeenCalled();
    expect(projection.loadWorkspacePage).not.toHaveBeenCalled();
    expect(workspaces.listWorkspaceIdsPage).not.toHaveBeenCalled();
  });
});
