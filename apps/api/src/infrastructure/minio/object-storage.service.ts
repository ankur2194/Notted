// Part 40: the object-storage DATA plane.
//
// Deliberately separate from `MinioService`, which is the READINESS indicator
// consumed by `HealthModule`. Conflating a health probe with a byte mover would
// let a data-plane failure flip the readiness state (and vice versa), so the two
// share only the `MINIO_CLIENT`/`MINIO_CONFIG` providers.
//
// Scope: bytes and buckets. This service knows nothing about the database,
// authorization, workspaces, key policy, or filenames — those live in
// `src/attachments/`. It never logs a key, a signed URL, or object content
// (`docs/standards/observability.md`).

import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../../common/logging/structured-logger.service";
import { MINIO_CONFIG, type MinioConfig } from "../../config/minio.config";
import { SECURITY_CONFIG, type SecurityConfig } from "../../config/security.config";

import { MINIO_CLIENT } from "./minio.tokens";

import type { Client } from "minio";
import type { Readable } from "node:stream";

export type StorageBucket = "attachments" | "exports";

export interface StoredObjectStat {
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentType: string | null;
}

export interface PutObjectOptions {
  readonly contentType: string;
  readonly contentLength: number;
  readonly cacheControl?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PutObjectResult {
  readonly etag: string;
}

/**
 * The narrow byte-plane contract application services depend on. Tests inject an
 * in-memory double; production injects {@link ObjectStorageService}.
 */
export interface ObjectStore {
  isEnabled(): boolean;
  putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    options: PutObjectOptions,
  ): Promise<PutObjectResult>;
  getObjectStream(bucket: StorageBucket, key: string): Promise<Readable>;
  statObject(bucket: StorageBucket, key: string): Promise<StoredObjectStat | null>;
  removeObject(bucket: StorageBucket, key: string): Promise<void>;
  removeObjects(bucket: StorageBucket, keys: readonly string[]): Promise<void>;
  presignedGetUrl(
    bucket: StorageBucket,
    key: string,
    ttlSeconds: number,
    responseHeaders?: Readonly<Record<string, string>>,
  ): Promise<string>;
}

/** Thrown when a storage call is attempted while `FEATURE_STORAGE_ENABLED=false`. */
export class ObjectStorageDisabledError extends Error {
  constructor() {
    super("Object storage is disabled");
    this.name = "ObjectStorageDisabledError";
  }
}

const MINIMUM_PRESIGNED_TTL_SECONDS = 60;
const ABSENT_OBJECT_CODES = new Set(["NoSuchKey", "NotFound", "NoSuchObject", "ResourceNotFound"]);
const BUCKET_ALREADY_OWNED_CODES = new Set([
  "BucketAlreadyOwnedByYou",
  "BucketAlreadyExists",
  "BucketAlreadyOwnedByYou.",
]);

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== null && ABSENT_OBJECT_CODES.has(code)) return true;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404;
}

@Injectable()
export class ObjectStorageService implements ObjectStore, OnModuleInit {
  constructor(
    @Inject(MINIO_CLIENT) private readonly client: Client | null,
    @Inject(MINIO_CONFIG) private readonly config: MinioConfig,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    private readonly logger: StructuredLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.client === null) return;
    try {
      await this.ensureBuckets();
    } catch {
      // `compose.yaml`'s `minio-init` is the primary bucket provisioner and the
      // readiness probe reports the outage; a startup race here must not stop
      // the API from booting.
      this.logger.warn("Object storage bucket check failed at startup");
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /** Idempotent: creates each configured bucket only when it is missing. */
  async ensureBuckets(): Promise<void> {
    const client = this.requireClient();
    for (const bucket of ["attachments", "exports"] as const) {
      const name = this.bucketName(bucket);
      if (await client.bucketExists(name)) continue;
      try {
        await client.makeBucket(name, this.config.region);
      } catch (error: unknown) {
        const code = errorCode(error);
        if (code === null || !BUCKET_ALREADY_OWNED_CODES.has(code)) throw error;
      }
    }
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    options: PutObjectOptions,
  ): Promise<PutObjectResult> {
    const client = this.requireClient();
    const metadata: Record<string, string> = {
      "Content-Type": options.contentType,
      ...(options.cacheControl === undefined ? {} : { "Cache-Control": options.cacheControl }),
      ...(options.metadata ?? {}),
    };
    const result = await client.putObject(
      this.bucketName(bucket),
      key,
      body,
      options.contentLength,
      metadata,
    );
    return Object.freeze({ etag: result.etag });
  }

  // `async` so a disabled-storage failure REJECTS instead of throwing
  // synchronously; callers await it inside try/catch compensation blocks.
  async getObjectStream(bucket: StorageBucket, key: string): Promise<Readable> {
    return this.requireClient().getObject(this.bucketName(bucket), key);
  }

  /** Resolves `null` for a missing object; absence is never an exception. */
  async statObject(bucket: StorageBucket, key: string): Promise<StoredObjectStat | null> {
    const client = this.requireClient();
    try {
      const stat = await client.statObject(this.bucketName(bucket), key);
      const contentType = stat.metaData?.["content-type"];
      return Object.freeze({
        size: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
        contentType: typeof contentType === "string" ? contentType : null,
      });
    } catch (error: unknown) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  /** Idempotent: removing an absent object succeeds. */
  async removeObject(bucket: StorageBucket, key: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.removeObject(this.bucketName(bucket), key);
    } catch (error: unknown) {
      if (!isAbsent(error)) throw error;
    }
  }

  /**
   * Best-effort bulk removal used by compensating cleanup. Never throws: the
   * database row is already marked failed/deleted and Part 45's sweeper is the
   * backstop, so a cleanup error must not mask the original outcome.
   */
  async removeObjects(bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    if (this.client === null) return;
    try {
      await this.client.removeObjects(this.bucketName(bucket), [...keys]);
    } catch {
      this.logger.warn("Object storage bulk removal failed; deferred to reconciliation");
    }
  }

  /**
   * Narrowly scoped, short-lived download URL. Reserved for Part 54 exports; the
   * attachment download path streams through the API instead.
   *
   * The returned value is a bearer secret: never log it, never persist it, and
   * never place it in a document or analytics payload (ADR 0005).
   */
  async presignedGetUrl(
    bucket: StorageBucket,
    key: string,
    ttlSeconds: number,
    responseHeaders?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const client = this.requireClient();
    const ceiling = this.security.signedUrlTtlSeconds;
    const requested = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 0;
    const clamped = Math.max(
      MINIMUM_PRESIGNED_TTL_SECONDS,
      Math.min(requested, Math.max(ceiling, MINIMUM_PRESIGNED_TTL_SECONDS)),
    );
    return client.presignedGetObject(
      this.bucketName(bucket),
      key,
      clamped,
      responseHeaders === undefined ? undefined : { ...responseHeaders },
    );
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === "attachments" ? this.config.attachmentsBucket : this.config.exportsBucket;
  }

  private requireClient(): Client {
    if (this.client === null) throw new ObjectStorageDisabledError();
    return this.client;
  }
}
