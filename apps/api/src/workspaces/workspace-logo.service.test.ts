import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { auditLogs } from "../database/schema";
import { ObjectStorageDisabledError } from "../infrastructure/minio/object-storage.service";
import { createTenantContext, TenantContextService } from "../tenant";

import {
  parseWorkspaceLogoUrl,
  WorkspaceLogoService,
  workspaceLogoObjectKey,
  workspaceLogoUrl,
} from "./workspace-logo.service";
import { WORKSPACE_AUDIT_ACTIONS } from "./workspaces.constants";

import type { ImageProcessingService } from "../attachments/image-processing.service";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { ApiHttpException } from "../common/errors/api-http.exception";
import type { DatabaseService } from "../database/database.service";
import type {
  ListObjectsResult,
  ObjectStorageService,
  ObjectStore,
  PutObjectResult,
  StorageBucket,
  StoredObjectStat,
} from "../infrastructure/minio/object-storage.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const otherWorkspaceId = "20000000-0000-4000-8100-000000000002";
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

/** A real PNG signature: the service sniffs BYTES, never a declared type. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 0x11),
]);
/** DOS/PE header — a payload that cannot sniff as any image. */
const NOT_AN_IMAGE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
/**
 * Recognisable ASCII so "the audit row carries no image bytes" can be asserted
 * as a substring search over the serialized row rather than a shape check that
 * would pass even if the bytes were smuggled in under some other key.
 */
const THUMBNAIL_BODY = Buffer.from("WEBPTHUMBNAILBYTES", "utf8");

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

/** Captures the thrown `ApiHttpException` so BOTH its status and code can be asserted. */
async function rejection(work: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await work;
  } catch (error: unknown) {
    return error as ApiHttpException;
  }
  throw new Error("expected the call to reject");
}

/**
 * Emits the `thumbnail` variant the service selects. Deliberately NOT
 * `PassthroughImageProcessor`: that seam only produces `original`, so every
 * upload here would fail rendition selection and prove nothing. Sharp stays out
 * of this suite — the unit under test is the row/object/audit choreography.
 */
class ThumbnailImageProcessor {
  readonly maximumInputBytes = 2 * 1_024 * 1_024;

  supports(): boolean {
    return true;
  }

  process(): Promise<{
    width: number | null;
    height: number | null;
    objects: readonly { variant: string; body: Buffer; mimeType: string }[];
    blur: null;
  }> {
    return Promise.resolve({
      width: 200,
      height: 80,
      objects: [{ variant: "thumbnail", body: THUMBNAIL_BODY, mimeType: "image/webp" }],
      blur: null,
    });
  }
}

/**
 * In-memory `ObjectStore` double. Every call is appended to the SHARED
 * `operations` log the fake database also writes to, which is what makes
 * "the superseded object is removed only after the row commits" observable.
 */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  disabled = false;
  failRemove = false;

  constructor(private readonly operations: string[]) {}

  isEnabled(): boolean {
    return !this.disabled;
  }

  putObject(_bucket: StorageBucket, key: string, body: Buffer): Promise<PutObjectResult> {
    if (this.disabled) return Promise.reject(new ObjectStorageDisabledError());
    this.operations.push(`put:${key}`);
    this.objects.set(key, body);
    return Promise.resolve({ etag: "put-etag" });
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
            etag: `stat-${key.slice(-8)}`,
            lastModified: new Date("2026-08-01T00:00:00Z"),
            contentType: "image/webp",
          },
    );
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.operations.push(`remove:${key}`);
    if (this.failRemove) return Promise.reject(new Error("storage delete failed"));
    this.objects.delete(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  listObjects(): Promise<ListObjectsResult> {
    return Promise.resolve({ objects: [], truncated: false });
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

interface LogoRow {
  id: string;
  logoUrl: string | null;
}

/**
 * Stubs Drizzle's fluent builder with the three shapes this service uses: one
 * `select ... limit(1)`, one `update ... set ... where`, and the audit insert.
 * The row is mutated by the update so the same double answers a later read the
 * way the committed table would.
 */
function fakeDatabase(operations: string[], row: LogoRow | undefined) {
  const inserted: { table: unknown; value: Record<string, unknown> }[] = [];

  const builder = {
    select: () => ({
      from: () => {
        const chain = {
          where: () => chain,
          limit: () => Promise.resolve(row === undefined ? [] : [{ ...row }]),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          operations.push(`update:${String(value.logoUrl)}`);
          if (row !== undefined) row.logoUrl = value.logoUrl as string | null;
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        inserted.push({ table, value });
        return Promise.resolve();
      },
    }),
  };

  const database = {
    db: builder,
    transaction: <T>(work: (tx: typeof builder) => Promise<T>): Promise<T> => work(builder),
  } as unknown as DatabaseService;

  return { database, inserted };
}

function build(options: { readonly row?: LogoRow } = {}) {
  const tenant = new TenantContextService();
  const operations: string[] = [];
  const row = "row" in options ? options.row : { id: workspaceId, logoUrl: null as string | null };
  const { database, inserted } = fakeDatabase(operations, row);
  const store = new MemoryObjectStore(operations);
  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId, userId });
  const entry = {
    authorizeUser,
    // A REAL tenant ALS context on the same workspace, so `whereWorkspaceId`
    // resolves inside the scoped transaction instead of throwing.
    run: <T>(_operation: unknown, work: () => T): T =>
      tenant.run(createTenantContext({ workspaceId, userId }), work),
  } as unknown as AuthorizationEntryService;

  const service = new WorkspaceLogoService(
    database,
    entry,
    tenant,
    new ThumbnailImageProcessor() as unknown as ImageProcessingService,
    store as unknown as ObjectStorageService,
  );
  return { service, store, operations, inserted, authorizeUser, row };
}

function auditRows(inserted: { table: unknown; value: Record<string, unknown> }[]) {
  return inserted.filter((entry) => entry.table === auditLogs).map((entry) => entry.value);
}

function mutationInput() {
  return { principal: principal(), workspaceId, requestId: null };
}

describe("workspace logo addressing", () => {
  it("round-trips a workspace and token through the object key and the stored URL", () => {
    expect(workspaceLogoObjectKey(workspaceId, TOKEN_A)).toBe(
      `workspaces/${workspaceId}/logo/${TOKEN_A}.webp`,
    );
    expect(workspaceLogoUrl(workspaceId, TOKEN_A)).toBe(
      `/api/v1/workspaces/${workspaceId}/logo/${TOKEN_A}`,
    );
    expect(parseWorkspaceLogoUrl(workspaceLogoUrl(workspaceId, TOKEN_A), workspaceId)).toEqual({
      workspaceId,
      token: TOKEN_A,
    });
  });

  it("refuses any stored value that is not this workspace's own app-relative path", () => {
    // No logo at all.
    expect(parseWorkspaceLogoUrl(null, workspaceId)).toBeNull();
    // A pre-Part-72 external URL: the column has always been "a URL the
    // branding renderers may use", so old rows can hold one.
    expect(parseWorkspaceLogoUrl("https://cdn.example.test/logo.png", workspaceId)).toBeNull();
    // Malformed tokens: short, non-hex, and a traversal attempt.
    expect(
      parseWorkspaceLogoUrl(`/api/v1/workspaces/${workspaceId}/logo/abc`, workspaceId),
    ).toBeNull();
    expect(
      parseWorkspaceLogoUrl(
        `/api/v1/workspaces/${workspaceId}/logo/${"z".repeat(32)}`,
        workspaceId,
      ),
    ).toBeNull();
    expect(
      parseWorkspaceLogoUrl(`/api/v1/workspaces/${workspaceId}/logo/../../secret`, workspaceId),
    ).toBeNull();
    // THE ONE THAT MATTERS: a well-formed path naming a DIFFERENT workspace.
    // Without the owner check a row that somehow held a foreign path would let
    // this workspace's route reach another workspace's bytes.
    expect(
      parseWorkspaceLogoUrl(workspaceLogoUrl(otherWorkspaceId, TOKEN_A), workspaceId),
    ).toBeNull();
  });
});

describe("WorkspaceLogoService.upload", () => {
  it("refuses bytes that do not sniff as a supported image, before storage or the database", async () => {
    const context = build();
    const error = await rejection(
      context.service.upload({ ...mutationInput(), buffer: NOT_AN_IMAGE }),
    );
    expect(error.getStatus()).toBe(415);
    expect(error.safeResponse.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(context.store.objects.size).toBe(0);
    expect(context.operations).toEqual([]);
    expect(context.inserted).toEqual([]);
  });

  it("stores one rendition under a fresh token, persists the app-relative path, and audits identifiers only", async () => {
    const context = build();
    const result = await context.service.upload({ ...mutationInput(), buffer: PNG });

    // The token is minted per upload, so the URL is asserted by SHAPE.
    expect(result.logoUrl).toMatch(
      new RegExp(`^/api/v1/workspaces/${workspaceId}/logo/[0-9a-f]{32}$`, "u"),
    );
    const parsed = parseWorkspaceLogoUrl(result.logoUrl, workspaceId);
    expect(parsed).not.toBeNull();
    const key = workspaceLogoObjectKey(workspaceId, parsed?.token ?? "");
    expect([...context.store.objects.keys()]).toEqual([key]);
    expect(context.store.objects.get(key)).toEqual(THUMBNAIL_BODY);
    // The row now carries the app-relative path, not the object key.
    expect(context.row?.logoUrl).toBe(result.logoUrl);

    const audits = auditRows(context.inserted);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: WORKSPACE_AUDIT_ACTIONS.logoUpdate,
      entityType: "workspace",
      entityId: workspaceId,
      userId,
    });
    const metadata = audits[0]?.metadata as Record<string, unknown>;
    // Sizes and the source format ONLY. The object token is deliberately not
    // recorded: it is the bearer capability for a public URL and `audit_logs`
    // is CSV-exportable by every workspace admin. This assertion is exact
    // (`toEqual` on the key set, not `toMatchObject`) so a future writer cannot
    // quietly add a credential-shaped field back.
    expect(Object.keys(metadata).sort()).toEqual(["bytes", "sourceType"]);
    // `bytes` is what was KEPT (the rendition), not what was uploaded, and
    // `sourceType` is the sniffed type rather than anything the client declared.
    expect(metadata.bytes).toBe(THUMBNAIL_BODY.byteLength);
    expect(metadata.sourceType).toBe("image/png");
    expect(metadata.token).toBeUndefined();
    // No image bytes anywhere in the row, by construction and by search.
    expect(JSON.stringify(audits[0])).not.toContain("WEBPTHUMBNAILBYTES");
    expect(JSON.stringify(audits[0])).not.toContain("/logo/");
  });

  it("removes the superseded object only after the row commits", async () => {
    const previousKey = workspaceLogoObjectKey(workspaceId, TOKEN_A);
    const context = build({
      row: { id: workspaceId, logoUrl: workspaceLogoUrl(workspaceId, TOKEN_A) },
    });
    context.store.objects.set(previousKey, Buffer.from("old"));

    const result = await context.service.upload({ ...mutationInput(), buffer: PNG });
    const parsed = parseWorkspaceLogoUrl(result.logoUrl, workspaceId);
    const newKey = workspaceLogoObjectKey(workspaceId, parsed?.token ?? "");

    // PUT before the row, DELETE after it: a crash between them leaves an
    // unreferenced object rather than a row pointing at bytes that never landed.
    expect(context.operations).toEqual([
      `put:${newKey}`,
      `update:${result.logoUrl}`,
      `remove:${previousKey}`,
    ]);
    expect(context.store.objects.has(previousKey)).toBe(false);
  });

  it("still succeeds when the superseded object cannot be removed", async () => {
    const previousKey = workspaceLogoObjectKey(workspaceId, TOKEN_A);
    const context = build({
      row: { id: workspaceId, logoUrl: workspaceLogoUrl(workspaceId, TOKEN_A) },
    });
    context.store.objects.set(previousKey, Buffer.from("old"));
    context.store.failRemove = true;

    // The row is already correct and the old token is unreachable, so an
    // orphaned rendition is a storage cost the Part 45 sweep collects — not a
    // reason to fail an administrator's save.
    const result = await context.service.upload({ ...mutationInput(), buffer: PNG });
    expect(result.logoUrl).not.toBeNull();
    expect(context.row?.logoUrl).toBe(result.logoUrl);
    expect(auditRows(context.inserted)).toHaveLength(1);
  });
});

describe("WorkspaceLogoService.remove", () => {
  it("clears the column, discards the object, and audits the deletion", async () => {
    const key = workspaceLogoObjectKey(workspaceId, TOKEN_A);
    const context = build({
      row: { id: workspaceId, logoUrl: workspaceLogoUrl(workspaceId, TOKEN_A) },
    });
    context.store.objects.set(key, Buffer.from("old"));

    const result = await context.service.remove(mutationInput());
    expect(result).toEqual({ logoUrl: null });
    expect(context.row?.logoUrl).toBeNull();
    expect(context.operations).toEqual(["update:null", `remove:${key}`]);
    expect(context.store.objects.size).toBe(0);

    const audits = auditRows(context.inserted);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: WORKSPACE_AUDIT_ACTIONS.logoDelete });
  });

  it("is idempotent: removing an absent logo succeeds and writes no audit row", async () => {
    const context = build({ row: { id: workspaceId, logoUrl: null } });
    const result = await context.service.remove(mutationInput());
    // A second DELETE from a double-clicked button must not 404, and must not
    // fill the audit log with events that describe nothing.
    expect(result).toEqual({ logoUrl: null });
    expect(context.operations).toEqual([]);
    expect(auditRows(context.inserted)).toEqual([]);
  });
});

describe("WorkspaceLogoService.read", () => {
  it("serves the rendition the current token names", async () => {
    const key = workspaceLogoObjectKey(workspaceId, TOKEN_A);
    const context = build({
      row: { id: workspaceId, logoUrl: workspaceLogoUrl(workspaceId, TOKEN_A) },
    });
    context.store.objects.set(key, THUMBNAIL_BODY);

    const content = await context.service.read(workspaceId, TOKEN_A);
    expect(content.mimeType).toBe("image/webp");
    expect(content.contentLength).toBe(THUMBNAIL_BODY.byteLength);
    expect(content.etag).toBe(`"stat-${key.slice(-8)}"`);
  });

  it("answers every miss with the same 404, so the public route cannot be probed", async () => {
    const storedUrl = workspaceLogoUrl(workspaceId, TOKEN_A);
    const key = workspaceLogoObjectKey(workspaceId, TOKEN_A);

    const withLogo = build({ row: { id: workspaceId, logoUrl: storedUrl } });
    withLogo.store.objects.set(key, THUMBNAIL_BODY);
    const noLogo = build({ row: { id: workspaceId, logoUrl: null } });
    const unknown = build({ row: undefined });

    const misses = await Promise.all([
      // Malformed token — refused before the row is even read.
      rejection(withLogo.service.read(workspaceId, "not-a-token")),
      // Superseded token: well-formed, but no longer the one on the row.
      rejection(withLogo.service.read(workspaceId, TOKEN_B)),
      // The workspace has no logo.
      rejection(noLogo.service.read(workspaceId, TOKEN_A)),
      // The workspace does not exist.
      rejection(unknown.service.read(workspaceId, TOKEN_A)),
    ]);

    for (const miss of misses) {
      expect(miss.getStatus()).toBe(404);
      expect(miss.safeResponse).toEqual({
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
  });
});

describe("WorkspaceLogoService storage failures", () => {
  it("turns a disabled object store into a 503 on both the write and the read path", async () => {
    const key = workspaceLogoObjectKey(workspaceId, TOKEN_A);
    const context = build({
      row: { id: workspaceId, logoUrl: workspaceLogoUrl(workspaceId, TOKEN_A) },
    });
    context.store.objects.set(key, THUMBNAIL_BODY);
    context.store.disabled = true;

    const failedUpload = await rejection(
      context.service.upload({ ...mutationInput(), buffer: PNG }),
    );
    expect(failedUpload.getStatus()).toBe(503);
    expect(failedUpload.safeResponse.code).toBe("SERVICE_UNAVAILABLE");

    const failedRead = await rejection(context.service.read(workspaceId, TOKEN_A));
    expect(failedRead.getStatus()).toBe(503);
    expect(failedRead.safeResponse.code).toBe("SERVICE_UNAVAILABLE");
    // A configuration failure must not leave a half-written row behind.
    expect(context.row?.logoUrl).toBe(workspaceLogoUrl(workspaceId, TOKEN_A));
  });
});
