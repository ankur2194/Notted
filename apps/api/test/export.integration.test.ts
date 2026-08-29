// Part 62 — export job lifecycle against a live, disposable PostgreSQL.
//
// Same shape as `comments.integration.test.ts`: self-provisioning (`migrate` +
// `seedDatabase`), self-skipping when no reachable `DATABASE_URL` is configured,
// and every collaborator constructed BY HAND rather than through the Nest
// container, so the test exercises the real SQL and the real policies without
// booting the application graph.
//
// NO REDIS, NO BULLMQ LOOP, NO MINIO. The generation pipeline is proved by
// reading the `job_outbox` row the producer wrote inside `ExportService.create`'s
// transaction and then invoking `ExportGenerationWorkerService.handle` directly
// with a hand-built `QueueJobContext` — the outbox row IS the contract between
// the two halves. Object storage is an in-memory `ObjectStore` double, because
// what is under test is the state machine and the authorization boundary, not
// the S3 wire protocol; a live MinIO would add a container and a source of
// flakes without touching a line of the behaviour being asserted.
//
// WHAT THIS FILE IS FOR: the four things unit tests with a fake database cannot
// prove — that the row and its outbox intent really commit together, that the
// real policy denies a non-requester and a foreign tenant, that an elapsed
// download grant really refuses, and that a completed export really produces
// both announcements.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  emailDeliveries,
  exportJobs,
  jobOutbox,
  notifications,
  schema,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { WorkspaceEmailProducerService } from "../src/email/workspace-email-producer.service";
import { ExportGenerationService } from "../src/export/export-generation.service";
import { ExportJobProducer } from "../src/export/export-job.producer";
import { ExportService } from "../src/export/export.service";
import { ExportGenerationWorkerService } from "../src/export/export.worker.service";
import { NoteExportSourceService } from "../src/export/note-export-source.service";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NotesService } from "../src/notes/notes.service";
import { MentionNotificationProducer } from "../src/notifications/mention-notification.producer";
import { NotificationService } from "../src/notifications/notification.service";
import { DOMAIN_JOB_TYPES } from "../src/queue/job-identifiers";
import { EXPORT_GENERATE_JOB_DEFINITION } from "../src/queue/job-registry";
import { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import { createTenantContext, TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { PdfExportService } from "../src/export/pdf-export.service";
import type {
  ObjectStore,
  ObjectStorageService,
  StorageBucket,
} from "../src/infrastructure/minio/object-storage.service";
import type { QueueHandlerRegistry } from "../src/queue/queue-handler-registry.service";
import type { AuthenticatedPrincipal, ExportFormat } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `export:${userId}`,
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

/** In-memory `ObjectStore`. Records every key it is asked to write. */
function memoryObjectStore() {
  const objects = new Map<string, Buffer>();
  const store: ObjectStore = {
    isEnabled: () => true,
    putObject: async (bucket: StorageBucket, key: string, body: Buffer) => {
      objects.set(`${bucket}/${key}`, body);
      return { etag: `etag-${objects.size}` };
    },
    getObjectStream: async (bucket: StorageBucket, key: string) => {
      const body = objects.get(`${bucket}/${key}`);
      if (body === undefined) throw new Error("NoSuchKey");
      return Readable.from(body);
    },
    statObject: async (bucket: StorageBucket, key: string) => {
      const body = objects.get(`${bucket}/${key}`);
      return body === undefined
        ? null
        : { size: body.byteLength, etag: "etag", lastModified: new Date(), contentType: null };
    },
    listObjects: async () => ({ objects: [], truncated: false }),
    removeObject: async (bucket: StorageBucket, key: string) => {
      objects.delete(`${bucket}/${key}`);
    },
    removeObjects: async (bucket: StorageBucket, keys: readonly string[]) => {
      for (const key of keys) objects.delete(`${bucket}/${key}`);
    },
    presignedGetUrl: async () => {
      throw new Error("exports never presign");
    },
  };
  return { objects, store };
}

function build(db: NodePgDatabase<typeof schema>) {
  const tenant = new TenantContextService();
  const database = {
    db,
    transaction: <T>(
      work: (scope: DatabaseTransaction) => Promise<T>,
      config?: PgTransactionConfig,
    ) => db.transaction(work, config),
  } as unknown as DatabaseService;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    warning: () => undefined,
    failure: () => undefined,
  } as unknown as StructuredLogger;
  const authorization = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const { objects, store } = memoryObjectStore();
  const exportService = new ExportService(
    database,
    tenant,
    new ExportJobProducer(tenant),
    store,
    logger,
  );
  return {
    tenant,
    objects,
    authorization,
    exportService,
    notesService: new NotesService(
      database,
      authorization,
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
      undefined,
      undefined,
      new MentionNotificationProducer(tenant, logger),
    ),
    worker: new ExportGenerationWorkerService(
      database,
      exportService,
      // Real service, stubbed collaborators: this suite exercises the `txt` path
      // end to end. `pdf` is the arm that needs Chromium and `zip` the arm that
      // needs authorized note reads; neither is driven here.
      new ExportGenerationService(
        { render: async () => Buffer.alloc(0) } as unknown as PdfExportService,
        {
          load: async () => ({ attachments: [], comments: [], versions: [] }),
        } as unknown as NoteExportSourceService,
        { chromiumPath: null, renderTimeoutMs: 30_000, maxArtifactBytes: 26_214_400 },
      ),
      store as unknown as ObjectStorageService,
      new NotificationService(database, tenant),
      new WorkspaceEmailProducerService(tenant),
      authorization,
      { register: () => () => undefined } as unknown as QueueHandlerRegistry,
      logger,
    ),
  };
}

describe.skipIf(!HAS_DATABASE)("Part 62 export job lifecycle (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.transaction(async (tx) => seedDatabase(tx));
  });

  afterAll(async () => pool?.end());

  /** Create a note, then queue a `txt` export of it as `actor`. */
  async function queueExport(
    harness: ReturnType<typeof build>,
    actor: AuthenticatedPrincipal,
    workspaceId: string,
    body: string,
  ) {
    const note = await harness.notesService.create({
      principal: actor,
      workspaceId,
      title: `Export source ${randomUUID()}`,
      projectId: null,
      folderId: null,
      parentId: null,
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
      },
      idempotencyKey: `export-fixture-${randomUUID()}`,
    });
    const job = await harness.tenant.run(
      createTenantContext({ workspaceId, userId: actor.userId }),
      () =>
        harness.exportService.create({
          principal: actor,
          workspaceId,
          format: "txt",
          sourceType: "note",
          sourceId: note.note.id,
          options: {
            includeAttachments: false,
            includeComments: false,
            includeVersionHistory: false,
            headerText: null,
            footerText: null,
            margins: null,
          },
          idempotencyKey: randomUUID(),
        }),
    );
    return { noteId: note.note.id, noteVersion: note.note.version, job };
  }

  /** Drain the single `export.generate` intent for this export id. */
  async function runWorker(
    harness: ReturnType<typeof build>,
    scope: NodePgDatabase<typeof schema>,
    exportId: string,
  ): Promise<void> {
    const intents = await scope
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.generateExport));
    const intent = intents.find(
      (row) => (row.payload as { exportId?: string }).exportId === exportId,
    );
    expect(intent).toBeDefined();
    await harness.worker.handle({
      outboxIntentId: (intent as { id: string }).id,
      // The processor always supplies these; the handler reads them to tell a
      // retryable attempt from the final one.
      attempt: 1,
      maximumAttempts: 3,
      jobType: EXPORT_GENERATE_JOB_DEFINITION.jobType,
      idempotencyKey: (intent as { idempotencyKey: string }).idempotencyKey,
      payload: EXPORT_GENERATE_JOB_DEFINITION.payloadSchema.parse(
        (intent as { payload: unknown }).payload,
      ),
      signal: new AbortController().signal,
    });
  }

  it("carries a note from create through ready, download and both announcements", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const { job } = await queueExport(
      harness,
      owner,
      SEED_IDS.workspaces.alpha,
      "The quick brown fox.",
    );

    // A create is a QUEUED job with nothing to download yet.
    expect(job.status).toBe("queued");
    expect(job.downloadPath).toBeNull();
    expect(job.downloadExpiresAt).toBeNull();
    // ADR 0006: the intent committed in the SAME transaction as the row.
    const intents = await db
      .select()
      .from(jobOutbox)
      .where(eq(jobOutbox.jobType, DOMAIN_JOB_TYPES.generateExport));
    expect(
      intents.filter((row) => (row.payload as { exportId?: string }).exportId === job.id),
    ).toHaveLength(1);

    await runWorker(harness, db, job.id);

    const ready = await harness.tenant.run(
      createTenantContext({ workspaceId: SEED_IDS.workspaces.alpha, userId: owner.userId }),
      () =>
        harness.exportService.read({ workspaceId: SEED_IDS.workspaces.alpha, exportId: job.id }),
    );
    expect(ready.status).toBe("ready");
    expect(ready.downloadPath).toContain(`/exports/${job.id}/download`);
    expect(ready.downloadExpiresAt).not.toBeNull();
    // The wire shape never carries the storage address.
    expect(Object.keys(ready)).not.toContain("objectKey");
    // Both lifecycles were stamped, and they are independent columns.
    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
    expect(row?.objectKey).toContain(SEED_IDS.workspaces.alpha);
    expect(row?.objectExpiresAt).not.toBeNull();

    // The bytes really round-trip, and they really contain the note body.
    const content = await harness.tenant.run(
      createTenantContext({ workspaceId: SEED_IDS.workspaces.alpha, userId: owner.userId }),
      () =>
        harness.exportService.openDownload({
          workspaceId: SEED_IDS.workspaces.alpha,
          exportId: job.id,
        }),
    );
    expect(content.mimeType).toBe("text/plain; charset=utf-8");
    expect(content.filename.endsWith(".txt")).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString("utf8")).toContain("The quick brown fox.");

    // Both announcements landed, in their two separate failure domains.
    const notified = await db
      .select()
      .from(notifications)
      .where(eq(notifications.targetId, job.id));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.kind).toBe("export");
    expect(notified[0]?.recipientUserId).toBe(SEED_IDS.users.alphaOwner);

    const mailed = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.relatedEntityId, job.id));
    expect(mailed).toHaveLength(1);
    expect(mailed[0]?.templateKey).toBe("export_ready");
    expect(mailed[0]?.relatedEntityType).toBe("export");

    await db.delete(notifications).where(eq(notifications.targetId, job.id));
    await db.delete(emailDeliveries).where(eq(emailDeliveries.relatedEntityId, job.id));
  });

  it("refuses a ready export whose download grant has elapsed", async ({ skip }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const { job } = await queueExport(harness, owner, SEED_IDS.workspaces.alpha, "Expiring soon.");
    await runWorker(harness, db, job.id);

    // The row stays `ready` and the bytes stay present: ONLY the outer grant
    // lapsed. This is exactly the window the retention sweep has not reached.
    await db
      .update(exportJobs)
      .set({ signedUrlExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(exportJobs.id, job.id));

    await expect(
      harness.tenant.run(
        createTenantContext({ workspaceId: SEED_IDS.workspaces.alpha, userId: owner.userId }),
        () =>
          harness.exportService.openDownload({
            workspaceId: SEED_IDS.workspaces.alpha,
            exportId: job.id,
          }),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "EXPORT_EXPIRED" } });

    // And the job itself still reports no download path, so a client cannot
    // even construct the request from a stale list response.
    const stale = await harness.tenant.run(
      createTenantContext({ workspaceId: SEED_IDS.workspaces.alpha, userId: owner.userId }),
      () =>
        harness.exportService.read({ workspaceId: SEED_IDS.workspaces.alpha, exportId: job.id }),
    );
    expect(stale.downloadPath).toBeNull();

    await db.delete(notifications).where(eq(notifications.targetId, job.id));
    await db.delete(emailDeliveries).where(eq(emailDeliveries.relatedEntityId, job.id));
  });

  it("denies a non-requester member in the same workspace, admits an admin, and conceals a foreign tenant's export", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const { job } = await queueExport(harness, owner, SEED_IDS.workspaces.alpha, "Private bytes.");

    // The REAL policy, not a stub. The requester may read their own export...
    await expect(
      harness.authorization.authorizeUser({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.read",
        resource: { kind: "export", id: job.id },
      }),
    ).resolves.toBeDefined();

    // ...but an ordinary member who did not request it may not. An export is a
    // private artefact of one person's request; membership is not enough.
    // The actor is an EDITOR on purpose: `editorAllowed`/`viewerAllowed` gate
    // every export action on `requestedById === actorId`, so this is the real
    // isolation case. Seeding an admin here would assert nothing — see the
    // deliberate admin carve-out below.
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.alphaEditor),
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.read",
        resource: { kind: "export", id: job.id },
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });

    // Same for the download and the cancel.
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.alphaEditor),
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.download",
        resource: { kind: "export", id: job.id },
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.alphaEditor),
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.cancel",
        resource: { kind: "export", id: job.id },
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });

    // A viewer is denied on the same ground, so the carve-out below is about
    // the admin role and not about write capability.
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.alphaViewer),
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.read",
        resource: { kind: "export", id: job.id },
      }),
    ).rejects.toMatchObject({ decision: { allowed: false } });

    // DELIBERATE POLICY, NOT AN OVERSIGHT: owners and admins are allowed
    // another member's export unconditionally (`decideUser` returns
    // `workspace_owner` / `workspace_admin` before any resource fact is read —
    // `authorization-policy.service.ts`). Asserted as a POSITIVE here so a
    // future narrowing of the admin role fails this suite loudly rather than
    // silently changing who can read somebody else's bytes.
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.alphaAdmin),
        workspaceId: SEED_IDS.workspaces.alpha,
        action: "export.read",
        resource: { kind: "export", id: job.id },
      }),
    ).resolves.toMatchObject({
      membershipRole: "admin",
      decision: { allowed: true, audit: { outcome: "allow", reason: "workspace_admin" } },
    });

    // CROSS-TENANT: a beta member naming an alpha export id gets 404, never
    // 403 — a 403 would confirm the id exists.
    await expect(
      harness.authorization.authorizeUser({
        principal: principal(SEED_IDS.users.betaOwner),
        workspaceId: SEED_IDS.workspaces.beta,
        action: "export.read",
        resource: { kind: "export", id: job.id },
      }),
    ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

    // And the SERVICE refuses the same id under a beta tenant context, so the
    // concealment does not depend on the transport guard having run.
    await expect(
      harness.tenant.run(
        createTenantContext({
          workspaceId: SEED_IDS.workspaces.beta,
          userId: SEED_IDS.users.betaOwner,
        }),
        () =>
          harness.exportService.read({ workspaceId: SEED_IDS.workspaces.beta, exportId: job.id }),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
  });

  it("is replay-safe: draining the same intent twice produces one artefact and one announcement", async ({
    skip,
  }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const { job } = await queueExport(harness, owner, SEED_IDS.workspaces.alpha, "Exactly once.");

    await runWorker(harness, db, job.id);
    // A redelivered BullMQ message. The claim already moved the row off
    // `queued`, so the second pass must be a clean no-op — not a second upload
    // and not a second "your export is ready" in somebody's inbox.
    await runWorker(harness, db, job.id);

    expect(
      await db.select().from(notifications).where(eq(notifications.targetId, job.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(emailDeliveries).where(eq(emailDeliveries.relatedEntityId, job.id)),
    ).toHaveLength(1);
    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
    expect(row?.status).toBe("ready");

    await db.delete(notifications).where(eq(notifications.targetId, job.id));
    await db.delete(emailDeliveries).where(eq(emailDeliveries.relatedEntityId, job.id));
  });

  it("fails cleanly when the source note is deleted before the job runs", async ({ skip }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const { noteId, noteVersion, job } = await queueExport(
      harness,
      owner,
      SEED_IDS.workspaces.alpha,
      "Doomed source.",
    );

    // The REAL delete path, so the test proves the worker reads what the
    // product actually writes rather than a hand-set flag.
    await harness.notesService.softDelete({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId,
      expectedVersion: noteVersion,
    });

    // A deleted source is ordinary user behaviour, not an incident: the job
    // must settle the row rather than throw and dead-letter.
    await expect(runWorker(harness, db, job.id)).resolves.toBeUndefined();

    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("source_unavailable");
    // Only the closed-table sentence, never raw exception text.
    expect(row?.errorMessage).toBe("The item being exported is no longer available.");
    expect(row?.objectKey).toBeNull();
    // Nothing was announced for an export that never produced bytes.
    expect(
      await db.select().from(notifications).where(eq(notifications.targetId, job.id)),
    ).toHaveLength(0);
  });

  it("refuses an unsupported format before writing anything", async ({ skip }) => {
    if (db === undefined) return skip("no reachable disposable PostgreSQL");
    const harness = build(db);
    const owner = principal(SEED_IDS.users.alphaOwner);
    const before = await db.select().from(exportJobs);

    await expect(
      harness.tenant.run(
        createTenantContext({
          workspaceId: SEED_IDS.workspaces.alpha,
          userId: SEED_IDS.users.alphaOwner,
        }),
        () =>
          harness.exportService.create({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            // Part 64 implemented `markdown`, `docx` and `zip`, so every member
            // of `ExportFormat` is now producible and there is no longer a
            // *typed* format to refuse. The guard under test was never "docx is
            // unimplemented" — it is that a format the worker could only fail
            // later is refused BEFORE a row exists. That is a runtime `includes`
            // check against `SUPPORTED_EXPORT_FORMATS`, so the value that still
            // reaches it is one the compiler never saw: a hand-assembled call, a
            // migrated row, or a deployment that SHORTENS the supported list (a
            // host with no Chromium dropping `pdf` is the realistic case). The
            // cast reproduces exactly that caller — same reasoning as
            // `export.service.test.ts`'s "refuses a format outside the
            // supported list" case.
            format: "rtf" as unknown as ExportFormat,
            sourceType: "note",
            sourceId: SEED_IDS.notes.alphaPinnedRoot,
            options: {
              includeAttachments: false,
              includeComments: false,
              includeVersionHistory: false,
              headerText: null,
              footerText: null,
              margins: null,
            },
            idempotencyKey: randomUUID(),
          }),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "EXPORT_FORMAT_UNSUPPORTED" } });

    // No queued row for a format the worker could only fail later.
    expect(await db.select().from(exportJobs)).toHaveLength(before.length);
  });
});
