# Database migration policy

This policy applies to the Drizzle migration surface introduced in Plan Part 12.

## Generate and review

- Change schema exports under `apps/api/src/database/schema/`, then run
  `pnpm db:generate`.
- Review every generated SQL statement, metadata change, lock implication, default,
  constraint, index, backfill, compatibility window, and rollback effect before staging.
- Hand-written SQL is exceptional. The initial
  `0000_enable_extensions.sql` is hand-written because Drizzle Kit does not generate
  `CREATE EXTENSION`; its purpose and review rationale are recorded in the file and Part
  12 completion record.
- `pnpm db:check` must pass after generation. Do not use `drizzle-kit push` as a
  substitute for a reviewed migration.

## Immutability

Once a migration is accepted into shared history or applied to any persistent
environment, do not edit or reorder its SQL, snapshot, or journal entry. Correct it with
a new forward migration. A migration hash change is reviewed like a new data change and
must include compatibility and rollback notes.

## Application

- Apply migrations explicitly with `pnpm db:migrate`; application startup never mutates
  the schema implicitly.
- Apply each migration once per database before starting application instances that
  depend on it.
- Back up authoritative data before an irreversible migration. Redis and Meilisearch are
  disposable projections and are not migration rollback sources.

## Required tests

Before accepting a migration:

1. Apply the complete migration history to an empty supported PostgreSQL database.
2. Apply it with representative pre-existing data and verify that data is preserved or
   deliberately transformed.
3. Run a simple database health query through the API's configured PostgreSQL/Drizzle
   path.
4. For table-bearing migrations, test constraints, cascades, workspace boundaries,
   upgrade compatibility, and any backfill or rollback procedure.

Part 12 has no application tables or Part 20 seed dataset. Its live migration test creates
a deterministic pre-existing probe row, applies the migration, verifies that row and
`select 1`, and checks both required extensions. Later parts replace that minimal probe
with representative domain fixtures appropriate to their schema.

## Rollback

Prefer a compatible corrective migration over destructive down-migrations. If application
rollback is required, retain schema compatibility until the old version is no longer in
use. Extension removal is not an automatic rollback: later schemas can depend on
`uuid-ossp` or `vector`, so removal requires dependency inspection, a backup, and a
separate reviewed operation.
