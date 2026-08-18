// Part 64 — `NoteExportSourceService` unit suite.
//
// The harness is the in-repo fake-database style (`export.service.test.ts`,
// `attachments.service.test.ts`) with the same crucial extension: the fake
// EVALUATES the `WHERE` clause. Without that, a query missing its workspace
// predicate would be indistinguishable from one that has it, and every tenant
// isolation test below would pass against a cross-tenant read. `whereValues`
// walks the Drizzle `SQL` tree for bound parameters and `matches` applies them:
// every string parameter must identify the row, and every boolean parameter must
// match one of the row's flags.
//
// It also records the ACTIVE TENANT CONTEXT at the moment each statement is
// issued. That is what turns "every row read happens inside `run(operation, …)`"
// into an assertion rather than a hope — a statement issued outside the
// authorized operation would record `null` (and, in production, `whereWorkspace`
// would throw outright).

import { Readable } from "node:stream";

import { Param, SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { attachments, comments, noteVersions } from "../database/schema";
import { ObjectStorageDisabledError } from "../infrastructure/minio/object-storage.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteExportSourceService } from "./note-export-source.service";

import type { ExportSourceSubject } from "./export-renderers";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";
import type {
  ListObjectsResult,
  ObjectStore,
  StorageBucket,
  StoredObjectStat,
} from "../infrastructure/minio/object-storage.service";
import type { ExportOptions } from "@notted/shared-types";

const workspaceId = "64000000-0000-4000-8100-000000000001";
const otherWorkspaceId = "64000000-0000-4000-8100-00000000000f";
const noteId = "64000000-0000-4000-8500-000000000002";
const requestedById = "64000000-0000-4000-8000-000000000003";

const SECRET_FILENAME = "board-minutes-confidential.pdf";
const SECRET_KEY = "workspaces/64000000/attachments/secret-object";
const SECRET_CONTENT = "the comment body nobody may log";

const subject: ExportSourceSubject = Object.freeze({
  workspaceId,
  noteId,
  requestedById,
  correlationId: "correlation",
});

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return Object.freeze({
    includeAttachments: false,
    includeComments: false,
    includeVersionHistory: false,
    headerText: null,
    footerText: null,
    margins: null,
    ...overrides,
  });
}

const ALL_INCLUDED = options({
  includeAttachments: true,
  includeComments: true,
  includeVersionHistory: true,
});

// The audit facts are irrelevant to "does a denial propagate"; building a real
// decision would import half the policy layer to assert nothing extra.
const DENIAL = new AuthorizationDeniedError({
  allowed: false,
  code: "authorization.concealed",
  httpStatus: 404,
  safeMessage: "Not found",
  audit: {},
} as unknown as ConstructorParameters<typeof AuthorizationDeniedError>[0]);

interface FakeRow {
  readonly identifiers: readonly string[];
  readonly flags: readonly boolean[];
  readonly values: Record<string, unknown>;
}

function attachmentRow(overrides: Record<string, unknown> = {}): FakeRow {
  const values = {
    id: "att-1",
    noteId,
    workspaceId,
    processingStatus: "ready",
    filename: SECRET_FILENAME,
    mimeType: "application/pdf",
    sizeBytes: 12,
    storageKey: SECRET_KEY,
    variants: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    // The parent note's flag, carried exactly as `commentRow`/`versionRow` do:
    // `readAttachments` joins `notes` for `is_deleted` so the three sibling
    // reads are symmetric.
    noteIsDeleted: false,
    ...overrides,
  };
  return {
    values,
    identifiers: [
      String(values.id),
      String(values.noteId),
      String(values.workspaceId),
      String(values.processingStatus),
    ],
    flags: [Boolean(values.noteIsDeleted)],
  };
}

function commentRow(overrides: Record<string, unknown> = {}): FakeRow {
  const values = {
    id: "com-1",
    parentId: null,
    content: SECRET_CONTENT,
    isResolved: false,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    authorName: "Ada Lovelace",
    noteWorkspaceId: workspaceId,
    noteIsDeleted: false,
    noteId,
    ...overrides,
  };
  return {
    values,
    identifiers: [String(values.id), String(values.noteId), String(values.noteWorkspaceId)],
    flags: [Boolean(values.noteIsDeleted)],
  };
}

function versionRow(overrides: Record<string, unknown> = {}): FakeRow {
  const values = {
    id: "ver-1",
    version: 7,
    content: { type: "doc", content: [] },
    createdAt: new Date("2026-08-03T00:00:00Z"),
    createdByName: "Ada Lovelace",
    noteWorkspaceId: workspaceId,
    noteIsDeleted: false,
    noteId,
    ...overrides,
  };
  return {
    values,
    identifiers: [String(values.id), String(values.noteId), String(values.noteWorkspaceId)],
    flags: [Boolean(values.noteIsDeleted)],
  };
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

function matches(row: FakeRow, condition: unknown): boolean {
  return whereValues(condition).every((value) =>
    typeof value === "boolean"
      ? row.flags.includes(value)
      : row.identifiers.includes(String(value)),
  );
}

interface Statement {
  readonly table: unknown;
  readonly scope: string | null;
  readonly limit: number | null;
}

function fakeDatabase(
  tenant: TenantContextService,
  rows: {
    attachments?: FakeRow[];
    comments?: FakeRow[];
    versions?: FakeRow[];
  } = {},
) {
  const statements: Statement[] = [];
  const source = (table: unknown): FakeRow[] => {
    if (table === attachments) return rows.attachments ?? [];
    if (table === comments) return rows.comments ?? [];
    if (table === noteVersions) return rows.versions ?? [];
    return [];
  };

  const db = {
    select: () => ({
      from: (table: unknown) => {
        let condition: unknown;
        let limit: number | null = null;
        const chain = {
          innerJoin: () => chain,
          where: (value: unknown) => {
            condition = value;
            return chain;
          },
          orderBy: () => chain,
          limit: (value: number) => {
            limit = value;
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) => {
            statements.push({
              table,
              scope: tenant.tryGet()?.workspaceId ?? null,
              limit,
            });
            return resolve(
              source(table)
                .filter((row) => matches(row, condition))
                .map((row) => ({ ...row.values })),
            );
          },
        };
        return chain;
      },
    }),
  };

  return {
    statements,
    database: { db } as unknown as DatabaseService,
  };
}

function fakeAuthorization(tenant: TenantContextService, denial?: Error) {
  const authorizeUserJob = vi.fn((input: { workspaceId: string; userId: string }) =>
    denial === undefined
      ? Promise.resolve({ workspaceId: input.workspaceId, userId: input.userId })
      : Promise.reject(denial),
  );
  const service = {
    authorizeUserJob,
    run: <T>(operation: { workspaceId: string; userId: string }, work: () => T): T =>
      tenant.run(
        createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
        work,
      ),
  } as unknown as AuthorizationEntryService;
  return { authorizeUserJob, service };
}

/** Minimal `ObjectStore`; only `getObjectStream` is exercised by this service. */
class StubObjectStore implements ObjectStore {
  streams = new Map<string, () => Readable>();
  disabled = false;
  lastStream: Readable | null = null;

  isEnabled(): boolean {
    return !this.disabled;
  }

  putObject(): Promise<{ etag: string }> {
    return Promise.resolve({ etag: "etag" });
  }

  getObjectStream(_bucket: StorageBucket, key: string): Promise<Readable> {
    if (this.disabled) return Promise.reject(new ObjectStorageDisabledError());
    const factory = this.streams.get(key);
    if (factory === undefined) return Promise.reject(new Error("NoSuchKey"));
    const stream = factory();
    this.lastStream = stream;
    return Promise.resolve(stream);
  }

  statObject(): Promise<StoredObjectStat | null> {
    return Promise.resolve(null);
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
  rows: Parameters<typeof fakeDatabase>[1] = {},
  authorizationDenial?: Error,
  store: StubObjectStore = new StubObjectStore(),
) {
  const tenant = new TenantContextService();
  const fake = fakeDatabase(tenant, rows);
  const authorization = fakeAuthorization(tenant, authorizationDenial);
  const logged: unknown[] = [];
  const record = (metadata: unknown, message: string): void => {
    logged.push(metadata, message);
  };
  const logger = { info: vi.fn(record), warning: vi.fn(record) } as unknown as StructuredLogger;
  const service = new NoteExportSourceService(
    fake.database,
    authorization.service,
    tenant,
    store,
    logger,
  );
  return {
    service,
    store,
    logged,
    statements: fake.statements,
    authorizeUserJob: authorization.authorizeUserJob,
  };
}

describe("NoteExportSourceService.load", () => {
  it("authorizes note.read once for the requester and reads every row inside the operation", async () => {
    const harness = build({
      attachments: [attachmentRow()],
      comments: [commentRow()],
      versions: [versionRow()],
    });

    const bundle = await harness.service.load(subject, ALL_INCLUDED);

    expect(harness.authorizeUserJob).toHaveBeenCalledTimes(1);
    expect(harness.authorizeUserJob).toHaveBeenCalledWith({
      userId: requestedById,
      workspaceId,
      action: "note.read",
      resource: { kind: "note", id: noteId },
      correlationId: "correlation",
    });
    expect(harness.statements).toHaveLength(3);
    // Every statement ran with the authorized workspace active, and every
    // statement is bounded.
    expect(harness.statements.map((statement) => statement.scope)).toEqual([
      workspaceId,
      workspaceId,
      workspaceId,
    ]);
    expect(harness.statements.every((statement) => (statement.limit ?? 0) > 0)).toBe(true);
    expect(bundle.attachments).toHaveLength(1);
    expect(bundle.comments).toHaveLength(1);
    expect(bundle.versions).toHaveLength(1);
  });

  it("propagates an authorization denial and reads nothing", async () => {
    const harness = build({ attachments: [attachmentRow()] }, DENIAL);

    await expect(harness.service.load(subject, ALL_INCLUDED)).rejects.toBe(DENIAL);
    expect(harness.statements).toHaveLength(0);
  });

  it("never returns a row from another workspace", async () => {
    const harness = build({
      attachments: [attachmentRow({ id: "foreign", workspaceId: otherWorkspaceId })],
      comments: [commentRow({ id: "foreign", noteWorkspaceId: otherWorkspaceId })],
      versions: [versionRow({ id: "foreign", noteWorkspaceId: otherWorkspaceId })],
    });

    const bundle = await harness.service.load(subject, ALL_INCLUDED);

    expect(bundle).toEqual({ attachments: [], comments: [], versions: [] });
  });

  it("never returns a row belonging to another note", async () => {
    const harness = build({
      attachments: [
        attachmentRow({ id: "other-note", noteId: "64000000-0000-4000-8500-0000000000ff" }),
      ],
      comments: [commentRow({ id: "other-note", noteId: "64000000-0000-4000-8500-0000000000ff" })],
      versions: [versionRow({ id: "other-note", noteId: "64000000-0000-4000-8500-0000000000ff" })],
    });

    const bundle = await harness.service.load(subject, ALL_INCLUDED);

    expect(bundle).toEqual({ attachments: [], comments: [], versions: [] });
  });

  it("issues no query at all for an excluded list", async () => {
    const harness = build({
      attachments: [attachmentRow()],
      comments: [commentRow()],
      versions: [versionRow()],
    });

    const bundle = await harness.service.load(subject, options({ includeComments: true }));

    expect(harness.statements).toHaveLength(1);
    expect(harness.statements[0]?.table).toBe(comments);
    expect(bundle.attachments).toEqual([]);
    expect(bundle.versions).toEqual([]);
    expect(bundle.comments).toHaveLength(1);
  });

  it("excludes attachments that are not ready and everything hanging off a deleted note", async () => {
    // `attachments` itself has no `is_deleted` column: an attachment delete is a
    // HARD delete, so only `processing_status` distinguishes a row whose bytes
    // exist. The PARENT note's flag is honoured by all three reads alike.
    const harness = build({
      attachments: [
        attachmentRow({ id: "pending", processingStatus: "pending" }),
        attachmentRow({ id: "failed", processingStatus: "failed" }),
        attachmentRow({ id: "trashed", noteIsDeleted: true }),
      ],
      comments: [commentRow({ id: "trashed", noteIsDeleted: true })],
      versions: [versionRow({ id: "trashed", noteIsDeleted: true })],
    });

    const bundle = await harness.service.load(subject, ALL_INCLUDED);

    expect(bundle).toEqual({ attachments: [], comments: [], versions: [] });
  });

  it("reads the object key from the authorized row, never the other way round", async () => {
    const harness = build({ attachments: [attachmentRow()] });

    const bundle = await harness.service.load(subject, options({ includeAttachments: true }));

    expect(bundle.attachments[0]).toEqual({
      attachmentId: "att-1",
      filename: SECRET_FILENAME,
      mimeType: "application/pdf",
      sizeBytes: 12,
      objectKey: SECRET_KEY,
    });
  });

  it("resolves one object address per row through attachmentObjectKeys", async () => {
    const harness = build({
      attachments: [
        attachmentRow({
          variants: { original: { key: "variants/original", width: 1, height: 1, bytes: 1 } },
        }),
      ],
    });

    const bundle = await harness.service.load(subject, options({ includeAttachments: true }));

    expect(bundle.attachments[0]?.objectKey).toBe(SECRET_KEY);
  });

  it("logs identifiers and counts only — never a filename, key or content", async () => {
    const harness = build({
      attachments: [attachmentRow()],
      comments: [commentRow()],
      versions: [versionRow()],
    });

    await harness.service.load(subject, ALL_INCLUDED);

    const serialized = JSON.stringify(harness.logged);
    expect(serialized).not.toContain(SECRET_FILENAME);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_CONTENT);
    expect(serialized).toContain(noteId);
  });
});

describe("NoteExportSourceService.readObject", () => {
  it("returns the bytes for a readable object", async () => {
    const harness = build();
    harness.store.streams.set(SECRET_KEY, () => Readable.from([Buffer.from("hello")]));

    await expect(harness.service.readObject(SECRET_KEY, 1_000)).resolves.toEqual(
      Buffer.from("hello"),
    );
  });

  it("returns null for a missing object instead of throwing", async () => {
    const harness = build();

    await expect(harness.service.readObject(SECRET_KEY, 1_000)).resolves.toBeNull();
  });

  it("returns null when object storage is disabled", async () => {
    const harness = build();
    harness.store.disabled = true;

    await expect(harness.service.readObject(SECRET_KEY, 1_000)).resolves.toBeNull();
  });

  it("stops and destroys the stream once the cap is exceeded", async () => {
    const harness = build();
    let pulled = 0;
    harness.store.streams.set(SECRET_KEY, () =>
      Readable.from(
        (function* chunks() {
          for (let index = 0; index < 1_000; index += 1) {
            pulled += 1;
            yield Buffer.alloc(4, 0x41);
          }
        })(),
        { objectMode: true, highWaterMark: 1 },
      ),
    );

    await expect(harness.service.readObject(SECRET_KEY, 5)).resolves.toBeNull();
    expect(harness.store.lastStream?.destroyed).toBe(true);
    // The point of the cap is that the oversized object never occupies the
    // memory it was denied: reading stops within a chunk or two of the limit,
    // not after the whole 4 KiB has been pulled through.
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it("returns null and logs only an error class when the stream fails", async () => {
    const harness = build();
    harness.store.streams.set(SECRET_KEY, () =>
      Readable.from(
        (function* chunks() {
          yield Buffer.from("ok");
          throw new Error(`stream failed for ${SECRET_KEY}`);
        })(),
      ),
    );

    await expect(harness.service.readObject(SECRET_KEY, 1_000)).resolves.toBeNull();
    expect(JSON.stringify(harness.logged)).not.toContain(SECRET_KEY);
  });
});
