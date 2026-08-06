import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { attachments, auditLogs, jobOutbox } from "../database/schema";
import { ObjectStorageDisabledError } from "../infrastructure/minio/object-storage.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { ATTACHMENT_AUDIT_ACTIONS, ATTACHMENT_DOMAIN_EVENTS } from "./attachments.constants";
import { AttachmentsService } from "./attachments.service";
import { PassthroughImageProcessor } from "./image-processing";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { SecurityConfig } from "../config/security.config";
import type { DatabaseService } from "../database/database.service";
import type {
  ObjectStore,
  PutObjectOptions,
  StorageBucket,
} from "../infrastructure/minio/object-storage.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const noteId = "20000000-0000-4000-8500-000000000002";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 0x11),
]);

const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: 10 * 1_024 * 1_024 * 1_024,
} as unknown as SecurityConfig;

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

/** Minimal in-memory `ObjectStore` double; records the exact call order. */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly calls: string[] = [];
  failOnPutNumber: number | null = null;
  private puts = 0;

  isEnabled(): boolean {
    return true;
  }

  putObject(
    _bucket: StorageBucket,
    key: string,
    body: Buffer,
    options: PutObjectOptions,
  ): Promise<{ etag: string }> {
    this.puts += 1;
    this.calls.push(`put:${key}`);
    if (this.failOnPutNumber === this.puts) {
      return Promise.reject(new Error("storage write failed"));
    }
    this.objects.set(key, { body, contentType: options.contentType });
    return Promise.resolve({ etag: `etag-${this.objects.size}` });
  }

  getObjectStream(_bucket: StorageBucket, key: string): Promise<Readable> {
    const stored = this.objects.get(key);
    if (stored === undefined) return Promise.reject(new Error("NoSuchKey"));
    return Promise.resolve(Readable.from([stored.body]));
  }

  statObject(_bucket: StorageBucket, key: string) {
    const stored = this.objects.get(key);
    return Promise.resolve(
      stored === undefined
        ? null
        : {
            size: stored.body.byteLength,
            etag: `etag-${key.slice(-8)}`,
            lastModified: new Date("2026-08-01T00:00:00Z"),
            contentType: stored.contentType,
          },
    );
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.calls.push(`remove:${key}`);
    this.objects.delete(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    this.calls.push(`removeMany:${keys.join(",")}`);
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

interface FakeRow {
  id: string;
  workspaceId: string;
  noteId: string;
  originalName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  mediaType: "image" | "file";
  processingStatus: "pending" | "processing" | "ready" | "failed";
  processingError: string | null;
  variants: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  createdById: string;
  createdAt: Date;
}

/**
 * Stubs Drizzle's fluent builder with just enough behavior to observe the
 * lifecycle: one attachment row, one workspace row, one note row, and an
 * append-only list of inserts.
 */
function fakeDatabase(options: {
  readonly noteExists?: boolean;
  readonly usedBytes?: number;
  readonly storageLimitBytes?: number | null;
  readonly workspaceExists?: boolean;
}) {
  const rows: FakeRow[] = [];
  const inserted: { table: unknown; value: Record<string, unknown> }[] = [];
  const statusHistory: string[] = [];

  const builder = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const chain = {
          where: () => chain,
          limit: () => chain,
          orderBy: () => Promise.resolve(rows.map((row) => ({ ...row }))),
          for: () => chain,
          then: (resolve: (value: unknown) => unknown) => resolve(result(table, projection)),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        inserted.push({ table, value });
        if (table === attachments) {
          // An insert is a PARTIAL row: production never sets `createdAt`,
          // because the column carries `defaultNow().notNull()`. A double that
          // stored the insert verbatim therefore left `createdAt` undefined and
          // made the service's `.toISOString()` throw. Synthesizing the column
          // default here models the real table instead of weakening production
          // code, and a supplied value still wins.
          const partial = value as unknown as Partial<FakeRow>;
          rows.push({
            ...(partial as FakeRow),
            createdAt: partial.createdAt ?? new Date(),
            processingError: null,
          });
          statusHistory.push(String(value.processingStatus));
        }
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          const row = rows[0];
          if (row !== undefined) {
            Object.assign(row, value);
            if (typeof value.processingStatus === "string") {
              statusHistory.push(value.processingStatus);
            }
          }
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => {
          const removed = rows.splice(0, rows.length);
          return Promise.resolve(removed.map((row) => ({ id: row.id })));
        },
      }),
    }),
    execute: () => Promise.resolve(),
  };

  function result(table: unknown, projection?: Record<string, unknown>): unknown[] {
    // No idempotency replay is ever stored by this double, so every upload runs
    // the full lifecycle rather than short-circuiting.
    if (projection !== undefined && "resourceId" in projection) return [];
    if (projection !== undefined && "limit" in projection) {
      return options.workspaceExists === false
        ? []
        : [{ limit: options.storageLimitBytes ?? null }];
    }
    if (projection !== undefined && "used" in projection) {
      return [{ used: String(options.usedBytes ?? 0) }];
    }
    if (table === attachments) return rows.map((row) => ({ ...row }));
    return options.noteExists === false ? [] : [{ id: noteId }];
  }

  const database = {
    db: builder,
    transaction: <T>(work: (tx: typeof builder) => Promise<T>) => work(builder),
  } as unknown as DatabaseService;

  return { database, rows, inserted, statusHistory };
}

function authorization(tenant: TenantContextService, denied = false) {
  const authorizeUser = denied
    ? vi.fn().mockRejectedValue(new Error("denied"))
    : vi.fn().mockResolvedValue({ workspaceId, userId });
  return {
    entry: {
      authorizeUser,
      run: <T>(_operation: unknown, work: () => T): T =>
        tenant.run(createTenantContext({ workspaceId, userId }), work),
    } as unknown as AuthorizationEntryService,
    authorizeUser,
  };
}

function build(
  databaseOptions: Parameters<typeof fakeDatabase>[0] = {},
  store: ObjectStore = new MemoryObjectStore(),
  denied = false,
) {
  const tenant = new TenantContextService();
  const fake = fakeDatabase(databaseOptions);
  const auth = authorization(tenant, denied);
  const service = new AttachmentsService(
    fake.database,
    auth.entry,
    tenant,
    store,
    new PassthroughImageProcessor(),
    security,
    { warn: vi.fn() } as unknown as StructuredLogger,
  );
  return { service, store, ...fake, authorizeUser: auth.authorizeUser };
}

function uploadInput() {
  return {
    principal: principal(),
    workspaceId,
    noteId,
    buffer: PNG,
    declaredMimeType: "text/html",
    declaredFilename: "shell.php",
    idempotencyKey: "upload-000000001",
    requestId: null,
  };
}

describe("AttachmentsService", () => {
  it("walks pending -> processing -> ready and persists the sniffed type, not the declared one", async () => {
    const context = build();
    const result = await context.service.uploadImage(uploadInput());

    expect(context.statusHistory).toEqual(["pending", "processing", "ready"]);
    expect(result.attachment.mimeType).toBe("image/png");
    expect(result.attachment.status).toBe("ready");
    expect(result.attachment.mediaType).toBe("image");
    expect(result.attachment.displayName).toBe("shell.png");
    expect(result.attachment.contentPath).toBe(
      `/api/v1/workspaces/${workspaceId}/attachments/${result.attachment.id}/content`,
    );
    const store = context.store as MemoryObjectStore;
    expect(store.objects.size).toBe(1);
    const [key] = [...store.objects.keys()];
    expect(key).toMatch(/^w\/[\da-f-]{36}\/a\/[\da-f-]{36}\/original\/[\da-f]{32}\.png$/u);
  });

  it("never puts an object key on the wire", async () => {
    const context = build();
    const result = await context.service.uploadImage(uploadInput());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/original/");
    expect(serialized).not.toContain('"key"');
    expect(Object.keys(result.attachment.variants.original ?? {})).toEqual([
      "width",
      "height",
      "bytes",
      "mimeType",
    ]);
  });

  it("writes the completion audit and the domain event in the ready transaction", async () => {
    const context = build();
    await context.service.uploadImage(uploadInput());
    const audits = context.inserted
      .filter((entry) => entry.table === auditLogs)
      .map((entry) => entry.value.action);
    expect(audits).toEqual([
      ATTACHMENT_AUDIT_ACTIONS.uploadStarted,
      ATTACHMENT_AUDIT_ACTIONS.uploadCompleted,
    ]);
    const outbox = context.inserted.find((entry) => entry.table === jobOutbox);
    expect(outbox?.value).toMatchObject({
      jobType: ATTACHMENT_DOMAIN_EVENTS.created,
      queueName: "attachment-domain-events",
      payloadVersion: 1,
    });
    expect(String(outbox?.value.payloadHash)).toMatch(/^[\da-f]{64}$/u);
    expect(String(outbox?.value.idempotencyKey)).toContain("attachment-domain:attachment.created:");
  });

  it("marks the row failed and removes written objects AFTER that commit", async () => {
    const store = new MemoryObjectStore();
    // Force a second write so one object is already durable when the failure
    // happens. The passthrough processor emits one object, so simulate the
    // Part 41 shape with a two-object processor.
    const twoObjectProcessor = {
      maximumInputBytes: 15 * 1_024 * 1_024,
      supports: () => true,
      process: (request: { buffer: Buffer }) =>
        Promise.resolve({
          width: 10,
          height: 10,
          blur: null,
          objects: [
            {
              variant: "original" as const,
              body: request.buffer,
              mimeType: "image/png",
              width: 10,
              height: 10,
            },
            {
              variant: "thumbnail" as const,
              body: request.buffer,
              mimeType: "image/webp",
              width: 4,
              height: 4,
            },
          ],
        }),
    };
    store.failOnPutNumber = 2;
    const tenant = new TenantContextService();
    const fake = fakeDatabase({});
    const auth = authorization(tenant);
    const service = new AttachmentsService(
      fake.database,
      auth.entry,
      tenant,
      store,
      twoObjectProcessor,
      security,
      { warn: vi.fn() } as unknown as StructuredLogger,
    );

    await expect(service.uploadImage(uploadInput())).rejects.toBeInstanceOf(ApiHttpException);
    expect(fake.statusHistory).toEqual(["pending", "processing", "failed"]);
    expect(fake.rows[0]?.processingError).toBe("storage_unavailable");

    const firstPut = store.calls.findIndex((call) => call.startsWith("put:"));
    const removal = store.calls.findIndex((call) => call.startsWith("removeMany:"));
    expect(firstPut).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(firstPut);
    // The status update commits before removal: the failure audit is already
    // recorded by the time the cleanup call is made.
    expect(
      fake.inserted.filter((entry) => entry.table === auditLogs).map((entry) => entry.value.action),
    ).toContain(ATTACHMENT_AUDIT_ACTIONS.uploadFailed);
    expect(store.objects.size).toBe(0);
  });

  it("refuses an unsupported or spoofed payload before any row or object exists", async () => {
    const context = build();
    await expect(
      context.service.uploadImage({
        ...uploadInput(),
        buffer: Buffer.from("<?php system($_GET['c']); ?>", "utf8"),
      }),
    ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });
    expect(context.rows).toEqual([]);
    expect((context.store as MemoryObjectStore).objects.size).toBe(0);
    expect(context.inserted).toEqual([]);
  });

  it("refuses SVG until Part 41 can rasterize it, without leaving a failed row", async () => {
    const context = build();
    await expect(
      context.service.uploadImage({
        ...uploadInput(),
        buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8"),
      }),
    ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });
    expect(context.rows).toEqual([]);
  });

  it("rejects an upload that would exceed the workspace quota, writing nothing", async () => {
    const context = build({ usedBytes: 1_000, storageLimitBytes: 1_010 });
    await expect(context.service.uploadImage(uploadInput())).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(context.rows).toEqual([]);
    expect((context.store as MemoryObjectStore).objects.size).toBe(0);
  });

  it("clamps a generous workspace limit to the platform ceiling", async () => {
    const context = build({
      usedBytes: security.maximumWorkspaceStorageBytes,
      storageLimitBytes: Number.MAX_SAFE_INTEGER,
    });
    await expect(context.service.uploadImage(uploadInput())).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("returns the shared not-found shape for a missing note and a missing workspace", async () => {
    await expect(
      build({ noteExists: false }).service.uploadImage(uploadInput()),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
    await expect(
      build({ workspaceExists: false }).service.uploadImage(uploadInput()),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
  });

  it("stops at the authorization entry before any SQL runs", async () => {
    const context = build({}, new MemoryObjectStore(), true);
    await expect(context.service.uploadImage(uploadInput())).rejects.toThrow("denied");
    await expect(
      context.service.readContent({
        principal: principal(),
        workspaceId,
        attachmentId: noteId,
        variant: "full",
      }),
    ).rejects.toThrow("denied");
    await expect(
      context.service.listForNote({ principal: principal(), workspaceId, noteId }),
    ).rejects.toThrow("denied");
    await expect(
      context.service.delete({ principal: principal(), workspaceId, attachmentId: noteId }),
    ).rejects.toThrow("denied");
    expect(context.inserted).toEqual([]);
    expect(context.rows).toEqual([]);
  });

  it("authorizes uploads against the target note and reads against the file", async () => {
    const context = build();
    await context.service.uploadImage(uploadInput());
    expect(context.authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action: "file.upload", resource: { kind: "note", id: noteId } }),
    );
    const id = context.rows[0]?.id ?? "";
    await context.service.readContent({
      principal: principal(),
      workspaceId,
      attachmentId: id,
      variant: "medium",
    });
    expect(context.authorizeUser).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "file.read", resource: { kind: "file", id } }),
    );
  });

  it("streams the resolved variant and falls back through the preference chain", async () => {
    const context = build();
    const uploaded = await context.service.uploadImage(uploadInput());
    for (const variant of ["thumbnail", "medium", "full"] as const) {
      const content = await context.service.readContent({
        principal: principal(),
        workspaceId,
        attachmentId: uploaded.attachment.id,
        variant,
      });
      expect(content.mimeType).toBe("image/png");
      expect(content.contentLength).toBe(PNG.byteLength);
      expect(content.filename).toBe("shell.png");
      content.stream.destroy();
    }
  });

  it("hides a row that is not ready and an object that has vanished", async () => {
    const context = build();
    const uploaded = await context.service.uploadImage(uploadInput());
    const selector = {
      principal: principal(),
      workspaceId,
      attachmentId: uploaded.attachment.id,
      variant: "full" as const,
    };

    (context.store as MemoryObjectStore).objects.clear();
    await expect(context.service.readContent(selector)).rejects.toMatchObject({
      safeResponse: { code: "NOT_FOUND" },
    });

    const row = context.rows[0];
    if (row !== undefined) row.processingStatus = "pending";
    await expect(context.service.readContent(selector)).rejects.toMatchObject({
      safeResponse: { code: "NOT_FOUND" },
    });
  });

  it("reports disabled object storage as 503, not as an anonymous 500", async () => {
    const context = build();
    const uploaded = await context.service.uploadImage(uploadInput());
    const selector = {
      principal: principal(),
      workspaceId,
      attachmentId: uploaded.attachment.id,
      variant: "full" as const,
    };

    // Storage switched off AFTER a successful upload: the row is ready and the
    // variant resolves, so the failure can only come from the storage read.
    const store = context.store as MemoryObjectStore;
    const disabled = new ObjectStorageDisabledError();
    vi.spyOn(store, "statObject").mockRejectedValue(disabled);
    await expect(context.service.readContent(selector)).rejects.toMatchObject({
      safeResponse: { code: "SERVICE_UNAVAILABLE" },
    });

    // A genuine storage fault is NOT rewritten into a clean unavailability.
    vi.spyOn(store, "statObject").mockRejectedValue(new Error("connection reset"));
    await expect(context.service.readContent(selector)).rejects.toThrow("connection reset");
  });

  it("lists note attachments with keys stripped", async () => {
    const context = build();
    await context.service.uploadImage(uploadInput());
    const listed = await context.service.listForNote({
      principal: principal(),
      workspaceId,
      noteId,
    });
    expect(listed.items).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('"key"');
    expect(context.authorizeUser).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "note.read", resource: { kind: "note", id: noteId } }),
    );
  });

  it("records deletion intent in the transaction and removes objects only afterwards", async () => {
    const context = build();
    const uploaded = await context.service.uploadImage(uploadInput());
    const store = context.store as MemoryObjectStore;
    const keys = [...store.objects.keys()];
    const before = store.calls.length;

    const result = await context.service.delete({
      principal: principal(),
      workspaceId,
      attachmentId: uploaded.attachment.id,
    });
    expect(result).toEqual({ id: uploaded.attachment.id, deleted: true });
    expect(context.rows).toEqual([]);
    expect(
      context.inserted
        .filter((entry) => entry.table === jobOutbox)
        .map((entry) => entry.value.jobType),
    ).toContain(ATTACHMENT_DOMAIN_EVENTS.deleted);
    expect(store.calls.slice(before).some((call) => call.startsWith("removeMany:"))).toBe(true);
    expect(store.objects.size).toBe(0);

    // Repeating the cleanup is a no-op, which is what makes the after-commit
    // ordering safe to retry.
    await expect(store.removeObjects("attachments", keys)).resolves.toBeUndefined();
    expect(store.objects.size).toBe(0);
  });

  it("bounds the parser to the image ceiling, never above the operator limit", () => {
    expect(build().service.maximumImageUploadBytes).toBe(15 * 1_024 * 1_024);
    const tenant = new TenantContextService();
    const lowered = new AttachmentsService(
      fakeDatabase({}).database,
      authorization(tenant).entry,
      tenant,
      new MemoryObjectStore(),
      new PassthroughImageProcessor(),
      { ...security, maximumUploadBytes: 1_024 } as unknown as SecurityConfig,
      { warn: vi.fn() } as unknown as StructuredLogger,
    );
    expect(lowered.maximumImageUploadBytes).toBe(1_024);
  });
});
