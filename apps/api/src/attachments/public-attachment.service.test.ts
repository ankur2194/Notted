import { Readable } from "node:stream";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { hashPublicLinkToken } from "../notes/note-public-link-token";

import { AttachmentsService } from "./attachments.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { AuthConfig } from "../config/auth.config";
import type { SecurityConfig } from "../config/security.config";
import type { DatabaseService } from "../database/database.service";
import type { ObjectStore } from "../infrastructure/minio/object-storage.service";
import type { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import type { StorageQuotaService } from "../storage/storage-quota.service";
import type { TenantContextService } from "../tenant";
import type { ImageProcessor } from "./image-processing";
import type { SQL } from "drizzle-orm";

const attachmentId = "20000000-0000-4000-8900-000000000001";
const token = "a".repeat(32);
const key = "opaque-key";
const document = (mediaType: "image" | "file") => ({
  type: "doc",
  content:
    mediaType === "file"
      ? [
          {
            type: "attachment",
            attrs: { attachmentId, name: "report.pdf", mimeType: "application/pdf", sizeBytes: 5 },
          },
        ]
      : [{ type: "image", attrs: { attachmentId, alt: "photo" } }],
});

function harness(mediaType: "image" | "file" = "file") {
  const row = {
    attachment: {
      id: attachmentId,
      filename: "report.pdf",
      mediaType,
      variants: {
        [mediaType === "image" ? "full" : "original"]: {
          key,
          mimeType: mediaType === "file" ? "application/pdf" : "image/png",
        },
      },
    },
    content: document(mediaType) as unknown,
  };
  let result: typeof row | undefined = row;
  const joins: string[] = [];
  let predicate = "";
  let parameters: unknown[] = [];
  const dialect = new PgDialect();
  const query = {
    select: () => ({
      from: () => {
        const chain = {
          innerJoin: (_table: unknown, on: SQL) => {
            joins.push(dialect.sqlToQuery(on).sql);
            return chain;
          },
          where: (condition: SQL) => {
            const rendered = dialect.sqlToQuery(condition);
            predicate = rendered.sql;
            parameters = rendered.params;
            return chain;
          },
          limit: () => Promise.resolve(result === undefined ? [] : [result]),
        };
        return chain;
      },
    }),
  };
  const statObject = vi.fn().mockResolvedValue({ size: 5, etag: "etag" });
  const getObjectStream = vi
    .fn()
    .mockImplementation(() => Promise.resolve(Readable.from(["bytes"])));
  const objects = { statObject, getObjectStream } as unknown as ObjectStore;
  const service = new AttachmentsService(
    { db: query } as unknown as DatabaseService,
    {} as AuthorizationEntryService,
    {} as TenantContextService,
    objects,
    {} as ImageProcessor,
    {} as SecurityConfig,
    {} as StructuredLogger,
    {} as StorageQuotaService,
    {} as NoteSearchIndexProducer,
    { secret: "test-pepper" } as AuthConfig,
  );
  return {
    service,
    row,
    setResult: (value: typeof row | undefined) => {
      result = value;
    },
    joins,
    get predicate() {
      return predicate;
    },
    get parameters() {
      return parameters;
    },
    statObject,
    getObjectStream,
  };
}

describe("AttachmentsService.readPublicContent", () => {
  it("rejects malformed tokens before SQL/storage and uses one joined lookup for live tokens", async () => {
    const test = harness();
    expect(await test.service.readPublicContent({ token: "invalid", attachmentId })).toBeNull();
    expect(test.joins).toHaveLength(0);
    expect(await test.service.readPublicContent({ token, attachmentId })).toMatchObject({
      mediaType: "file",
      mimeType: "application/pdf",
    });
    expect(test.joins).toHaveLength(2);
    expect(test.joins.join(" ")).toContain('"attachments"."workspace_id" = "notes"."workspace_id"');
    expect(test.joins.join(" ")).toContain('"attachments"."note_id" = "notes"."id"');
    expect(test.joins.join(" ")).toContain(
      '"notes"."workspace_id" = "note_public_links"."workspace_id"',
    );
    expect(test.predicate).toContain('"notes"."is_deleted"');
    expect(test.predicate).toContain('"attachments"."processing_status"');
    expect(test.parameters).toContain(hashPublicLinkToken(token, "test-pepper"));
    expect(test.parameters).not.toContain(token);
    expect(test.statObject).toHaveBeenCalledOnce();
    expect(test.getObjectStream).toHaveBeenCalledOnce();
  });

  it("does no object-store I/O for absent, trashed, revoked or foreign matches", async () => {
    const test = harness();
    test.setResult(undefined); // The joined SQL filters all of these out identically.
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    expect(test.statObject).not.toHaveBeenCalled();
  });

  it("denies unreferenced, wrong-node-type and unsafe variants before storage", async () => {
    const test = harness();
    test.row.content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: attachmentId }] }],
    };
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    test.row.content = document("image");
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    test.row.content = document("file");
    test.row.attachment.variants.original!.mimeType = "text/html";
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    expect(test.statObject).not.toHaveBeenCalled();
  });

  it("allows raster images but rejects unsafe image renditions and missing objects", async () => {
    const test = harness("image");
    expect(await test.service.readPublicContent({ token, attachmentId })).toMatchObject({
      mediaType: "image",
      mimeType: "image/png",
    });
    test.row.attachment.variants.full!.mimeType = "image/svg+xml";
    test.statObject.mockClear();
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    expect(test.statObject).not.toHaveBeenCalled();
    test.row.attachment.variants.full!.mimeType = "image/png";
    test.statObject.mockResolvedValueOnce(null);
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
  });

  it("conceals an object deleted between stat and stream, but does not conceal infrastructure failure", async () => {
    const test = harness();
    test.getObjectStream.mockRejectedValueOnce({ code: "NoSuchKey" });
    expect(await test.service.readPublicContent({ token, attachmentId })).toBeNull();
    test.getObjectStream.mockRejectedValueOnce(new Error("connection reset"));
    await expect(test.service.readPublicContent({ token, attachmentId })).rejects.toThrow(
      "connection reset",
    );
  });
});
