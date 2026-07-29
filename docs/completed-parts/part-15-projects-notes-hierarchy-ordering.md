# Part 15 — Implement Projects, Notes, Hierarchy, and Ordering

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent) under `lead-part-engineer`
- **Plan reference:** `Plan.md`, Part 15
- **Related records:**
  `part-14-workspace-membership-tables.md`;
  `docs/decisions/0004-collaborative-document-authority.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`

## Objective

Introduce the core content schema for Notted: projects (with explicit access
grants for restricted projects), folders (workspace-owned nesting containers
separate from notes), notes (the TipTap-JSON-projection document entity with
hierarchy, sibling ordering, soft delete, optimistic concurrency, and
templates), and per-user note sharing grants. Per ADR 0007 the schema adds
explicit stable sibling ordering, the folder/note hierarchy model, sharing
grants with no public link by default, and project access records that exist
ONLY for restricted projects. Per ADR 0004 the notes table stores the
deterministic TipTap JSON projection, extracted plain text, and a monotonic
version for optimistic concurrency (the Yjs binary state is a later part).
Cross-workspace foreign-reference combinations are prevented at the database
layer via composite foreign keys where feasible, with the remaining
invariants (depth, cycles, delegation caps, ordering uniqueness) deferred to
service logic in Parts 29/31/32. No NestJS services, transports, jobs, or
auth wiring are introduced; only schema, the generated migration, and tests.

## Implemented Work

- Added `apps/api/src/database/schema/projects.ts` defining:
  - `projectStatusEnum` = `pgEnum("project_status", ["active", "archived",
"completed"])`.
  - `projectAccessRoleEnum` = `pgEnum("project_access_role", ["admin",
"editor", "viewer"])` — a NARROWER enum than `memberRoleEnum`: it excludes
    `owner` because project ownership is delegated from workspace-level
    ownership (workspace owners/admins are project admins via the policy
    layer, not via rows in `project_access`). Reusing `memberRoleEnum` was
    rejected because it would imply a project-level `owner` role that does
    not exist.
  - `projects` table: `id`, `workspace_id` (→ `workspaces.id` CASCADE,
    notNull), `name` (varchar 255, notNull), `description` (text, nullable),
    `cover_image_url` (text, nullable), `color` (varchar 7, default
    `#3b82f6`), `status` (project_status default `active`, notNull),
    `due_date` (timestamptz, nullable), `is_archived` (bool default false,
    notNull — denormalized mirror of `status = 'archived'`), `created_by_id`
    (→ `users.id` RESTRICT, notNull), `created_at`/`updated_at` (timestamptz
    defaultNow, notNull). Indexes: `projects_workspace_id_id_unique` (UNIQUE
    composite — composite FK target for notes, redundant with the `id` PK but
    required by PostgreSQL), `projects_workspace_id_idx`,
    `projects_workspace_status_idx`, `projects_created_by_id_idx`.
  - `project_access` table per ADR 0007: `id`, `project_id` (→ `projects.id`
    CASCADE, notNull), `user_id` (→ `users.id` CASCADE, notNull — grantee),
    `role` (project_access_role, notNull), `created_by_id` (→ `users.id`
    RESTRICT, notNull — grantor), `created_at` (timestamptz defaultNow,
    notNull). Indexes: `project_access_project_user_unique` (UNIQUE — one
    grant per project+user), `project_access_user_id_idx`. This table is
    workspace-free at the column level; cross-workspace grant validation is
    service logic (Part 24/29).
  - Forward relations only: `projectsRelations` (`workspace`, `createdBy`,
    `access` → many `project_access`), `projectAccessRelations` (`project`,
    `user`, `createdBy` with disambiguating `relationName`).
- Added `apps/api/src/database/schema/folders.ts` defining:
  - `folders` table: `id`, `workspace_id` (→ `workspaces.id` CASCADE,
    notNull), `parent_id` (→ `folders.id` self-ref CASCADE, nullable — root
    folders are NULL), `name` (varchar 255, notNull), `created_by_id`
    (→ `users.id` RESTRICT, notNull), `created_at`/`updated_at` (timestamptz
    defaultNow, notNull). Indexes: `folders_workspace_id_id_unique` (UNIQUE
    composite — composite FK target for notes), `folders_workspace_parent_idx`
    (tree reads). The max-depth-3 limit and cycle prevention are SERVICE
    logic (Part 31); the schema only models the self-edge and cascade. Folder
    ordering is intentionally omitted (the brief/ADR specify only NOTE
    ordering).
  - `foldersRelations` with a self-relation (`parent`/`children`,
    `relationName: "folders_parent"`), `workspace`, and `createdBy`.
- Added `apps/api/src/database/schema/notes.ts` defining:
  - `noteTypeEnum` = `pgEnum("note_type", ["document", "task"])`.
  - `noteSharePermissionEnum` = `pgEnum("note_share_permission", ["view",
"comment", "edit"])`.
  - `notes` table: `id`; `workspace_id` (→ `workspaces.id` CASCADE, notNull);
    `project_id` (nullable — composite FK below), `folder_id` (nullable —
    composite FK below), `parent_id` (→ `notes.id` self-ref CASCADE, nullable
    — note hierarchy); `title` (varchar 500, notNull); `content` (jsonb
    default `{"type":"doc","content":[]}`, notNull — TipTap JSON projection
    per ADR 0004); `content_plain` (text default `""` — extracted plain text
    for search/list); `note_type` (note_type default `document`, notNull);
    `is_template`/`is_pinned`/`is_archived`/`is_deleted` (bools default false,
    notNull); `deleted_at` (timestamptz, nullable); `version` (integer
    default 1, notNull — optimistic concurrency); `page_size` (varchar 10
    default `a4`, notNull); `sort_order` (double precision default 0, notNull
    — stable sibling ordering); `created_by_id` (→ `users.id` RESTRICT,
    notNull); `updated_by_id` (→ `users.id` SET NULL, nullable);
    `created_at`/`updated_at` (timestamptz defaultNow, notNull).
    - Indexes: `notes_sibling_order_idx` on `(workspace_id, parent_id,
sort_order)` (NON-UNIQUE — sibling uniqueness is service-enforced,
      see Important Decisions); `notes_workspace_project_idx`;
      `notes_workspace_active_updated_idx` PARTIAL
      (`where notes.is_deleted = false`); `notes_workspace_template_idx`;
      `notes_created_by_id_idx`.
    - Foreign keys: `notes.workspace_id` → `workspaces.id` CASCADE;
      `notes.parent_id` → `notes.id` self-CASCADE; `notes.created_by_id` →
      `users.id` RESTRICT; `notes.updated_by_id` → `users.id` SET NULL;
      composite `notes_workspace_project_fk` on `(workspace_id, project_id)`
      → `projects(workspace_id, id)` ON DELETE NO ACTION (cross-tenant
      guard; service-mediated nullification on project delete, Part 29);
      composite `notes_workspace_folder_fk` on `(workspace_id, folder_id)` →
      `folders(workspace_id, id)` ON DELETE NO ACTION (cross-tenant guard;
      service-mediated nullification on folder delete, Part 31).
  - `note_shares` table per ADR 0007: `id`, `note_id` (→ `notes.id` CASCADE,
    notNull), `user_id` (→ `users.id` CASCADE, notNull — grantee),
    `permission` (note_share_permission default `view`, notNull),
    `created_by_id` (→ `users.id` RESTRICT, notNull — grantor), `created_at`
    (timestamptz defaultNow, notNull). NO public-link columns by default.
    Indexes: `note_shares_note_user_unique` (UNIQUE — one grant per note+user),
    `note_shares_user_id_idx`.
  - `notesRelations` (workspace, project, folder, parent/children self,
    createdBy, updatedBy, shares) and `noteSharesRelations` (note, user,
    createdBy) with disambiguating `relationName` for the multiple `users`
    references and the `notes` self-reference.
- Appended every Part 15 table, relation, and enum to the aggregate `schema`
  object in `apps/api/src/database/schema/index.ts` and re-exported each by
  name. The existing Part 12/13/14 entries and the `Schema = typeof schema`
  type are preserved; a `// Part 15 — …` comment marks the new block.
- Generated migration
  `apps/api/src/database/migrations/0003_cute_maria_hill.sql` via
  `pnpm db:generate`, plus its snapshot (`meta/0003_snapshot.json`) and a new
  journal entry (`idx: 3`, `tag: 0003_cute_maria_hill`) in `meta/_journal.json`
  (the journal previously ended at `idx: 2`). Prior migrations
  (`0000_enable_extensions.sql`, `0001_volatile_wiccan.sql`,
  `0002_minor_mad_thinker.sql`), their snapshots, and the pre-Part-15 journal
  entries were not edited.
- Reviewed the generated SQL and applied ONE review-time reorder (see
  Important Decisions): drizzle-kit 0.31 emits the composite-FK-target UNIQUE
  indexes after the FK constraints, but PostgreSQL requires the referenced
  unique constraint to exist at `ADD CONSTRAINT` time. The two target indexes
  (`projects_workspace_id_id_unique`, `folders_workspace_id_id_unique`) are
  moved before the FK block, with a documenting comment. The final schema
  state is identical; only statement order within this forward migration
  changes.
- Added `apps/api/test/notes-projects-schema.test.ts` with:
  - A no-database unit suite: the barrel exposes the five tables, five
    relation objects, and four enums; the enums have the expected values;
    every brief column exists with correct nullability (including Part 15
    additions `folder_id`, `note_type`, `is_template`, `is_pinned`,
    `is_archived`, `is_deleted`, `deleted_at`, `sort_order`); the
    one-grant-per-target unique indexes and the composite-FK-target unique
    indexes exist; the Plan Part 15 lookup indexes (sibling order, workspace
    +project, recent-active partial, templates, creators, project
    workspace/status/creators, folder tree) exist with correct uniqueness;
    and every foreign key has the intended `onDelete` (cascade/restrict/
    set-null/no-action) including the two composite cross-tenant FKs.
  - A `DATABASE_URL`-gated live suite (mirroring `database.migration.test.ts`
    and `workspace-schema.test.ts`) that applies migrations and asserts: (a)
    the five tables and four enums exist; (b) fixtures cover project notes,
    root standalone notes, nested child notes, template notes, soft-deleted
    notes, AND note-hierarchy cascade (deleting a parent removes its child);
    (c) sibling ordering via `sort_order` returns notes in the expected order
    (including fractional midpoint values); (d) CROSS-TENANT REJECTION —
    inserting a note whose `workspace_id` ≠ the project's workspace fails
    with `23503` via the composite FK `notes_workspace_project_fk`; the same
    rejection holds for a folder via `notes_workspace_folder_fk`; (e)
    `note_shares` rejects a duplicate `(note_id, user_id)` grant with `23505`
    and cascade-deletes shares when the note is deleted; (f) project deletion
    cascades to `project_access`, and workspace deletion cascades to notes,
    folders, and projects (counts go to 0). Each live test creates
    deterministic unique fixtures and cleans them up. Uses
    `isDatabaseReachable` + `describe.skipIf(!HAS_DATABASE_URL)` + `skip()`.

## Important Decisions

- **Sibling ordering uses `double precision`, not integer.** Double precision
  lets the service (Part 31) insert a note between two siblings via a
  midpoint (e.g. `(1.0 + 2.0) / 2 = 1.5`) without rewriting the whole sibling
  group, which is the dominant reorder cost with integer sort keys. New notes
  append via `max(sort_order) + 1` computed by the service at insert time;
  the column default of 0 is only the fallback. Periodic re-normalization
  (after many midpoint insertions exhaust float precision near a cluster) is
  service-side. Chosen over `integer` because the brief calls for drag-to-
  reorder, which is the workload that benefits most from fractional indexing.
- **Sibling-order index is NON-UNIQUE; uniqueness is service-enforced.** A
  UNIQUE composite index on `(workspace_id, parent_id, sort_order)` would be
  inconsistent: PostgreSQL treats NULLs as distinct in unique indexes, so
  multiple root notes (parent_id NULL) could share a sort_order while child
  notes (parent_id NOT NULL) would be tightly constrained — a confusing
  split. The schema therefore provides a plain composite index
  `notes_sibling_order_idx` for the sibling-lookup hot path, and the service
  (Part 31) enforces uniqueness transactionally within a sibling group. This
  matches ADR 0007's "store explicit stable sibling ordering ... reorder
  operations are transactional" guidance.
- **Composite cross-tenant FKs on `notes.project_id` and `notes.folder_id`
  are the "where feasible, composite constraints" the Plan calls for.** Both
  `projects` and `folders` carry `workspace_id`, so a composite FK
  `(workspace_id, project_id) → projects(workspace_id, id)` and
  `(workspace_id, folder_id) → folders(workspace_id, id)` make a note
  physically unable to reference another workspace's project or folder at the
  database layer. To support these composite FK targets, `projects` and
  `folders` each declare a UNIQUE index on `(workspace_id, id)` (redundant
  with the `id` PK but required by PostgreSQL). This is the basis of the
  cross-tenant rejection test.
- **Composite FKs use `ON DELETE NO ACTION`, not `SET NULL`.** Notted.md
  specifies `projectId.references(..., { onDelete: "set null" })` so deleting
  a project keeps its notes as standalone. A composite FK with `ON DELETE
SET NULL` would set BOTH referencing columns (`workspace_id` AND
  `project_id`) to NULL, but `workspace_id` is NOT NULL — so PostgreSQL
  would reject the project deletion. Using `ON DELETE CASCADE` would destroy
  notes (wrong). `ON DELETE NO ACTION` preserves the cross-tenant guard and
  makes project/folder deletion SERVICE-mediated: Part 29 (project delete)
  and Part 31 (folder delete) nullify the corresponding `notes.project_id`/
  `notes.folder_id` in the same transaction before deleting the container.
  The observable behavior ("container deletion keeps notes alive as
  standalone") is preserved through service coordination. This is a
  deliberate, security-first deviation from Notted.md's literal `set null`,
  documented in the schema module comments and here. `NO ACTION` (not
  `RESTRICT`) is chosen because NO ACTION is checked at the end of the
  statement, so the workspace CASCADE delete (which removes notes, folders,
  and projects together in one statement) succeeds without per-row
  violations — verified by the live cascade test.
- **`notes.parent_id` uses a simple self-FK CASCADE, not a composite self-FK.**
  A composite self-FK `(workspace_id, parent_id) → notes(workspace_id, id)`
  was considered to enforce same-workspace parents at the DB layer, but the
  simple self-FK is the well-supported Drizzle pattern, the cross-workspace
  parent invariant is enforced by the service (Part 31) alongside cycle
  prevention, and the parent's `workspace_id` is already constrained by this
  table's own `workspace_id` FK. CASCADE on parent delete matches Notted.md's
  note-hierarchy cascade and is verified by the live test.
- **Cycle prevention (note parent chain) and folder max-depth-3 are SERVICE
  logic (Part 31), not SQL CHECKs.** Neither a parent-chain cycle nor a
  folder-depth limit is expressible as a column CHECK or a tractable trigger.
  The schema models the edges (self-FKs) and the cascade behavior only; Part
  31 rejects cycles and depth > 3 inside the create/reparent transaction.
- **Project access uses a NARROWER role enum (`project_access_role`:
  admin/editor/viewer), not `memberRoleEnum`.** Project ownership is
  delegated from workspace ownership; workspace owners/admins are project
  admins via the policy layer (Part 24), never via a row in `project_access`.
  Storing an `owner` value here would imply project-level ownership that does
  not exist. `project_access` rows exist ONLY for restricted projects;
  absence means the project inherits workspace access (ADR 0007).
- **Note sharing has NO public-link columns by default (ADR 0007).**
  `note_shares` stores explicit per-user grants only. Public sharing, if
  later authorized, uses revocable hashed tokens in a separate table. A grant
  cannot exceed the actor's delegation rights or bypass project restrictions;
  that is service/policy logic (Part 24/32), not a DB constraint.
- **`created_by_id` is `ON DELETE RESTRICT` across all Part 15 tables.**
  Projects, folders, notes, `project_access`, and `note_shares` each carry a
  notNull `created_by_id` audit field referencing `users.id`. RESTRICT
  matches the Part 14 `workspaces.created_by_id` convention for shared tenant
  entities and audit trails: deleting the creator must not silently drop the
  row or its audit. The service (Part 26) transfers or nullifies before
  account deletion. `notes.updated_by_id` is nullable and uses `SET NULL` so
  deleting the last editor preserves the note (the creator audit remains).
- **Grantee columns (`project_access.user_id`, `note_shares.user_id`) use
  `ON DELETE CASCADE`.** Explicit grants are personal; deleting a user
  removes grants TO them. The durable workspace membership remains the source
  of truth for default access.
- **`relations` imported from `drizzle-orm` (root) and `sql` from
  `drizzle-orm` (root); `foreignKey` from `drizzle-orm/pg-core`.** Matches
  the Part 13/14 convention. The partial index
  `notes_workspace_active_updated_idx` uses `sql\`notes.is_deleted = false\``
  as the predicate.
- **Forward relations only.** `workspacesRelations`, `usersRelations`, and
  the Part 13/14 files were intentionally not extended with back-references,
  to keep earlier parts immutable per the handoff rules. Drizzle supports
  one-directional relations.
- **One review-time reorder of the generated migration.** drizzle-kit 0.31
  emits composite-FK-target UNIQUE indexes in the index block (after the FK
  constraints), but PostgreSQL requires the referenced unique constraint to
  exist at `ADD CONSTRAINT` time. The two target indexes
  (`projects_workspace_id_id_unique`, `folders_workspace_id_id_unique`) are
  moved before the FK block with a documenting comment. This edits the NEW
  migration only (`0003_cute_maria_hill.sql`); prior migrations, snapshots,
  and the journal were not touched by hand. The final schema state is
  identical; only statement order within this forward migration changes. The
  snapshot (`0003_snapshot.json`) captures schema state, not statement order,
  so `db:check` and future generation are unaffected.

## Files and Components

| Path                                                        | Purpose                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/database/schema/projects.ts`                  | `projects`, `project_access`, `projectStatusEnum`, `projectAccessRoleEnum`, and forward relations. Documents project-access-only-when-restricted model, the composite-FK target, and the service-mediated project deletion.                                                                |
| `apps/api/src/database/schema/folders.ts`                   | `folders` self-nesting container, `foldersRelations`. Documents the depth/cycle handoff to Part 31 and the composite-FK target.                                                                                                                                                            |
| `apps/api/src/database/schema/notes.ts`                     | `notes`, `note_shares`, `noteTypeEnum`, `noteSharePermissionEnum`, and forward relations. Documents TipTap JSON projection (ADR 0004), sibling ordering choice, the two composite cross-tenant FKs, the simple self-FK for hierarchy, and all deferred invariants.                         |
| `apps/api/src/database/schema/index.ts`                     | Aggregate `schema` barrel now exposes the Part 15 tables, relations, and enums and re-exports each by name. `Schema = typeof schema` preserved.                                                                                                                                            |
| `apps/api/src/database/migrations/0003_cute_maria_hill.sql` | Generated forward migration: four enums, five tables, seventeen foreign keys (cascade/restrict/set-null/no-action including two composite cross-tenant FKs), and fifteen indexes (four unique). One review-time reorder of the two composite-FK-target unique indexes before the FK block. |
| `apps/api/src/database/migrations/meta/0003_snapshot.json`  | Generated Drizzle snapshot for migration 0003.                                                                                                                                                                                                                                             |
| `apps/api/src/database/migrations/meta/_journal.json`       | Appended journal entry `idx: 3`, `tag: 0003_cute_maria_hill`.                                                                                                                                                                                                                              |
| `apps/api/test/notes-projects-schema.test.ts`               | Unit suite (no DB) + DATABASE_URL-gated live suite asserting tables/enums, project/root/nested/template/soft-deleted fixtures, hierarchy cascade, ordering, cross-tenant rejection (project + folder composite FKs), share uniqueness/cascade, and project/workspace cascades.             |

## Database and Data Changes

Migration `0003_cute_maria_hill.sql` is additive only. It creates four enum
types (`note_share_permission`, `note_type`, `project_access_role`,
`project_status`), five tables (`folders`, `note_shares`, `notes`,
`project_access`, `projects`), seventeen foreign keys, and fifteen indexes
(four unique — `projects_workspace_id_id_unique`,
`folders_workspace_id_id_unique`, `note_shares_note_user_unique`,
`project_access_project_user_unique`; eleven lookup — `folders_workspace_
parent_idx`, `note_shares_user_id_idx`, `notes_sibling_order_idx`,
`notes_workspace_project_idx`, `notes_workspace_active_updated_idx` (PARTIAL
`where is_deleted = false`), `notes_workspace_template_idx`,
`notes_created_by_id_idx`, `project_access_user_id_idx`,
`projects_workspace_id_idx`, `projects_workspace_status_idx`,
`projects_created_by_id_idx`). Foreign-key cascade choices: workspace/user
cascade per Part 14 conventions; `created_by_id` RESTRICT on all five tables;
`notes.updated_by_id` SET NULL; `notes.parent_id` and `folders.parent_id`
self-CASCADE; `project_access.project_id`, `project_access.user_id`,
`note_shares.note_id`, `note_shares.user_id` CASCADE; the two composite
cross-tenant FKs on `notes` (`notes_workspace_project_fk`,
`notes_workspace_folder_fk`) NO ACTION. No data, no seed, no destructive
statement, no extension change. Defaults use PostgreSQL built-ins
(`gen_random_uuid()`, `now()`, `'{"type":"doc","content":[]}'::jsonb`, enum
literals, `0` for double precision) and require no extension beyond the Part
12 baseline. The migration is forward-only per project policy; rollback is a
separate reviewed operation.

Current immutable-surface hashes:

| File                                                        | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/src/database/schema/projects.ts`                  | `a4ccbb4bebf3c61dcb041680aebdc58b9ff8c76a0fa30280a04a9a5b194aebdb` |
| `apps/api/src/database/schema/folders.ts`                   | `d3bef35b5eb3ce7f3128b78641f3a6331352194958023e8def288ec5abf4bd70` |
| `apps/api/src/database/schema/notes.ts`                     | `ea102d11255d5e30972c380129510c73a32e0638531f2f1f959d4b811daf943d` |
| `apps/api/src/database/schema/index.ts`                     | `82238f4550d3822b335fadb1921faa776f3360bcdb46e0059c035962d41159cf` |
| `apps/api/src/database/migrations/0003_cute_maria_hill.sql` | `d9a145d697ed2ed5d62a2aa7dede25c7aa2db5a6d1a2a094ae14f93fb696eed3` |
| `apps/api/src/database/migrations/meta/0003_snapshot.json`  | `d538ccdbf7e772e7f00063f5d67c943718b0e5b0622ad8ac5a8f74c8e63f8b54` |
| `apps/api/src/database/migrations/meta/_journal.json`       | `9852162097b0d28ce0bbd2c177154db68c15ffd1295e2623a777cb5bda33935a` |
| `apps/api/test/notes-projects-schema.test.ts`               | `fc6194a33f3bf0a2f4ba664ab6846267d8cfdc245a24aea22d1ec805d22456bb` |

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe: there is no
anonymous or unauthenticated access, no project/note/share is auto-created,
and no transport reads these tables yet. The schema is purely structural;
Parts 21 (auth), 24 (centralized authorization), 29 (project CRUD), and
31/32 (note CRUD and sharing UI) wire behavior on top.

## Security and Tenant-Isolation Notes

- **Cross-tenant integrity is enforced at the database layer for the two
  highest-risk references.** A note cannot reference another workspace's
  project (`notes_workspace_project_fk`) or folder (`notes_workspace_folder_fk`)
  — both are composite FKs that include `workspace_id`, so an insert with a
  mismatched `(workspace_id, project_id)`/`(workspace_id, folder_id)` pair is
  rejected with `23503`. This is verified by the live cross-tenant tests and
  is the "where feasible, composite constraints" the Plan calls for.
- **Cross-tenant parent-note references are service-enforced (Part 31).** The
  simple self-FK on `notes.parent_id` does not include `workspace_id`, so the
  service must verify the parent is in the same workspace inside the
  reparent transaction. A composite self-FK was considered and deferred
  (see Important Decisions). The same-workspace guarantee for the parent
  chain composes with the workspace-scoped sibling-order index.
- **`project_access` and `note_shares` are workspace-free at the column
  level** (they reach `workspace_id` transitively via `project_id`/`note_id`).
  Cross-workspace grant validation (grantee must be an active workspace
  member; grantor cannot exceed delegation cap; share cannot bypass project
  restrictions) is service/policy logic (Part 24/29/32), not a DB constraint,
  because expressing it would require denormalizing `workspace_id` onto these
  tables, which the brief deliberately omits.
- **Access is never inferred from authorship (ADR 0007).** `created_by_id` is
  an audit field, not a grant. A note's author has no implicit access beyond
  what `workspace_members`, `project_access`, or `note_shares` grants.
- **No public link sharing by default.** `note_shares` has no token/url
  columns. Public sharing, if later authorized, uses revocable hashed tokens
  in a separate table.
- **RESTRICT on all `created_by_id` columns** prevents silent loss of audit
  trails and shared tenant entities when a creator account is removed; the
  service (Part 26) transfers or nullifies first.
- **Soft delete retains rows** for trash/restore and the Part 19 retention
  policy; hard delete is a separate, service-initiated permanent removal.
- **No secrets, connection strings, tokens, cookies, or signed URLs appear**
  in the schema, migration, tests, or this record. The `content`/`content_
plain` projections are user document data, not credentials.

## Verification Evidence

Final verification completed on 2026-07-29.

| Check                               | Result | Notes                                                                                                                      |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| Migration and composite constraints | Pass   | `0003_cute_maria_hill.sql` applied on PostgreSQL 16; project/folder composite targets and FKs were created in valid order. |
| Focused content suite               | Pass   | Root/project/nested/template/deleted notes, hierarchy cascade, ordering, sharing, and container behavior passed live.      |
| Cross-tenant writes                 | Pass   | Notes referencing another tenant's project or folder were rejected with SQLSTATE `23503`.                                  |
| Repository quality gate             | Pass   | Sequential format, lint, type-check, tests, build, and `db:check` passed.                                                  |

## Known Limitations and Follow-up Work

- **Service-mediated project/folder deletion is Part 29/31.** Because the
  composite cross-tenant FKs use `ON DELETE NO ACTION`, deleting a project or
  folder that still has notes will fail with a foreign-key violation unless
  the service first nullifies `notes.project_id`/`notes.folder_id` for the
  affected notes in the same transaction. This is intentional (security-first
  cross-tenant guard) and documented in the schema module comments. Part 29
  (project delete) and Part 31 (folder delete) own this coordination.
- **Sibling-order uniqueness is service-enforced (Part 31).** The composite
  index `(workspace_id, parent_id, sort_order)` is non-unique; the service
  must enforce unique sort_order within a sibling group transactionally and
  must reject cross-container/cross-workspace reorder IDs (the latter is also
  prevented by the presence of `workspace_id` on every note).
- **Cycle prevention and folder max-depth-3 are Part 31.** Neither is
  expressible as a SQL CHECK; the service rejects cyclic parenting and folder
  depth > 3 inside the create/reparent transaction.
- **Delegation caps and project-restriction bypass for shares are Part
  24/32.** `note_shares.permission` records the grant; "a grant cannot exceed
  the actor's delegation rights or bypass project restrictions" is
  service/policy logic.
- **`notes.parent_id` cross-workspace is service-enforced.** Unlike
  `project_id`/`folder_id`, the parent self-FK does not include `workspace_id`
  in a composite; Part 31 verifies the parent is in the same workspace.
- **TipTap JSON projection only; Yjs binary state is Part 39.** `notes.content`
  is the deterministic read/search/export projection per ADR 0004. The Yjs
  binary update/snapshot and the projection-sync pipeline are Parts 33/39.
  The `version` column is monotonic optimistic concurrency, not the Yjs
  revision id.
- **Plain-text extraction is Part 33/39.** `content_plain` defaults to `""`
  and is populated by the projection pipeline; it is not maintained by a DB
  trigger.
- **No tags/attachments/comments/note_versions-rows tables yet.** Those are
  Part 16 and will reference `notes.id` (and `note_versions` will reuse the
  `version` semantics). Names were chosen to compose: `notes`, `note_shares`,
  `note_type`, `note_share_permission`.
- **No standalone tasks yet.** Part 17 owns task data; `note_type = "task"`
  only tags a note for list/view filtering.
- **`color` and `page_size` validation is service-side** (Part 29/31); the
  schema only constrains length.
- **The review-time reorder of the generated migration is a one-time manual
  fix.** If the schema is regenerated (it should be a no-op since the
  snapshot matches), drizzle-kit would re-emit the broken order; the reorder
  comment in the SQL documents why the indexes precede the FK block.

## Handoff Notes

- Never edit prior migrations `0000_enable_extensions.sql`,
  `0001_volatile_wiccan.sql`, `0002_minor_mad_think.sql`, their snapshots, or
  the pre-Part-15 journal entries. Forward-only corrections use a new
  migration.
- Migration `0003_cute_maria_hill.sql` and its snapshot are now immutable;
  any later project/note/folder/share-schema change must use a new generated
  forward migration and update the schema barrel.
- Later schema parts import `projects`, `folders`, `notes`, `note_shares`,
  `projectAccess` from the barrel (or via `./projects`, `./folders`,
  `./notes`). Part 16 (`note_versions`, tags, attachments, comments) will
  reference `notes.id` with CASCADE and should reuse the `version` semantics.
- The composite cross-tenant FKs mean service code in Part 29/31 MUST
  nullify `notes.project_id`/`notes.folder_id` before deleting the
  container, or the delete will fail with `23503`. This is the intended
  security-first behavior.
- `NO ACTION` (not `RESTRICT`) on the composite FKs is deliberate: it lets
  the workspace CASCADE delete succeed (NO ACTION is checked at end of
  statement after notes/folders/projects are all cascade-deleted). Switching
  to RESTRICT would break workspace deletion.
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL (the dev compose stack from Part 9). The live
  suite applies migrations and creates/cleans up its own deterministic
  fixtures, but run it against a fresh database or after `infra:reset:dev`
  for a clean state.
- The `created_by_id` RESTRICT constraint on all five Part 15 tables means
  any Part 21/26 user-deletion path must handle creators of projects,
  folders, notes, project-access grants, and note shares (transfer or
  reassign before account deletion).
- The `notes.sort_order` column is `double precision`; service code should
  guard against float-precision exhaustion near a cluster and periodically
  re-normalize (Part 31).

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 15 record: added projects, project access, folders, notes, note sharing schema (`projects`, `project_access`, `folders`, `notes`, `note_shares`, `projectStatusEnum`, `projectAccessRoleEnum`, `noteTypeEnum`, `noteSharePermissionEnum`), generated migration `0003_cute_maria_hill.sql` (with one review-time reorder of composite-FK-target indexes), and unit + live test suites. Status left `In progress` pending reviewer verification. |
| 2026-07-29 | Lead                        | Completed live hierarchy/ordering/sharing/composite-FK verification and all sequential repository gates; marked Part 15 Complete.                                                                                                                                                                                                                                                                                                                           |
