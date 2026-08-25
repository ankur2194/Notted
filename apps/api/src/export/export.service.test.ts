// Part 62 — `ExportService` unit suite.
//
// The harness is the in-repo fake-database style (`attachments.service.test.ts`,
// `notification.service.test.ts`): a hand-rolled stub of Drizzle's fluent
// builder over an in-memory row list. It is extended in exactly ONE way, and
// that extension is the whole point of this file: the fake EVALUATES the
// `WHERE` clause of every statement.
//
// Without that, a conditional `UPDATE … WHERE status = 'queued'` would be
// indistinguishable from an unconditional one, and every "illegal transition is
// a no-op" test below would pass while the production statement quietly allowed
// the transition. `whereValues` walks the Drizzle `SQL` tree, collects the bound
// parameters, and `matchesRow` applies them: id-shaped params must identify the
// row, and status-shaped params act as the guard set. That is enough to make
// the state machine genuinely observable without standing up PostgreSQL.

import { Readable } from "node:stream";

import { SUPPORTED_EXPORT_FORMATS } from "@notted/shared-types";
import { Param, SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { apiIdempotencyRecords, auditLogs, exportJobs, jobOutbox } from "../database/schema";
import { ObjectStorageDisabledError } from "../infrastructure/minio/object-storage.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { ExportJobProducer, exportGenerateIdempotencyKey } from "./export-job.producer";
import { ExportService, type ExportFailureCode } from "./export.service";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";
import type {
  ListObjectsResult,
  ObjectStore,
  StorageBucket,
  StoredObjectStat,
} from "../infrastructure/minio/object-storage.service";
import type {
  AuthenticatedPrincipal,
  ExportFormat,
  ExportOptions,
  ExportStatus,
} from "@notted/shared-types";

const userId = "40000000-0000-4000-8000-000000000001";
const otherUserId = "40000000-0000-4000-8000-000000000009";
const workspaceId = "40000000-0000-4000-8100-000000000001";
const noteId = "40000000-0000-4000-8500-000000000002";
const exportId = "40000000-0000-4000-8600-000000000003";

const EXPORT_STATUSES: readonly string[] = [
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
  "cancelled",
];

const DEFAULT_OPTIONS: ExportOptions = Object.freeze({
  includeAttachments: false,
  includeComments: false,
  includeVersionHistory: false,
  headerText: null,
  footerText: null,
  margins: null,
});

function principal(): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

interface FakeExportRow {
  id: string;
  workspaceId: string;
  requestedById: string;
  format: "pdf" | "html" | "markdown" | "txt" | "docx" | "zip";
  status: ExportStatus;
  sourceType: string;
  sourceId: string | null;
  options: unknown;
  objectKey: string | null;
  objectExpiresAt: Date | null;
  signedUrlExpiresAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

function exportRow(overrides: Partial<FakeExportRow> = {}): FakeExportRow {
  return {
    id: exportId,
    workspaceId,
    requestedById: userId,
    format: "txt",
    status: "queued",
    sourceType: "note",
    sourceId: noteId,
    options: { ...DEFAULT_OPTIONS },
    objectKey: null,
    objectExpiresAt: null,
    signedUrlExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

/** The fake row as the typed select shape `toJob` expects. */
function dbRow(overrides: Partial<FakeExportRow> = {}): typeof exportJobs.$inferSelect {
  return exportRow(overrides) as unknown as typeof exportJobs.$inferSelect;
}

/** Collects every bound parameter value out of a Drizzle condition tree. */
function whereValues(condition: unknown): unknown[] {
  const values: unknown[] = [];
  const visit = (chunk: unknown): void => {
    if (chunk instanceof SQL) {
      for (const inner of chunk.queryChunks) visit(inner);
      return;
    }
    if (Array.isArray(chunk)) {
      for (const inner of chunk) visit(inner);
      return;
    }
    if (chunk instanceof Param) values.push(chunk.value);
  };
  visit(condition);
  return values;
}

/**
 * Applies collected parameters to a row. Status-shaped strings form the guard
 * set (the row's status must be one of them); every other string must identify
 * the row through one of its identifier columns. That is exactly the shape of
 * every statement this service issues, and it fails closed for anything else.
 */
function matchesRow(row: FakeExportRow, condition: unknown): boolean {
  const strings = whereValues(condition).filter((v): v is string => typeof v === "string");
  const statuses = strings.filter((v) => EXPORT_STATUSES.includes(v));
  const identifiers = strings.filter((v) => !EXPORT_STATUSES.includes(v));
  const rowIdentifiers = [row.id, row.workspaceId, row.requestedById, row.sourceId];
  return (
    identifiers.every((value) => rowIdentifiers.includes(value)) &&
    (statuses.length === 0 || statuses.includes(row.status))
  );
}

interface InsertRecord {
  readonly handle: string;
  readonly table: unknown;
  readonly value: Record<string, unknown>;
}

function fakeDatabase(options: { rows?: FakeExportRow[]; noteTitle?: string | null } = {}) {
  const rows: FakeExportRow[] = options.rows ?? [];
  const inserted: InsertRecord[] = [];
  const idempotency: { resourceId: string; payloadHash: string }[] = [];
  const statements = { count: 0 };

  function makeBuilder(handle: string) {
    const builder = {
      select: (projection?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          statements.count += 1;
          let condition: unknown;
          const chain = {
            where: (value: unknown) => {
              condition = value;
              return chain;
            },
            orderBy: () => chain,
            limit: () => chain,
            offset: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              resolve(read(table, projection, condition)),
          };
          return chain;
        },
      }),
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          statements.count += 1;
          inserted.push({ handle, table, value });
          if (table === apiIdempotencyRecords) {
            idempotency.push({
              resourceId: String(value.resourceId),
              payloadHash: String(value.payloadHash),
            });
          }
          const created =
            table === exportJobs
              ? exportRow({
                  ...(value as unknown as Partial<FakeExportRow>),
                  // The real table supplies these defaults; a double that left
                  // them undefined would make `toJob().toISOString()` throw.
                  createdAt: new Date(),
                  completedAt: null,
                })
              : null;
          if (created !== null) rows.push(created);
          return {
            returning: () => Promise.resolve(created === null ? [] : [{ ...created }]),
            onConflictDoNothing: () => Promise.resolve(),
            then: (resolve: (value: unknown) => unknown) => resolve(undefined),
          };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            statements.count += 1;
            const affected = rows.filter((row) => matchesRow(row, condition));
            for (const row of affected) Object.assign(row, values);
            return {
              returning: () => Promise.resolve(affected.map((row) => ({ ...row }))),
              then: (resolve: (value: unknown) => unknown) => resolve(undefined),
            };
          },
        }),
      }),
      execute: () => {
        statements.count += 1;
        return Promise.resolve();
      },
    };
    return builder;
  }

  function read(
    table: unknown,
    projection: Record<string, unknown> | undefined,
    condition: unknown,
  ) {
    if (projection !== undefined && "resourceId" in projection) return [...idempotency];
    if (projection !== undefined && "title" in projection) {
      return options.noteTitle === null || options.noteTitle === undefined
        ? []
        : [{ title: options.noteTitle }];
    }
    if (table === exportJobs) {
      return rows.filter((row) => matchesRow(row, condition)).map((row) => ({ ...row }));
    }
    return [];
  }

  const db = makeBuilder("db");
  const database = {
    db,
    // A DISTINCT handle, so "both writes landed on the same transaction" is a
    // real assertion rather than a tautology over a single shared builder.
    transaction: <T>(work: (tx: typeof db) => Promise<T>) => work(makeBuilder("tx")),
  } as unknown as DatabaseService;

  return { database, rows, inserted, idempotency, statements };
}

/** Minimal in-memory `ObjectStore`; only the read path is exercised here. */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  disabled = false;

  isEnabled(): boolean {
    return !this.disabled;
  }

  putObject(_bucket: StorageBucket, key: string, body: Buffer): Promise<{ etag: string }> {
    this.objects.set(key, body);
    return Promise.resolve({ etag: "etag" });
  }

  getObjectStream(_bucket: StorageBucket, key: string): Promise<Readable> {
    if (this.disabled) return Promise.reject(new ObjectStorageDisabledError());
    const body = this.objects.get(key);
    if (body === undefined) return Promise.reject(new Error("NoSuchKey"));
    return Promise.resolve(Readable.from([body]));
  }

  statObject(_bucket: StorageBucket, key: string): Promise<StoredObjectStat | null> {
    if (this.disabled) return Promise.reject(new ObjectStorageDisabledError());
    const body = this.objects.get(key);
    return Promise.resolve(
      body === undefined
        ? null
        : {
            size: body.byteLength,
            etag: "etag",
            lastModified: new Date("2026-08-01T00:00:00Z"),
            contentType: "text/plain; charset=utf-8",
          },
    );
  }

  listObjects(): Promise<ListObjectsResult> {
    return Promise.resolve({ objects: [], truncated: false });
  }

  removeObject(): Promise<void> {
    return Promise.resolve();
  }

  removeObjects(): Promise<void> {
    return Promise.resolve();
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

function build(
  databaseOptions: Parameters<typeof fakeDatabase>[0] = {},
  store: ObjectStore = new MemoryObjectStore(),
) {
  const tenant = new TenantContextService();
  const fake = fakeDatabase(databaseOptions);
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as StructuredLogger;
  const service = new ExportService(
    fake.database,
    tenant,
    new ExportJobProducer(tenant),
    store,
    logger,
  );
  const run = <T>(work: () => Promise<T>): Promise<T> =>
    tenant.run(createTenantContext({ workspaceId, userId }), work);
  return { service, tenant, run, store, logger, ...fake };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    principal: principal(),
    workspaceId,
    format: "txt" as const,
    sourceType: "note" as const,
    sourceId: noteId,
    options: { ...DEFAULT_OPTIONS },
    idempotencyKey: "export-000000001",
    correlationId: null,
    ...overrides,
  };
}

describe("ExportService.create", () => {
  it("refuses an unsupported source before issuing any SQL", async () => {
    const { service, run, statements, inserted } = build();
    await run(async () => {
      await expect(
        service.create(createInput({ sourceType: "workspace", sourceId: null })),
      ).rejects.toMatchObject({ safeResponse: { code: "EXPORT_FORMAT_UNSUPPORTED" } });
    });
    expect(statements.count).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  /*
   * THE COVERAGE THIS TEST EXISTS FOR SURVIVED PART 64; ITS SUBJECT COULD NOT.
   *
   * Part 62 pointed it at `pdf`, Part 63 moved it to `docx`, and each time the
   * instruction was to move it rather than delete it. Part 64 implements the
   * last three formats, so `SUPPORTED_EXPORT_FORMATS` is now every member of
   * `ExportFormat` and there is no longer a *typed* format to refuse.
   *
   * The guard being protected was never really "docx is unimplemented" — it is
   * that a format the worker could only fail later is refused BEFORE a row
   * exists. That guard is a runtime `includes` check against a runtime array, so
   * the value that can still reach it is one the compiler never saw: a
   * hand-assembled service call, a migrated row, or a future deployment that
   * SHORTENS the supported list (a host with no Chromium dropping `pdf` is the
   * realistic case). The cast is the point — it reproduces exactly that caller.
   */
  it("refuses a format outside the supported list before issuing any SQL", async () => {
    const { service, run, statements, inserted } = build();
    await run(async () => {
      await expect(
        service.create(createInput({ format: "rtf" as unknown as ExportFormat })),
      ).rejects.toMatchObject({ safeResponse: { code: "EXPORT_FORMAT_UNSUPPORTED" } });
    });
    expect(statements.count).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  // Driven off the shared constant rather than a literal list: the array IS the
  // capability contract, so a format added there without a renderer arm fails
  // here instead of at generation time.
  it.each(SUPPORTED_EXPORT_FORMATS)(
    "accepts %s, a format the generator can actually produce",
    async (format) => {
      const { service, run, inserted } = build();
      await run(async () => {
        await service.create(createInput({ format }));
      });
      // Filtered by table: one `create` legitimately writes three rows in the
      // one transaction (the export, its outbox intent, the idempotency record).
      expect(inserted.filter((entry) => entry.table === exportJobs)).toHaveLength(1);
    },
  );

  it("commits the export row and its generation intent on the SAME transaction", async () => {
    const { service, run, inserted } = build();
    const job = await run(() => service.create(createInput()));

    const exportInsert = inserted.find((entry) => entry.table === exportJobs);
    const outboxInsert = inserted.find((entry) => entry.table === jobOutbox);
    expect(exportInsert).toBeDefined();
    expect(outboxInsert).toBeDefined();
    // ADR 0006: the intent is durable with the row, or neither exists.
    expect(exportInsert?.handle).toBe("tx");
    expect(outboxInsert?.handle).toBe("tx");
    expect(exportInsert?.value.status).toBe("queued");
    expect(exportInsert?.value.requestedById).toBe(userId);
    expect(outboxInsert?.value.idempotencyKey).toBe(exportGenerateIdempotencyKey(job.id));
    // Identifier-only payload: no format, no options, no content.
    expect(Object.keys(outboxInsert?.value.payload as Record<string, unknown>).sort()).toEqual([
      "action",
      "exportId",
      "intentId",
      "requestedById",
      "workspaceId",
    ]);
  });

  it("writes exactly one export.create audit row, never the options", async () => {
    const { service, run, inserted } = build();
    const job = await run(() => service.create(createInput()));

    const auditRows = inserted.filter((entry) => entry.table === auditLogs);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.handle).toBe("tx");
    expect(auditRows[0]?.value).toMatchObject({
      workspaceId,
      userId,
      action: "export.create",
      entityType: "export",
      entityId: job.id,
      metadata: { format: "txt", sourceType: "note", sourceId: noteId },
    });
    expect(JSON.stringify(auditRows[0]?.value.metadata)).not.toContain("includeAttachments");
  });

  it("replays an identical idempotency key without a second export.create audit row", async () => {
    const { service, run, inserted } = build();
    await run(() => service.create(createInput()));
    await run(() => service.create(createInput()));

    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(1);
  });

  it("replays an identical idempotency key to the same export without a second insert", async () => {
    const { service, run, inserted } = build();
    const first = await run(() => service.create(createInput()));
    const second = await run(() => service.create(createInput()));

    expect(second.id).toBe(first.id);
    expect(inserted.filter((entry) => entry.table === exportJobs)).toHaveLength(1);
    expect(inserted.filter((entry) => entry.table === jobOutbox)).toHaveLength(1);
  });

  it("rejects a reused idempotency key carrying a different payload", async () => {
    const { service, run, inserted } = build();
    await run(() => service.create(createInput()));
    await run(async () => {
      await expect(
        service.create(
          createInput({ options: { ...DEFAULT_OPTIONS, headerText: "Confidential" } }),
        ),
      ).rejects.toMatchObject({ safeResponse: { code: "IDEMPOTENCY_KEY_REUSED" } });
    });
    expect(inserted.filter((entry) => entry.table === exportJobs)).toHaveLength(1);
  });
});

describe("ExportService.list", () => {
  it("returns only the requester's own exports, newest first, with a bounded page", async () => {
    const rows = [exportRow({ id: exportId, requestedById: userId })];
    const { service, run } = build({ rows });
    const page = await run(() =>
      service.list({ workspaceId, requestedById: userId, page: 1, limit: 20 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);

    const foreign = await run(() =>
      service.list({ workspaceId, requestedById: otherUserId, page: 1, limit: 20 }),
    );
    expect(foreign.items).toHaveLength(0);
  });
});

describe("ExportService.read", () => {
  it("404s a row that is not in the active workspace, without leaking existence", async () => {
    const rows = [exportRow({ workspaceId: "40000000-0000-4000-8100-000000000099" })];
    const { service, run } = build({ rows });
    await run(async () => {
      await expect(service.read({ workspaceId, exportId })).rejects.toMatchObject({
        safeResponse: { code: "NOT_FOUND" },
      });
    });
  });
});

describe("ExportService state machine", () => {
  it("claims a queued row exactly once", async () => {
    const rows = [exportRow({ status: "queued" })];
    const { service, run } = build({ rows });
    const claim = await run(() => service.claim({ workspaceId, exportId }));
    expect(claim?.id).toBe(exportId);
    expect(claim?.format).toBe("txt");
    expect(claim?.sourceType).toBe("note");
    expect(rows[0]?.status).toBe("processing");
    // A redelivered message finds nothing to claim.
    expect(await run(() => service.claim({ workspaceId, exportId }))).toBeNull();
  });

  it.each(["processing", "ready", "failed", "cancelled", "expired"] as const)(
    "claim on a %s row is a no-op returning null, never a throw",
    async (status) => {
      const rows = [exportRow({ status })];
      const { service, run } = build({ rows });
      expect(await run(() => service.claim({ workspaceId, exportId }))).toBeNull();
      expect(rows[0]?.status).toBe(status);
    },
  );

  it("marks a processing row ready and grants a bounded download window", async () => {
    const rows = [exportRow({ status: "processing" })];
    const { service, run } = build({ rows });
    const marked = await run(() =>
      service.markReady({
        workspaceId,
        exportId,
        objectKey: `${workspaceId}/${exportId}.txt`,
        byteLength: 12,
      }),
    );
    expect(marked).toBe(true);
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.signedUrlExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]?.objectExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]?.errorCode).toBeNull();
  });

  it.each(["queued", "ready", "cancelled"] as const)(
    "markReady on a %s row is a no-op returning false",
    async (status) => {
      const rows = [exportRow({ status })];
      const { service, run } = build({ rows });
      const marked = await run(() =>
        service.markReady({ workspaceId, exportId, objectKey: "k", byteLength: 1 }),
      );
      expect(marked).toBe(false);
      expect(rows[0]?.status).toBe(status);
      expect(rows[0]?.objectKey).toBeNull();
    },
  );

  it.each(["ready", "cancelled", "expired"] as const)(
    "markFailed on a %s row is a no-op returning false",
    async (status) => {
      const rows = [exportRow({ status })];
      const { service, run } = build({ rows });
      const marked = await run(() =>
        service.markFailed({ workspaceId, exportId, errorCode: "generation_failed" }),
      );
      expect(marked).toBe(false);
      expect(rows[0]?.status).toBe(status);
      expect(rows[0]?.errorMessage).toBeNull();
    },
  );

  it.each(["queued", "processing"] as const)(
    "cancels a %s row and writes exactly one export.cancel audit row",
    async (status) => {
      const rows = [exportRow({ status })];
      const { service, run, inserted } = build({ rows });
      const job = await run(() => service.cancel({ workspaceId, exportId }));
      expect(job.status).toBe("cancelled");
      expect(job.completedAt).not.toBeNull();
      const auditRows = inserted.filter((entry) => entry.table === auditLogs);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.handle).toBe("tx");
      expect(auditRows[0]?.value).toMatchObject({
        workspaceId,
        userId,
        action: "export.cancel",
        entityType: "export",
        entityId: exportId,
      });
    },
  );

  it("treats cancelling an already-ready export as a no-op, not an error, and writes no audit row", async () => {
    const rows = [
      exportRow({
        status: "ready",
        objectKey: "k",
        signedUrlExpiresAt: new Date(Date.now() + 60_000),
      }),
    ];
    const { service, run, inserted } = build({ rows });
    const job = await run(() => service.cancel({ workspaceId, exportId }));
    expect(job.status).toBe("ready");
    expect(rows[0]?.status).toBe("ready");
    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(0);
  });
});

describe("ExportService.markFailed", () => {
  const codes: readonly ExportFailureCode[] = [
    "source_unavailable",
    "source_forbidden",
    "format_unsupported",
    "generation_failed",
    "storage_unavailable",
  ];

  it.each(codes)("stores only the closed-set sentence for %s", async (errorCode) => {
    const rows = [exportRow({ status: "processing" })];
    const { service, run } = build({ rows });
    expect(await run(() => service.markFailed({ workspaceId, exportId, errorCode }))).toBe(true);

    const message = rows[0]?.errorMessage ?? "";
    expect(rows[0]?.errorCode).toBe(errorCode);
    // The persisted text is a sentence written for a user, never the code and
    // never anything an exception could have carried into it.
    expect(message).not.toBe(errorCode);
    expect(message).not.toContain(errorCode);
    expect(message).not.toMatch(/Error|at .*\(|\/|stack|undefined|null/u);
    expect(message.endsWith(".")).toBe(true);
  });
});

describe("ExportService.openDownload", () => {
  it("refuses an export whose download grant has lapsed, and writes no audit row", async () => {
    const rows = [
      exportRow({
        status: "ready",
        objectKey: `${workspaceId}/${exportId}.txt`,
        signedUrlExpiresAt: new Date(Date.now() - 1_000),
      }),
    ];
    const { service, run, inserted } = build({ rows });
    await run(async () => {
      await expect(service.openDownload({ workspaceId, exportId })).rejects.toMatchObject({
        safeResponse: { code: "EXPORT_EXPIRED" },
      });
    });
    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(0);
  });

  it("refuses an export whose object has already been swept away, and writes no audit row", async () => {
    const rows = [
      exportRow({
        status: "ready",
        objectKey: `${workspaceId}/${exportId}.txt`,
        signedUrlExpiresAt: new Date(Date.now() + 60_000),
      }),
    ];
    const { service, run, inserted } = build({ rows });
    await run(async () => {
      await expect(service.openDownload({ workspaceId, exportId })).rejects.toMatchObject({
        safeResponse: { code: "EXPORT_OBJECT_UNAVAILABLE" },
      });
    });
    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(0);
  });

  it("refuses a non-ready export even though the policy already should have, and writes no audit row", async () => {
    const rows = [exportRow({ status: "processing" })];
    const { service, run, inserted } = build({ rows });
    await run(async () => {
      await expect(service.openDownload({ workspaceId, exportId })).rejects.toMatchObject({
        safeResponse: { code: "EXPORT_OBJECT_UNAVAILABLE" },
      });
    });
    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(0);
  });

  it("streams the bytes with a sanitised filename derived from the live source, and writes one export.download audit row", async () => {
    const objectKey = `${workspaceId}/${exportId}.txt`;
    const rows = [
      exportRow({
        status: "ready",
        objectKey,
        signedUrlExpiresAt: new Date(Date.now() + 60_000),
      }),
    ];
    const store = new MemoryObjectStore();
    store.objects.set(objectKey, Buffer.from("hello", "utf8"));
    const { service, run, inserted } = build({ rows, noteTitle: "../../etc/passwd" }, store);
    const content = await run(() => service.openDownload({ workspaceId, exportId }));
    expect(content.filename).toBe("etcpasswd.txt");
    expect(content.mimeType).toBe("text/plain; charset=utf-8");
    expect(content.contentLength).toBe(5);
    const auditRows = inserted.filter((entry) => entry.table === auditLogs);
    expect(auditRows).toHaveLength(1);
    // No transaction on this read path — the audit row lands on the plain `db` handle.
    expect(auditRows[0]?.handle).toBe("db");
    expect(auditRows[0]?.value).toMatchObject({
      workspaceId,
      userId,
      action: "export.download",
      entityType: "export",
      entityId: exportId,
      metadata: { format: "txt" },
    });
  });

  it("degrades to a stable 503 when object storage is switched off, and writes no audit row", async () => {
    const rows = [
      exportRow({
        status: "ready",
        objectKey: `${workspaceId}/${exportId}.txt`,
        signedUrlExpiresAt: new Date(Date.now() + 60_000),
      }),
    ];
    const store = new MemoryObjectStore();
    store.disabled = true;
    const { service, run, inserted } = build({ rows }, store);
    await run(async () => {
      const error = await service.openDownload({ workspaceId, exportId }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiHttpException);
      expect((error as ApiHttpException).safeResponse.code).toBe("SERVICE_UNAVAILABLE");
    });
    expect(inserted.filter((entry) => entry.table === auditLogs)).toHaveLength(0);
  });
});

describe("ExportService.toJob", () => {
  it("never emits an object key and withholds the path until the export is ready", () => {
    const { service } = build();
    const queued = service.toJob(dbRow({ status: "queued" }));
    expect("objectKey" in queued).toBe(false);
    expect(JSON.stringify(queued)).not.toContain(".txt");
    expect(queued.downloadPath).toBeNull();
    expect(queued.downloadExpiresAt).toBeNull();
  });

  it("withholds the path from a ready export whose grant has lapsed", () => {
    const { service } = build();
    const lapsed = service.toJob(
      dbRow({ status: "ready", objectKey: "k", signedUrlExpiresAt: new Date(Date.now() - 1_000) }),
    );
    expect(lapsed.downloadPath).toBeNull();
    // The ceiling itself is still reported, so the client can explain why.
    expect(lapsed.downloadExpiresAt).not.toBeNull();
  });

  it("offers the login-gated path for a ready export inside its grant", () => {
    const { service } = build();
    const ready = service.toJob(
      dbRow({ status: "ready", objectKey: "k", signedUrlExpiresAt: new Date(Date.now() + 60_000) }),
    );
    expect(ready.downloadPath).toBe(
      `/api/v1/workspaces/${workspaceId}/exports/${exportId}/download`,
    );
  });

  it("falls back to default options for a legacy empty jsonb value", () => {
    const { service } = build();
    const job = service.toJob(dbRow({ options: {} }));
    expect(job.options).toEqual(DEFAULT_OPTIONS);
  });
});

describe("fake database harness", () => {
  it("evaluates the guard clause, so a conditional update is genuinely conditional", () => {
    const row = exportRow({ status: "ready" });
    // Mirrors the shape of `markReady`'s WHERE: id + workspace + prior status.
    expect(matchesRow(row, whereValuesFixture("queued"))).toBe(false);
    expect(matchesRow(row, whereValuesFixture("ready"))).toBe(true);
  });
});

/** Builds a condition tree with the same shape the service produces. */
function whereValuesFixture(status: string): SQL {
  return new SQL([new Param(exportId), new Param(workspaceId), new Param(status)]);
}
