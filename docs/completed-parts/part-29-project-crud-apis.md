# Part 29 — Implement project CRUD APIs

## Status

- **State:** Complete
- **Completed on:** 2026-08-01
- **Implemented by:** Phase 5 Parts 26–29 coordinated delivery session
- **Plan reference:** `Plan.md`, Part 29
- **Related records:** Parts 15, 18, 19, 24, 26

## Objective

Provide tenant-scoped project pagination, filtering, sorting, create/read/update, lifecycle transitions, and deletion with validated cover references, authorization, audit records, and durable domain events.

## Implemented Work

- Added shared project list/create/update/result schemas, types, statuses, sorting fields, and REST paths.
- Added `ProjectsService` and thin REST endpoints for list, create, read, update, archive, complete, restore, and delete.
- Supports bounded pagination; status, archive, due-date, and escaped-name filters; and stable sorting.
- Keeps `status` and `isArchived` synchronized across transitions.
- Validates colors, dates, and app-relative attachment cover references; covers must resolve to a ready attachment in the active workspace.
- Filters restricted projects before pagination for editor/viewer roles while owner/admin roles retain workspace-wide visibility.
- Makes create replay-safe with durable hash-only idempotency records.
- Atomically writes each mutation, audit row, and identifier-only project-domain outbox event.
- On deletion, nullifies tenant-scoped note/task project links before deleting the project so those records survive.

## Important Decisions

- Project-domain events are durable outbox contracts for later search/webhook consumers; no later-part consumer was implemented here.
- Deleting a project preserves its notes and tasks as workspace-level records instead of cascading user content.
- Cover references are authorized application attachment paths, not arbitrary remote URLs.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/projects/` | Project service, REST controller, constants, module, and tests |
| `packages/shared-validators/src/project.schema.ts` | Project validation contracts |
| `packages/shared-types/src/project.ts` | Project types, statuses, results, and REST paths |
| `apps/api/src/common/idempotency/` | Durable project-create replay support |

## Database and Data Changes

No project-table migration. Project creation uses the Part 26 `api_idempotency_records` migration; existing projects, notes, tasks, attachments, project-access, audit, and outbox tables provide the remaining storage.

## API, Configuration, and Operational Changes

- `GET/POST /api/v1/workspaces/:workspaceId/projects`
- `GET/PATCH/DELETE /api/v1/workspaces/:workspaceId/projects/:projectId`
- `POST .../:projectId/archive`, `.../complete`, and `.../restore`
- Project creation requires `Idempotency-Key`.
- Emits version-1 `project.created`, `project.updated`, `project.archived`, `project.completed`, `project.restored`, and `project.deleted` intents to `project-domain-events`.

## Security and Tenant-Isolation Notes

- Every operation enters centralized authorization and then executes tenant-filtered SQL.
- Project access restrictions are applied in SQL before pagination, preventing hidden rows from affecting pages or counts.
- Cross-workspace covers and project selectors are rejected/concealed; mutations require trusted origins.
- Audit/outbox events contain identifiers and changed-field metadata, not project content.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Shared project validator tests | Pass | Included in 32 passing focused shared-validator tests |
| Focused project service/controller suites | Pass | Included in 49 passing focused Parts 26/28/29 API tests |
| Disposable PostgreSQL integration | Pass | Included in 12 live tests covering authorization, tenant isolation, pagination, and persistence invariants |
| Project note/task deletion regression | Pass | Unit test proves scoped links are nullified before audit/outbox/project deletion |
| `DATABASE_URL=<disposable> pnpm test` | Pass | Repository suites passed; API reported 562 passed with 3 unrelated infrastructure-dependent skips |
| `pnpm format:check` / `pnpm lint` / `pnpm type-check` | Pass | Repository-wide static gates passed |
| `pnpm db:check` / `pnpm build` | Pass | Drizzle consistency and production compilation passed |

## Known Limitations and Follow-up Work

- Search, webhook, and other consumers of `project-domain-events` are owned by later parts.
- Project list/detail screens are owned by Part 30.

## Handoff Notes

- Preserve the status/`isArchived` mirror and note/task preservation behavior in future project changes.
- Keep access predicates before pagination and route all new transports through `ProjectsService`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Coordinated delivery session | Implemented and verified project CRUD and lifecycle APIs |
