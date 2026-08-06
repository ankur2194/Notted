// Part 12 / Part 13 schema barrel. Identity and authentication tables are
// added in Part 13; remaining application tables are added in Parts 14–18.
// Each later part appends its exported tables and relations to the aggregate
// `schema` object so the Drizzle adapter and the typed `db` handle remain a
// single source of truth.
//
// Better Auth mounting (Part 21) consumes this barrel directly: `users` is the
// application user profile and Better Auth's `user` table (mapped via
// `user.modelName = "users"`); `session`, `account`, `verification`,
// `twoFactor`, and `passkey` are the Better Auth-owned auth tables. Relations
// are included so the Drizzle adapter can use experimental joins.

// Part 15 — projects, folders, notes, and sharing.
// Part 16 — tags, attachments, comments, and note versions.
// Part 18 — operations and integration tables (embeddings, audit logs, API
// keys, webhooks + deliveries, exports, AI provider config + usage, email
// deliveries, durable job outbox, and worker idempotency). Part 21 adds only
// the approved encrypted authentication-email context bridge. Sensitive values are stored only as hashes
// (api_keys.key_hash, webhook payload hashes, job payload hashes) or as
// application-encrypted blobs with an explicit key-version column
// (webhooks.encrypted_secret, ai_provider_config.encrypted_credentials);
// request/output content is deliberately NOT retained (ai_usage, audit_logs
// metadata, email_deliveries). See each module for the owning service part.
import {
  aiProviderConfig,
  aiProviderConfigRelations,
  aiProviderEnum,
  aiUsage,
  aiUsageRelations,
} from "./ai";
import { apiIdempotencyRecords } from "./api-idempotency";
import { apiKeys, apiKeysRelations } from "./api-keys";
import {
  attachmentMediaTypeEnum,
  attachmentStatusEnum,
  attachments,
  attachmentsRelations,
} from "./attachments";
import { auditLogs, auditLogsRelations } from "./audit-logs";
import {
  account,
  accountRelations,
  passkey,
  passkeyRelations,
  session,
  sessionRelations,
  twoFactor,
  twoFactorRelations,
  usersRelations,
  verification,
} from "./auth";
import {
  authEmailIntents,
  authEmailIntentsRelations,
  authEmailIntentStatusEnum,
  authEmailPurposeEnum,
} from "./auth-email-intents";
import { comments, commentsRelations } from "./comments";
import { emailDeliveries, emailDeliveriesRelations, emailStatusEnum } from "./email-deliveries";
import { exportFormatEnum, exportJobs, exportJobsRelations, exportStatusEnum } from "./exports";
import { folders, foldersRelations } from "./folders";
import { jobStatusEnum, jobIdempotency } from "./job-idempotency";
import { jobOutbox, jobOutboxRelations, jobOutboxStatusEnum } from "./job-outbox";
import { noteEmbeddings, noteEmbeddingsRelations } from "./note-embeddings";
import { noteVersions, noteVersionsRelations } from "./note-versions";
import {
  noteShares,
  noteSharesRelations,
  noteSharePermissionEnum,
  noteTypeEnum,
  notes,
  notesRelations,
} from "./notes";
import {
  notificationKindEnum,
  notifications,
  notificationsRelations,
  notificationTargetTypeEnum,
} from "./notifications";
import {
  projectAccess,
  projectAccessRelations,
  projectAccessRoleEnum,
  projectStatusEnum,
  projects,
  projectsRelations,
} from "./projects";
import { noteTags, noteTagsRelations, tags, tagsRelations } from "./tags";
// Part 17 — standalone tasks, custom task statuses, and task-tag links.
import {
  taskPriorityEnum,
  taskRecurrenceEnum,
  taskStatusEnum,
  taskStatuses,
  taskStatusesRelations,
  taskTags,
  taskTagsRelations,
  tasks,
  tasksRelations,
} from "./tasks";
import { users } from "./users";
import {
  webhookDeliveryStatusEnum,
  webhookDeliveries,
  webhookDeliveriesRelations,
  webhooks,
  webhooksRelations,
} from "./webhooks";
import { workspaceDeletionAudits } from "./workspace-deletion-audits";
import {
  invitations,
  invitationsRelations,
  memberRoleEnum,
  workspaceMembers,
  workspaceMembersRelations,
  workspacePlanEnum,
  workspaces,
  workspacesRelations,
} from "./workspaces";

// Re-export tables and relations so application code and tests can import them
// from the canonical schema barrel.
export {
  account,
  accountRelations,
  passkey,
  passkeyRelations,
  session,
  sessionRelations,
  twoFactor,
  twoFactorRelations,
  usersRelations,
  verification,
} from "./auth";
export { users } from "./users";
export { BETTER_AUTH_SCHEMA_CONTRACT } from "./auth-contract";
export {
  invitations,
  invitationsRelations,
  memberRoleEnum,
  workspaceMembers,
  workspaceMembersRelations,
  workspacePlanEnum,
  workspaces,
  workspacesRelations,
} from "./workspaces";
export { workspaceDeletionAudits } from "./workspace-deletion-audits";
export { folders, foldersRelations } from "./folders";
export {
  noteShares,
  noteSharesRelations,
  noteSharePermissionEnum,
  noteTypeEnum,
  notes,
  notesRelations,
} from "./notes";
export {
  projectAccess,
  projectAccessRelations,
  projectAccessRoleEnum,
  projectStatusEnum,
  projects,
  projectsRelations,
} from "./projects";
export {
  attachmentMediaTypeEnum,
  attachmentStatusEnum,
  attachments,
  attachmentsRelations,
} from "./attachments";
export type {
  AttachmentPreviewObject,
  AttachmentVariantObject,
  AttachmentVariantRecord,
} from "./attachments";
export { comments, commentsRelations } from "./comments";
export { noteVersions, noteVersionsRelations } from "./note-versions";
export { noteTags, noteTagsRelations, tags, tagsRelations } from "./tags";
export {
  taskPriorityEnum,
  taskRecurrenceEnum,
  taskStatusEnum,
  taskStatuses,
  taskStatusesRelations,
  taskTags,
  taskTagsRelations,
  tasks,
  tasksRelations,
} from "./tasks";
// Part 18 — operations and integration tables (final schema part).
export {
  aiProviderConfig,
  aiProviderConfigRelations,
  aiProviderEnum,
  aiUsage,
  aiUsageRelations,
} from "./ai";
export { apiKeys, apiKeysRelations } from "./api-keys";
export { apiIdempotencyRecords } from "./api-idempotency";
export { auditLogs, auditLogsRelations } from "./audit-logs";
export {
  authEmailIntents,
  authEmailIntentsRelations,
  authEmailIntentStatusEnum,
  authEmailPurposeEnum,
  type AuthEmailPurpose,
} from "./auth-email-intents";
export { emailDeliveries, emailDeliveriesRelations, emailStatusEnum } from "./email-deliveries";
export { exportFormatEnum, exportJobs, exportJobsRelations, exportStatusEnum } from "./exports";
export { jobStatusEnum, jobIdempotency } from "./job-idempotency";
export {
  jobOutbox,
  jobOutboxRelations,
  jobOutboxStatusEnum,
  type JobOutboxPayload,
} from "./job-outbox";
export { noteEmbeddings, noteEmbeddingsRelations } from "./note-embeddings";
export {
  notificationKindEnum,
  notifications,
  notificationsRelations,
  notificationTargetTypeEnum,
} from "./notifications";
export {
  webhookDeliveryStatusEnum,
  webhookDeliveries,
  webhookDeliveriesRelations,
  webhooks,
  webhooksRelations,
} from "./webhooks";

export const schema = {
  // Part 13 — application user profile; doubles as Better Auth's `user` table.
  users,
  usersRelations,
  // Part 13 — Better Auth-owned auth tables.
  session,
  sessionRelations,
  account,
  accountRelations,
  verification,
  twoFactor,
  twoFactorRelations,
  passkey,
  passkeyRelations,
  // Part 14 — workspace tenancy root, memberships, and invitations.
  workspaces,
  workspacesRelations,
  workspaceMembers,
  workspaceMembersRelations,
  invitations,
  invitationsRelations,
  memberRoleEnum,
  workspacePlanEnum,
  // Part 26 — deletion tombstones have no workspace/user FK and survive the
  // tenant cascade. Part 71 owns their read and retention policy.
  workspaceDeletionAudits,
  // Part 15 — projects, project access, folders, notes, note sharing, and
  // their enums and relations. Notes carry composite FKs to projects and
  // folders for DB-level cross-tenant integrity; ordering, depth, cycle, and
  // delegation invariants are enforced by the service (Parts 29/31/32).
  projects,
  projectsRelations,
  projectAccess,
  projectAccessRelations,
  projectStatusEnum,
  projectAccessRoleEnum,
  folders,
  foldersRelations,
  notes,
  notesRelations,
  noteShares,
  noteSharesRelations,
  noteTypeEnum,
  noteSharePermissionEnum,
  // Part 16 — tags, note_tags junction, attachments (processing state +
  // variants per ADR 0005), comments (selection anchors per ADR 0004), and
  // note_versions snapshot rows. Cross-workspace tag-assignment invariant is
  // service-enforced (Part 24/31); comment anchor remapping-through-edits is
  // editor/service logic (Part 60); version retention purge is Part 19/55.
  tags,
  tagsRelations,
  noteTags,
  noteTagsRelations,
  attachments,
  attachmentsRelations,
  attachmentStatusEnum,
  attachmentMediaTypeEnum,
  comments,
  commentsRelations,
  noteVersions,
  noteVersionsRelations,
  // Part 17 — standalone tasks, custom task statuses (board columns), and
  // task-tag links. Status design: built-in `task_status` enum plus optional
  // `custom_status_id` override; recurrence as enum + optional cron. Inline
  // TipTap checklists do NOT auto-become tasks — conversion is an explicit
  // service action (Part 47). Assignee-membership is service-enforced
  // (Part 24/47); cross-workspace project assignment is rejected at the DB
  // layer via the `tasks_workspace_project_fk` composite FK.
  tasks,
  tasksRelations,
  taskStatuses,
  taskStatusesRelations,
  taskTags,
  taskTagsRelations,
  taskStatusEnum,
  taskPriorityEnum,
  taskRecurrenceEnum,
  // Part 18 — operations and integration tables.
  // note_embeddings: one 1536-dim pgvector row per note (HNSW cosine index);
  // multi-embedding/chunked design is deferred to Part 53.
  noteEmbeddings,
  noteEmbeddingsRelations,
  // audit_logs: append-only workspace activity trail (no updatedAt;
  // immutability is service-enforced in Part 71; metadata carries no
  // content/secrets).
  auditLogs,
  auditLogsRelations,
  // api_keys: hash-only machine credentials (UNIQUE key_hash); raw keys are
  // never persisted. Authenticated by the API-key service (Part 61).
  apiKeys,
  apiKeysRelations,
  apiIdempotencyRecords,
  // webhooks + webhook_deliveries: workspace-owned endpoints (encrypted
  // signing secret + key version; disabled until verified) and immutable
  // delivery attempts. HMAC/SSRF/retries are the dispatcher (Part 66).
  webhooks,
  webhooksRelations,
  webhookDeliveries,
  webhookDeliveriesRelations,
  webhookDeliveryStatusEnum,
  // exports: private MinIO-backed export jobs (state machine queued→ready→
  // expired; 7-day object retention + 7-day download grant; authorization
  // rechecked at create + download — Part 62/63).
  exportJobs,
  exportJobsRelations,
  exportFormatEnum,
  exportStatusEnum,
  // ai_provider_config + ai_usage: per-workspace AI config (encrypted
  // credentials + key version; disabled by default) and append-only usage
  // rows with NO request/output content retained. The AI service (Part 67)
  // encrypts/decrypts and fails closed on quota.
  aiProviderConfig,
  aiProviderConfigRelations,
  aiUsage,
  aiUsageRelations,
  aiProviderEnum,
  // email_deliveries: transactional email delivery status (template key +
  // safe recipient; NO bodies/tokens/magic links persisted). Transactional
  // intent lives in job_outbox; worker replay protection in job_idempotency.
  emailDeliveries,
  emailDeliveriesRelations,
  emailStatusEnum,
  // Part 21 — encrypted, expiring, one-time context for authentication emails.
  authEmailIntents,
  authEmailIntentsRelations,
  authEmailPurposeEnum,
  authEmailIntentStatusEnum,
  // Part 25 — current-user, workspace-scoped notification center storage.
  notifications,
  notificationsRelations,
  notificationKindEnum,
  notificationTargetTypeEnum,
  // job_idempotency: independently expiring cross-restart worker replay
  // protection (ADR 0006). Stores only a payload hash + small safe result; cleanup
  // maintenance worker (Part 50) reaps past-expiry rows.
  jobIdempotency,
  jobStatusEnum,
  // job_outbox: durable side-effect intent committed atomically with business
  // state. Dispatch occurs after commit. job_idempotency remains separate,
  // expiring worker replay protection (ADR 0006).
  jobOutbox,
  jobOutboxRelations,
  jobOutboxStatusEnum,
} as const;

/**
 * Aggregate schema type consumed by the Drizzle handle and transaction types.
 * Re-exported so callers depend on the barrel rather than the `typeof` query.
 */
export type Schema = typeof schema;
