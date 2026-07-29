# Part 20 — Create realistic seed data

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer`
- **Plan reference:** `Plan.md`, Part 20
- **Related records:** Parts 12–19; ADRs 0004, 0005, 0007, and 0009

The implementation is authored, but this was an implement-only session. Reviewer #2 must
run the pending checks below before changing this record to `Complete`.

## Objective

Provide a deterministic, realistic, idempotent PostgreSQL development dataset that later
API, authorization, UI, editor, and tenant-isolation work can use without introducing
production-like credentials or changing the accepted schema/migrations.

## Implemented Work

- Added the **Alpha isolation tenant** (`Notted Alpha Studio`) and **Beta isolation
  tenant** (`Notted Beta Workshop`) scenarios with stable UUIDs for every seeded row.
- Added six labeled seed identities using reserved `.test` addresses. Alpha includes
  owner, admin, editor, and viewer; Beta has its own owner/editor pair and no accidental
  cross-tenant membership.
- Added three projects, root and nested folders, standalone/project/nested notes, a
  template, soft-deleted and pinned notes, and a task-list note.
- Added explicit TipTap JSON with headings, paragraphs, bullet/ordered lists, task-list
  nodes, and a blockquote, together with a deterministic matching plain-text projection.
- Added workspace tags and note links; an inline anchored comment thread and reply;
  ordered full-note snapshots; and private attachment metadata with an opaque key,
  processing state, and preview variant metadata. No bytes or URLs are created.
- Added realistic first-class tasks: task-note-linked and standalone rows, nesting,
  built-in and custom status behavior, fixed UTC due/completion dates, member assignees,
  priorities, recurrence/cron, ordering, and task-tag links.
- Added a reusable typed `seedDatabase(db)` function. CLI execution creates the existing
  `pg.Pool`, binds aggregate Drizzle `schema`, writes in one transaction, and closes the
  pool in `finally`.
- Added `assertSafeSeedTarget`: production is always refused; default targets are
  `notted_dev` and explicit `notted_*_test`/`notted_*_review` database names; exceptional non-production use
  requires exactly `ALLOW_UNSAFE_DATABASE_SEED=true` without logging URL credentials.
- Added a DATABASE_URL/reachability-gated integration suite that applies migrations,
  invokes `seedDatabase()` twice in an outer rollback-only transaction, and authors
  idempotency, isolation, roles, and relationship assertions without deleting developer
  rows.

## Important Decisions

- Canonical rows use deterministic UUIDs and fixed UTC timestamps. ID-bearing rows use
  primary-key conflict updates; `note_tags`/`task_tags` use conflict-safe composite-pair
  inserts. User upserts deliberately leave future Better Auth-managed verification and
  two-factor state untouched. The seed neither truncates nor removes arbitrary data.
- A lightweight `to_regclass` probe checks final-schema tables before writes and gives a
  clear migration prerequisite failure. PostgreSQL remains authoritative.
- Seed output is limited to scenario labels and stable counts. It excludes identities,
  note/comment/task content, object keys, connection strings, hashes, credentials, and
  tokens.
- The seed deliberately creates no Better Auth `account`, `session`, `verification`,
  `twoFactor`, or `passkey` rows. Deterministic identities are relational fixtures, not
  login credentials. Part 21 owns supported authentication and development login.
- Operations/integration rows were omitted because they do not improve Part 20 browsing
  and would add unnecessary secret/payload confusion.

## Files and Components

| Path                                                  | Purpose                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api/src/database/seed-fixtures.ts`              | Stable IDs, scenario/identity labels, fixed timestamps, TipTap fixtures, and expected counts  |
| `apps/api/src/database/seed.ts`                       | Transactional idempotent seed function and safe CLI entry point                               |
| `apps/api/test/database.seed.test.ts`                 | Unit fixture/target-safety assertions and gated rollback-only PostgreSQL integration coverage |
| `apps/api/package.json`                               | API `db:seed` command using installed `tsx` and `apps/api/.env`                               |
| `scripts/dev-tooling.mjs`                             | Root `pnpm db:seed` environment validation and API-script routing                             |
| `README.md`                                           | Root quick-start seed command and no-login-credentials boundary                               |
| `docs/README.md`                                      | Exact seed workflow, reseed behavior, scenario labels, and authentication warning             |
| `docs/completed-parts/part-20-realistic-seed-data.md` | This implementation and verification handoff                                                  |

## Database and Data Changes

The development seed adds the following canonical row counts when executed: 6 users, 2
workspaces, 6 memberships, 3 projects, 3 folders, 9 notes, 3 tags, 4 note-tag links, 2
comments, 3 note versions, 1 attachment metadata row, 1 custom task status, 4 tasks, and
2 task-tag links.

The seed now requires migrations `0000`–`0007`. It does not create or apply migrations;
the Phase 3 reviewer fix migration `0007_early_bloodaxe.sql` supplies the Better Auth
conversion, outbox, and note-version uniqueness required by the current schema.

## API, Configuration, and Operational Changes

- API package: `pnpm --filter @notted/api db:seed` runs
  `node --env-file=.env --import tsx src/database/seed.ts`.
- Root: `pnpm db:seed` requires the documented development environment, runs existing
  environment consistency validation, then invokes the API package command.
- Required order: `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:seed`.
- No dependency, environment variable, route, event, queue, port, or feature flag was
  added.

## Security and Tenant-Isolation Notes

- Alpha and Beta use disjoint member sets and tenant-owned relationships; stable IDs are
  exported for direct negative isolation tests.
- Emails use reserved `.test` domains. There are no real people, passwords, password
  hashes, raw API keys, webhook secrets, provider credentials, sessions, verification
  tokens, TOTP secrets, passkeys, auth claims, or sensitive operations payloads.
- Attachment rows are private metadata only. Object keys are opaque and no signed/public
  URL or object byte is generated.
- The seed is platform tooling and intentionally does not establish request tenant
  context. Its complete canonical graph is constrained by existing foreign keys and one
  atomic transaction; application repository scoping remains mandatory in Parts 24+.

## Verification Evidence

| Check                       | Result | Notes                                                                                                                                                     |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed integration suite      | Pass   | Included in the live gate; `seedDatabase()` ran twice transactionally and relationship/isolation assertions passed.                                       |
| API and root command routes | Pass   | Both commands seeded `notted_phase3_review` with identical canonical counts.                                                                              |
| Idempotency                 | Pass   | Two command runs retained 6 users, 2 workspaces, 6 memberships, and 3 unique note versions with no duplicate keys.                                        |
| Safety refusal              | Pass   | `production_review` and all production-mode attempts were rejected before connection; only project-prefixed dev/test/review names are allowed by default. |
| Repository quality          | Pass   | Sequential format, lint, type-check, unit/live tests, build, migration consistency, and audit threshold passed.                                           |

## Known Limitations and Follow-up Work

- UI/API browsing awaits Parts 21+ (authentication, authorization, transports, and
  screens). The complete relationship graph is integration-testable now.
- Seed identities cannot authenticate until Part 21 creates a supported development
  login flow. Do not convert these fixtures into fabricated auth rows.

## Handoff Notes

Do not randomize the exported IDs, dates, scenario labels, or expected counts without
updating the integration assertions and this record. Reseeding may safely restore
canonical fixture fields but must never become a truncate/delete workflow. Preserve the
authentication boundary and migration immutability.

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                  |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-29 | `backend-platform-engineer` | Authored Part 20 implementation; verification remains pending Reviewer #1                                                                                                                                                                               |
| 2026-07-29 | `backend-platform-engineer` | Reviewer #1 fix pass: added seed-target validation and dev/test/review/production/override unit cases; updated fixtures for Better Auth boolean verification and `image`; migration prerequisite is now 0007. Verification remains pending Reviewer #2. |
| 2026-07-29 | Lead                        | Tightened project-prefixed seed allowlisting, verified API/root reseeding and relationship counts, and marked Part 20 Complete.                                                                                                                         |
