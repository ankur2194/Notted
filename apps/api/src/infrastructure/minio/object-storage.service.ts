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

/** One entry from a bucket listing. Deliberately metadata only — no bytes. */
export interface StoredObjectSummary {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

export interface ListObjectsOptions {
  /**
   * Key prefix to scan. Required and never empty: an unprefixed listing of a
   * production bucket is not something a caller should be able to ask for by
   * omission.
   */
  readonly prefix: string;
  /**
   * Hard ceiling on the number of keys buffered. The listing stops there and
   * reports `truncated`.
   */
  readonly limit: number;
}

export interface ListObjectsResult {
  readonly objects: readonly StoredObjectSummary[];
  /** `true` when the prefix holds more keys than `limit` allowed us to read. */
  readonly truncated: boolean;
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
  /**
   * Bounded prefix listing. Part 45's reconciliation sweep is the only caller:
   * a listing answers "which bytes exist", never "who may read them" (ADR 0005).
   */
  listObjects(bucket: StorageBucket, options: ListObjectsOptions): Promise<ListObjectsResult>;
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

  /**
   * Bounded prefix listing for Part 45 reconciliation.
   *
   * MinIO exposes listing as an UNBOUNDED object stream, so a bucket holding ten
   * million keys would be read into memory by a naive `for await`. This wrapper
   * stops at `options.limit`, destroys the stream, and reports `truncated` so the
   * caller knows another pass has work left. Memory is therefore capped by the
   * caller's configured limit rather than by the size of the bucket.
   *
   * An empty prefix is refused: a full-bucket scan is never something a caller
   * should be able to request by forgetting an argument.
   *
   * Keys are returned to the caller but are NEVER logged here (ADR 0005 /
   * `docs/standards/observability.md`).
   */
  async listObjects(
    bucket: StorageBucket,
    options: ListObjectsOptions,
  ): Promise<ListObjectsResult> {
    const client = this.requireClient();
    if (options.prefix === "") throw new Error("listObjects requires a non-empty prefix");
    const limit = Math.max(0, Math.floor(options.limit));
    if (limit === 0) return Object.freeze({ objects: Object.freeze([]), truncated: true });

    const objects: StoredObjectSummary[] = [];
    let truncated = false;
    const stream = client.listObjectsV2(this.bucketName(bucket), options.prefix, true);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : new Error("object listing failed"));
      };
      stream.on("data", (item) => {
        // A common-prefix ("directory") entry carries `prefix` and no `name`.
        // The listing above is recursive so none should appear, but skipping
        // them keeps a non-object entry out of any caller's delete set.
        if (typeof item.name !== "string" || item.name === "") return;
        if (objects.length >= limit) {
          truncated = true;
          stream.destroy();
          finish();
          return;
        }
        objects.push(
          Object.freeze({ key: item.name, size: item.size, lastModified: item.lastModified }),
        );
      });
      stream.on("error", (error: unknown) => finish(error));
      stream.on("end", () => finish());
      stream.on("close", () => finish());
    });
    return Object.freeze({ objects: Object.freeze([...objects]), truncated });
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
