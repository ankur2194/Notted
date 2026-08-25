import { z } from "zod";

import {
  defineOutboxJob,
  identifierPayloadSchema,
  platformIdentifierPayloadSchema,
  unscopedIdentifierPayloadSchema,
  type AnyOutboxJobDefinition,
} from "./job-contracts";
import { DOMAIN_JOB_TYPES, type DomainJobType } from "./job-identifiers";
import { DEAD_LETTER_QUEUE_NAME, PHYSICAL_QUEUE_NAMES } from "./queue-names";

const route = (
  physicalQueueName: (typeof PHYSICAL_QUEUE_NAMES)[keyof typeof PHYSICAL_QUEUE_NAMES],
  sourceQueueName: string,
  priority: "high" | "default" = "default",
) =>
  Object.freeze({
    physicalQueueName,
    deadLetterQueueName: DEAD_LETTER_QUEUE_NAME,
    priority,
    sourceQueueNames: Object.freeze([sourceQueueName]),
  });

const actorDefinition = <const TType extends DomainJobType>(
  jobType: TType,
  sourceQueueName: string,
) =>
  defineOutboxJob({
    jobType,
    payloadVersion: 1,
    payloadSchema: identifierPayloadSchema(jobType),
    route: route(PHYSICAL_QUEUE_NAMES.default, sourceQueueName),
    authority: "actor",
  });

export const AUTH_EMAIL_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.deliverAuthEmail,
  payloadVersion: 1,
  payloadSchema: unscopedIdentifierPayloadSchema(DOMAIN_JOB_TYPES.deliverAuthEmail),
  route: route(PHYSICAL_QUEUE_NAMES.default, "auth-email", "high"),
  authority: "system",
});

export const WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.sendWorkspaceInvitation,
  payloadVersion: 1,
  payloadSchema: identifierPayloadSchema(DOMAIN_JOB_TYPES.sendWorkspaceInvitation),
  route: route(PHYSICAL_QUEUE_NAMES.default, "transactional-email", "high"),
  authority: "actor",
});

export const STORAGE_MAINTENANCE_SOURCE_QUEUE_NAME = "storage-maintenance" as const;

export const STORAGE_MAINTENANCE_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.storageMaintenanceSweep,
  payloadVersion: 1,
  payloadSchema: unscopedIdentifierPayloadSchema(DOMAIN_JOB_TYPES.storageMaintenanceSweep),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, STORAGE_MAINTENANCE_SOURCE_QUEUE_NAME),
  authority: "system",
});

export const NOTE_VERSION_RETENTION_SOURCE_QUEUE_NAME = "note-version-retention" as const;
export const NOTE_VERSION_RETENTION_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.noteVersionRetentionSweep,
  payloadVersion: 1,
  payloadSchema: unscopedIdentifierPayloadSchema(DOMAIN_JOB_TYPES.noteVersionRetentionSweep),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, NOTE_VERSION_RETENTION_SOURCE_QUEUE_NAME),
  authority: "system",
});

export const AUDIT_LOG_RETENTION_SOURCE_QUEUE_NAME = "audit-log-retention" as const;
export const AUDIT_LOG_RETENTION_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.auditLogRetentionSweep,
  payloadVersion: 1,
  payloadSchema: unscopedIdentifierPayloadSchema(DOMAIN_JOB_TYPES.auditLogRetentionSweep),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, AUDIT_LOG_RETENTION_SOURCE_QUEUE_NAME),
  authority: "system",
});

/**
 * Workspace-deletion cleanup intent. Authority is "system" and the payload is
 * identifier-only so the durable intent survives the workspace cascade
 * (`job_outbox.workspace_id` is SET NULL). Part 26 emits it inside the
 * workspace-deletion transaction. Search has its own concern-specific intent,
 * so the completed Part 40 cleanup contract remains independently consumable.
 */
export const WORKSPACE_DELETED_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.workspaceDeleted,
  payloadVersion: 1,
  payloadSchema: platformIdentifierPayloadSchema(DOMAIN_JOB_TYPES.workspaceDeleted),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, "workspace-cleanup"),
  authority: "system",
});

export const WORKSPACE_SEARCH_PURGE_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.workspaceSearchPurge,
  payloadVersion: 1,
  payloadSchema: platformIdentifierPayloadSchema(DOMAIN_JOB_TYPES.workspaceSearchPurge),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, "workspace-search-purge"),
  authority: "system",
});

/**
 * Part 51.2 — search-index sync source queue. Producers (Part 51.3) commit one
 * `job_outbox` row with this `queue_name` inside the note-mutation transaction;
 * the dispatcher routes it to the default physical lane.
 */
export const NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME = "note-search-sync" as const;

export const NOTE_SEARCH_SYNC_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.noteSearchSync,
  payloadVersion: 1,
  payloadSchema: platformIdentifierPayloadSchema(DOMAIN_JOB_TYPES.noteSearchSync),
  route: route(PHYSICAL_QUEUE_NAMES.default, NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME),
  authority: "system",
});

export const NOTE_EMBEDDING_GENERATE_SOURCE_QUEUE_NAME = "note-embedding-generate" as const;
export const NOTE_EMBEDDING_GENERATE_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.noteEmbeddingGenerate,
  payloadVersion: 1,
  payloadSchema: platformIdentifierPayloadSchema(DOMAIN_JOB_TYPES.noteEmbeddingGenerate),
  route: route(PHYSICAL_QUEUE_NAMES.ai, NOTE_EMBEDDING_GENERATE_SOURCE_QUEUE_NAME),
  authority: "system",
});

/**
 * Part 60 — mention notification fan-out. ONE intent per recipient, so a single
 * note update that adds three mentions commits three independent outbox rows.
 * The payload does NOT fit `identifierPayloadSchema`: it carries a `recipientId`
 * that is neither the actor nor a resource id, so the shape is declared inline
 * here rather than widening the shared factory for one job type.
 */
export const MENTION_NOTIFY_SOURCE_QUEUE_NAME = "mention-notify" as const;

export const MENTION_NOTIFY_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.mentionNotify,
  payloadVersion: 1,
  payloadSchema: z
    .object({
      action: z.literal(DOMAIN_JOB_TYPES.mentionNotify),
      intentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      noteId: z.string().uuid(),
      recipientId: z.string().uuid(),
      actorId: z.string().uuid(),
    })
    .strict(),
  route: route(PHYSICAL_QUEUE_NAMES.default, MENTION_NOTIFY_SOURCE_QUEUE_NAME),
  authority: "actor",
});

/**
 * Part 61 — generic workspace email delivery. It REUSES the existing
 * `transactional-email` source queue rather than opening a new lane: operators
 * already watch that name, and invitation mail has always travelled on it.
 *
 * The payload does NOT fit `identifierPayloadSchema` (nor the platform variant):
 * `workspaceId` is NULLABLE here, because `welcome` is sent before the recipient
 * belongs to any workspace, and both shared factories require a uuid. Declared
 * inline for the same reason `MENTION_NOTIFY_JOB_DEFINITION` is.
 *
 * There is deliberately NO subject identifier in the payload.
 * `email_deliveries.related_entity_type`/`related_entity_id` are the
 * authoritative subject reference and the handler re-reads them from the claimed
 * row, so a tampered payload cannot redirect a send at a different entity.
 */
export const WORKSPACE_EMAIL_SOURCE_QUEUE_NAME = "transactional-email" as const;

export const WORKSPACE_EMAIL_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.deliverWorkspaceEmail,
  payloadVersion: 1,
  payloadSchema: z
    .object({
      action: z.literal(DOMAIN_JOB_TYPES.deliverWorkspaceEmail),
      intentId: z.string().uuid(),
      deliveryId: z.string().uuid(),
      workspaceId: z.string().uuid().nullable(),
      actorId: z.string().uuid().optional(),
    })
    .strict(),
  route: route(PHYSICAL_QUEUE_NAMES.default, WORKSPACE_EMAIL_SOURCE_QUEUE_NAME, "high"),
  authority: "system",
});

/**
 * Part 62 — export generation. ONE intent per `exports` row, committed inside
 * the same transaction as the row itself (ADR 0006).
 *
 * The payload is declared inline for the same reason
 * `MENTION_NOTIFY_JOB_DEFINITION` is: it carries an `exportId` AND a
 * `requestedById`, and neither shared factory models that pair — the identifier
 * schemas expect a resource id plus an optional actor, not a requester the
 * handler must re-authorize.
 *
 * Authority is "system", NOT "actor". The requester travels in the payload only
 * as an identifier to re-authorize with: the handler re-checks them against the
 * LIVE source via `authorizeUserJob`, so a tampered or stale payload grants
 * nothing on its own. Declaring "actor" would imply the payload itself carries
 * the permission, which is exactly the inversion ADR 0006 forbids.
 */
export const EXPORT_GENERATE_SOURCE_QUEUE_NAME = "export-generate" as const;

export const EXPORT_GENERATE_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.generateExport,
  payloadVersion: 1,
  payloadSchema: z
    .object({
      action: z.literal(DOMAIN_JOB_TYPES.generateExport),
      intentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      exportId: z.string().uuid(),
      requestedById: z.string().uuid(),
    })
    .strict(),
  route: route(PHYSICAL_QUEUE_NAMES.export, EXPORT_GENERATE_SOURCE_QUEUE_NAME),
  authority: "system",
});

/**
 * Part 66 — outbound webhook delivery. ONE intent per (endpoint x event),
 * committed inside the producing transaction (ADR 0006), so a workspace with
 * four subscribed endpoints commits four independent rows for one note update.
 * `job-identifiers.ts` carries the reasoning for why this is a dedicated intent
 * rather than a subscription to the shared `note.*`/`project.*` job types.
 *
 * Authority is "system", NOT "actor" — the same call `EXPORT_GENERATE` made.
 * The payload GRANTS NOTHING: the handler re-reads the endpoint, takes its
 * `created_by_id`, and re-authorizes that user against the LIVE resource with
 * `authorizeUserJob`. An endpoint whose creator lost access, or a resource that
 * was deleted or restricted after the intent was committed, therefore delivers
 * nothing. Declaring "actor" would imply the payload itself carries the
 * permission, which is exactly the inversion ADR 0006 forbids.
 *
 * The payload is identifiers only, with ONE deliberate exception: `occurredAt`.
 * A deletion's timestamp is not recoverable from the row afterwards — by the
 * time the handler runs, the thing that was deleted is gone or tombstoned, and
 * `now()` at delivery time would misreport when the event happened to every
 * receiver. It is schema-validated here and covered by `payload_hash`, so a
 * tampered value fails the hash check before the handler sees it. This is a
 * bounded, argued exception to ADR 0006's identifier-only rule, not a slip.
 *
 * `resourceId` and `actorId` are nullable because not every event has them:
 * `member.joined` has no note or project resource, and a system-initiated
 * mutation has no acting user.
 *
 * `maximumAttempts: 5` is Notted.md's "max 5 attempts", per endpoint rather
 * than shared (see `job-identifiers.ts`). It rides the standard
 * `notted-bounded-exponential` backoff the whole runtime uses: 1s -> 2s -> 4s
 * -> 8s from the `QUEUE_BACKOFF_BASE_MS` default, +/- the jitter percentage and
 * capped by `QUEUE_BACKOFF_MAX_MS`.
 *
 * // ponytail: shares the notted-default lane; give webhooks their own lane if
 * // a noisy tenant starves email/mentions.
 */
export const WEBHOOK_DELIVER_SOURCE_QUEUE_NAME = "webhook-deliver" as const;

export const WEBHOOK_DELIVER_JOB_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.webhookDeliver,
  payloadVersion: 1,
  payloadSchema: z
    .object({
      action: z.literal(DOMAIN_JOB_TYPES.webhookDeliver),
      intentId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      webhookId: z.string().uuid(),
      eventId: z.string().uuid(),
      event: z.string().min(1).max(100),
      resourceId: z.string().uuid().nullable(),
      actorId: z.string().uuid().nullable(),
      occurredAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  route: route(PHYSICAL_QUEUE_NAMES.default, WEBHOOK_DELIVER_SOURCE_QUEUE_NAME),
  authority: "system",
  maximumAttempts: 5,
});

export const JOB_IDEMPOTENCY_CLEANUP_SOURCE_QUEUE_NAME = "queue-maintenance" as const;

export const JOB_IDEMPOTENCY_CLEANUP_DEFINITION = defineOutboxJob({
  jobType: DOMAIN_JOB_TYPES.jobIdempotencyCleanup,
  payloadVersion: 1,
  payloadSchema: unscopedIdentifierPayloadSchema(DOMAIN_JOB_TYPES.jobIdempotencyCleanup),
  route: route(PHYSICAL_QUEUE_NAMES.maintenance, JOB_IDEMPOTENCY_CLEANUP_SOURCE_QUEUE_NAME),
  authority: "system",
});

const registryEntries = [
  AUTH_EMAIL_JOB_DEFINITION,
  WORKSPACE_INVITATION_EMAIL_JOB_DEFINITION,
  ...(
    [
      [DOMAIN_JOB_TYPES.noteCreated, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteUpdated, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteMoved, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteDeleted, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteRestored, "note-domain-events"],
      [DOMAIN_JOB_TYPES.notePermanentlyDeleted, "note-domain-events"],
      [DOMAIN_JOB_TYPES.folderCreated, "note-domain-events"],
      [DOMAIN_JOB_TYPES.folderUpdated, "note-domain-events"],
      [DOMAIN_JOB_TYPES.folderDeleted, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteShareUpserted, "note-domain-events"],
      [DOMAIN_JOB_TYPES.noteShareRevoked, "note-domain-events"],
      [DOMAIN_JOB_TYPES.projectCreated, "project-domain-events"],
      [DOMAIN_JOB_TYPES.projectUpdated, "project-domain-events"],
      [DOMAIN_JOB_TYPES.projectArchived, "project-domain-events"],
      [DOMAIN_JOB_TYPES.projectCompleted, "project-domain-events"],
      [DOMAIN_JOB_TYPES.projectRestored, "project-domain-events"],
      [DOMAIN_JOB_TYPES.projectDeleted, "project-domain-events"],
      [DOMAIN_JOB_TYPES.tagCreated, "tag-domain-events"],
      [DOMAIN_JOB_TYPES.tagUpdated, "tag-domain-events"],
      [DOMAIN_JOB_TYPES.tagDeleted, "tag-domain-events"],
      [DOMAIN_JOB_TYPES.taskCreated, "task-domain-events"],
      [DOMAIN_JOB_TYPES.taskUpdated, "task-domain-events"],
      [DOMAIN_JOB_TYPES.taskReordered, "task-domain-events"],
      [DOMAIN_JOB_TYPES.taskDeleted, "task-domain-events"],
      [DOMAIN_JOB_TYPES.taskBulkApplied, "task-domain-events"],
      [DOMAIN_JOB_TYPES.attachmentCreated, "attachment-domain-events"],
      [DOMAIN_JOB_TYPES.attachmentDeleted, "attachment-domain-events"],
    ] as const
  ).map(([jobType, sourceQueueName]) => actorDefinition(jobType, sourceQueueName)),
  WORKSPACE_DELETED_JOB_DEFINITION,
  WORKSPACE_SEARCH_PURGE_JOB_DEFINITION,
  STORAGE_MAINTENANCE_JOB_DEFINITION,
  NOTE_VERSION_RETENTION_JOB_DEFINITION,
  AUDIT_LOG_RETENTION_JOB_DEFINITION,
  JOB_IDEMPOTENCY_CLEANUP_DEFINITION,
  NOTE_SEARCH_SYNC_JOB_DEFINITION,
  NOTE_EMBEDDING_GENERATE_JOB_DEFINITION,
  MENTION_NOTIFY_JOB_DEFINITION,
  WORKSPACE_EMAIL_JOB_DEFINITION,
  EXPORT_GENERATE_JOB_DEFINITION,
  WEBHOOK_DELIVER_JOB_DEFINITION,
] as const satisfies readonly AnyOutboxJobDefinition[];

export const JOB_REGISTRY: ReadonlyMap<DomainJobType, AnyOutboxJobDefinition> = new Map(
  registryEntries.map((definition) => [definition.jobType, definition] as const),
);

export function registeredJobDefinition(jobType: string): AnyOutboxJobDefinition | undefined {
  return JOB_REGISTRY.get(jobType as DomainJobType);
}

export function isRegisteredOutboxRoute(
  definition: AnyOutboxJobDefinition,
  sourceQueueName: string,
  payloadVersion: number,
): boolean {
  return (
    definition.payloadVersion === payloadVersion &&
    definition.route.sourceQueueNames.includes(sourceQueueName)
  );
}
