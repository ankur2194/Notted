import { randomUUID } from "node:crypto";

import { NestFactory } from "@nestjs/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { DatabaseService } from "../src/database/database.service";
import {
  attachments,
  notes,
  noteTags,
  projects,
  tags,
  users,
  workspaces,
} from "../src/database/schema";
import { MeilisearchService } from "../src/infrastructure/meilisearch/meilisearch.service";
import { noteIndexDocumentSchema, type NoteIndexDocument } from "../src/search/note-index.document";
import { NoteIndexRepository } from "../src/search/note-index.repository";
import { NoteReindexService } from "../src/search/note-reindex.service";

import type { INestApplicationContext } from "@nestjs/common";

const RUN_INTEGRATION =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.FEATURE_SEARCH_ENABLED !== "false" &&
  process.env.MEILISEARCH_INDEX_PREFIX === "notted_e2e_";

describe.skipIf(!RUN_INTEGRATION)("search reindex drift repair (PostgreSQL + Meilisearch)", () => {
  let app: INestApplicationContext;
  let database: DatabaseService;
  let noteIndex: NoteIndexRepository;
  let meilisearch: MeilisearchService;
  let reindex: NoteReindexService;

  const userId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const liveNoteId = randomUUID();
  const deletedNoteId = randomUUID();
  const staleNoteId = randomUUID();
  const otherNoteId = randomUUID();
  const tagId = randomUUID();

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    database = app.get(DatabaseService);
    noteIndex = app.get(NoteIndexRepository);
    meilisearch = app.get(MeilisearchService);
    reindex = app.get(NoteReindexService);
    expect(noteIndex.indexUid).toBe("notted_e2e_notes_v1");
    expect(noteIndex.indexUid).not.toBe("notted_dev_notes_v1");

    await database.db.insert(users).values({
      id: userId,
      email: `search-reindex-${userId}@example.invalid`,
      name: "Search reindex fixture",
    });
    await database.db.insert(workspaces).values([
      {
        id: workspaceId,
        name: "Search reindex target",
        slug: `search-reindex-${workspaceId}`,
        createdById: userId,
      },
      {
        id: otherWorkspaceId,
        name: "Search reindex isolation control",
        slug: `search-reindex-${otherWorkspaceId}`,
        createdById: userId,
      },
    ]);
    await database.db.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Moved destination",
      createdById: userId,
    });
    await database.db.insert(notes).values([
      {
        id: liveNoteId,
        workspaceId,
        projectId,
        title: "Edited authoritative title",
        contentPlain: "Edited authoritative plain content",
        createdById: userId,
        updatedById: userId,
      },
      {
        id: deletedNoteId,
        workspaceId,
        title: "Deleted authoritative note",
        contentPlain: "must not remain indexed",
        isDeleted: true,
        deletedAt: new Date(),
        createdById: userId,
      },
      {
        id: otherNoteId,
        workspaceId: otherWorkspaceId,
        title: "Other tenant unchanged",
        contentPlain: "byte-equivalent control",
        createdById: userId,
      },
    ]);
    await database.db.insert(tags).values({
      id: tagId,
      workspaceId,
      name: "converged-tag",
      color: "#123456",
    });
    await database.db.insert(noteTags).values({ noteId: liveNoteId, tagId });
    await database.db.insert(attachments).values({
      id: randomUUID(),
      noteId: liveNoteId,
      workspaceId,
      originalName: "fixture.txt",
      filename: "fixture.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: `w/${workspaceId}/search-reindex-fixture`,
      processingStatus: "ready",
      createdById: userId,
    });

    await noteIndex.ensureIndex();
    await noteIndex.updateDocuments([
      driftedDocument(liveNoteId, workspaceId, userId),
      driftedDocument(deletedNoteId, workspaceId, userId),
      driftedDocument(staleNoteId, workspaceId, userId),
      {
        ...driftedDocument(otherNoteId, otherWorkspaceId, userId),
        title: "Other tenant unchanged",
        content: "byte-equivalent control",
      },
    ]);
  });

  afterAll(async () => {
    if (noteIndex !== undefined) {
      await noteIndex.deleteWorkspaceDocuments(workspaceId);
      await noteIndex.deleteWorkspaceDocuments(otherWorkspaceId);
    }
    if (database !== undefined) {
      await database.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await database.db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
      await database.db.delete(users).where(eq(users.id, userId));
    }
    await app?.close();
  });

  it("repairs create/edit/tag/move/delete/attachment drift without touching another tenant", async () => {
    const otherBefore = await readWorkspaceDocuments(otherWorkspaceId);
    const result = await reindex.reindexWorkspace(workspaceId);
    expect(result).toMatchObject({ status: "completed", workspaceId, staleDeleted: 2 });

    const target = await readWorkspaceDocuments(workspaceId);
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({
      id: liveNoteId,
      title: "Edited authoritative title",
      content: "Edited authoritative plain content",
      tags: ["converged-tag"],
      projectId,
      hasAttachments: true,
    });
    expect(target.map(({ id }) => id)).not.toContain(deletedNoteId);
    expect(target.map(({ id }) => id)).not.toContain(staleNoteId);

    const otherAfter = await readWorkspaceDocuments(otherWorkspaceId);
    expect(otherAfter).toEqual(otherBefore);
    expect(otherAfter.map(({ id }) => id)).toEqual([otherNoteId]);
  });

  async function readWorkspaceDocuments(id: string): Promise<readonly NoteIndexDocument[]> {
    const page = await meilisearch.getDocumentsPage(noteIndex.indexUid, {
      fields: [
        "id",
        "title",
        "content",
        "tags",
        "workspaceId",
        "projectId",
        "authorId",
        "createdAt",
        "updatedAt",
        "hasAttachments",
      ],
      filter: `workspaceId = "${id}"`,
      offset: 0,
      limit: 100,
    });
    return page.results.map((value) => noteIndexDocumentSchema.parse(value));
  }
});

function driftedDocument(id: string, workspaceId: string, authorId: string): NoteIndexDocument {
  return {
    id,
    title: "stale title",
    content: "stale content",
    tags: [],
    workspaceId,
    projectId: null,
    authorId,
    createdAt: 1,
    updatedAt: 1,
    hasAttachments: false,
  };
}
