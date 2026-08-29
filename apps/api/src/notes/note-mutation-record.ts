// The audit row, the outbox intent, and the webhook delivery that every note or
// folder mutation writes — in the caller's transaction, never after it.
//
// Extracted from `NotesService` when folders moved to their own service: both
// need it, and the alternative was either a circular injection between the two
// services or a second copy of the same three writes. A free function taking the
// transaction is the shape that lets two services share it and neither own it.
//
// ORDERING IS THE POINT (ADR 0006). The audit row, the `job_outbox` intent and
// the webhook delivery all commit with the change they describe. A job dispatched
// before commit can observe a row that never existed; a webhook announced before
// commit can tell a customer about a change a rollback then un-did.

import { createHash, randomUUID } from "node:crypto";

import { recordAudit } from "../audit/audit-record";
import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import { activeWorkspaceId, TenantContextService } from "../tenant";

import {
  FOLDER_AUDIT_ENTITY_TYPE,
  NOTE_AUDIT_ENTITY_TYPE,
  NOTE_DOMAIN_EVENTS,
  NOTE_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  NOTE_DOMAIN_EVENT_PAYLOAD_VERSION,
  NOTE_DOMAIN_EVENT_QUEUE,
  type NoteMutation,
} from "./notes.constants";

import type { DatabaseTransaction } from "../database/database.service";
import type { WebhookDeliveryProducer } from "../webhooks/webhook-delivery.producer";

export interface MutationActor {
  readonly principal: { readonly userId: string };
  readonly requestId?: string | null;
}

export async function recordNoteMutation(
  tx: DatabaseTransaction,
  context: {
    readonly tenantContext: TenantContextService;
    readonly webhookProducer?: WebhookDeliveryProducer | undefined;
  },
  mutation: NoteMutation,
  entityId: string,
  input: MutationActor,
): Promise<void> {
  const workspaceId = activeWorkspaceId(context.tenantContext);
  const folderMutation = mutation.startsWith("folder");
  const eventName = NOTE_DOMAIN_EVENTS[mutation];
  await recordAudit(tx, {
    workspaceId,
    userId: input.principal.userId,
    action: eventName,
    entityType: folderMutation ? FOLDER_AUDIT_ENTITY_TYPE : NOTE_AUDIT_ENTITY_TYPE,
    entityId,
    metadata: {},
    requestId: input.requestId ?? null,
  });
  const intentId = randomUUID();
  const payload: JobOutboxPayload = Object.freeze({
    action: eventName,
    intentId,
    workspaceId,
    resourceIds: Object.freeze([entityId]),
    actorId: input.principal.userId,
  });
  await tx.insert(jobOutbox).values({
    id: intentId,
    workspaceId,
    queueName: NOTE_DOMAIN_EVENT_QUEUE,
    jobType: eventName,
    payloadVersion: NOTE_DOMAIN_EVENT_PAYLOAD_VERSION,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    idempotencyKey: `${NOTE_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${eventName}:${entityId}:${intentId}`,
    correlationId: input.requestId ?? null,
  });
  // Part 66. `note.created`, `note.updated` and `note.deleted` are the
  // subscribable subset; the producer drops the rest (`note.moved`, `folder.*`)
  // before it issues any SQL.
  await context.webhookProducer?.scheduleWebhookDeliveries(tx, {
    event: eventName,
    workspaceId,
    resourceId: entityId,
    actorId: input.principal.userId,
    occurredAt: new Date(),
    correlationId: input.requestId ?? null,
  });
}
