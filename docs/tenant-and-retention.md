# Tenant Protection and Retention Policy

This document is the operational reference for how Notted enforces the
workspace (tenant) boundary on every database query, and how long it retains
deleted/soft-deleted/historical data. It is the companion to
[ADR 0009](decisions/0009-tenant-protection-strategy.md), which records the
architectural decision and its alternatives.

> **Authority.** ADR 0003 (Better Auth owns authentication; shared backend
> policies load workspace grants from PostgreSQL and **deny by default**) and
> ADR 0007 (every tenant-owned row carries or derives `workspace_id`;
> cross-workspace foreign-key combinations must be impossible or
> transactionally rejected; a bare UUID never grants access) together set the
> posture. ADR 0009 decides the _mechanism_: **repository-layer enforcement
> with a transaction-local tenant/user context, plus composite DB constraints
> where feasible, plus automated denial tests.** PostgreSQL row-level security
> is deliberately deferred (see ADR 0009 for the rationale).

## 1. Workspace-scoping strategy

### 1.1 The active context

Every request, WebSocket message, and background job runs inside an
**active tenant context** of the shape:

```ts
interface TenantContext {
  readonly workspaceId: string; // the boundary; REQUIRED for tenant-owned queries
  readonly userId: string | null; // null when a system job acts in-workspace
  readonly requestId?: string | null; // correlation id from RequestContextMiddleware
}
```

The context is held by `TenantContextService`
(`apps/api/src/tenant/tenant-context.service.ts`), an
`AsyncLocalStorage<TenantContext>`-backed NestJS `@Global()` injectable. It
propagates across async hops without being threaded through every signature.
The API is:

| Method         | Behavior                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run(ctx, fn)` | Establish `ctx` for the duration of `fn`, restoring the prior context after. **Use this at every request, WebSocket-message, job, and transaction boundary that establishes a workspace scope.** |
| `get()`        | Return the active context, or throw `TenantError("tenant.no_active_context")` when unset — **deny by default**.                                                                                  |
| `tryGet()`     | Return the context or `null`. For platform code that legitimately runs outside any workspace scope. Tenant repositories must not use it.                                                         |

`get()` is the contract: a tenant-owned query that runs without a context
**fails loudly** rather than reading unscoped data. No mutation/clear API is
exposed; callback-bounded `run()` prevents context leakage between operations.

### 1.2 The scoping helper

`apps/api/src/tenant/workspace-scope.ts` exposes the canonical predicate:

```ts
whereWorkspace(table, tenantContext) === eq(table.workspaceId, tenantContext.get().workspaceId);
```

**Rule (enforced by review and the denial tests):** every tenant-owned
read/update/delete includes `whereWorkspace` or a constrained-parent equivalent.
Every insert derives `workspace_id` from `activeWorkspaceId(tenantContext)`,
passes direct values through `assertWorkspaceInsertValues`, and validates
parent references with `assertActiveWorkspace` in the same transaction (with
composite FKs as defense where present). Existing-resource reads/mutations also
call `assertActiveWorkspace` after scoped resolution and before SQL. Absence of
scope is a security bug.

```ts
// Correct — a workspace-scoped read:
const rows = await db
  .select()
  .from(notes)
  .where(whereWorkspace(notes, tenantContext));

// Correct — a workspace-scoped write that the composite FK protects:
await db.insert(notes).values({
  workspaceId: activeWorkspaceId(tenantContext),
  projectId,
  ...
});
// notes_workspace_project_fk ensures `projectId` belongs to the same workspace.
```

**Tables without a direct `workspace_id`** (junctions and polymorphic children:
`note_tags`, `task_tags`, `comments`, `note_versions`, `note_embeddings`,
`note_collaboration_states`, `note_collaboration_updates`, `project_access`,
`note_shares`, `webhook_deliveries`) are scoped **by their parent table** via a
join:

```ts
// Comments reach workspace transitively via note_id -> notes.workspace_id.
const rows = await db
  .select({ comment: comments })
  .from(comments)
  .innerJoin(notes, eq(comments.noteId, notes.id))
  .where(whereWorkspace(notes, tenantContext));
```

### 1.3 What the DB layer guarantees vs. what the service layer guarantees

The guarantee is layered. **Each tier is independently testable.**

| Tier                      | Mechanism                                                                                                                                                                                     | What it catches                                                                                                                                  | What it does NOT catch                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **DB**                    | Composite cross-tenant FKs (see §1.4)                                                                                                                                                         | A `notes`/`tasks` row in workspace A referencing a `projects`/`folders` row in workspace B at INSERT/UPDATE time. Rejects with SQLSTATE `23503`. | Reads. Writes to junction/child tables. Two-hop invariants (assignee membership, tag assignment, share delegation). |
| **Repository (Part 24+)** | Active-context predicates plus `assertActiveWorkspace` on resolved resources/parents and `assertWorkspaceInsertValues` on direct inserts; helpers call `get()` and deny by default before SQL | Cross-tenant reads and READ/INSERT/UPDATE/DELETE attempts, including constrained-parent child/junction operations.                               | Bugs where a developer forgets the helper. Caught by review + the denial tests.                                     |
| **Policy (Part 24)**      | Membership and resource-grant evaluation against live `workspace_members`/`project_access`/`note_shares` rows                                                                                 | A user who is authenticated but no longer a workspace member; role/action escalation; project/note grant boundaries                              | Bypassed only by a code bug, which the helper prevents.                                                             |

A valid session **never** implies workspace access (ADR 0003). A bare UUID
**never** grants access (ADR 0007). Authorization is re-evaluated live on every
operation that touches tenant-owned data.

### 1.4 Existing DB-level cross-tenant protections

Parts 15 and 17 added composite cross-tenant foreign keys that reject the most
common cross-workspace writes at the DB layer:

| Composite FK                                                                                                         | Rejects                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `notes_workspace_project_fk` (`notes(workspace_id, project_id)` → `projects(workspace_id, id)`, ON DELETE NO ACTION) | A note in workspace A pointing at workspace B's project |
| `notes_workspace_folder_fk` (`notes(workspace_id, folder_id)` → `folders(workspace_id, id)`, ON DELETE NO ACTION)    | A note in workspace A pointing at workspace B's folder  |
| `tasks_workspace_project_fk` (`tasks(workspace_id, project_id)` → `projects(workspace_id, id)`, ON DELETE NO ACTION) | A task in workspace A pointing at workspace B's project |

These are **ON DELETE NO ACTION**: project/folder deletion is mediated by the
service (Part 29/31), which nullifies `notes.project_id`/`notes.folder_id`/
`tasks.project_id` for the affected rows in the same transaction before
deleting the project/folder. This is a security-first deviation from
Notted.md's literal `onDelete: "set null"`; the observable behavior (project
deletion keeps notes/tasks alive as standalone) is preserved through service
coordination.

Two-hop invariants the composite FKs **cannot** express (assignee membership,
note-tag/task-tag cross-workspace assignment, note-share delegation cap) are
enforced in the service transaction by Part 24+ and tested in their owning
parts.

### 1.5 Tenant-owned tables

Every table in the schema is one of:

- **Tenant-owned (carries `workspace_id` directly):** `workspaces` (root, id IS
  the boundary), `workspace_members`, `invitations`, `projects`, `folders`,
  `notes`, `tags`, `attachments`, `tasks`, `task_statuses`, `audit_logs`,
  `api_keys`, `webhooks`, `exports`, `ai_provider_config`, `ai_usage`,
  `email_deliveries` (`workspace_id` is **nullable** for system emails —
  verification, magic link, password reset).
- **Tenant-owned (reaches `workspace_id` transitively via a parent):**
  `project_access` (via `project_id` → `projects`), `note_shares` (via
  `note_id` → `notes`), `note_tags` (via `note_id`/`tag_id`), `comments` (via
  `note_id`), `note_versions` (via `note_id`), `note_embeddings` (via
  `note_id`), `note_collaboration_states` (via `note_id`),
  `note_collaboration_updates` (via `note_id`), `task_tags` (via
  `task_id`/`tag_id`), `webhook_deliveries` (via `webhook_id`).
- **Global (NOT workspace-scoped, intentionally):** `users` (a user can belong
  to many workspaces), `account`, `session`, `verification`, `two_factor`,
  `passkey` (Better Auth-owned identity/session tables — ADR 0003), and
  `job_idempotency` (cross-cutting dedup surface whose key encodes the intent
  — ADR 0006; it spans many intent types and must outlive referenced-resource
  deletion within its TTL).
- **Operational mixed scope:** `job_outbox.workspace_id` is nullable because
  platform maintenance intent may be workspace-less. Tenant-correlated rows
  carry the workspace and are filtered by the dispatcher; `ON DELETE SET NULL`
  preserves safe operational state. The outbox payload remains identifier-only
  and never grants access—the worker reloads authoritative scoped resources.

Global tables are out of `whereWorkspace`'s scope by design; access to them is
gated by the Part 24 policy layer (e.g. a user reads only their own `session`
rows).

### 1.6 Cross-workspace denial tests

`apps/api/test/tenant-isolation.test.ts` is the regression net. It exercises:

1. **Unit tests (no DB)** for `TenantContextService` (`run`/`get`/`tryGet`
   semantics, nested/restored contexts, and the deny-by-default `get()` throw)
   and the `whereWorkspace` helper (rejects missing context and produces the
   expected `eq(table.workspaceId, ...)` predicate from an active context).
2. **Unit repository matrices** that attempt READ/INSERT/UPDATE/DELETE for all
   direct tenant entities and constrained-parent entities, assert typed
   `tenant.workspace_mismatch`, and prove the guarded SQL callback is never
   reached.
3. **Live tests (DATABASE_URL-gated, `describe.skipIf(!HAS_DATABASE_URL)` +
   `skip()`)** that set up two tenants (workspace A + owner, workspace B +
   owner) and assert:
   - **DB-level write denial:** `notes` → B's project, `notes` → B's folder,
     `tasks` → B's project each reject with SQLSTATE `23503` (foreign-key
     violation).
   - **Read-scope predicate:** direct predicates cover workspaces, members,
     invitations, projects, folders, notes, tags, attachments, tasks, task
     statuses, audit logs, API keys, webhooks, exports, AI config/usage, and
     scoped email deliveries. Explicit constrained-parent joins cover
     project access, note shares, note tags, comments, note versions, task
     tags, note embeddings, and webhook deliveries. Every query includes A's
     row and excludes B's row; the test file contains the full matrix.

## 2. Retention policy

Retention is the answer to "how long does Notted keep this data before the
cleanup job deletes it?" Part 19 defines the policy and the typed config; the
actual scheduled purge/reconciliation work belongs to the feature parts that
own each lifecycle: Parts 21, 45, 55, and 71. Part 50 supplies the maintenance
queue and worker infrastructure; Part 78 adds observability rather than data
retention jobs.

### 2.1 Config keys and defaults

The retention windows live in `apps/api/src/config/retention.config.ts` and are
exposed via the `RETENTION_CONFIG` provider. Every finite key is environment-
overridable with a hard minimum of 1 day and a maximum of ~100 years. Paid-tier
note/version keys accept `"unlimited"`, represented as `null`, meaning "no
automated purge".

| Key                                  | Env var                                  | Default            | Applies to                                                               | Purge job                  |
| ------------------------------------ | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------ | -------------------------- |
| `deletedNoteRetentionDaysFree`       | `RETENTION_DELETED_NOTE_DAYS_FREE`       | `30`               | Free-tier soft-deleted notes (`notes.is_deleted = true`)                 | Part 45                    |
| `deletedNoteRetentionDaysPro`        | `RETENTION_DELETED_NOTE_DAYS_PRO`        | `null` (unlimited) | Pro-tier soft-deleted notes                                              | Part 45 (skip when `null`) |
| `deletedNoteRetentionDaysEnterprise` | `RETENTION_DELETED_NOTE_DAYS_ENTERPRISE` | `null` (unlimited) | Enterprise soft-deleted notes                                            | Part 45 (skip when `null`) |
| `noteVersionRetentionDaysFree`       | `RETENTION_NOTE_VERSION_DAYS_FREE`       | `30`               | Free-tier `note_versions` snapshot rows                                  | Part 55                    |
| `noteVersionRetentionDaysPro`        | `RETENTION_NOTE_VERSION_DAYS_PRO`        | `null` (unlimited) | Pro-tier `note_versions`                                                 | Part 55 (skip when `null`) |
| `noteVersionRetentionDaysEnterprise` | `RETENTION_NOTE_VERSION_DAYS_ENTERPRISE` | `null` (unlimited) | Enterprise `note_versions`                                               | Part 55 (skip when `null`) |
| `auditLogRetentionDays`              | `RETENTION_AUDIT_LOG_DAYS`               | `365`              | `audit_logs` rows                                                        | Part 71                    |
| `exportObjectRetentionDays`          | `RETENTION_EXPORT_OBJECT_DAYS`           | `7`                | MinIO objects for `exports` rows (ADR 0007)                              | Parts 45/62                |
| `sessionShortLivedHours`             | `SESSION_SHORT_LIVED_HOURS`              | `24` (hours only)  | Better Auth 1.6.24 fixed non-remember-me TTL (ADRs 0007, 0010)            | Part 21 (Better Auth)      |
| `sessionRememberMeDays`              | `SESSION_REMEMBER_ME_DAYS`               | `30`               | Remember-me session duration (ADR 0007)                                  | Part 21 (Better Auth)      |
| `orphanedObjectCleanupDays`          | `RETENTION_ORPHANED_OBJECT_DAYS`         | `7`                | Orphaned MinIO objects whose DB record is gone (ADR 0005 reconciliation) | Part 45                    |

### 2.2 Notes on individual entities

- **Soft-deleted notes (`notes.is_deleted = true`).** The `deleted_at`
  timestamp on the note is the retention reference. Free workspaces: 30 days
  in the trash before hard delete; Pro and Enterprise: unlimited by default.
  Hard delete is FINAL — the row and its cascade children are gone.
- **Note versions (`note_versions`).** Free: 30 days of snapshot history. Pro
  and Enterprise: unlimited. Part 55 scans `note_versions.created_at` joined
  to the note's workspace plan to decide which rows to reap.
- **Audit logs (`audit_logs`).** 365 days across all plans (compliance
  baseline). Append-only (no `updated_at`); immutability is service-enforced
  in Part 71.
- **Export objects (`exports`).** Two distinct lifecycles (Part 18): the
  `signed_url_expires_at` download-grant ceiling (capped at 7 days per
  Notted.md) and the `object_expires_at` object-retention expiry (7 days per
  ADR 0007) the cleanup job uses. Only `ready` rows are downloadable;
  `failed`/`cancelled`/`expired` rows have no usable object and are cleaned up
  promptly.
- **Sessions.** Owned by Better Auth (ADR 0003). The Part 21 auth wiring
  configures short-lived (24h) and remember-me (30d) session durations from
  these config keys and enforces expiry. If stale expired rows require a
  maintenance sweep after provider integration, Part 21 owns that cleanup;
  Part 19 does not delete session rows.
- **Orphaned objects.** ADR 0005 mandates the DB is authoritative: an object
  whose DB record has been gone for longer than the grace period (7 days) is
  treated as orphaned and is deleted. The reconciliation scan is Part 45.
- **Other entities.** API keys (`api_keys`) have their own `expires_at` /
  `is_revoked` lifecycle (Part 61); webhook deliveries (`webhook_deliveries`)
  are bounded by the dispatcher's retry cap (Part 66); AI usage
  (`ai_usage`) is append-only and follows the audit-log retention window;
  email deliveries (`email_deliveries`) follow a short operational window set
  by Part 65; job idempotency rows (`job_idempotency`) carry their own
  `expires_at` TTL (ADR 0006). None of these are purged by Part 19 — they are
  listed for completeness; the purge path is the owning service part.

### 2.3 What Part 19 does NOT do

- **No purge jobs run.** Part 19 defines the policy and the config; the
  scheduled maintenance jobs that scan and delete past-expiry rows are
  the owning Parts 21, 45, 55, and 71. Until those lifecycle handlers ship,
  the `RETENTION_CONFIG` values are inert.
- **No new schema columns.** Every timestamp the purge jobs will need already
  exists from Parts 14–18 (`notes.deleted_at`, `notes.created_at`,
  `note_versions.created_at`, `audit_logs.created_at`,
  `exports.object_expires_at`, `exports.signed_url_expires_at`,
  `job_idempotency.expires_at`). No migration was generated for Part 19.
- **No service-layer enforcement.** Applying `whereWorkspace` inside every
  repository method is Part 24+; Part 19 ships the strategy, the primitive,
  and the denial tests.

## 3. Related decisions and parts

- [ADR 0003 — Better Auth is the authentication and session authority](decisions/0003-authentication-ownership.md)
- [ADR 0006 — Durable job intent with idempotent BullMQ workers](decisions/0006-background-workers.md)
- [ADR 0007 — Schema gaps and deny-by-default product defaults](decisions/0007-schema-gaps-and-safe-defaults.md)
- [ADR 0009 — Tenant protection strategy](decisions/0009-tenant-protection-strategy.md)
- Part 21 — Integrate Better Auth (consumes session-retention config).
- Part 24 — Centralized authorization (consumes `TenantContextService` and applies `whereWorkspace`).
- Part 26 — Workspaces, members, and invitations service.
- Parts 29/31 — Projects/folders deletion (the composite-FK nullification contract).
- Parts 33+ — Realtime (uses `TenantContextService.run` per WebSocket message).
- Part 21 — Session expiry behavior.
- Part 45 — Deleted-note, expired-export, and orphan-object cleanup.
- Part 55 — Note-version retention.
- Part 71 — Audit-log retention.
