import { createHash, randomUUID } from "node:crypto";

import { HttpStatus } from "@nestjs/common";
import { idempotencyKeySchema } from "@notted/shared-validators";
import { and, eq, sql } from "drizzle-orm";

import { type DatabaseTransaction, type DatabaseService } from "../../database/database.service";
import { apiIdempotencyRecords } from "../../database/schema";
import { ApiHttpException } from "../errors/api-http.exception";

import type { Request } from "express";

const API_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ApiIdempotencyIdentity {
  readonly actorUserId: string;
  readonly operation: string;
  readonly keyHash: string;
  readonly payloadHash: string;
}

export interface ApiIdempotencyRecord {
  readonly resourceId: string;
  readonly payloadHash: string;
}

export function requireIdempotencyKey(request: Request): string {
  const parsed = idempotencyKeySchema.safeParse(request.header("idempotency-key"));
  if (!parsed.success) {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid Idempotency-Key header is required.",
    });
  }
  return parsed.data;
}

export function hashApiPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createApiIdempotencyIdentity(input: {
  readonly actorUserId: string;
  readonly operation: string;
  readonly key: string;
  readonly payload: unknown;
}): ApiIdempotencyIdentity {
  return Object.freeze({
    actorUserId: input.actorUserId,
    operation: input.operation,
    keyHash: createHash("sha256").update(input.key, "utf8").digest("hex"),
    payloadHash: hashApiPayload(input.payload),
  });
}

export async function lockApiIdempotency(
  tx: DatabaseTransaction,
  identity: ApiIdempotencyIdentity,
): Promise<void> {
  const lockKey = `${identity.actorUserId}:${identity.operation}:${identity.keyHash}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

export async function loadApiIdempotency(
  db: DatabaseService["db"] | DatabaseTransaction,
  identity: ApiIdempotencyIdentity,
): Promise<ApiIdempotencyRecord | null> {
  const [row] = await db
    .select({
      resourceId: apiIdempotencyRecords.resourceId,
      payloadHash: apiIdempotencyRecords.payloadHash,
    })
    .from(apiIdempotencyRecords)
    .where(
      and(
        eq(apiIdempotencyRecords.actorUserId, identity.actorUserId),
        eq(apiIdempotencyRecords.operation, identity.operation),
        eq(apiIdempotencyRecords.keyHash, identity.keyHash),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function assertIdempotencyPayload(
  record: ApiIdempotencyRecord,
  identity: ApiIdempotencyIdentity,
): void {
  if (record.payloadHash !== identity.payloadHash) {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "The idempotency key was already used for a different request.",
    });
  }
}

export async function storeApiIdempotency(
  tx: DatabaseTransaction,
  identity: ApiIdempotencyIdentity,
  resourceId: string,
): Promise<void> {
  await tx.insert(apiIdempotencyRecords).values({
    id: randomUUID(),
    actorUserId: identity.actorUserId,
    operation: identity.operation,
    keyHash: identity.keyHash,
    payloadHash: identity.payloadHash,
    resourceId,
    expiresAt: new Date(Date.now() + API_IDEMPOTENCY_RETENTION_MS),
  });
}
