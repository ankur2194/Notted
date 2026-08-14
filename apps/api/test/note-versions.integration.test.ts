import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseRetentionConfig } from "../src/config/retention.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import { jobOutbox, noteVersions, notes, schema, workspaces } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { NoteVersionRetentionService } from "../src/maintenance/note-version-retention.service";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NotesService } from "../src/notes/notes.service";
import { DOMAIN_JOB_TYPES } from "../src/queue/job-identifiers";
import { NoteEmbeddingProducer } from "../src/search/note-embedding-producer";
import { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import { createTenantContext, TenantContextService } from "../src/tenant";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AuthenticatedPrincipal, NoteDocument } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `version:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

async function reachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe.skipIf(!HAS_DATABASE_URL)("Part 55 note snapshots and retention (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let databaseReachable = false;

  beforeAll(async () => {
    databaseReachable = await reachable(DATABASE_URL as string);
    if (!databaseReachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => pool?.end());

  it("atomically stores immutable ordered post-save states and only the concurrent winner", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    await db.transaction(async (tx) => seedDatabase(tx));
    const tenant = new TenantContextService();
    const database = {
      db,
      transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>) => db!.transaction(work),
    } as unknown as DatabaseService;
    const authorization = new AuthorizationEntryService(
      new AuthorizationRepository(database, tenant),
      new AuthorizationPolicyService(),
      tenant,
    );
    const service = new NotesService(
      database,
      authorization,
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
    );
    const owner = principal(SEED_IDS.users.alphaOwner);
    const created = await service.create({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      title: `Version fixture ${randomUUID()}`,
      projectId: null,
      folderId: null,
      parentId: null,
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: { type: "doc", content: [] },
      idempotencyKey: `version-create-${randomUUID()}`,
    });
    try {
      const first = service.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        expectedVersion: 1,
        title: "winner-a",
      });
      const second = service.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        expectedVersion: 1,
        title: "winner-b",
      });
      const settled = await Promise.allSettled([first, second]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rows = await db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.noteId, created.note.id))
        .orderBy(asc(noteVersions.version));
      expect(rows.map((row) => row.version)).toEqual([1, 2]);
      expect(rows[1]?.title).toMatch(/^winner-[ab]$/u);
      // No service update API exists for history rows; ordered reads continue
      // to expose exactly the accepted immutable payloads written above.
      expect(rows[0]?.title).toBe(created.note.title);
    } finally {
      await db.delete(notes).where(eq(notes.id, created.note.id));
    }
  });

  it("restores complex content as immutable N+1 history with convergence intents and tenant-safe authorization", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    await db.transaction(async (tx) => seedDatabase(tx));
    const tenant = new TenantContextService();
    const database = {
      db,
      transaction: <T>(
        work: (scope: DatabaseTransaction) => Promise<T>,
        config?: PgTransactionConfig,
      ) => db!.transaction(work, config),
    } as unknown as DatabaseService;
    const authorization = new AuthorizationEntryService(
      new AuthorizationRepository(database, tenant),
      new AuthorizationPolicyService(),
      tenant,
    );
    const service = new NotesService(
      database,
      authorization,
      tenant,
      new NoteSearchIndexProducer(tenant),
      new NoteVersionsService(tenant),
      new NoteEmbeddingProducer(tenant),
    );
    const owner = principal(SEED_IDS.users.alphaOwner);
    const viewer = principal(SEED_IDS.users.alphaViewer);
    const betaOwner = principal(SEED_IDS.users.betaOwner);
    const imageAttachmentId = randomUUID();
    const fileAttachmentId = randomUUID();
    const complex: NoteDocument = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Before heading", marks: [{ type: "bold" }] }],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Nested task" }] }],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const restored = true" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
                },
              ],
            },
          ],
        },
        { type: "pageBreak" },
        {
          type: "image",
          attrs: {
            attachmentId: imageAttachmentId,
            alt: "Historical diagram",
            caption: "Original caption",
            width: 32,
            height: 16,
            align: "right",
            wrap: "inline",
            fullWidth: false,
          },
        },
        {
          type: "attachment",
          attrs: {
            attachmentId: fileAttachmentId,
            name: "history.txt",
            mimeType: "text/plain",
            sizeBytes: 23,
          },
        },
      ],
    };
    const changed: NoteDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "changed searchable token" }],
        },
      ],
    };
    const requestId = randomUUID();
    const created = await service.create({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      title: `Version restore fixture ${randomUUID()}`,
      projectId: null,
      folderId: null,
      parentId: null,
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: { type: "doc", content: [] },
      idempotencyKey: `version-restore-create-${randomUUID()}`,
    });
    try {
      const checkpoint = await service.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        expectedVersion: created.note.version,
        title: "History original",
        content: complex,
      });
      const sourcePage = await service.listVersions({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        limit: 20,
      });
      const source = sourcePage.items.find((item) => item.version === checkpoint.note.version);
      expect(source).toBeDefined();
      const sourceBefore = await service.readVersion({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        versionId: source!.id,
      });
      expect(sourceBefore).toMatchObject({ title: "History original", content: complex });

      const current = await service.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        expectedVersion: checkpoint.note.version,
        title: "History changed",
        content: changed,
      });
      const historyBeforeDeniedRestores = await service.listVersions({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        limit: 20,
      });
      await expect(
        service.restoreVersion({
          principal: viewer,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: created.note.id,
          versionId: source!.id,
          expectedVersion: current.note.version,
        }),
      ).rejects.toMatchObject({ decision: { allowed: false } });
      await expect(
        service.listVersions({
          principal: betaOwner,
          workspaceId: SEED_IDS.workspaces.beta,
          noteId: created.note.id,
          limit: 20,
        }),
      ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
      await expect(
        service.readVersion({
          principal: betaOwner,
          workspaceId: SEED_IDS.workspaces.beta,
          noteId: created.note.id,
          versionId: source!.id,
        }),
      ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
      await expect(
        service.restoreVersion({
          principal: betaOwner,
          workspaceId: SEED_IDS.workspaces.beta,
          noteId: created.note.id,
          versionId: source!.id,
          expectedVersion: current.note.version,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
      const historyAfterDeniedRestores = await service.listVersions({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        limit: 20,
      });
      expect(historyAfterDeniedRestores.items).toEqual(historyBeforeDeniedRestores.items);

      const restored = await service.restoreVersion({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        versionId: source!.id,
        expectedVersion: current.note.version,
        requestId,
      });
      expect(restored.note).toMatchObject({
        version: current.note.version + 1,
        title: "History original",
        content: complex,
        contentPlain: expect.stringContaining("Header"),
        progress: { checklist: { done: 1, total: 1 } },
      });
      expect(restored.restoredFrom).toMatchObject({ id: source!.id, version: 2 });
      expect(restored.createdVersion).toMatchObject({
        version: current.note.version + 1,
        isCurrent: true,
      });

      const history = await service.listVersions({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        limit: 20,
      });
      expect(history.items.map((item) => item.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      const sourceAfter = await service.readVersion({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: created.note.id,
        versionId: source!.id,
      });
      expect(sourceAfter).toMatchObject({
        id: sourceBefore.id,
        version: sourceBefore.version,
        title: sourceBefore.title,
        author: sourceBefore.author,
        createdAt: sourceBefore.createdAt,
        content: sourceBefore.content,
      });
      expect(sourceAfter.isCurrent).toBe(false);
      expect(restored.createdVersion.id).not.toBe(source!.id);

      const convergenceIntents = await db
        .select({ jobType: jobOutbox.jobType, payload: jobOutbox.payload })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.correlationId, requestId),
            inArray(jobOutbox.jobType, [
              DOMAIN_JOB_TYPES.noteSearchSync,
              DOMAIN_JOB_TYPES.noteEmbeddingGenerate,
            ]),
          ),
        );
      expect(convergenceIntents).toHaveLength(2);
      expect(convergenceIntents.map((intent) => intent.jobType).sort()).toEqual(
        [DOMAIN_JOB_TYPES.noteEmbeddingGenerate, DOMAIN_JOB_TYPES.noteSearchSync].sort(),
      );
      expect(
        convergenceIntents.every(
          (intent) =>
            intent.payload.workspaceId === SEED_IDS.workspaces.alpha &&
            intent.payload.actorId === owner.userId &&
            JSON.stringify(intent.payload.resourceIds) === JSON.stringify([created.note.id]),
        ),
      ).toBe(true);
    } finally {
      await db
        .delete(jobOutbox)
        .where(
          sql`${jobOutbox.payload}->'resourceIds' @> ${JSON.stringify([created.note.id])}::jsonb`,
        );
      await db.delete(notes).where(eq(notes.id, created.note.id));
    }
  });

  it("preserves earliest/latest/current, skips unlimited plans, is repeat-safe, and isolates tenants", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) return skip("no reachable disposable PostgreSQL");
    class Rollback extends Error {}
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const freeNote = SEED_IDS.notes.alphaPinnedRoot;
        const proNote = SEED_IDS.notes.betaRoot;
        await tx
          .update(workspaces)
          .set({ plan: "free" })
          .where(eq(workspaces.id, SEED_IDS.workspaces.alpha));
        await tx
          .update(workspaces)
          .set({ plan: "pro" })
          .where(eq(workspaces.id, SEED_IDS.workspaces.beta));
        await tx.update(notes).set({ version: 4 }).where(eq(notes.id, freeNote));
        await tx.update(notes).set({ version: 4 }).where(eq(notes.id, proNote));
        const old = new Date("2020-01-01T00:00:00.000Z");
        for (const [noteId, creator] of [
          [freeNote, SEED_IDS.users.alphaOwner],
          [proNote, SEED_IDS.users.betaOwner],
        ] as const) {
          await tx.delete(noteVersions).where(eq(noteVersions.noteId, noteId));
          await tx.insert(noteVersions).values(
            [1, 2, 3, 4, 5].map((version) => ({
              noteId,
              version,
              title: `v${version}`,
              content: { type: "doc", content: [] },
              contentPlain: "",
              createdById: creator,
              createdAt: old,
            })),
          );
        }
        const database = { db: tx } as unknown as DatabaseService;
        const tenant = new TenantContextService();
        const versions = new NoteVersionsService(tenant);
        await expect(
          tenant.run(
            createTenantContext({
              workspaceId: SEED_IDS.workspaces.alpha,
              userId: SEED_IDS.users.alphaOwner,
            }),
            () =>
              versions.recordAcceptedState(tx, {
                noteId: proNote,
                workspaceId: SEED_IDS.workspaces.alpha,
                version: 6,
                title: "cross-tenant",
                content: { type: "doc", content: [] },
                contentPlain: "",
                createdById: SEED_IDS.users.alphaOwner,
              }),
          ),
        ).rejects.toMatchObject({ code: "tenant.workspace_mismatch" });
        const retention = new NoteVersionRetentionService(
          database,
          { info: () => undefined } as unknown as StructuredLogger,
          parseRetentionConfig({}),
        );
        await retention.purgeExpired();
        await retention.purgeExpired();
        const remaining = await tx
          .select()
          .from(noteVersions)
          .where(inArray(noteVersions.noteId, [freeNote, proNote]));
        expect(
          remaining
            .filter((row) => row.noteId === freeNote)
            .map((row) => row.version)
            .sort(),
        ).toEqual([1, 4, 5]);
        expect(remaining.filter((row) => row.noteId === proNote)).toHaveLength(5);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
