# Completed Parts

This directory is the durable implementation history for the numbered parts in the root [`Plan.md`](../../Plan.md). Its purpose is to let another developer, agent, or later session understand what has actually been built without reconstructing decisions from source code or conversation history.

## Required Workflow

1. Before starting a plan part, read the completion records for all prerequisite parts and inspect any open risks they identify.
2. Implement and verify the selected `Plan.md` part according to its stated requirements and completion criteria.
3. Copy `TEMPLATE.md` to `part-NN-short-name.md`, where `NN` is the zero-padded part number.
4. Replace every placeholder with factual information. Do not claim tests or commands that were not run.
5. If verification was skipped or failed, mark it clearly and do not describe the part as complete.
6. Add later corrections or discoveries to the existing record instead of creating a competing summary.

## Naming and Scope

- Use one primary record per numbered part: `part-01-architecture-decisions.md`, `part-02-monorepo-initialization.md`, and so on through `part-88-post-mvp-delivery.md`.
- Keep the record focused on the implemented part. Link related records rather than copying their content.
- Use repository-relative paths and include migration names, configuration keys, API routes, and important symbols where they help future work.
- Never include passwords, tokens, private keys, connection strings with credentials, personal data, or other secrets.
- A record may be prepared while work is ongoing, but its status must remain `In progress` until every required completion criterion passes.

## Status Values

- `Complete`: all stated completion criteria passed.
- `Complete with follow-up`: the part is usable and verified, but explicitly listed non-blocking work remains.
- `In progress`: implementation or required verification remains.
- `Blocked`: work cannot continue; the blocker and required resolution are recorded.
- `Superseded`: a later decision or implementation replaced this work; link the replacement record.

## Index

Add one row after creating each record. Keep rows ordered by part number.

| Part | Status   | Completed  | Summary                                                                                                                                                                 |
| ---: | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Complete | 2026-07-22 | Architecture boundaries, safe schema defaults, and a strictly resolved compatibility baseline.                                                                          |
|    2 | Complete | 2026-07-22 | pnpm + Turborepo monorepo scaffolding, four canonical workspaces, root task scripts, and strict runtime/package pins.                                                   |
|    3 | Complete | 2026-07-23 | App-scoped Next.js/NestJS + repo-wide TypeScript/a11y/import ESLint, Prettier, fail-on-warning scripts, and optional commit gates.                                      |
|    4 | Complete | 2026-07-27 | Next.js 16 App Router scaffold with canonical styles, minimal client islands, accessibility coverage, production build, and rendered HTTP smoke.                        |
|    5 | Complete | 2026-07-27 | NestJS API scaffold with typed configuration, safe HTTP bootstrap, health endpoints, structured logging, error envelopes, bounded rate limiting, and graceful shutdown. |
|    6 | Complete | 2026-07-24 | Verified framework-neutral shared types and strict Zod validators consumed through API and web package boundaries.                                                      |
|    7 | Complete | 2026-07-27 | Least-privilege SHA-pinned CI, safe coverage artifacts, deterministic builds, real Drizzle consistency, and verified green/failure/reverted-green behavior.             |
|    8 | Complete | 2026-07-27 | Typed API/web/infrastructure environment contracts, safe examples, strict production preflight, dotenv-aware cross-file checks, and contract tests.                     |
|    9 | Complete | 2026-07-27 | Digest/source-pinned healthy development services, internal networking with host loopback access, non-root MinIO, private buckets, volumes, and runtime recovery proof. |
|   10 | Complete | 2026-07-27 | Canonical developer commands, local-daemon guarded reset, legacy-volume recovery guidance, and stepwise onboarding verification.                                        |
|   11 | Complete | 2026-07-27 | Narrow PostgreSQL, Redis, MinIO, Meilisearch, and SMTP clients with bounded lifecycle, coalesced readiness, and live loss/recovery proof.                               |
|   12 | Complete | 2026-07-27 | Drizzle/PostgreSQL providers, transaction helper, immutable extension migration, schema conventions, policy, and empty/pre-existing-data verification.                  |
|   13 | Complete | 2026-07-29 | Better Auth 1.6.24 identity schema with existing users model, database-generated UUID contract, boolean verification plus preserved timestamp, and auth-owned tables.   |
|   14 | Complete | 2026-07-29 | Workspace roots, memberships, invitations, roles, plans, quotas, uniqueness, and tenant-lifecycle foreign keys.                                                         |
|   15 | Complete | 2026-07-29 | Projects, folders, hierarchical notes, ordering, sharing/access grants, and composite cross-workspace foreign keys.                                                     |
|   16 | Complete | 2026-07-29 | Tags, attachment metadata, threaded comments, and uniquely keyed note-version snapshots.                                                                                |
|   17 | Complete | 2026-07-29 | Standalone tasks, custom statuses, nesting, recurrence, assignees, ordering, and task-tag links.                                                                        |
|   18 | Complete | 2026-07-29 | Operations/integration schema including durable job outbox intent and independent worker idempotency.                                                                   |
|   19 | Complete | 2026-07-29 | Repository-layer tenant context, strict pre-SQL guards, all-operation isolation matrices, and retention policy.                                                         |
|   20 | Complete | 2026-07-29 | Deterministic multi-tenant seed fixtures with idempotent writes and production/target-name safety refusal.                                                              |
|   21 | Complete | 2026-07-31 | Better Auth backend, opaque sessions, Redis acceleration, and encrypted durable auth-email delivery verified with live infrastructure. |
|   22 | Complete | 2026-07-31 | Accessible auth screens, safe redirects, server route protection, logout, and critical Chromium journeys verified. |
|   23 | Complete | 2026-07-31 | Optional OAuth, TOTP/recovery, passkeys, remember-me, recent authentication, and safe session controls verified. |
|   24 | Complete | 2026-07-31 | Central authorization policy, tenant-scoped facts, shared adapters, and cross-tenant denial verified. |
|   25 | Complete | 2026-07-31 | Responsive shell, server-validated workspace selection, persistent notifications, migration, accessibility, and browser journeys verified. |
|   26 | Complete | 2026-08-01 | Verified REST/tRPC workspace lifecycle with replay-safe creation, atomic owner membership, tenant authorization, durable deletion audit, and cleanup intent. |
|   27 | Complete | 2026-08-01 | Accessible workspace list/create, overview, settings, switching, permission states, and real-stack Chromium lifecycle/isolation journeys. |
|   28 | Complete | 2026-08-01 | Verified membership and single-use invitation lifecycle with role/last-owner safety, durable queued email delivery, acceptance UI, and audit evidence. |
|   29 | Complete | 2026-08-01 | Tenant-scoped project CRUD, filtering, lifecycle transitions, cover authorization, replay safety, durable domain events, and note/task preservation. |
|   30 | Complete | 2026-08-02 | Project list/detail UI, read projection, durable restriction state; Review #2: a11y, type-check, lint, integration all pass. |
|   31 | Complete | 2026-08-02 | Transactional note/folder APIs, deletion batches, safe cascade, versioned renormalization, index/concurrency artifacts; Review #2: calculatePosition fix, planner assertions, all gates pass. |
|   32 | Complete | 2026-08-02 | Note hierarchy/sharing UI, DnD, folders/trash, authenticated sharing, rollback injection; Review #2: a11y, clipboard race, keyboard DnD, focus mgmt, all gates pass. |
|   33 | Complete | 2026-08-03 | Versioned TipTap allow-list, bounded migration, safe URL/plain/HTML helpers, exact headless extensions, and verified ProseMirror round-trips. |
|   34 | Complete | 2026-08-03 | TipTap editor and roving-tabindex toolbar, drift-proof shortcut table and help dialog, sanitized link/colour dialogs, remount restoration; Review #2: ARIA and duplicate-render fixes, all gates pass. |
|   35 | Complete | 2026-08-03 | Table contract widening with bounds, resizable tables, restored nested checklists, lowlight code blocks, markdown rules, single Tab authority; Review #2: Table keymap strip fix, split-cell guard, all gates pass. |
|   36 | Complete | 2026-08-03 | Mention node contract, slash command menu, workspace-scoped mentions with removed-user fallback, shared suggestion popover; Review #2: member pagination and lazy directory fetch, all gates pass. |

## Cross-cutting records

Work that is not a numbered `Plan.md` part. Keep rows ordered by date.

| Record | Status | Completed | Summary |
| --- | -------- | ---------- | ------- |
| [Coverage remediation](coverage-remediation-2026-08-04.md) | Complete | 2026-08-04 | Made `pnpm test:ci` pass in all four workspaces: CI Postgres service plus the `turbo.json` env declaration that makes it effective, serialized DB suites, fixed a leaking concurrency fixture, fixed the archived-notes list query, and covered `src/lib`, the auth service/controller, and the shared route builders. |
| [All-in-Docker development](all-in-docker-development-2026-08-04.md) | Complete | 2026-08-04 | Replaced the infrastructure-only Compose stack with a root `compose.yaml` that runs infrastructure and both applications, so `docker compose up` is the only setup command, and cut the published port surface from nine to three (3000, 3001, 8025). Verified from a clean state, including registration through Mailpit email verification to an authenticated session. |
