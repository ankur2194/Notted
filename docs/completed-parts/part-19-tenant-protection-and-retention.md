# Part 19 — Database-level tenant protection and retention policies

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer`
- **Plan reference:** `Plan.md`, Part 19
- **Related records:** Parts 12–18; ADRs 0003, 0005, 0006, 0007, and 0009;
  `docs/tenant-and-retention.md`

Verification completed after two independent reviews, one bounded fix pass,
and direct lead remediation of the remaining findings.

## Objective and scope

Part 19 selects and documents one workspace-scoping strategy, provides its
shared infrastructure, defines data-retention policy, and authors automated
cross-workspace security coverage. It does not implement authentication (Part
21), authorization policies/repositories (Part 24+), or lifecycle jobs (Parts 45/55/71).

No schema was changed and no migration was created. Existing migrations
`0000`–`0006`, snapshots, and the migration journal were not edited for Part 19.
The completed-parts index records Parts 13–20 as complete after the final gate.

The shared Phase 3 Reviewer #1 fix pass adds forward migration
`0007_early_bloodaxe.sql` for Parts 13/16/18. It does not add RLS or other Part
19 DDL; Part 19 remains repository-enforced. Prior migrations remain immutable.

## Implemented work

### ADR 0009

`docs/decisions/0009-tenant-protection-strategy.md` is Accepted, dated
2026-07-28. It selects:

- repository-layer tenant enforcement;
- callback/transaction-local `AsyncLocalStorage` tenant/user context;
- deny-by-default workspace predicates on every tenant-owned repository read
  and write from Part 24 onward;
- existing composite database constraints where feasible; and
- deferral of PostgreSQL RLS because application policies remain authoritative,
  RLS would add pooled-connection/session-variable and hand-maintained policy
  risk, and no second direct database client currently justifies the additional
  authority.

The existing DB-level cross-tenant write constraints remain:

1. `notes_workspace_project_fk`;
2. `notes_workspace_folder_fk`;
3. `tasks_workspace_project_fk`.

Assignee membership, tag assignment, sharing/delegation, and similar two-hop
invariants are not claimed as DB-enforced. They remain transactional Part 24+
service policy.

### Tenant context and scoping helper

`TenantContext` is:

```ts
interface TenantContext {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly requestId?: string | null;
}
```

`TenantContextService` is a singleton injectable backed by
`AsyncLocalStorage<TenantContext>` and exposes only:

- `run(context, fn)` — bounds context to one callback and restores the prior
  context on success or failure;
- `get()` — returns the active context or throws typed
  `TenantError`/`tenant.no_active_context`; and
- `tryGet()` — returns the active context or `null` for legitimate platform
  code outside tenant repositories.

No mutation, `enterWith`, clear, `exit`, or `disable` API is exposed. The global
`TenantContextModule` exports the service and `AppModule` imports that module.

`whereWorkspace(table, tenantContext)` accepts only tables with a typed Drizzle
`workspaceId` column, calls `tenantContext.get()` itself, and returns
`eq(table.workspaceId, active.workspaceId)`. `whereWorkspaceId` provides the
equivalent root-table predicate for `workspaces.id`. Tables without a direct
`workspace_id` are intentionally ineligible and must be scoped through a
constrained parent join. `activeWorkspaceId(tenantContext)` is the only helper
tenant-owned inserts use to derive their direct workspace value. Part 24+ owns
applying these helpers and parent validation to every actual repository method.

### Retention configuration

`RETENTION_CONFIG` follows existing Nest config-provider conventions and is
exported by `ConfigModule`. Finite values are bounded integers; `null` means
unlimited/no automated purge.

| Key                                  | Environment variable                     | Default            |
| ------------------------------------ | ---------------------------------------- | ------------------ |
| `deletedNoteRetentionDaysFree`       | `RETENTION_DELETED_NOTE_DAYS_FREE`       | `30`               |
| `deletedNoteRetentionDaysPro`        | `RETENTION_DELETED_NOTE_DAYS_PRO`        | `null` (unlimited) |
| `deletedNoteRetentionDaysEnterprise` | `RETENTION_DELETED_NOTE_DAYS_ENTERPRISE` | `null` (unlimited) |
| `noteVersionRetentionDaysFree`       | `RETENTION_NOTE_VERSION_DAYS_FREE`       | `30`               |
| `noteVersionRetentionDaysPro`        | `RETENTION_NOTE_VERSION_DAYS_PRO`        | `null` (unlimited) |
| `noteVersionRetentionDaysEnterprise` | `RETENTION_NOTE_VERSION_DAYS_ENTERPRISE` | `null` (unlimited) |
| `auditLogRetentionDays`              | `RETENTION_AUDIT_LOG_DAYS`               | `365`              |
| `exportObjectRetentionDays`          | `RETENTION_EXPORT_OBJECT_DAYS`           | `7`                |
| `sessionShortLivedHours`             | `SESSION_SHORT_LIVED_HOURS`              | `24` hours         |
| `sessionRememberMeDays`              | `SESSION_REMEMBER_ME_DAYS`               | `30`               |
| `orphanedObjectCleanupDays`          | `RETENTION_ORPHANED_OBJECT_DAYS`         | `7`                |

The authored unit suite covers defaults, all overrides, case-insensitive
`unlimited` paid-tier semantics, invalid/non-integer/out-of-range values, and a
frozen result. Part 19 defines policy only. Better Auth consumes session TTLs
in Part 21; Parts 45, 55, and 71 implement deleted-note/export-object, version, audit, and
orphan-object execution.

### Isolation coverage matrix

`apps/api/test/tenant-isolation.test.ts` contains no-DB unit coverage and
`DATABASE_URL`-gated live security tests.

| Category                                | Entities/invariants authored                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active-context unit behavior            | `run`, `get`, `tryGet`, nested restore, rejection restore, async propagation, missing-context typed denial                                                                                                                                        |
| Scope-helper unit behavior              | missing-context denial; active insert workspace ID; direct `workspace_id` predicate; `workspaces.id` root predicate; typed pre-SQL workspace mismatch denial                                                                                      |
| Direct operation denial matrix          | READ/INSERT/UPDATE/DELETE for workspaces identity, workspace members, invitations, projects, folders, notes, tags, attachments, tasks, task statuses, audit logs, API keys, webhooks, exports, AI provider config, AI usage, and email deliveries |
| Parent-resolved operation denial matrix | READ/INSERT/UPDATE/DELETE for project access→project; note shares/tags/comments/versions/embeddings→note; task tags→task; webhook deliveries→webhook                                                                                              |
| Direct scoped reads                     | workspaces, workspace members, invitations, projects, folders, notes, tags, attachments, tasks, task statuses, audit logs, API keys, webhooks, exports, AI provider config, AI usage, scoped email deliveries                                     |
| Constrained-parent scoped reads         | project access→projects; note shares→notes; note tags→notes; comments→notes; note versions→notes; task tags→tasks; note embeddings→notes; webhook deliveries→webhooks                                                                             |
| DB write denials                        | notes→cross-tenant project; notes→cross-tenant folder; tasks→cross-tenant project (`23503`)                                                                                                                                                       |

Each live read case seeds both tenants, asserts tenant A's row is present, and
asserts tenant B's row is excluded. Global identity/auth tables and
`job_idempotency` are intentionally outside workspace scoping.

## Files and components

- `apps/api/src/tenant/tenant-context.ts`
- `apps/api/src/tenant/tenant-context.service.ts`
- `apps/api/src/tenant/tenant-context.module.ts`
- `apps/api/src/tenant/tenant-errors.ts`
- `apps/api/src/tenant/workspace-scope.ts`
- `apps/api/src/tenant/index.ts`
- `apps/api/src/config/retention.config.ts`
- `apps/api/src/config/retention.config.test.ts`
- `apps/api/src/config/config.module.ts`
- `apps/api/src/app.module.ts`
- `apps/api/test/tenant-isolation.test.ts`
- `docs/decisions/0009-tenant-protection-strategy.md`
- `docs/tenant-and-retention.md`
- `docs/completed-parts/part-19-tenant-protection-and-retention.md`

## Verification evidence

Final verification completed on 2026-07-29.

| Check                    | State | Evidence                                                                                                             |
| ------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Context/scope unit tests | Pass  | Distinct read/insert/update/delete boundaries deny all 17 direct and 8 parent-scoped entity classes before SQL.      |
| Live isolation tests     | Pass  | Included in the nine-file live gate (123/123): scoped reads exclude tenant B and composite FK writes return `23503`. |
| Repository quality       | Pass  | Sequential format, lint, type-check, API/unit tests, production build, and `db:check`.                               |
| PostgreSQL execution     | Pass  | Fresh PostgreSQL 16/pgvector databases exercised empty migrations, populated upgrade, isolation, and seed paths.     |

## Known limitations and follow-up

- Part 21 must establish context only after authentication/workspace resolution.
- Part 24+ must call the active-context scoping helper in every tenant-owned
  repository path and enforce assignee, tag, share, and other two-hop rules in
  transactions.
- Parts 45, 55, and 71 must implement idempotent purge/reconciliation jobs; retention config
  is inert until then.
- RLS remains deferred and requires a superseding ADR if later selected.
- Future repositories remain required to call the operation-specific guards;
  that application-layer authorization work begins in Part 24.

## Revision history

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial partial Part 19 implementation.                                                                                                                                                                                                                                                                                                                                                               |
| 2026-07-29 | `backend-platform-engineer` | Completed implement-only artifacts, made context callback-bounded, made scoping require active context, represented Pro/Enterprise note/version retention explicitly as unlimited, and expanded the isolation matrix to every listed indirect parent join. Verification remains pending.                                                                                                              |
| 2026-07-29 | `backend-platform-engineer` | Reviewer #1 fix pass: added strict `assertActiveWorkspace` and `assertWorkspaceInsertValues` guards plus explicit all-operation direct/parent matrices proving typed denial before SQL. Existing live 23503 coverage remains limited to notes→project, notes→folder, and tasks→project; no DB enforcement is claimed for tag/share/assignee two-hop policy. Verification remains pending Reviewer #2. |
| 2026-07-29 | Lead                        | Added operation-specific read/insert/update/delete boundaries, completed live isolation and retention-owner review, and marked Part 19 Complete.                                                                                                                                                                                                                                                      |
