# Part 13 — Implement Identity and Authentication Tables

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent) under `lead-part-engineer`
- **Plan reference:** `Plan.md`, Part 13
- **Related records:**
  `part-12-drizzle-migration-tooling.md`;
  `docs/decisions/0003-authentication-ownership.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`;
  `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Introduce the durable identity and authentication schema before any workspace,
project, or note tables. Per ADR 0003, Better Auth is the sole owner of
credential, account, session, verification, two-factor, and passkey lifecycle,
so Part 13 must generate PostgreSQL tables that the pinned Better Auth
`1.6.24` Drizzle adapter can mount without parallel/overlapping session, JWT,
password, or user tables.

Part 13 therefore adds the application `users` table (also Better Auth's
`user` table) plus every Better Auth-owned table required by the core adapter
(`session`, `account`, `verification`) and by the plugins Notted will use
(`twoFactor`, `passkey`), with normalized email uniqueness, timezone-aware
timestamps, useful lookup indexes, and `ON DELETE CASCADE` from user to auth
rows. No NestJS auth wiring is added (that is Part 21); only schema, the
generated migration, and tests.

## Implemented Work

- Added `better-auth@1.6.24` and `@better-auth/drizzle-adapter@1.6.24` to
  `apps/api/package.json` (exact versions, alphabetical order). Strict pnpm
  install succeeded with no peer-override flags; the lockfile resolved the
  Better Auth + Drizzle ORM `^0.45.2` peers cleanly, matching ADR 0008.
- Added `apps/api/src/database/schema/users.ts` defining the application
  `users` table: `id` (uuid PK), `email` (varchar(255), not null), `name`
  (varchar(255), not null), Better Auth property `image` mapped to `avatar_url`
  (text, nullable), `email_verified` (boolean, default false, not null),
  `email_verified_at` (nullable timestamptz preserving Notted semantics),
  `two_factor_enabled` (boolean, default false, not null — required by the
  Better Auth `twoFactor` plugin), and `created_at`/`updated_at` timestamptz.
  Email uniqueness is enforced case-insensitively via a functional unique
  index on `lower(email)` so no `citext` extension is required.
- Added `apps/api/src/database/schema/auth.ts` defining the Better Auth-owned
  tables and all identity relations:
  - `account` (providerId, accountId, userId FK cascade, OAuth tokens,
    credential-account password, timestamps).
  - `session` (token, expiresAt, userId FK cascade, ipAddress, userAgent,
    timestamps).
  - `verification` (identifier, value, expiresAt, timestamps; no user FK per
    the core schema).
  - `two_factor` (secret, backupCodes, userId FK cascade, verified,
    failedVerificationCount, lockedUntil).
  - `passkey` (publicKey, credentialID, userId FK cascade, counter,
    deviceType, backedUp, transports, aaguid, name, createdAt).
  - Relations for `users ↔ account/session/twoFactor/passkey` and the reverse
    `one(users)` sides. `verification` has no relation to `users`.
- Appended every table and relation to the aggregate `schema` object in
  `apps/api/src/database/schema/index.ts` and re-exported each by name so the
  Drizzle adapter (Part 21) and tests can consume them through the barrel. The
  `Schema = typeof schema` type is preserved.
- Generated migration `apps/api/src/database/migrations/0001_volatile_wiccan.sql`
  via `pnpm db:generate`, plus its snapshot (`meta/0001_snapshot.json`) and a
  new journal entry in `meta/_journal.json`. Migration `0000_enable_extensions.sql`
  and its snapshot were not edited.
- Added `apps/api/test/identity-schema.test.ts` with a no-database unit suite
  (schema barrel exposes the expected tables and relations; each table declares
  the adapter-expected columns with correct nullability; the four user FKs
  cascade; the unique and lookup indexes exist via Drizzle metadata) and a
  `DATABASE_URL`-gated live suite (following the established
  `database.migration.test.ts` pattern) that applies the migration and verifies
  the tables, key column types, indexes, and cascade rules via
  `information_schema` and `pg_indexes`.

## Important Decisions

- **Adapter schema source of truth.** Field names and types were taken
  directly from the installed adapter packages: `@better-auth/core`'s
  `getAuthTables` for `user`/`session`/`account`/`verification`,
  `better-auth/plugins/two-factor/schema.mjs` for the `twoFactor` table and
  the `twoFactorEnabled` user column, and the v1.6 Better Auth passkey plugin
  documentation for the `passkey` table (the `@better-auth/passkey` package is
  not installed in Part 13 — it is a Part 21 concern; the documented field
  names match what the installed core schema machinery expects via
  `getFieldName`).
- **Drizzle property keys match the adapter's camelCase fieldNames** so the
  Drizzle adapter can resolve fields by name without renaming: `userId`,
  `emailVerified`, `twoFactorEnabled`, `accountId`, `providerId`, `accessToken`,
  `expiresAt`, `failedVerificationCount`, `credentialID`, `backedUp`, etc. The
  underlying PostgreSQL column names follow Notted's snake_case convention
  (`user_id`, `email_verified`, `two_factor_enabled`, `account_id`, ...).
- **`users` is both the application user profile and Better Auth's `user`
  table.** Per ADR 0003 no parallel user/session/JWT table is introduced.
  Better Auth property keys now match 1.6.24 directly: `image` maps to the
  existing `avatar_url` DB column and `emailVerified` is a non-null boolean.
  Notted's timestamp is the independent nullable `emailVerifiedAt` /
  `email_verified_at` field. `BETTER_AUTH_SCHEMA_CONTRACT` requires Part 21 to
  mount `modelName: "users"` with `advanced.database.generateId=false`,
  preserving PostgreSQL-generated UUIDs.
- **`twoFactor.userId` cascades.** The plugin schema does not specify
  `onDelete` for the user reference; we chose `cascade` so deleting a user
  purges their 2FA state, matching the core account/session/passkey cascade
  behavior and ADR 0003's intent.
- **Functional email unique index instead of `citext`.** The Part 12 extension
  migration enables only `uuid-ossp` and `vector`. Adding `citext` would
  require a new hand-written extension migration that Part 13 was not asked
  to author. A `uniqueIndex(...).on(sql\`lower(email)\`)`keeps the column type`varchar`, gives the same case-insensitive uniqueness guarantee, and is
cleanly emitted by `drizzle-kit generate`as`CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"))`.
- **`magicLink`/`emailOtp` plugins add no extra tables** in `1.6.24` (they
  reuse the core `verification` table), so no extra tables were created.
- **No NestJS, transport, or auth-config wiring** was added — those are
  Part 21. The schema is intentionally inert until then.

## Files and Components

| Path                                                        | Purpose                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/package.json`                                     | Added `better-auth@1.6.24` and `@better-auth/drizzle-adapter@1.6.24` dependencies.                                                                        |
| `apps/api/src/database/schema/users.ts`                     | Application `users` table (also Better Auth `user`), functional email uniqueness index. Dependency-free so later parts can import `users` without cycles. |
| `apps/api/src/database/schema/auth-contract.ts`             | Strict Part 21 contract for the existing users model and database-generated IDs.                                                                          |
| `apps/api/src/database/schema/auth.ts`                      | Better Auth-owned `account`, `session`, `verification`, `twoFactor`, `passkey` tables plus all Part 13 relations.                                         |
| `apps/api/src/database/schema/index.ts`                     | Aggregate `schema` barrel now exposes the Part 13 tables and relations and re-exports each by name. `Schema = typeof schema` preserved.                   |
| `apps/api/src/database/migrations/0001_volatile_wiccan.sql` | Generated forward migration: six tables, four cascading user FKs, lookup and unique indexes, functional `lower(email)` unique index.                      |
| `apps/api/src/database/migrations/meta/0001_snapshot.json`  | Generated Drizzle snapshot for migration 0001.                                                                                                            |
| `apps/api/src/database/migrations/meta/_journal.json`       | Appended journal entry `idx: 1`, `tag: 0001_volatile_wiccan`.                                                                                             |
| `apps/api/src/database/migrations/0007_early_bloodaxe.sql`  | Forward Reviewer #1 correction: data-safe verification conversion plus the shared Part 16/18 fixes.                                                       |
| `apps/api/src/database/migrations/meta/0007_snapshot.json`  | Generated final Phase 3 schema snapshot.                                                                                                                  |
| `apps/api/test/identity-schema.test.ts`                     | Unit suite (no DB) + DATABASE_URL-gated live suite asserting the migration matches adapter requirements.                                                  |
| `pnpm-lock.yaml`                                            | Resolved the new Better Auth dependency graph under strict peer checks.                                                                                   |

## Database and Data Changes

Migration `0001_volatile_wiccan.sql` is additive only: it creates six tables
(`users`, `session`, `account`, `verification`, `two_factor`, `passkey`), four
cascading foreign keys from `account`/`session`/`two_factor`/`passkey` to
`users(id)`, and ten indexes (four unique — `users_email_lower_unique`,
`session_token_unique`, `account_provider_account_id_unique`,
`passkey_credential_id_unique`; six lookup — `account_user_id_idx`,
`session_user_id_idx`, `two_factor_user_id_idx`, `two_factor_secret_idx`,
`passkey_user_id_idx`, `verification_identifier_idx`). No data, no seed, no
destructive statement, no extension change. Defaults use PostgreSQL built-ins
(`gen_random_uuid()`, `now()`, literal `true`/`false`/`0`) and require no
extension beyond the Part 12 baseline. The migration is forward-only per
project policy; rollback is a separate reviewed operation.

Historical initial-implementation hashes (superseded by forward migration
0007 and the Reviewer #1 source corrections; not current-file hashes):

Forward correction `0007_early_bloodaxe.sql` first adds
`email_verified_at`, copies every existing non-null `email_verified` timestamp,
then converts the old column with `USING (email_verified IS NOT NULL)` before
setting `DEFAULT false` and `NOT NULL`. Thus old verified rows retain their
exact timestamp and become boolean true; old null rows become false.

| File                                                        | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/src/database/schema/users.ts`                     | `ddf87c287313bef23d19445bd746418407f199a21448421251b31a585a0ace46` |
| `apps/api/src/database/schema/auth.ts`                      | `f3f421facc40896c59abe706b5172012f3b71cd91264a33bbe42a9ddaf973b78` |
| `apps/api/src/database/schema/index.ts`                     | `ed06042927dd45660268b330fe9f84498be965e183c13a254f4cc92c3c88b099` |
| `apps/api/src/database/migrations/0001_volatile_wiccan.sql` | `7ff0ad1b5769cb87e9be0beb1b813215fd3f5d2b95930ad97b73531d2e3200f4` |
| `apps/api/src/database/migrations/meta/0001_snapshot.json`  | `545525d5eb09c1e13747e77a183439055e59d84c6ba63d21f7a8a93ba8c26b45` |
| `apps/api/src/database/migrations/meta/_journal.json`       | `f80b600a371d6306b83b411b430b37a69642fcb952dbf1a0156369fd4333cb45` |
| `apps/api/test/identity-schema.test.ts`                     | `b0a8adcb7b4fdf24c60600f073a6f3d1abd8d71f6812cae43f6900dbd9d4a032` |
| `apps/api/package.json`                                     | `231858f28886f89e3a77b9e155c780e601a9021d892dcab9b680b9fa82795bcd` |

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe: there is no anonymous
access, no session is issued, and no transport reads these tables yet. The
schema is purely structural; Part 21 mounts the Better Auth adapter and
configures cookies, origins, CSRF/origin checks, and session expiry.

## Security and Tenant-Isolation Notes

- Per ADR 0003, no parallel password, refresh-token, session, or JWT tables
  were introduced. Better Auth owns credential and session lifecycle.
- Credential-account `password`, OAuth `access_token`/`refresh_token`/
  `id_token`, and `two_factor.secret`/`backup_codes` columns are persisted but
  documented as never-selectable into API responses or logs; Part 21 enforces
  that at the auth boundary.
- `users.email` uniqueness is enforced case-insensitively to prevent
  same-mailbox account duplication via casing.
- `verification.value` (magic-link tokens, email-OTP codes) is stored as
  transient text with `expires_at`; it is never logged.
- No workspace_id is introduced here (Part 14 owns workspace membership and
  tenant-scoped authorization). A valid identity created by Part 13 never
  implies workspace access; that boundary is enforced starting in Part 14 and
  re-tested in every later tenant-owned part.
- No secrets, connection strings, cookies, or signed URLs appear in the
  schema, migration, tests, or this record.

## Verification Evidence

Final verification completed on 2026-07-29 after two independent reviews,
one bounded fix pass, and direct lead remediation.

| Check                           | Result | Notes                                                                                                                      |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| Frozen install / peer graph     | Pass   | `pnpm install --frozen-lockfile`; Better Auth 1.6.24 and Drizzle 0.45.2 resolve without peer overrides.                    |
| Format, lint, type-check, build | Pass   | Repository format/type/build passed; all workspace lint tasks and the root ESLint config passed sequentially.              |
| Unit tests                      | Pass   | API: 184 passed, 38 live-only skipped; shared packages and web tests also passed in the broad gate.                        |
| Live Phase 3 database suites    | Pass   | Nine files, 123 tests, 0 skipped against fresh `notted_phase3_review`, including the identity adapter contract.            |
| Empty and populated migrations  | Pass   | 0000–0007 applied to an empty DB; populated 0007 upgrade preserved `email_verified_at` and converted boolean verification. |
| Drizzle consistency             | Pass   | `pnpm db:check`.                                                                                                           |

## Known Limitations and Follow-up Work

- **Part 21 wiring contract is explicit.** It must use the existing `users`
  model and database-generated IDs (`advanced.database.generateId=false`). It
  must not reintroduce `avatarUrl` or overload the boolean verification field
  with timestamp semantics.
- **`@better-auth/passkey` plugin** is not installed yet; the `passkey` table
  was created from the documented v1.6 schema. Part 21 (or whichever part
  first ships passkey auth) must install `@better-auth/passkey@1.6.24` and
  verify the schema matches by re-running `npx auth@latest generate` or the
  migration tests.
- **`session`/`account`/`verification`/`two_factor`/`passkey` rows are not
  workspace-scoped** and intentionally so — they are identity/auth-owned. The
  first tenant-owned table (`workspaces`, `workspace_members`) arrives in
  Part 14, which also owns the first tenant-isolation tests.
- **No application-level role/permission columns** were added to `users`.
  Workspace roles live on `workspace_members` in Part 14; system roles, if
  needed, are a separate decision.

## Handoff Notes

- Never edit migration `0000_enable_extensions.sql`, its snapshot, or the
  pre-Part-13 journal entries. Forward-only corrections use a new migration.
- Migration `0001_volatile_wiccan.sql` and its snapshot are now immutable;
  any later identity-schema change (e.g. Part 21's `emailVerified`/`image`
  reconciliation) must use a new generated forward migration and update the
  schema barrel.
- Later schema parts import `users` from
  `apps/api/src/database/schema/users.ts` (or via the barrel). Identity/auth
  tables should only be referenced by Part 21 (auth wiring) and tests; later
  tenant-owned tables should reference `users` only via foreign keys to record
  the actor, never to grant workspace access.
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL (the dev compose stack from Part 9). The live
  suite applies migrations and does not clean up its schema; run it against a
  fresh database or after `infra:reset:dev`.
- Better Auth mounting in Part 21 should consume the barrel directly:
  `drizzleAdapter(db, { provider: "pg", schema: { ...schema, user: schema.users } })`,
  with `usePlural: false` (default). The plural relation field names
  (`accounts`, `sessions`, `twoFactors`, `passkeys`) already match the
  adapter's join keys.

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 13 record: added Better Auth dependencies, identity schema (`users`, `account`, `session`, `verification`, `twoFactor`, `passkey`), generated migration `0001_volatile_wiccan.sql`, and unit + live test suites. Status left `In progress` pending reviewer verification.                                                                                             |
| 2026-07-29 | `backend-platform-engineer` | Reviewer #1 fix pass: aligned Better Auth 1.6.24 `image`/boolean `emailVerified`, retained `emailVerifiedAt`, recorded database-generated ID wiring, and added forward migration `0007_early_bloodaxe.sql`. Migration 0007 copies existing timestamps before `USING (email_verified IS NOT NULL)`, then sets default false and NOT NULL. Verification remains pending Reviewer #2. |
| 2026-07-29 | Lead                        | Completed empty/populated migrations, live identity tests, and all sequential repository gates; marked Part 13 Complete.                                                                                                                                                                                                                                                           |
