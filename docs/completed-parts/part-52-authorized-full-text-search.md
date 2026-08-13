# Part 52 — Authorized full-text search

## Status

- **State:** Complete
- **Completed on:** 2026-08-13
- **Implemented by:** Lead agent with frontend/backend specialists and independent review
- **Plan reference:** `Plan.md`, Part 52
- **Related records:** Parts 51, 53, and 54

## Objective

Provide workspace-scoped, authorized full-text note search with filters, sorting, pagination, suggestions, recent searches, and accessible global and full-page UI.

## Implemented Work

- Added validated REST search and suggestion routes backed by Meilisearch candidates and authoritative PostgreSQL authorization/metadata.
- Added project, author, date, and attachment filters; relevance/date sorting; safe plain-text highlight markers; stable post-authorization pagination; and archived/template labels.
- Added the Cmd/Ctrl+K palette, workspace-local recents, full search page, loading/empty/error/retry states, keyboard navigation, and focused Playwright coverage.
- Corrected the Meilisearch 0.60 adapter to call `index.search(query, options)` and added a live compatibility regression.

## Important Decisions

- Meilisearch is only a candidate source. PostgreSQL remains authoritative for access, title, author, project, archive/template state, and attachment presence.
- Direct note shares do not bypass restricted-project access; canonical `note.read` policy applies.
- Highlight data remains plain text with control-character match markers; no provider HTML reaches the browser.
- Archived and template notes remain searchable and are visibly labelled.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/search/search.controller.ts` | Validated authorized REST transport |
| `apps/api/src/search/search.service.ts` | Search/suggestion orchestration and post-authorization pagination |
| `apps/api/src/search/search-result.repository.ts` | Tenant/access filtering and authoritative result facts |
| `apps/api/src/search/note-index.repository.ts` | Meilisearch candidate queries and safe mapping |
| `apps/web/src/components/search/` | Palette, filters, result states, and full-page search UI |
| `apps/web/e2e/search.spec.ts` | Real-stack keyboard, navigation, result, and empty-state journeys |
| `packages/shared-types/src/search.ts` | Search response contracts |
| `packages/shared-validators/src/search.schema.ts` | Search request validation |

## Database and Data Changes

None. Part 52 consumes Part 51's rebuildable index and existing PostgreSQL data.

## API, Configuration, and Operational Changes

- Added `GET /api/v1/workspaces/:workspaceId/search` and `/search/suggestions`.
- Search remains controlled by the existing Meilisearch configuration and feature flag.

## Security and Tenant-Isolation Notes

Workspace scope is server-proven, provider filters include the workspace ID, and every hit is re-authorized against PostgreSQL before return. Deleted, stale, cross-tenant, and restricted-project candidates are excluded. Queries and content are not logged.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| API Vitest suite | Pass | 1,365 passed, 79 live-gated skipped |
| Web Vitest suite | Pass | 1,356 passed |
| `pnpm e2e:test --grep "search"` | Pass | 4 Chromium journeys |
| `pnpm type-check` | Pass | All workspaces |
| `rtk lint` | Pass | No ESLint issues |
| `pnpm --filter @notted/api build` | Pass | TypeScript build |
| `pnpm --filter @notted/api db:check` | Pass | Migration consistency |

## Known Limitations and Follow-up Work

None known within Part 52 scope.

## Handoff Notes

The Meilisearch SDK's search signature is intentionally represented as separate query/options arguments. Do not collapse it back to one object without changing the pinned provider version and live tests.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-13 | Lead agent | Initial completion record |
