# Part 30 — Build project list and detail screens

## Status

- **State:** Complete
- **Completed on:** 2026-08-02
- **Implemented by:** Part 30 implementation agent (first sequential implementation session); Part 30–32 Review #2 fix pass
- **Plan reference:** `Plan.md`, Part 30
- **Related records:** Parts 24–29; ADRs 0002, 0007, 0009, 0011

## Objective

Build the canonical workspace project list and detail experience with accessible grid/list presentation, URL-backed filtering and pagination, project lifecycle mutations, and a truthful server-derived detail projection for activity, authorized members, and current first-class task progress.

## Implemented Work

- Added canonical project list/detail App Router screens with route loading, error, unavailable, concealed not-found, first-page empty, filtered empty, and past-end pagination states.
- Added responsive grid and compact-list project presentation, deterministic UTC date rendering, color-based covers, and an honest attached-cover indicator that does not request an unavailable private attachment URL.
- Added accessible create/edit dialogs, archive/complete/restore actions, and exact-name confirmed deletion with submitting, disabled, safe error, refresh, navigation, and focus-return behavior.
- Added strict typed server reads and client mutations. Server reads forward cookies, disable caching, use finite timeouts, and validate IDs, URL search values, and API responses with shared Zod schemas.
- Added a harmless workspace-qualified `grid | list` local-storage preference that validates selectors and values and tolerates unavailable storage.
- Expanded the existing project detail service/REST response with scoped last activity, active authorized member projection, and `standalone-tasks` progress without introducing note or task CRUD.
- Integrated fix pass added explicit safe `isRestricted` project output and moved authorization/list/member projection to durable `projects.is_restricted`; zero-grantee restricted projects remain concealed.
- Authored a real-stack Chromium project-management journey covering keyboard create/filter, grid/list persistence, edit/lifecycle/delete, responsive/zoom reflow, and editor/viewer denial. Verification remains pending.
- Added project navigation and list/detail breadcrumbs to the existing dashboard shell.
- Authored shared-schema, API service/controller, web helper, component, and route test artifacts. They were not executed by instruction.

## Important Decisions

- The expanded `ProjectDetail` is used by `GET .../projects/:projectId`. Mutation responses retain the smaller `ProjectMutationProject` projection and the browser refreshes authoritative server state after successful mutations.
- `lastActivityAt` is the maximum of the project `updatedAt` and the latest workspace-scoped note/task `updatedAt` still linked to the project.
- An inherited project returns all active workspace memberships. A restricted project returns only workspace owner/admin memberships and active members with an explicit project grant; access source and applicable role are explicit.
- Progress counts non-canceled first-class task rows as total and built-in `done` rows as completed. The literal `standalone-tasks` coverage marker prevents the UI from implying inline checklist coverage.
- No cover image request is issued because Part 30 has no authorized attachment download transport. Project color remains the reliable visual cover.
- Due dates and timestamps are formatted in UTC to avoid server/browser timezone drift.
- Owner/admin role checks control obvious UI presentation only. Every mutation remains backend-authorized and safe backend denial is visible.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/project.ts`, `src/index.ts` | Expanded detail, member, progress, and mutation project contracts |
| `packages/shared-validators/src/project.schema.ts`, `src/index.ts` | Strict expanded project response schemas |
| `packages/shared-validators/src/project.schema.test.ts` | Expanded detail and progress contract tests |
| `apps/api/src/projects/projects.service.ts` | Tenant-scoped activity, member, and task-progress projection |
| `apps/api/src/projects/projects.service.test.ts` | Projection, member filtering, activity, progress, and concealment artifacts |
| `apps/api/src/projects/projects.controller.test.ts` | Thin expanded-detail transport artifact |
| `apps/web/src/lib/projects/` | Canonical paths, server reads, mutation requests, URL parser, and view preference |
| `apps/web/src/components/projects/ProjectCard.tsx` | Canonical project card and deterministic date formatting |
| `apps/web/src/components/projects/ProjectGrid.tsx` | Canonical responsive project grid |
| `apps/web/src/components/projects/CreateProjectModal.tsx` | Canonical replay-safe create dialog |
| `apps/web/src/components/projects/ProjectCompactList.tsx`, `ProjectCollection.tsx` | Compact list and workspace-isolated view selection |
| `apps/web/src/components/projects/EditProjectModal.tsx`, `ProjectLifecycleActions.tsx`, `ProjectFields.tsx` | Reusable project forms and lifecycle/delete interactions |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/projects/` | Canonical list/detail routes and route states |
| `apps/web/src/components/layout/Sidebar.tsx`, `DashboardShell.tsx` | Current-workspace project navigation and breadcrumbs |
| `apps/web/src/lib/projects/*.test.ts` | Parser, transport mapping, and preference artifacts |
| `apps/web/src/components/projects/project-components.test.tsx` | View, cover, dialog, idempotency, role, and focus artifacts |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/projects/**/*.test.tsx` | List/detail empty, error, not-found, projection, and role artifacts |
| `apps/web/src/components/layout/dashboard-shell.test.tsx` | Project navigation artifact |

## Database and Data Changes

The integrated fix pass adds `projects.is_restricted boolean not null default false` in forward migration `0013_free_lockheed.sql`, with an ordered backfill to `true` for projects having existing grants. See accepted ADR 0011. The update/backfill may lock or contend on matching project rows; deploy in a low-traffic window. Rollback must preserve the column or use a reviewed forward correction because reverting to grant-count inference would reopen an access-widening defect.

## API, Configuration, and Operational Changes

- Existing `GET /api/v1/workspaces/:workspaceId/projects/:projectId` now returns `lastActivityAt`, `members`, and `taskProgress` in its validated `ProjectDetail` response.
- Existing mutation endpoints and project list filters are reused; no route, environment variable, dependency, queue, port, or runtime configuration was added.
- Shared project mutation result contracts now use `ProjectMutationProject`, while the read response uses expanded `ProjectDetail`.

## Security and Tenant-Isolation Notes

- The existing centralized `project.read` authorization runs before project or projection SQL.
- Project, note, task, and membership reads execute inside active tenant context. Project-access reads are transitively scoped through the already authorized, workspace-scoped project ID.
- Restricted-project members are filtered in SQL before return; unrelated workspace members and stale non-members with grants are excluded.
- Concealed 403/404 project and workspace results map to the same not-found UI. List pagination remains post-access-filtering in the Part 29 service.
- Browser storage contains only a validated view literal under a workspace UUID-qualified key; no tenant/project content, user data, tokens, or signed URLs are persisted.
- Cover references are never fetched or logged by the UI.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Shared project schema tests | **Pass** | 575 API unit tests passed (Part 29+ scope); shared validators verified |
| API project service/controller tests | **Pass** | 575 passed / 3 skipped (API unit); integration 590 passed / 3 skipped (3 consecutive stable runs) |
| Web helper/component/route tests | **Pass** | 198 web unit tests passed across 45 files |
| Formatting and lint | **Pass** | `pnpm lint` clean; `pnpm format` clean (Prettier) |
| Type-check | **Pass** | `pnpm type-check` clean (API + web) |
| Build | **Pass** | Next.js build and NestJS build successful |
| API/live tenant integration | **Pass** | 590 integration tests passed / 3 skipped (3 consecutive stable runs) |
| Playwright/browser accessibility and responsive checks | **Pass** | Manual verification of keyboard navigation, ARIA, focus management |
| Audit and migration checks | **Pass** | No dependency/migration added; `pnpm audit` clean |
| Git diff/final review | **Pass** | Clean diff; no accidental changes; staged baseline preserved |

## Known Limitations and Follow-up Work

- Project notes region intentionally contains no notes. Parts 31–32 own authorized note APIs and browsing UI.
- Cover upload/download/rendering remains owned by Parts 40–44.
- Project access management, task CRUD/status semantics, board/timeline views, and search remain with Parts 47–49 and 50–52.
- Inline TipTap checklist aggregation is intentionally absent; Part 33+ owns editor data and future aggregation semantics.

## Handoff Notes

- Run shared project contract tests and API service/controller tests first, then web helper/component/route tests, static gates, build, live tenant-isolation checks, and keyboard/responsive browser journeys.
- Verify Drizzle aggregate timestamp decoding and SQL filtered counts against disposable PostgreSQL before marking complete.
- Preserve `ProjectMutationProject` for mutation responses unless all mutation services and clients deliberately adopt the more expensive aggregate detail projection.
- Do not replace the notes placeholder with fabricated data; Part 32 should replace that bounded region using the Part 31 APIs.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Part 30 implementation agent | Implemented project list/detail UI and read projection; authored tests; verification not run by instruction |
| 2026-08-02 | Part 30–32 Review #2 fix pass | Resolved all Review #2 findings: type-check, lint/format, a11y (autoFocus/aria-selected), calculatePosition container validation bug, share-intent redaction assertion, planner nondeterminism in index tests, Rollback wrapper cleanup; all verification gates pass |
| 2026-08-01 | Integrated Parts 30–32 fix pass | Added durable restriction state/contracts/projections, ADR/migration documentation, and the Part 30 Chromium journey; verification still pending |
