# Part 12 — Configure Drizzle ORM and Migration Tooling

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** `/root` with backend and quality specialists
- **Plan reference:** `Plan.md`, Part 12
- **Related records:** `part-05-nestjs-api-scaffold.md`;
  `part-09-development-compose-stack.md`;
  `part-11-configuration-dependency-clients.md`;
  `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Establish the typed Drizzle/PostgreSQL boundary, reviewed migration history, transaction
helper, schema export convention, and executable empty/upgrade verification needed before
application tables are introduced.

## Implemented Work

- Added `drizzle.config.ts` for PostgreSQL, the canonical schema glob and migration output,
  strict/verbose generation, and environment-owned database credentials.
- Added a global NestJS database module with a bounded `pg.Pool`, typed Drizzle handle,
  narrow `DatabaseService`, transaction helper, graceful pool lifecycle, and readiness
  query.
- Added the canonical schema barrel. It is intentionally empty until Part 13 adds identity
  tables; later parts append exports to the single aggregate.
- Added the initial reviewed SQL migration and Drizzle journal/snapshot. The migration
  idempotently enables `uuid-ossp` and `vector`.
- Wired root/API commands for `db:check`, `db:generate`, `db:migrate`, and `db:studio`.
- Added unit tests for transaction delegation/configuration and pool shutdown.
- Added a Docker-gated live migration suite that creates representative pre-existing probe
  data, applies the complete migration history, verifies data preservation, executes
  `select 1`, and confirms both extensions.
- Added `docs/database-migrations.md` with generation, SQL review, immutability,
  application, empty/seeded-data testing, compatibility, and rollback rules.

## Important Decisions

- Exact versions remain Drizzle ORM `0.45.2`, Drizzle Kit `0.31.10`, and `pg` `8.22.0`.
  ADR 0008 explains the deliberate ORM-line deviation required by Better Auth `1.6.24`.
- PostgreSQL is authoritative. Redis and Meilisearch are not migration rollback sources.
- Application startup never mutates the schema. Migrations run explicitly as a release or
  developer step.
- Accepted/applied SQL, journal entries, and snapshots are immutable. Corrections use a new
  forward migration.
- The extension migration is hand-written because Drizzle Kit does not generate
  `CREATE EXTENSION`; table migrations remain generated and reviewed.
- Part 20's domain seed does not exist yet. Part 12 therefore uses a deterministic
  pre-existing probe row to exercise the upgrade/data-preservation path without inventing
  future product tables or credentials.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/drizzle.config.ts` | Drizzle Kit dialect, schema, output, and database configuration. |
| `apps/api/src/database/database.module.ts` | PostgreSQL pool and typed Drizzle providers. |
| `apps/api/src/database/database.service.ts` | Narrow database/transaction/lifecycle contract. |
| `apps/api/src/database/schema/index.ts` | Canonical aggregate schema barrel. |
| `apps/api/src/database/migrations/0000_enable_extensions.sql` | Initial `uuid-ossp` and `vector` migration. |
| `apps/api/src/database/migrations/meta/` | Drizzle migration snapshot and journal. |
| `apps/api/test/database.migration.test.ts` | Live empty/seeded-preservation, health-query, and extension verification. |
| `docs/database-migrations.md` | Durable migration policy and rollback guidance. |

## Database and Data Changes

Migration `0000_enable_extensions.sql` adds the database extensions `uuid-ossp` and
`vector` with `IF NOT EXISTS`. It creates no application table, row, credential, or tenant
surface. The test-only probe table is dropped in `finally` and never remains in the
development database.

Rollback does not automatically drop either extension because later schemas can depend on
them. Removal requires dependency inspection, backup, and a separately reviewed operation.

Current immutable-surface hashes:

| File | SHA-256 |
|---|---|
| `apps/api/drizzle.config.ts` | `14ac6285ce007c4b11a494e8150fd82333a817352286fb5b44d58b64b57bf5c4` |
| `apps/api/test/database.migration.test.ts` | `92192a3e6e851cff5a1eb2045df6147bce26bcaa5fa0abc9ea8971c4a193fc18` |
| `apps/api/src/database/migrations/0000_enable_extensions.sql` | `c667eb549918de9735b414667044eb507496e1dce5c2cc74ccd4e46434ac85ad` |
| `apps/api/src/database/migrations/meta/0000_snapshot.json` | `bc7aa9d847645cf3c8cb29bf1e90c0a41ed2217b4b497cc5ec26a307d2fe11b3` |
| `apps/api/src/database/migrations/meta/_journal.json` | `c31ac551d38024aafd5a8e81d0e2f13dc8662c6f4d85d573ea5cb921d736947f` |
| `apps/api/src/database/schema/index.ts` | `7eef9156ee6bc305710c73730542f3ec89cffda7976323d2fae7f46040677185` |

## API, Configuration, and Operational Changes

- `DATABASE_URL` and pool/query/readiness bounds are typed through Part 8 configuration.
- `pnpm db:check` validates Drizzle schema/migration consistency without mutating a
  database.
- `pnpm db:generate` creates reviewable migration artifacts.
- `pnpm db:migrate` explicitly applies accepted migrations using the ignored API
  environment.
- `pnpm db:studio` starts the local Drizzle inspection tool.
- `/health/ready` executes the simple PostgreSQL health query through the configured API
  database path.

## Security and Tenant-Isolation Notes

- Connection strings and driver errors are never logged; readiness reports a generic
  database failure.
- Queries use Drizzle/parameterized SQL. The migration test contains only fixed SQL and no
  external input.
- No tenant table exists in Part 12. Parts 13–19 own schema constraints, workspace
  boundaries, tenant-denial tests, and retention behavior.
- Migration artifacts and test output contain no ignored environment values.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `pnpm db:check` | Pass | Drizzle schema, journal, snapshot, and migration history are consistent. |
| Live migration test | Pass | Two tests passed against a fresh isolated pgvector/PostgreSQL 16 volume. |
| Empty forward migration | Pass | The complete history created the migration journal and enabled both extensions. |
| Pre-existing data preservation | Pass | A deterministic probe row survived migration and was removed after assertion. |
| Extension query | Pass | Returned `uuid-ossp` and `vector`. |
| API database health query | Pass | Built API readiness returned database `up`; dependency outage/recovery also passed. |
| Unit/E2E and CI coverage suites | Pass | Database service/readiness tests and the broad repository suites passed. |
| Frozen install, format, lint, type-check, build | Pass | Exact package graph and all repository quality gates passed. |

## Known Limitations and Follow-up Work

- Part 12 intentionally has no application tables or domain seed. Parts 13–20 add them with
  generated migrations, realistic fixtures, constraints, cascades, and tenant-denial
  coverage.
- Extension rollback is intentionally manual and dependency-aware, not an automatic down
  migration.

## Handoff Notes

- Never edit migration `0000`, its snapshot, or journal after this accepted checkpoint.
- Add a new forward migration for every later schema change and update the schema barrel.
- Run empty and representative-data migrations before accepting each later database part.
- Do not use `drizzle-kit push` in place of reviewed migration history.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-27 | `/root` | Recorded the existing Drizzle foundation, added migration policy and data-preservation coverage, completed live empty/upgrade/API verification, and marked Part 12 complete. |
