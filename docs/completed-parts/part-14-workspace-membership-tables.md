# Part 14 — Implement Workspace and Membership Tables

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent) under `lead-part-engineer`
- **Plan reference:** `Plan.md`, Part 14
- **Related records:**
  `part-13-identity-authentication-tables.md`;
  `docs/decisions/0003-authentication-ownership.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`

## Objective

Introduce the first tenant-owned schema in Notted: the workspace tenancy root,
membership, and invitation tables that Parts 15–18 (projects, notes, tags,
tasks, …) will reference. Per ADR 0007 every tenant-owned row carries or reaches
a `workspace_id`; per ADR 0003 a valid identity never implies workspace access,
so only an active `workspace_members` row with a role grants access (enforced
by the service/policy layer in Part 26). Part 14 therefore adds the
`workspaces`, `workspace_members`, and `invitations` tables, the `member_role`
and `workspace_plan` enums, the membership uniqueness constraint, workspace
deletion cascades, the ADR 0007 invitation contract, and a reviewed forward
migration. No NestJS services, controllers, transports, jobs, or auth wiring
are introduced (those are Parts 21, 26, 28); only schema, the generated
migration, and tests.

## Implemented Work

- Added `apps/api/src/database/schema/workspaces.ts` defining:
  - `memberRoleEnum` = `pgEnum("member_role", ["owner", "admin", "editor",
"viewer"])` — matches the permissions matrix in `Notted.md`.
  - `workspacePlanEnum` = `pgEnum("workspace_plan", ["free", "pro",
"enterprise"])`.
  - `workspaces` table: `id` (uuid PK), `name` (varchar 255, notNull),
    `slug` (varchar 255, notNull, unique), `description` (text, nullable),
    `logo_url` (text, nullable), `domain` (varchar 255, nullable, unique),
    `plan` (workspace_plan default `"free"`, notNull), `settings` (jsonb
    default `{}`, notNull — branding/accent/page defaults),
    `storage_limit_bytes` (bigint, `{ mode: "number" }`, nullable — per-
    workspace storage override; NULL means plan default applies), `created_by_id`
    (uuid → `users.id` RESTRICT, notNull), `created_at`/`updated_at`
    (timestamptz defaultNow, notNull). Indexes: `workspaces_slug_unique`
    (unique), `workspaces_domain_unique` (unique), `workspaces_created_by_id_idx`.
  - `workspace_members` table: `id` (uuid PK), `workspace_id` (uuid →
    `workspaces.id` CASCADE, notNull), `user_id` (uuid → `users.id` CASCADE,
    notNull), `role` (member_role default `"editor"`, notNull), `joined_at`
    (timestamptz defaultNow, notNull). Indexes:
    `workspace_members_workspace_user_unique` (unique composite on
    `(workspace_id, user_id)` — enforces exactly one role per user per
    workspace), `workspace_members_user_id_idx` (covers "list a user's
    workspaces", not covered by the composite's leftmost prefix).
  - `invitations` table per ADR 0007: `id` (uuid PK), `workspace_id` (uuid →
    `workspaces.id` CASCADE, notNull), `email` (varchar 255, notNull — stored
    normalized to lowercase by the service), `role` (member_role default
    `"viewer"`, notNull), `token_hash` (varchar 255, notNull, unique — HASH
    only, never raw token), `invited_by_id` (uuid → `users.id` CASCADE,
    notNull), `expires_at` (timestamptz, notNull — no token without expiry can
    be persisted), `accepted_at` (timestamptz, nullable), `accepted_by_id`
    (uuid → `users.id` SET NULL, nullable), `revoked_at` (timestamptz,
    nullable), `created_at`/`updated_at` (timestamptz defaultNow, notNull).
    Indexes: `invitations_token_hash_unique` (unique — single-use semantics),
    `invitations_workspace_id_idx`, `invitations_email_idx`.
  - Forward relations only: `workspacesRelations` (`createdBy` → one `users`,
    `members` → many `workspace_members`, `invitations` → many `invitations`),
    `workspaceMembersRelations` (`workspace`, `user`), `invitationsRelations`
    (`workspace`, `invitedBy`, `acceptedBy` with disambiguating `relationName`
    for the two `users` references).
- Appended every Part 14 table, relation, and enum to the aggregate `schema`
  object in `apps/api/src/database/schema/index.ts` and re-exported each by
  name. The existing Part 13 entries and the `Schema = typeof schema` type are
  preserved; a `// Part 14 — …` comment marks the new block.
- Generated migration
  `apps/api/src/database/migrations/0002_minor_mad_thinker.sql` via
  `pnpm db:generate`, plus its snapshot (`meta/0002_snapshot.json`) and a new
  journal entry (`idx: 2`, `tag: 0002_minor_mad_thinker`) in `meta/_journal.json`.
  Prior migrations (`0000_enable_extensions.sql`, `0001_volatile_wiccan.sql`),
  their snapshots, and the pre-Part-14 journal entries were not edited.
- Added `apps/api/test/workspace-schema.test.ts` with:
  - A no-database unit suite: the barrel exposes the three tables, three
    relation objects, and the two enums; the enums have the expected values;
    every column declared in the brief exists with correct nullability;
    `workspace_members` uses `joined_at` (no separate `created_at`/`updated_at`);
    the membership unique constraint, slug/domain/token uniqueness, and all
    lookup indexes exist via Drizzle metadata; and every foreign key has the
    intended `onDelete` (workspace/user cascade, creator restrict, acceptor
    set null).
  - A `DATABASE_URL`-gated live suite (mirroring `database.migration.test.ts`
    and `identity-schema.test.ts`) that applies migrations and asserts: (a) the
    three tables and two enums exist, (b) a duplicate `(workspace_id, user_id)`
    membership is rejected with `23505` unique violation, (c) an invalid role
    enum value is rejected with `22P02` invalid text representation, and (d)
    deleting a workspace cascades to its members and invitations. Each live
    test creates deterministic unique fixtures and cleans them up.

## Important Decisions

- **`workspaces.created_by_id` is `ON DELETE RESTRICT`, not cascade.** A
  workspace is a shared tenant entity (multiple members, future notes/projects/
  attachments), not personal auth state. Cascading creator deletion would
  silently destroy the workspace and every member's data. RESTRICT forces the
  membership service (Part 26) to transfer ownership or delete the workspace
  explicitly before the original creator's account can be removed. This is the
  deny-by-default choice and the only safe option given the column is
  `notNull`. Ownership at any point in time is whoever currently holds the
  `owner` role in `workspace_members`, not the `created_by_id` audit field.
- **Workspace deletion cascades to `workspace_members` and `invitations`.**
  `workspace_members.workspace_id` and `invitations.workspace_id` are
  `ON DELETE CASCADE` so a deleted workspace cannot leave orphaned tenant rows.
  Later parts (15–18) will add the same cascade to projects/notes/tags/tasks/etc.
- **User deletion cascades/nullifies per-column.** `workspace_members.user_id`
  and `invitations.invited_by_id` cascade (deleting a user removes their
  memberships and pending invitations); `invitations.accepted_by_id` is
  `SET NULL` so the historical invitation record is preserved when an acceptor
  is later deleted (the durable membership is the source of truth, not the
  invitation row).
- **Last-owner protection is service logic (Part 26), not a DB constraint.**
  The schema guarantees (via `workspace_members_workspace_user_unique`) that a
  user has exactly one role per workspace, so "is this user an owner?" is a
  single-row lookup. But "would removing/changing this owner leave zero
  owners?" is a transactional count that cannot be expressed as a column
  constraint; Part 26 enforces it inside the membership service transaction.
  This is documented in the schema module comment and here.
- **`storage_limit_bytes` as an explicit `bigint` column** (not JSON). Keeps
  quota checks indexable and avoids baking plan limits into the `settings`
  JSON. NULL means the plan default applies (Part 45 owns plan default
  constants). `mode: "number"` is safe because workspace storage caps are far
  below `Number.MAX_SAFE_INTEGER`.
- **Invitation email stored normalized to lowercase by the service.** The
  service (Part 28) lowercases before insert and before lookup, so plain
  `btree` indexes on `email` are sufficient — no functional `lower(email)`
  index is needed here (unlike `users.email`, which is matched case-
  insensitively at the DB layer because Better Auth owns it).
- **Single-use invitations via `token_hash` UNIQUE + service markers.** A given
  token hash can redeem at most one row; the service additionally sets
  `accepted_at`/`revoked_at` and rejects already-used or revoked tokens. Only
  the hash is persisted; the raw token is generated, emailed, and discarded.
- **Forward relations only.** `usersRelations` in `auth.ts` was intentionally
  not extended with `many(workspaces)`/`many(workspaceMembers)`/
  `many(invitations)` back-references, to keep Part 13 files immutable per the
  handoff rules. Drizzle supports one-directional relations, so forward
  queries (`workspaces` → `createdBy`, `members`, `invitations`) work; reverse
  queries (`users` → workspaces) can be added in a later part if the Drizzle
  adapter's experimental joins need them.
- **`relations` imported from `drizzle-orm` (root), not `drizzle-orm/pg-core`.**
  Drizzle 0.45.2 exports `relations` only from the root package; importing it
  from `pg-core` raises `relations is not a function` at `db:generate` time.
  Part 13's `auth.ts` already follows this convention.
- **`workspace_members` has only `joined_at`** (no `created_at`/`updated_at`),
  matching `Notted.md` exactly. `joined_at` is the membership creation
  timestamp; role-change auditing is a later concern if needed.

## Files and Components

| Path                                                          | Purpose                                                                                                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/database/schema/workspaces.ts`                  | `workspaces`, `workspace_members`, `invitations` tables, `memberRoleEnum`, `workspacePlanEnum`, and forward relations. First tenant-owned schema; documents deletion model and last-owner handoff. |
| `apps/api/src/database/schema/index.ts`                       | Aggregate `schema` barrel now exposes the Part 14 tables, relations, and enums and re-exports each by name. `Schema = typeof schema` preserved.                                                    |
| `apps/api/src/database/migrations/0002_minor_mad_thinker.sql` | Generated forward migration: two enums, three tables, six foreign keys (cascade/restrict/set null), eight indexes (four unique).                                                                   |
| `apps/api/src/database/migrations/meta/0002_snapshot.json`    | Generated Drizzle snapshot for migration 0002.                                                                                                                                                     |
| `apps/api/src/database/migrations/meta/_journal.json`         | Appended journal entry `idx: 2`, `tag: 0002_minor_mad_thinker`.                                                                                                                                    |
| `apps/api/test/workspace-schema.test.ts`                      | Unit suite (no DB) + DATABASE_URL-gated live suite asserting tables/enums, duplicate-membership rejection, invalid-role rejection, and workspace cascade.                                          |

## Database and Data Changes

Migration `0002_minor_mad_thinker.sql` is additive only: it creates two enum
types (`member_role`, `workspace_plan`), three tables (`invitations`,
`workspace_members`, `workspaces`), and eight indexes (four unique —
`workspaces_slug_unique`, `workspaces_domain_unique`,
`workspace_members_workspace_user_unique`, `invitations_token_hash_unique`;
four lookup — `workspaces_created_by_id_idx`,
`workspace_members_user_id_idx`, `invitations_workspace_id_idx`,
`invitations_email_idx`). Six foreign keys are added: `workspaces.created_by_id`
→ `users(id)` RESTRICT; `workspace_members.workspace_id` → `workspaces(id)`
CASCADE and `.user_id` → `users(id)` CASCADE; `invitations.workspace_id` →
`workspaces(id)` CASCADE, `.invited_by_id` → `users(id)` CASCADE, and
`.accepted_by_id` → `users(id)` SET NULL. No data, no seed, no destructive
statement, no extension change. Defaults use PostgreSQL built-ins
(`gen_random_uuid()`, `now()`, `'{}'::jsonb`, enum literals) and require no
extension beyond the Part 12 baseline. The migration is forward-only per
project policy; rollback is a separate reviewed operation.

Current immutable-surface hashes:

| File                                                          | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/src/database/schema/workspaces.ts`                  | `675a77c3edf323c604226396fa4c4bdb7884adbae90a32e670ffa37bd8095080` |
| `apps/api/src/database/schema/index.ts`                       | `dc977810305cbc92309b5a09f068f7f6ef6748026345049618ccbadcfa8a4e02` |
| `apps/api/src/database/migrations/0002_minor_mad_thinker.sql` | `a8f2d27963e87e25f2e6a5e06ede421744cc257d06d5f9eb2e9a7afe54b24f1b` |
| `apps/api/src/database/migrations/meta/0002_snapshot.json`    | `fb05fc2f1ac00a783ea5e1eabb6a0a802db187df092fdca72a186d6656cbc686` |
| `apps/api/src/database/migrations/meta/_journal.json`         | `f905482eefc1ad360d4d112fc480fab0edcccf7722bbe8f1037458eb923b2fb7` |
| `apps/api/test/workspace-schema.test.ts`                      | `6bd3dc4bb14c49c1318a2047067e1ebd943ac600102c3d47d2ccdcb6430f8594` |

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe: there is no anonymous
or unauthenticated workspace access, no membership is auto-created, and no
transport reads these tables yet. The schema is purely structural; Parts 21
(auth), 26 (membership service), and 28 (invitation flows) wire behavior on top.

## Security and Tenant-Isolation Notes

- Per ADR 0003, a valid Better Auth identity created in Part 13 never implies
  workspace access. Only an active `workspace_members` row with a role grants
  access; the service policy layer (Part 26) denies by default and will be the
  first place transport requests are authorized against workspace membership.
- `workspace_members_workspace_user_unique` guarantees exactly one role per user
  per workspace, so privilege is a single-row lookup and cannot be duplicated or
  split across rows.
- Invitations store only `token_hash`; the raw invitation token is generated,
  emailed, and discarded, and is never persisted or logged (ADR 0007). Token
  hashes are unique so a leaked token redeems at most one row.
- `expires_at` is `notNull` so a token without an expiry can never be persisted;
  the service supplies the ADR 0007 seven-day default. `accepted_at` /
  `revoked_at` are service-set single-use markers.
- `invitations.email` is normalized to lowercase by the service before insert;
  acceptance requires the authenticated user's email to match (service-side,
  Part 28), so an invitation cannot be redeemed by a different mailbox.
- `workspaces.created_by_id` is RESTRICT so a creator account cannot be deleted
  while any workspace still references them, preventing silent tenant-data loss.
- Workspace deletion cascades to memberships and invitations (and, in later
  parts, to all tenant-owned rows), so a deleted workspace leaves no orphaned
  accessible rows.
- No secrets, connection strings, raw tokens, cookies, or signed URLs appear in
  the schema, migration, tests, or this record.

## Verification Evidence

Final verification completed on 2026-07-29.

| Check                            | Result | Notes                                                                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Migration and schema consistency | Pass   | `0002_minor_mad_thinker.sql` applied in the empty forward chain; `pnpm db:check` passed.               |
| Focused workspace suite          | Pass   | Included in the nine-file live gate: duplicate membership, invalid role, and workspace cascade passed. |
| Cross-tenant isolation           | Pass   | Workspace/member/invitation read and mutation guards were included in the direct tenant matrix.        |
| Repository quality gate          | Pass   | Sequential format, lint, type-check, API tests, and production build passed.                           |

## Known Limitations and Follow-up Work

- **Last-owner protection is Part 26.** The schema cannot express "at least one
  owner per workspace" as a constraint; the membership service must count
  `owner` rows inside the role-change/removal transaction and reject changes
  that would leave zero owners. Documented in the schema module comment.
- **Workspace deletion is hard delete (cascade).** Soft-delete/audit of
  workspace removal is not modeled here; if required, a later part adds a
  tombstone or audit table and the cascade is revisited. For now deletion is
  irreversible and removes all tenant rows.
- **`workspaces.created_by_id` RESTRICT may surprise Part 21 user deletion.**
  Deleting a user who created any workspace will fail with a foreign-key
  violation until the workspace is deleted or `created_by_id` is reassigned.
  Part 26 must implement ownership transfer or `created_by_id` reassignment
  before account deletion for creators.
- **No reverse relations on `users`.** `usersRelations` in `auth.ts` was not
  extended (Part 13 immutability). If a later part needs `user → workspaces`
  joins via the Drizzle adapter, it must update `usersRelations` in a new
  change.
- **Invitation email normalization is a service contract, not a DB guarantee.**
  A direct SQL insert of a mixed-case email would bypass normalization. Part 28
  enforces lowercase before insert/lookup; a future migration could add a
  `CHECK` or generated column if defense-in-depth is required.
- **No project/note/tag/task tables yet.** Those are Parts 15–18 and will
  reference `workspaces.id` with the same cascade pattern.
- **Slug and domain validation** (format, reserved words, DNS ownership for
  custom domains) is service-side (Part 26/28); the schema only enforces
  uniqueness.

## Handoff Notes

- Never edit migration `0000_enable_extensions.sql`,
  `0001_volatile_wiccan.sql`, their snapshots, or the pre-Part-14 journal
  entries. Forward-only corrections use a new migration.
- Migration `0002_minor_mad_thinker.sql` and its snapshot are now immutable;
  any later workspace-schema change must use a new generated forward migration
  and update the schema barrel.
- Later schema parts (15–18) import `workspaces` from
  `apps/api/src/database/schema/workspaces.ts` (or via the barrel) and should
  use `onDelete: "cascade"` on their `workspace_id` foreign keys so workspace
  deletion removes all tenant-owned rows consistently.
- `memberRoleEnum` and `workspacePlanEnum` are exported from the barrel;
  shared Zod validators in `packages/shared-validators` should mirror their
  value sets when Part 26/28 contracts are written.
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL (the dev compose stack from Part 9). The live suite
  applies migrations and creates/cleans up its own deterministic fixtures, but
  run it against a fresh database or after `infra:reset:dev` for a clean state.
- The `workspaces.created_by_id` RESTRICT constraint means any Part 21/26 user
  deletion path must handle the case where the user created workspaces
  (transfer ownership or delete the workspace first).

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 14 record: added workspace, membership, and invitation schema (`workspaces`, `workspace_members`, `invitations`, `memberRoleEnum`, `workspacePlanEnum`), generated migration `0002_minor_mad_thinker.sql`, and unit + live test suites. Status left `In progress` pending reviewer verification. |
| 2026-07-29 | Lead                        | Completed live constraints/cascade/isolation verification and all sequential repository gates; marked Part 14 Complete.                                                                                                                                                                                       |
