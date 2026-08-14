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
  JOB_IDEMPOTENCY_CLEANUP_DEFINITION,
  NOTE_SEARCH_SYNC_JOB_DEFINITION,
  NOTE_EMBEDDING_GENERATE_JOB_DEFINITION,
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
