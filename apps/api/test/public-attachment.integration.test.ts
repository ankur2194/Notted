import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AttachmentsService } from "../src/attachments/attachments.service";
import { parseMinioConfig } from "../src/config/minio.config";
import { DatabaseService } from "../src/database/database.service";
import {
  attachments,
  notePublicLinks,
  notes,
  schema,
  users,
  workspaces,
} from "../src/database/schema";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import { generatePublicLinkToken, hashPublicLinkToken } from "../src/notes/note-public-link-token";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";
import {
  HAS_MINIO,
  isMinioReachable,
  minioTestClient,
  removeTestObjects,
  testKeyPrefix,
} from "./minio-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AuthConfig } from "../src/config/auth.config";
import type { SecurityConfig } from "../src/config/security.config";

class RollbackFixture extends Error {}
const pepper = "public-attachment-live-test-pepper";
const bytes = Buffer.from("%PDF-1.7\nunique public attachment bytes\n", "utf8");

describe.skipIf(!HAS_DATABASE || !HAS_MINIO)("public attachment (live PostgreSQL + MinIO)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await requireDatabase(); // configured but unavailable must FAIL, not silently skip
    if (!(await isMinioReachable()))
      throw new Error("MINIO_ENDPOINT is set but attachments bucket is unreachable");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(pool, { schema }), {
      migrationsFolder: resolve(process.cwd(), "src/database/migrations"),
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("joins the live token, owning note, tenant and current document before reading exact MinIO bytes", async () => {
    const prefix = testKeyPrefix();
    const key = `${prefix}original.pdf`;
    const client = minioTestClient();
    const config = parseMinioConfig(process.env);
    const storage = new ObjectStorageService(
      client,
      config,
      {} as SecurityConfig,
      { warn: vi.fn() } as unknown as StructuredLogger,
    );
    try {
      // Storage does not participate in PostgreSQL rollback; all bytes live in
      // this run's disposable test/ namespace and are removed in finally.
      await storage.putObject("attachments", key, bytes, {
        contentType: "application/pdf",
        contentLength: bytes.length,
      });
      const db = drizzle(pool, { schema });
      await expect(
        db.transaction(async (tx) => {
          // Entire fixture is new and rolled back; no seedDatabase/upsert of a
          // shared deterministic row, no committed audit/outbox or note changes.
          const suffix = randomUUID();
          const userId = randomUUID();
          const [alpha, beta] = [randomUUID(), randomUUID()];
          const [liveNote, otherNote, foreignNote] = [randomUUID(), randomUUID(), randomUUID()];
          const [fileId, otherFileId, foreignFileId] = [randomUUID(), randomUUID(), randomUUID()];
          const token = generatePublicLinkToken();
          const secondToken = generatePublicLinkToken();
          await tx.insert(users).values({
            id: userId,
            name: "Public attachment fixture",
            email: `public-attachment-${suffix}@example.test`,
          });
          await tx.insert(workspaces).values([
            { id: alpha, createdById: userId, name: "A", slug: `public-a-${suffix}` },
            { id: beta, createdById: userId, name: "B", slug: `public-b-${suffix}` },
          ]);
          const fileNode = {
            type: "attachment",
            attrs: {
              attachmentId: fileId,
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: bytes.length,
            },
          };
          await tx.insert(notes).values([
            {
              id: liveNote,
              workspaceId: alpha,
              createdById: userId,
              title: "Shared",
              content: { type: "doc", content: [fileNode] },
            },
            { id: otherNote, workspaceId: alpha, createdById: userId, title: "Other" },
            { id: foreignNote, workspaceId: beta, createdById: userId, title: "Foreign" },
          ]);
          const variant = {
            original: {
              key,
              width: 0,
              height: 0,
              bytes: bytes.length,
              mimeType: "application/pdf",
            },
          };
          await tx.insert(attachments).values([
            {
              id: fileId,
              noteId: liveNote,
              workspaceId: alpha,
              originalName: "report.pdf",
              filename: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: bytes.length,
              storageKey: key,
              mediaType: "file",
              processingStatus: "ready",
              variants: variant,
              createdById: userId,
            },
            {
              id: otherFileId,
              noteId: otherNote,
              workspaceId: alpha,
              originalName: "other.pdf",
              filename: "other.pdf",
              mimeType: "application/pdf",
              sizeBytes: bytes.length,
              storageKey: key,
              mediaType: "file",
              processingStatus: "ready",
              variants: variant,
              createdById: userId,
            },
            {
              id: foreignFileId,
              noteId: foreignNote,
              workspaceId: beta,
              originalName: "foreign.pdf",
              filename: "foreign.pdf",
              mimeType: "application/pdf",
              sizeBytes: bytes.length,
              storageKey: key,
              mediaType: "file",
              processingStatus: "ready",
              variants: variant,
              createdById: userId,
            },
          ]);
          const [link] = await tx
            .insert(notePublicLinks)
            .values({
              noteId: liveNote,
              workspaceId: alpha,
              tokenHash: hashPublicLinkToken(token, pepper),
              createdById: userId,
            })
            .returning({ id: notePublicLinks.id });
          if (!link) throw new Error("fixture link not inserted");

          const stat = vi.spyOn(storage, "statObject");
          const stream = vi.spyOn(storage, "getObjectStream");
          const service = new AttachmentsService(
            { db: tx } as unknown as DatabaseService,
            {} as never,
            {} as never,
            storage,
            {} as never,
            {} as SecurityConfig,
            { warn: vi.fn() } as unknown as StructuredLogger,
            {} as never,
            {} as never,
            { secret: pepper } as AuthConfig,
          );
          const read = (attachmentId: string, rawToken = token) =>
            service.readPublicContent({ token: rawToken, attachmentId });
          const success = await read(fileId);
          expect(success?.contentLength).toBe(bytes.length);
          const chunks: Buffer[] = [];
          for await (const chunk of success?.stream ?? [])
            chunks.push(Buffer.from(chunk as Buffer));
          expect(Buffer.concat(chunks).equals(bytes)).toBe(true);

          const deny = async (id: string, rawToken = token) => {
            const calls = [stat.mock.calls.length, stream.mock.calls.length];
            expect(await read(id, rawToken)).toBeNull();
            expect([stat.mock.calls.length, stream.mock.calls.length]).toEqual(calls);
          };
          await deny(otherFileId); // same tenant, different note, actual object exists
          await deny(foreignFileId); // other tenant, same storage key
          await deny(randomUUID());
          await tx
            .update(notes)
            .set({ content: { type: "doc", content: [] } })
            .where(eq(notes.id, liveNote));
          await deny(fileId); // row and bytes still live; removed file node revokes
          await tx
            .update(notes)
            .set({ content: { type: "doc", content: [fileNode] }, isDeleted: true })
            .where(eq(notes.id, liveNote));
          await deny(fileId); // trash
          await tx.update(notes).set({ isDeleted: false }).where(eq(notes.id, liveNote));
          const restored = await read(fileId);
          expect(restored).not.toBeNull();
          restored?.stream.destroy();
          await tx
            .update(notePublicLinks)
            .set({ tokenHash: hashPublicLinkToken(secondToken, pepper) })
            .where(eq(notePublicLinks.id, link.id));
          await deny(fileId); // regenerate invalidates the old bearer
          const regenerated = await read(fileId, secondToken);
          expect(regenerated).not.toBeNull();
          regenerated?.stream.destroy();
          await tx.delete(notePublicLinks).where(eq(notePublicLinks.id, link.id));
          await deny(fileId, secondToken); // revoke
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await removeTestObjects(prefix);
      // Cleanup helpers are best effort; a reachable store must not silently
      // leave this test's bytes behind on a successful run.
      expect(await storage.statObject("attachments", key)).toBeNull();
    }
  });
});
