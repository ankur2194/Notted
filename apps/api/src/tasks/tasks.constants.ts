export const TASK_AUDIT_ENTITY_TYPE = "task" as const;
export const TASK_DOMAIN_EVENT_QUEUE = "task-domain-events" as const;
export const TASK_DOMAIN_EVENT_PAYLOAD_VERSION = 1 as const;
export const TASK_DOMAIN_EVENT_IDEMPOTENCY_PREFIX = "task-domain:" as const;

export const TASK_DOMAIN_EVENTS = Object.freeze({
  create: "task.created",
  update: "task.updated",
  reorder: "task.reordered",
  delete: "task.deleted",
  bulk: "task.bulk_applied",
} as const);

export type TaskMutation = keyof typeof TASK_DOMAIN_EVENTS;

export const TASK_STATUS_AUDIT_ENTITY_TYPE = "task_status" as const;

/**
 * Audit actions only. Board columns get no `job_outbox` event: nothing indexes,
 * notifies on, or fans out a status row, and an outbox nobody drains only grows.
 */
export const TASK_STATUS_AUDIT_ACTIONS = Object.freeze({
  create: "task_status.created",
  update: "task_status.updated",
  delete: "task_status.deleted",
} as const);

export type TaskStatusMutation = keyof typeof TASK_STATUS_AUDIT_ACTIONS;

/**
 * Re-exported rather than redeclared: the wire contract already owns the bound
 * (`bulkTaskSchema` rejects longer batches at the boundary), and two literals
 * would eventually disagree.
 */
export { TASK_BULK_MAX } from "@notted/shared-validators";

/**
 * Recurrence never schedules further ahead than this. A cron the user can write
 * but that only matches once a decade is a silent "nothing happened" bug; the
 * horizon turns it into an explicit `null` the caller can report.
 */
export const TASK_RECURRENCE_HORIZON_YEARS = 5;
