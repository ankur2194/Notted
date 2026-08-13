# Part 53 — Embeddings and semantic search

## Status

- **State:** Complete
- **Completed on:** 2026-08-13
- **Implemented by:** Lead agent with backend specialist and independent review
- **Plan reference:** `Plan.md`, Part 53
- **Related records:** Parts 51, 52, and 54

## Objective

Add provider-neutral embeddings, durable generation after note changes, stale-vector detection/rebuild, and tenant-scoped semantic search with safe provider-disabled behavior.

## Implemented Work

- Added a provider-neutral embedding contract and an OpenAI-compatible adapter with validated configuration and bounded requests.
- Added deterministic content extraction/truncation and SHA-256 source hashes.
- Added transactional embedding intents, BullMQ handling, idempotent current-truth projection updates, and a guarded reindex CLI.
- Added fixed-dimension pgvector storage/query behavior and semantic search that authorizes candidates before pagination.
- Added clean provider-unavailable fallback when embeddings are not configured or fail.

## Important Decisions

- Embeddings use a fixed `vector(1536)` contract; incompatible configured dimensions fail before query execution.
- Long content is deterministically truncated rather than chunked, making source hashes and rebuilds stable.
- PostgreSQL is authoritative; vectors are rebuildable projections identified by model, dimension, and content hash.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/infrastructure/embeddings/` | Provider contract, module, and OpenAI-compatible adapter |
| `apps/api/src/search/embedding-source.ts` | Deterministic source text and hashing |
| `apps/api/src/search/note-embedding-producer.ts` | Transactional durable intent producer |
| `apps/api/src/search/note-embedding-job-handler.service.ts` | Idempotent embedding worker |
| `apps/api/src/search/note-embedding.repository.ts` | Vector projection persistence |
| `apps/api/src/search/semantic-search.repository.ts` | Tenant-scoped cosine candidate query |
| `apps/api/src/search/semantic-search.service.ts` | Provider, authorization, fallback, and pagination orchestration |
| `apps/api/scripts/embedding-reindex.ts` | Guarded rebuild command |

## Database and Data Changes

Uses the existing pgvector-enabled schema and fixed 1,536-dimension embedding projection introduced with this work. Embeddings are safely rebuildable; the CLI repairs missing/stale rows.

## API, Configuration, and Operational Changes

- Semantic mode is available through the Part 52 search route.
- Added embedding provider/model/base URL/key/dimension and bounded timeout/input configuration documented in `.env.example`.
- Added the embedding reindex package command and AI queue job registration.

## Security and Tenant-Isolation Notes

Vector SQL includes workspace scope before ranking, and all candidates pass the same authoritative `note.read` policy as full-text search. Provider failures are collapsed to safe availability states, and content, vectors, credentials, and queries are excluded from logs.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| API Vitest suite | Pass | 1,365 passed, 79 live-gated skipped; embedding unit/integration coverage included |
| `pnpm type-check` | Pass | All workspaces |
| `rtk lint` | Pass | No ESLint issues |
| `pnpm --filter @notted/api build` | Pass | TypeScript build |
| `pnpm --filter @notted/api db:check` | Pass | Migration consistency |

## Known Limitations and Follow-up Work

Semantic quality depends on an operator-configured compatible provider; absence or outage intentionally falls back without exposing provider details.

## Handoff Notes

Changing model dimension requires an explicit schema/model migration and rebuild; runtime configuration alone must not alter the fixed vector width.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-13 | Lead agent | Initial completion record |
