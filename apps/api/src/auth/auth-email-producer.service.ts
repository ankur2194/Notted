import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service";
import {
  authEmailIntents,
  emailDeliveries,
  jobOutbox,
  type AuthEmailPurpose,
} from "../database/schema";

import { AuthEmailEncryptionService, type AuthEmailContext } from "./auth-email-encryption.service";
import { AUTH_EMAIL_JOB_TYPE, AUTH_EMAIL_PAYLOAD_VERSION } from "./auth-email.types";

export interface QueueAuthEmailInput {
  readonly recipient: string;
  readonly purpose: AuthEmailPurpose;
  readonly context: AuthEmailContext;
  readonly expiresAt: Date;
  readonly correlationId?: string;
}

export interface QueuedAuthEmail {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly status: "queued";
}

@Injectable()
export class AuthEmailProducerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly encryption: AuthEmailEncryptionService,
  ) {}

  async queue(input: QueueAuthEmailInput): Promise<QueuedAuthEmail> {
    const deliveryId = randomUUID();
    const intentId = randomUUID();
    const outboxId = randomUUID();
    const encrypted = this.encryption.encrypt(input.context, {
      intentId,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
    });
    const payload = { action: AUTH_EMAIL_JOB_TYPE, intentId } as const;
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    await this.database.transaction(async (tx) => {
      await tx.insert(emailDeliveries).values({
        id: deliveryId,
        recipient: input.recipient.trim().toLowerCase(),
        templateKey: input.purpose,
      });
      await tx.insert(authEmailIntents).values({
        id: intentId,
        deliveryId,
        purpose: input.purpose,
        ...encrypted,
        expiresAt: input.expiresAt,
      });
      await tx.insert(jobOutbox).values({
        id: outboxId,
        queueName: "auth-email",
        jobType: AUTH_EMAIL_JOB_TYPE,
        payloadVersion: AUTH_EMAIL_PAYLOAD_VERSION,
        payload,
        payloadHash,
        idempotencyKey: `auth-email:${intentId}`,
        correlationId: input.correlationId,
      });
    });

    // The shared bounded dispatcher discovers this durable intent after commit.
    // No queue client is exposed to the producer and no Redis side effect can
    // race the business transaction.
    return { deliveryId, intentId, status: "queued" };
  }
}
