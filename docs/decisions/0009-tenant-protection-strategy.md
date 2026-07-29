# ADR 0009: Tenant protection strategy — repository-layer enforcement with transaction-local tenant/user context

- **Status:** Accepted
- **Date:** 2026-07-28
- **Related plan parts:** 19, 24, 26–32, 40–45, 50–69, 71, 74

## Context

Plan Part 19 requires Notted to "define a consistent workspace-scoping strategy
for every service query" and offers a choice: implement PostgreSQL row-level
security (RLS) with transaction-local tenant/user context and policies, OR
"otherwise document and test the repository-layer enforcement." The choice has
to be made before Phase 4 (Part 21+) wires authentication and the policy layer.

Earlier ADRs already commit Notted to a specific posture:

- **ADR 0003** makes shared backend policies "load current workspace membership
  and resource grants from PostgreSQL and deny by default," and states "A valid
  session never implies workspace access."
- **ADR 0007** states "All tenant-owned rows carry `workspace_id` directly when
  practical or have an unambiguous constrained path to it. Service policies and
  later database protections prove that boundary. Cross-workspace foreign-key
  combinations must be impossible or transactionally rejected; a bare UUID
  never grants access."

Parts 14–18 already implemented that boundary: every tenant-owned table either
carries `workspace_id` directly or reaches it via a constrained parent, and
Parts 15/17 added **composite cross-tenant foreign keys** that reject the most
important cross-workspace writes at the DB layer:

| Composite FK                                                                                                         | Rejects                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `notes_workspace_project_fk` (`notes(workspace_id, project_id)` → `projects(workspace_id, id)`, ON DELETE NO ACTION) | A note in workspace A pointing at workspace B's project |
| `notes_workspace_folder_fk` (`notes(workspace_id, folder_id)` → `folders(workspace_id, id)`, ON DELETE NO ACTION)    | A note in workspace A pointing at workspace B's folder  |
| `tasks_workspace_project_fk` (`tasks(workspace_id, project_id)` → `projects(workspace_id, id)`, ON DELETE NO ACTION) | A task in workspace A pointing at workspace B's project |

Other two-hop invariants (assignee membership, note-tag/task-tag cross-workspace
assignment, note-share delegation cap) are not expressible as single-column DB
constraints without denormalizing mutable membership onto the row; Parts 15–18
documented them as service-enforced (Part 24+).

So the open question is narrow: do we add PostgreSQL RLS on top of this
combination of (a) deny-by-default application policies and (b) composite DB
constraints, or do we ship repository-layer enforcement with a shared scoping
helper and comprehensive denial tests?

## Decision

**Notted uses repository-layer enforcement with a transaction-local tenant/user
context and a shared workspace-scoping helper, plus composite DB constraints
where feasible, plus automated cross-workspace denial tests for every major
entity. PostgreSQL row-level security is deliberately deferred.**

Concretely:

1. **A `TenantContextService` backed by Node's `AsyncLocalStorage<TenantContext>`
   establishes the active `{ workspaceId, userId, requestId? }` for the duration
   of a request, transaction, WebSocket message, or job.** The context is
   available across async hops WITHOUT being threaded through every service
   signature, so scoping cannot be silently forgotten because a caller "didn't
   have" the workspace id. The service exposes:
   - `run(context, fn)` — establish scope (request/job/transaction boundary).
   - `get()` — return the active context, throwing a typed `TenantError`
     ("no active tenant context") when unset — **deny by default**.
   - `tryGet()` — return the context or `null` (for code that legitimately
     runs outside a workspace scope, e.g. approved maintenance queries in Parts 45/50/55/71).
     Mutation and clear methods are deliberately omitted: every scope is bounded
     by `run`, including each WebSocket message, so one connection or job cannot
     leave a context behind for unrelated work.

2. **A `whereWorkspace(table, tenantContext)` helper requires the active
   context and builds the canonical `eq(table.workspaceId,
tenantContext.get().workspaceId)` Drizzle predicate.** Calling `get()` in
   the helper makes absence of context a typed deny-by-default error. The rule,
   enforced by review and tests: **every tenant-owned read/update/delete MUST
   include this predicate. Inserts obtain `workspace_id` from
   `activeWorkspaceId(tenantContext)` and pass values through
   `assertWorkspaceInsertValues`; existing-resource and constrained-parent
   paths call `assertActiveWorkspace` before SQL (or rely on an applicable
   composite FK as defense in depth). Absence of scope is a security bug.** Applying this helper inside
   every service repository is Part 24+; Part 19 ships the strategy, the
   primitive, and the denial tests.

3. **Composite DB constraints (the three FKs above) remain the DB-level
   guarantee** that the most common cross-workspace writes are impossible. The
   repository-layer helper is the guarantee for reads and for writes the
   composite FKs cannot express (assignee membership, tag assignment, share
   delegation, polymorphic entity links, etc.).

4. **Comprehensive cross-workspace denial tests live at
   `apps/api/test/tenant-isolation.test.ts`.** They cover (a) DB-level
   composite-FK write denial (`23503`) for the three composite FKs, (b) the
   workspace-scope read predicate returning zero rows from the other tenant,
   and (c) explicit READ/INSERT/UPDATE/DELETE pre-SQL denial matrices for every
   direct tenant-owned entity and every constrained-parent child/junction.

5. **Every tenant-owned query in Phase 4+ services MUST be scoped by the active
   `TenantContext` (via `whereWorkspace` or its transitive equivalent) and MUST
   deny by default.** The Part 24 policy layer enforces membership and resource
   grants; the repository layer enforces the workspace boundary on every row
   access; the DB layer rejects the inexpressible-in-policy cross-tenant writes
   via composite FKs.

### Why RLS is deferred

- **The application policy layer is the authority, per ADR 0003.** RLS would be
  a second, parallel authority for the workspace boundary. With deny-by-default
  application policies loading live workspace grants from PostgreSQL, RLS adds
  defense-in-depth but does not replace the application check (RLS cannot
  evaluate role/action/resource policy — only row membership). Shipping RLS now
  would not let us drop the application scoping helper.
- **Operational risk.** RLS requires `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
  plus `CREATE POLICY` on every tenant-owned table, `FORCE ROW LEVEL SECURITY`
  on owners, and a session-variable (`set_config`) or `current_setting` pattern
  that every connection must set before any query. A missed `SET`, a pooled
  connection reused without a reset, or a migration that forgets a table would
  silently leak data — the exact failure mode the strategy is meant to prevent.
- **Drizzle-friendliness.** The Drizzle 0.45.2 migration generator emits
  DDL for tables, columns, indexes, FKs, and enums. RLS policies and
  session-variable plumbing are not part of Drizzle's generated surface, so an
  RLS deployment would mean hand-edited SQL appended to every migration and a
  parallel review surface — divergent from the project's reviewed-migration-only
  convention (ADR 0007 / database standard).
- **Testability now.** Repository-layer enforcement is unit/integration testable
  today with the same Drizzle handle and the existing DATABASE_URL-gated live
  test pattern. RLS denial tests would require a more elaborate fixture
  (session-variable setup, role switching) for marginal additional coverage
  given the application layer is already tested for cross-tenant denial.
- **Defense-in-depth is not free and is not urgent.** Adding RLS as a second
  layer is valuable ONLY if a threat model identifies a realistic code path
  that bypasses the application policy layer (e.g. a direct DB user used by a
  non-application component). No such path exists in Phase 4: the API is the
  sole DB client, and background jobs reapply the same policies (ADR 0006).

## Alternatives considered

- **PostgreSQL row-level security as the primary tenant boundary.** Rejected for
  the operational and Drizzle-compatibility reasons above and because the
  application policy layer remains the authority for role/action/resource
  decisions (ADR 0003). RLS would be redundant with the application helper for
  every workspace-scoped query and could not replace it for grant/role checks.
- **Both: repository-layer enforcement AND RLS as defense-in-depth, now.**
  Considered and explicitly deferred. Defense-in-depth is a worthwhile second
  layer when a threat model requires it (e.g. a second DB user, an analytics
  replica, a future "raw SQL" admin path). Phase 4 has none of these. A future
  ADR may add RLS as a defense-in-depth layer without changing the application
  helper; that ADR must enumerate the protected tables, the session-variable
  contract, the connection-reset discipline, and the additional test matrix.
- **Stored procedures for every tenant-owned query.** Rejected: bypasses the
  Drizzle typed query builder, makes Phase 4 service work harder, and does not
  add guarantees beyond the scoping helper plus composite FKs.
- **Denormalize `workspace_id` onto every junction/child table to make every
  scope a single-column predicate.** Rejected: junctions like `note_tags`,
  `task_tags`, `webhook_deliveries` deliberately reach workspace transitively
  (Parts 16/17/18). Denormalizing mutable membership onto rows would race
  membership revocation and is the same argument Part 17 made for assignee
  membership. The helper's transitive-scope pattern (scope by parent) handles
  these tables without denormalization.

## Consequences

- **Phase 4 service repositories (Parts 24–69, 71, 74) MUST:**
  - Run every operation that touches a tenant-owned table inside an established
    `TenantContextService.run(...)` boundary.
  - Apply `whereWorkspace(table, tenantContext)` (or the transitive equivalent
    for junction/child tables) to every read/update/delete; inserts derive
    `workspace_id` with `activeWorkspaceId(tenantContext)`, validate it with
    `assertWorkspaceInsertValues`, and validate every parent with
    `assertActiveWorkspace` in the same transaction. These helpers call `get()` and deny when
    context is absent.
  - Rely on composite DB constraints only for the writes they actually cover
    (the three FKs); everything else is helper-enforced.
  - Include a cross-tenant denial test for every new tenant-owned read/write
    path.
- **A missed scope is a security bug**, not a performance issue or a style
  issue. Code review and the Part 24 policy layer are the primary enforcement;
  the test suite is the regression net.
- **`TenantContextService` is a `@Global()` NestJS module** so Part 24+ guards,
  interceptors, policies, repositories, and jobs can inject it without
  per-module imports.
- **The DB-level guarantee is limited to the three composite FKs.** Two-hop
  invariants (assignee membership, cross-workspace tag assignment, note-share
  delegation cap, polymorphic entity links) are service-enforced and tested in
  their owning parts.
- **RLS is a future option, not a closed door.** If a later threat model
  requires defense-in-depth, a new ADR can add RLS without changing the
  repository-layer helper or the application policy layer.

## Migration and rollback

There is no RLS to roll back. The new `TenantContextModule`
(`apps/api/src/tenant/`) and the `whereWorkspace` helper are additive: they do
not change any existing table, migration, service, or transport. Part 24+ is
the first consumer; until then the new module is wired into the app but has no
runtime callers.

Rolling back Part 19 means deleting the `apps/api/src/tenant/` directory, the
`retention.config.ts` provider, the `docs/tenant-and-retention.md` doc, the
`apps/api/test/tenant-isolation.test.ts` suite, and this ADR — without touching
any migration or any Phase 3 schema file.
