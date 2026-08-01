/** Stable audit verbs written by the project application service. */
export const PROJECT_AUDIT_ACTIONS = Object.freeze({
  create: "project.create",
  update: "project.update",
  archive: "project.archive",
  complete: "project.complete",
  restore: "project.restore",
  delete: "project.delete",
} as const);

/** Identifier-only domain event names reserved for future consumers. */
export const PROJECT_DOMAIN_EVENTS = Object.freeze({
  create: "project.created",
  update: "project.updated",
  archive: "project.archived",
  complete: "project.completed",
  restore: "project.restored",
  delete: "project.deleted",
} as const);

export const PROJECT_AUDIT_ENTITY_TYPE = "project" as const;
export const PROJECT_DOMAIN_EVENT_QUEUE = "project-domain-events" as const;
export const PROJECT_DOMAIN_EVENT_PAYLOAD_VERSION = 1 as const;
export const PROJECT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX = "project-domain:" as const;

export type ProjectMutation = keyof typeof PROJECT_DOMAIN_EVENTS;
