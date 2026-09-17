import { resolve } from "node:path";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import { schema } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { NotePublicLinksService } from "../src/notes/note-public-links.service";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NotesService } from "../src/notes/notes.service";
import { PublicNoteService } from "../src/notes/public-note.service";
import { TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AppConfig } from "../src/config/app.config";
import type { AuthConfig } from "../src/config/auth.config";
import type { SecurityConfig } from "../src/config/security.config";
import type { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

// Only `.secret` is read by NotePublicLinksService/PublicNoteService; narrow cast is safe.
const testAuthConfig = { secret: "integration-test-pepper" } as AuthConfig;
// Only `.appUrl` is read by NotePublicLinksService, to build the returned public URL.
const testAppConfig = { appUrl: new URL("https://app.example.test") } as AppConfig;
// Real AES-256-GCM round-trips through `encryptPublicLinkToken`/`decryptPublicLinkToken`
// below, so this needs a genuine 32-byte key, not a narrowed stub.
const testSecurityConfig = {
  activeEncryptionKeyVersion: 1,
  encryptionKeys: [{ version: 1, encodedKey: Buffer.alloc(32, 7).toString("base64") }],
} as unknown as SecurityConfig;
const testLogger = { warn: vi.fn() } as unknown as StructuredLogger;

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

/** Rolled back at the end of the test; never escapes this file. */
class Rollback extends Error {}

describe.skipIf(!HAS_DATABASE)("note public links integration", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    await requireDatabase();
    pool = new Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates, resolves, regenerates, trashes/restores, and revokes a public link", async () => {
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const tenant = new TenantContextService();
        const database = {
          db: tx,
          transaction: <T>(inner: (scope: DatabaseTransaction) => Promise<T>) =>
            tx.transaction(inner),
        } as unknown as DatabaseService;
        const authorization = new AuthorizationEntryService(
          new AuthorizationRepository(database, tenant),
          new AuthorizationPolicyService(),
          tenant,
        );
        const owner = principal(SEED_IDS.users.alphaOwner);
        // NotesService's `searchIndexProducer` and `noteVersions` are required
        // constructor params; the remaining five (embedding/collaboration/
        // mention/webhook producers, folders service) are `@Optional()` and
        // omitted here, same as `notes.integration.test.ts`'s `withNotes`
        // fixture does for the ones it doesn't exercise.
        const notesService = new NotesService(
          database,
          authorization,
          tenant,
          { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
          new NoteVersionsService(tenant),
        );
        const links = new NotePublicLinksService(
          database,
          authorization,
          tenant,
          testAuthConfig,
          testAppConfig,
          testSecurityConfig,
          testLogger,
        );
        const publicNote = new PublicNoteService(database, testAuthConfig);

        await tenant.run(
          { workspaceId: SEED_IDS.workspaces.alpha, userId: owner.userId },
          async () => {
            const created = await notesService.create({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              title: "Public link fixture",
              projectId: null,
              folderId: null,
              parentId: null,
              type: "document",
              pageSize: "letter",
              isTemplate: false,
              isPinned: false,
              isArchived: false,
              tagIds: [],
              content: { type: "doc", content: [] },
              idempotencyKey: `public-link-fixture-${Date.now()}`,
            });
            const noteId = created.note.id;

            // No link yet.
            expect(
              await links.status({
                principal: owner,
                workspaceId: SEED_IDS.workspaces.alpha,
                noteId,
              }),
            ).toMatchObject({ enabled: false, createdAt: null });

            // Create -> resolvable publicly.
            const first = await links.create({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              noteId,
            });
            const firstToken = new URL(first.url).pathname.split("/").pop() as string;
            const firstResolved = await publicNote.resolve(firstToken);
            expect(firstResolved?.title).toBe("Public link fixture");

            // The URL is re-copyable at any time, not shown once: a fresh
            // `status` call (a page refresh, or reopening the share modal)
            // decrypts and returns the SAME URL `create` returned.
            expect(
              await links.status({
                principal: owner,
                workspaceId: SEED_IDS.workspaces.alpha,
                noteId,
              }),
            ).toMatchObject({ enabled: true, url: first.url });

            // Regenerate -> old token stops working, new one works, and
            // `status` now reflects the NEW url, not the old one.
            const second = await links.create({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              noteId,
            });
            const secondToken = new URL(second.url).pathname.split("/").pop() as string;
            expect(secondToken).not.toBe(firstToken);
            expect(await publicNote.resolve(firstToken)).toBeNull();
            expect((await publicNote.resolve(secondToken))?.title).toBe("Public link fixture");
            expect(
              await links.status({
                principal: owner,
                workspaceId: SEED_IDS.workspaces.alpha,
                noteId,
              }),
            ).toMatchObject({ enabled: true, url: second.url });

            // Trash -> 404s. Restore -> works again, same token.
            const trashed = await notesService.softDelete({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              noteId,
              expectedVersion: created.note.version,
            });
            expect(await publicNote.resolve(secondToken)).toBeNull();
            await notesService.restore({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              noteId,
              expectedVersion: trashed.version,
            });
            expect((await publicNote.resolve(secondToken))?.title).toBe("Public link fixture");

            // Revoke -> 404s. Revoking again is a no-op, not an error.
            await links.revoke({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              noteId,
            });
            expect(await publicNote.resolve(secondToken)).toBeNull();
            await expect(
              links.revoke({ principal: owner, workspaceId: SEED_IDS.workspaces.alpha, noteId }),
            ).resolves.toMatchObject({ revoked: true });

            // Garbage / malformed token never reaches the database query: a
            // bogus hash would also miss every row and return `null`, so the
            // `toBeNull()` result alone can't distinguish "guard fired, zero
            // queries" from "guard bypassed, query ran and missed." Spy on
            // the transaction-scoped `db.select` to prove `resolve` never
            // even calls it for a token that fails `PUBLIC_LINK_TOKEN_PATTERN`.
            const selectSpy = vi.spyOn(database.db, "select");
            expect(await publicNote.resolve("not-a-valid-token")).toBeNull();
            expect(selectSpy).not.toHaveBeenCalled();
            selectSpy.mockRestore();
          },
        );
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
