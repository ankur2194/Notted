// Part 40: MinIO gating for integration suites.
//
// The gate has TWO layers, identical in shape to the existing PostgreSQL one
// (`notes.integration.test.ts`):
//
//   describe.skipIf(!HAS_MINIO)   -> "not configured at all"
//   beforeAll probe + skip("...") -> "configured but unreachable right now"
//
// MinIO cannot join the PostgreSQL rollback transaction, so a suite that talks
// to the real object store must write ONLY under a per-run random prefix and
// remove that prefix in `afterEach`. A crashed run then leaves an identifiable,
// disposable island rather than polluting the shared bucket.
//
// These run inside the api container (`docker compose exec api pnpm test`),
// which has `MINIO_ENDPOINT: minio`.

import { randomUUID } from "node:crypto";

import { Client } from "minio";

const endpoint = process.env.MINIO_ENDPOINT;

export const HAS_MINIO =
  typeof endpoint === "string" &&
  endpoint.trim() !== "" &&
  process.env.FEATURE_STORAGE_ENABLED !== "false";

export const MINIO_ATTACHMENTS_BUCKET =
  process.env.MINIO_BUCKET_ATTACHMENTS ?? "notted-attachments";

const PROBE_TIMEOUT_MS = 2_000;

export function minioTestClient(): Client {
  return new Client({
    endPoint: (endpoint ?? "127.0.0.1").trim(),
    port: Number(process.env.MINIO_PORT ?? 9_000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "nottedminio",
    secretKey: process.env.MINIO_SECRET_KEY ?? "notted-dev-minio-secret",
    region: process.env.MINIO_REGION ?? "us-east-1",
  });
}

/** True only when the attachments bucket answers within the probe window. */
export async function isMinioReachable(): Promise<boolean> {
  if (!HAS_MINIO) return false;
  try {
    const client = minioTestClient();
    return await Promise.race([
      client.bucketExists(MINIO_ATTACHMENTS_BUCKET),
      new Promise<boolean>((_resolve, reject) => {
        setTimeout(() => reject(new Error("minio probe timed out")), PROBE_TIMEOUT_MS).unref();
      }),
    ]);
  } catch {
    return false;
  }
}

/** Per-run namespace so a crashed suite leaves a disposable island. */
export function testKeyPrefix(): string {
  return `test/${randomUUID()}/`;
}

/** Best-effort removal of every object under a test prefix. Never throws. */
export async function removeTestObjects(prefix: string): Promise<void> {
  if (!HAS_MINIO || prefix === "" || !prefix.startsWith("test/")) return;
  try {
    const client = minioTestClient();
    const keys: string[] = [];
    const stream = client.listObjectsV2(MINIO_ATTACHMENTS_BUCKET, prefix, true);
    await new Promise<void>((resolve) => {
      stream.on("data", (item) => {
        if (typeof item.name === "string") keys.push(item.name);
      });
      stream.on("error", () => resolve());
      stream.on("end", () => resolve());
    });
    if (keys.length > 0) await client.removeObjects(MINIO_ATTACHMENTS_BUCKET, keys);
  } catch {
    // Leftovers under `test/` are disposable by design; never fail a suite here.
  }
}
