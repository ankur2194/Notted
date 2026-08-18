// Part 61 — transaction-scoped producer for the `email.deliver` intent.
//
// Called from inside the caller's business transaction, exactly like
// `MentionNotificationProducer.scheduleMentionNotifications`: ADR 0006 requires
// the durable intent to commit atomically with the business mutation, with
// dispatch happening only after commit. This service NEVER touches Redis — the
// shared dispatcher discovers the committed row and publishes the pointer.

import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { emailDeliveries, jobOutbox, type JobOutboxPayload } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  WORKSPACE_EMAIL_JOB_DEFINITION,
  WORKSPACE_EMAIL_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { assertActiveWorkspace, TenantContextService } from "../tenant";

import { isSuppressed, normalizeRecipient } from "./email-suppression";

import type { EmailTemplateKey } from "./email-templates";
import type { DatabaseTransaction } from "../database/database.service";

/** Shared prefix for every workspace-email idempotency key, for operators. */
export const WORKSPACE_EMAIL_IDEMPOTENCY_PREFIX = "email:";

export interface QueueWorkspaceEmailInput {
  readonly templateKey: EmailTemplateKey;
  readonly recipient: string;
  /** `null` for workspace-less system mail (`welcome`). */
  readonly workspaceId: string | null;
  readonly relatedEntityType: string;
  readonly relatedEntityId: string;
  readonly actorId?: string;
  readonly correlationId?: string | null;
}

export interface QueueWorkspaceEmailResult {
  /** `null` only when the duplicate check short-circuited before any write. */
  readonly deliveryId: string | null;
  readonly outcome: "queued" | "suppressed" | "duplicate";
}

/**
 * Deterministic identity of "this template, to this address, about this entity".
 *
 * It derives from the BUSINESS EVENT and never from a random id, so a replayed
 * transaction collapses to exactly one email through
 * `job_outbox_idempotency_key_unique`.
 *
 * ponytail: the identity deliberately omits time, so re-triggering the same
 * event about the same entity months later never re-sends while the outbox row
 * survives retention. Upgrade path: add a day/epoch bucket to the hashed object
 * — one line, no schema change.
 */
export function workspaceEmailIdempotencyKey(input: {
  readonly templateKey: EmailTemplateKey;
  /** Already normalised by the caller (`normalizeRecipient`). */
  readonly recipient: string;
  readonly relatedEntityType: string;
  readonly relatedEntityId: string;
}): string {
  const { templateKey, recipient, relatedEntityType, relatedEntityId } = input;
  return `${WORKSPACE_EMAIL_IDEMPOTENCY_PREFIX}${createHash("sha256")
    .update(JSON.stringify({ templateKey, recipient, relatedEntityType, relatedEntityId }))
    .digest("hex")}`;
}

/** Identifier-only payload. `workspaceId` is nullable, so it has its own type. */
interface WorkspaceEmailPayload {
  readonly action: typeof DOMAIN_JOB_TYPES.deliverWorkspaceEmail;
  readonly intentId: string;
  readonly deliveryId: string;
  readonly workspaceId: string | null;
  readonly actorId?: string;
}

@Injectable()
export class WorkspaceEmailProducerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Record ONE `email_deliveries` row and its outbox intent inside `tx`.
   *
   * The caller owns the transaction so the email cannot exist without the
   * business state that justifies it, and vice versa.
   */
  async queue(
    tx: DatabaseTransaction,
    input: QueueWorkspaceEmailInput,
  ): Promise<QueueWorkspaceEmailResult> {
    const recipient = normalizeRecipient(input.recipient);
    // A blank address is a caller bug, not a runtime condition: failing loudly
    // inside the caller's transaction beats persisting an unsendable row.
    if (recipient === "") throw new Error("Email recipient is required");

    // Workspace-scoped mail proves its scope before writing; workspace-less
    // system mail (`welcome`) runs outside any tenant context, so there is no
    // active workspace to assert against and `input.workspaceId` (null) is
    // written straight through.
    if (input.workspaceId !== null) {
      assertActiveWorkspace(input.workspaceId, this.tenantContext, "email.deliver");
    }

    if (await isSuppressed(tx, recipient, input.templateKey, input.workspaceId)) {
      // `suppressed` exists for exactly this: a durable record that the message
      // was withheld on purpose, with no outbox row so nothing ever sends it.
      const deliveryId = randomUUID();
      await tx.insert(emailDeliveries).values({
        id: deliveryId,
        workspaceId: input.workspaceId,
        recipient,
        templateKey: input.templateKey,
        status: "suppressed",
        errorMessage: "Recipient suppressed this template",
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      });
      return { deliveryId, outcome: "suppressed" };
    }

    const deliveryId = randomUUID();
    const intentId = randomUUID();
    const payload: WorkspaceEmailPayload = Object.freeze({
      action: DOMAIN_JOB_TYPES.deliverWorkspaceEmail,
      intentId,
      deliveryId,
      workspaceId: input.workspaceId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    });

    // THE OUTBOX ROW GOES FIRST, ON PURPOSE. Inserting the delivery first would
    // leave an orphaned `queued` delivery that nothing ever sends every time the
    // idempotency key collided — a row an operator would have to reconcile by
    // hand. Losing the conflict here means this business event already produced
    // an email, so there is nothing left to write.
    const inserted = await tx
      .insert(jobOutbox)
      .values({
        id: intentId,
        workspaceId: input.workspaceId,
        queueName: WORKSPACE_EMAIL_SOURCE_QUEUE_NAME,
        jobType: DOMAIN_JOB_TYPES.deliverWorkspaceEmail,
        payloadVersion: WORKSPACE_EMAIL_JOB_DEFINITION.payloadVersion,
        // `job_outbox.payload` is typed `JobOutboxPayload`, whose optional
        // `workspaceId?: string` predates workspace-less intents.
        // `WORKSPACE_EMAIL_JOB_DEFINITION.payloadSchema` is the authoritative
        // contract for this job type (and is asserted in the tests); this
        // assertion only reconciles `string | null` with the older jsonb type.
        payload: payload as unknown as JobOutboxPayload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: workspaceEmailIdempotencyKey({
          templateKey: input.templateKey,
          recipient,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
        }),
        correlationId: input.correlationId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: jobOutbox.id });
    if (inserted.length === 0) return { deliveryId: null, outcome: "duplicate" };

    await tx.insert(emailDeliveries).values({
      id: deliveryId,
      workspaceId: input.workspaceId,
      recipient,
      templateKey: input.templateKey,
      status: "queued",
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
    });
    return { deliveryId, outcome: "queued" };
  }
}
