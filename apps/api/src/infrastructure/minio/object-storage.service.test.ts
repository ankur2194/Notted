import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { ObjectStorageDisabledError, ObjectStorageService } from "./object-storage.service";

import type { StructuredLogger } from "../../common/logging/structured-logger.service";
import type { MinioConfig } from "../../config/minio.config";
import type { SecurityConfig } from "../../config/security.config";
import type { Client } from "minio";

const config = {
  enabled: true,
  attachmentsBucket: "notted-attachments",
  exportsBucket: "notted-exports",
  region: "us-east-1",
} as unknown as MinioConfig;

const security = { signedUrlTtlSeconds: 900 } as unknown as SecurityConfig;

function logger(): StructuredLogger {
  return { warn: vi.fn() } as unknown as StructuredLogger;
}

function service(client: Partial<Client> | null): ObjectStorageService {
  return new ObjectStorageService(client as Client | null, config, security, logger());
}

function s3Error(code: string, statusCode?: number): Error {
  return Object.assign(new Error(code), { code, statusCode });
}

describe("ObjectStorageService", () => {
  it("writes an object with its content type, length, and cache policy", async () => {
    const putObject = vi.fn().mockResolvedValue({ etag: "abc123" });
    const result = await service({ putObject }).putObject(
      "attachments",
      "w/x/a/y/original/z.png",
      Buffer.from("bytes"),
      { contentType: "image/png", contentLength: 5, cacheControl: "private, max-age=1" },
    );
    expect(result).toEqual({ etag: "abc123" });
    expect(putObject).toHaveBeenCalledWith(
      "notted-attachments",
      "w/x/a/y/original/z.png",
      expect.any(Buffer),
      5,
      expect.objectContaining({
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=1",
      }),
    );
  });

  it("resolves null instead of throwing when an object is absent", async () => {
    for (const error of [s3Error("NoSuchKey"), s3Error("NotFound"), s3Error("Whatever", 404)]) {
      const statObject = vi.fn().mockRejectedValue(error);
      await expect(
        service({ statObject }).statObject("attachments", "missing"),
      ).resolves.toBeNull();
    }
  });

  it("propagates a genuine stat failure rather than pretending the object is gone", async () => {
    const statObject = vi.fn().mockRejectedValue(s3Error("AccessDenied", 403));
    await expect(service({ statObject }).statObject("attachments", "k")).rejects.toThrow(
      "AccessDenied",
    );
  });

  it("returns normalized stat metadata", async () => {
    const lastModified = new Date("2026-08-01T00:00:00Z");
    const statObject = vi.fn().mockResolvedValue({
      size: 42,
      etag: "deadbeef",
      lastModified,
      metaData: { "content-type": "image/webp" },
    });
    await expect(service({ statObject }).statObject("attachments", "k")).resolves.toEqual({
      size: 42,
      etag: "deadbeef",
      lastModified,
      contentType: "image/webp",
    });
  });

  it("makes single and bulk removal idempotent", async () => {
    const removeObject = vi.fn().mockRejectedValue(s3Error("NoSuchKey"));
    await expect(
      service({ removeObject }).removeObject("attachments", "gone"),
    ).resolves.toBeUndefined();

    const removeObjects = vi.fn().mockRejectedValue(new Error("network down"));
    const store = service({ removeObjects });
    await expect(store.removeObjects("attachments", ["a", "b"])).resolves.toBeUndefined();
    await expect(store.removeObjects("attachments", [])).resolves.toBeUndefined();
    expect(removeObjects).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-absence removal failure", async () => {
    const removeObject = vi.fn().mockRejectedValue(s3Error("AccessDenied", 403));
    await expect(service({ removeObject }).removeObject("attachments", "k")).rejects.toThrow(
      "AccessDenied",
    );
  });

  it("streams an object from the exports bucket by logical name", async () => {
    const getObject = vi.fn().mockResolvedValue(Readable.from(["chunk"]));
    await service({ getObject }).getObjectStream("exports", "e/1");
    expect(getObject).toHaveBeenCalledWith("notted-exports", "e/1");
  });

  it("clamps the presigned TTL to [60, configured ceiling]", async () => {
    const presignedGetObject = vi.fn().mockResolvedValue("https://storage.invalid/signed");
    const store = service({ presignedGetObject });
    for (const [requested, expected] of [
      [1, 60],
      [59, 60],
      [60, 60],
      [300, 300],
      [900, 900],
      [86_400, 900],
      [Number.NaN, 60],
      [Number.POSITIVE_INFINITY, 60],
      [-5, 60],
    ] as const) {
      await store.presignedGetUrl("exports", "e/1", requested);
      expect(presignedGetObject).toHaveBeenLastCalledWith(
        "notted-exports",
        "e/1",
        expected,
        undefined,
      );
    }
  });

  it("creates only the buckets that are missing", async () => {
    const bucketExists = vi.fn(async (name: string) => name === "notted-attachments");
    const makeBucket = vi.fn().mockResolvedValue(undefined);
    await service({ bucketExists, makeBucket }).ensureBuckets();
    expect(makeBucket).toHaveBeenCalledTimes(1);
    expect(makeBucket).toHaveBeenCalledWith("notted-exports", "us-east-1");
  });

  it("tolerates a concurrent creator winning the makeBucket race", async () => {
    const bucketExists = vi.fn().mockResolvedValue(false);
    const makeBucket = vi.fn().mockRejectedValue(s3Error("BucketAlreadyOwnedByYou"));
    await expect(service({ bucketExists, makeBucket }).ensureBuckets()).resolves.toBeUndefined();

    const failing = vi.fn().mockRejectedValue(s3Error("AccessDenied", 403));
    await expect(service({ bucketExists, makeBucket: failing }).ensureBuckets()).rejects.toThrow(
      "AccessDenied",
    );
  });

  it("never crashes startup when the bucket check fails", async () => {
    const bucketExists = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(service({ bucketExists }).onModuleInit()).resolves.toBeUndefined();
  });

  it("is a no-op at startup and reports disabled when no client is configured", async () => {
    const disabled = service(null);
    await expect(disabled.onModuleInit()).resolves.toBeUndefined();
    expect(disabled.isEnabled()).toBe(false);
    await expect(
      disabled.putObject("attachments", "k", Buffer.alloc(1), {
        contentType: "image/png",
        contentLength: 1,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageDisabledError);
    await expect(disabled.getObjectStream("attachments", "k")).rejects.toBeInstanceOf(
      ObjectStorageDisabledError,
    );
    await expect(disabled.statObject("attachments", "k")).rejects.toBeInstanceOf(
      ObjectStorageDisabledError,
    );
    await expect(disabled.removeObject("attachments", "k")).rejects.toBeInstanceOf(
      ObjectStorageDisabledError,
    );
    await expect(disabled.presignedGetUrl("exports", "k", 300)).rejects.toBeInstanceOf(
      ObjectStorageDisabledError,
    );
    await expect(disabled.ensureBuckets()).rejects.toBeInstanceOf(ObjectStorageDisabledError);
    // Cleanup must stay silent when storage is off: the caller is already in a
    // failure path and must not be handed a second error.
    await expect(disabled.removeObjects("attachments", ["a"])).resolves.toBeUndefined();
  });
});
