# Part 54 — Hybrid ranking

## Status

- **State:** Complete
- **Completed on:** 2026-08-13
- **Implemented by:** Lead agent with backend specialist and independent review
- **Plan reference:** `Plan.md`, Part 54
- **Related records:** Parts 52 and 53

## Objective

Combine lexical relevance and vector similarity into deterministic, tunable hybrid search while retaining safe text-only fallback.

## Implemented Work

- Added normalized lexical/vector score fusion with documented weights and a deterministic note-ID tie-breaker.
- Added stable candidate windows deep enough for requested pages and post-authorization pagination.
- Added provider-outage and unconfigured-provider text-only fallback.
- Added count/latency/fallback diagnostics without exposing scores or query/content data to users or logs.
- Added curated exact-term, typo, conceptual, fallback, authorization, and later-page regressions.

## Important Decisions

- Candidate depth includes `pageOffset + limit + 1` and is bounded at 200.
- Scores remain internal; public result contracts expose availability/fallback but not ranking internals.
- Full-text remains usable whenever semantic search is unavailable.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/search/hybrid-ranking.service.ts` | Score normalization, weighting, and tie-breaking |
| `apps/api/src/search/hybrid-search.service.ts` | Candidate collection, authorization, pagination, and fallback |
| `apps/api/src/search/test-fixtures/hybrid-ranking.fixture.ts` | Curated relevance expectations |
| `apps/api/src/search/hybrid-search.integration.test.ts` | Provider/tenant integration coverage |
| `apps/api/src/search/hybrid-search.service.test.ts` | Deep-page, fallback, and authorization regressions |

## Database and Data Changes

None beyond Part 53's rebuildable embedding projection.

## API, Configuration, and Operational Changes

Hybrid mode is available through the Part 52 search route. Diagnostics are structured count/latency/fallback fields only.

## Security and Tenant-Isolation Notes

Both candidate sources are workspace-scoped and the merged candidates are authorized against PostgreSQL before pagination/return. Internal scores, query text, snippets, and note content are not logged or exposed.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| API Vitest suite | Pass | 1,365 passed, 79 live-gated skipped; curated hybrid and pagination tests included |
| `pnpm type-check` | Pass | All workspaces |
| `rtk lint` | Pass | No ESLint issues |
| `pnpm --filter @notted/api build` | Pass | TypeScript build |
| `pnpm --filter @notted/api db:check` | Pass | Migration consistency |

## Known Limitations and Follow-up Work

The 200-candidate safety cap intentionally bounds cost; ranking beyond that provider window is not considered.

## Handoff Notes

Tune weights only against reviewed fixtures and production-safe aggregate diagnostics; preserve deterministic tie-breaking and post-authorization pagination.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-13 | Lead agent | Initial completion record |
| 2026-08-13 | Lead agent | Independent final review (post-critical Meilisearch 0.60 fix) returned PASS. Removed a provably-safe non-null assertion in `hybrid-search.service.ts` by threading the authorized fact through a type-guarded filter; re-ran hybrid tests and API type-check. |
