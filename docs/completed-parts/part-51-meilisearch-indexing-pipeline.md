# Part 51 — Meilisearch indexing pipeline

## Status

- **State:** Complete
- **Completed on:** 2026-08-12
- **Plan reference:** `Plan.md`, Part 51
- **Verification:** Passed, including fresh PostgreSQL migration, isolated PostgreSQL + Meilisearch drift repair, and the real guarded reindex CLI.

## Objective and current result

PostgreSQL remains authoritative and Meilisearch is a versioned, disposable projection. Tasks 51.1–51.3 define the document/settings contract, authoritative projection reads, idempotent queue consumers, and transactionally emitted mutation intents. Task 51.4 adds bounded tenant-aware repair through `NoteReindexService.reindexWorkspace(workspaceId)` and the explicit platform operation `NoteReindexService.reindexAllWorkspaces()`.

Part 51 is complete. Independent review ran twice around one bounded remediation pass; the lead fixed the final dedicated-CLI runtime defect and ran the complete applicable gate.

## Index and document contract

- UID: `${MEILISEARCH_INDEX_PREFIX}notes_v1`; primary key `id`. Development defaults to `notted_dev_notes_v1`, tests to `notted_test_notes_v1`, and the Compose e2e profile explicitly uses `notted_e2e_notes_v1`.
- Document: UUID `id`, bounded `title`, bounded plain `content`, bounded tag-name array, UUID `workspaceId`, nullable UUID `projectId`, UUID `authorId`, UTC epoch-millisecond `createdAt`/`updatedAt`, and boolean `hasAttachments`.
- PostgreSQL projection includes every non-deleted note, including archived notes and templates. `hasAttachments` is true only for `ready` attachment rows.
- Searchable attributes, in order: `title`, `tags`, `content`.
- Filterable attributes: `workspaceId`, `projectId`, `authorId`, `createdAt`, `updatedAt`, `hasAttachments`.
- Sortable attributes: `createdAt`, `updatedAt`.
- Displayed attributes: `id`, `title`, `content`, `tags`, `workspaceId`, `projectId`, `authorId`, `createdAt`, `updatedAt`, `hasAttachments`.
- Ranking rules: `words`, `typo`, `proximity`, `attribute`, `sort`, `exactness`.
- Typo tolerance is enabled; one typo begins at 4 characters and two at 8, with no disabled words or attributes.

## Producer mutation matrix

All `note.search.sync` intents are written in the same PostgreSQL transaction as the authoritative mutation and dispatched only after commit by Part 50 infrastructure.

| Producer area | Mutations covered |
|---|---|
| Notes | create/copy, title/content/settings update, move/reparent/reorder, archive/template/pin state changes represented by update, subtree soft delete, subtree restore, permanent delete. Folders themselves are not indexed documents; folder operations emit sync only for affected notes. |
| Tags | assignment/removal and tag rename/delete for affected notes |
| Attachments | upload and deletion, plus an actual transition into or out of `ready`. A processing failure does not flip `hasAttachments` when the note's ready-attachment set did not change. |
| Projects | project deletion/nullification of affected note `projectId` values |
| Workspaces | a dedicated `workspace.search.purge` intent, committed beside `workspace.deleted`, purges all documents carrying that workspace UUID without consuming the completed generic cleanup concern |

Consumers always re-read current PostgreSQL state. Duplicate or out-of-order intents therefore upsert the latest live projection or delete an absent/soft-deleted ID rather than replaying event content.

## Reindex and tenant security

- `reindexWorkspace` validates a UUID, establishes a callback-bounded system tenant context, ensures the versioned index/settings, keyset-pages PostgreSQL by `(updatedAt,id)` in batches of 500 under a stable start boundary, and upserts each page.
- Stale detection requests only `id` from Meilisearch under the validated filter `workspaceId = "<uuid>"`. It never enumerates or deletes another workspace's IDs. UUID validation is the filter-escaping boundary.
- Candidate stale IDs are re-read under tenant scope immediately before deletion, and deleted IDs are re-read after deletion to close a concurrent delete/recreate race. Every operation is idempotent; interruption leaves a partial projection that a rerun repairs.
- `reindexAllWorkspaces` is a separately named explicit operation. It keyset-pages authoritative workspace UUIDs, reindexes each sequentially, then requests only `id`/`workspaceId` from the index, checks workspace existence in bounded PostgreSQL batches, and filter-purges only orphan workspace UUIDs. It never resets or drops an index.
- Concurrent mutations continue to emit incremental jobs. A commit before a stale delete is protected by authoritative rechecks; a commit after the final check carries a post-commit incremental job. Provider upserts have no compare-and-swap, so an interruption or an extreme old-upsert/new-job race may require the durable incremental delivery or a rerun for eventual convergence.
- Disabled search is a safe no-op result with zero counts; no database or provider work is attempted.

## Operational command

- One tenant: `pnpm --filter @notted/api search:reindex -- --workspace-id <uuid>`
- All tenants: `pnpm --filter @notted/api search:reindex -- --all`
- Production requires the exact configured target as an additional guard: `--confirm-production <configured-index-uid>` (for example `notted_prod_notes_v1`). Missing, conflicting, duplicate, malformed, and unknown options fail before the Nest application context starts.
- The command creates a dedicated CLI Nest context containing config/common/database/tenant/Meilisearch/reindex providers only. It does not initialize AppModule, QueueLifecycle/workers, schedulers, auth, or HTTP. It always closes the context in `finally` and prints only safe identifiers/counts.

## Prefix isolation, rollback, and rebuild

Development and e2e use different validated prefixes. Production configuration rejects names containing development/test/e2e markers. Operators must confirm the exact production UID at invocation.

No schema migration or persistent PostgreSQL change is part of Task 51.4. Rollback is to stop invoking the command and revert the service/repository/CLI source; incremental indexing remains available. Recovery never requires deleting PostgreSQL data. If projection correctness is uncertain, rerun the tenant command or explicit `--all`; do not drop the index as an operational shortcut. A future index-contract incompatibility must use a new versioned UID and reviewed cutover.

## Files and test source

- `apps/api/src/search/note-reindex.service.ts`: tenant/all-workspace repair orchestration.
- `apps/api/src/search/workspace-search.repository.ts`: bounded platform enumeration of workspace UUIDs only.
- `apps/api/src/search/note-index.repository.ts` and Meilisearch tokens/service: filtered ID/workspace-reference pages.
- `apps/api/scripts/search-reindex.ts` and `apps/api/package.json`: guarded no-listener CLI and package script.
- Search/Meilisearch/database providers use explicit class-token injection where the `tsx` CLI graph cannot rely on emitted decorator metadata.
- `apps/api/src/search/{note-reindex.service,search-reindex-cli}.test.ts`: parser, pagination, interruption/rerun, concurrent candidate behavior, orphan cleanup, and disabled-mode source.
- `apps/api/test/search-reindex.integration.test.ts`: isolated-prefix drift-repair integration source.

## Known limitations

- Meilisearch has no transactional snapshot shared with PostgreSQL and no conditional update by `updatedAt`. The stable PostgreSQL scan boundary and keyset cursor avoid mutable offsets; durable incremental jobs plus idempotent reruns provide eventual, not atomic, convergence for changes after the boundary.
- `--all` intentionally runs workspaces sequentially to keep provider/database pressure bounded; large installations may need resumable checkpoints/metrics in a later operations part.
- Search query APIs, authorization of returned hits, highlights, recent searches, UI, embeddings, and semantic/hybrid ranking are explicitly outside Part 51 (Parts 52–54).

## Revision history

| Date | Change |
|---|---|
| 2026-08-11 | Task 51.4 draft: bounded reindex service, guarded CLI, orphan cleanup, and unexecuted test source. |
| 2026-08-12 | Completed after two independent reviews, final remediation, isolated live drift-repair verification, successful guarded CLI execution, and the full repository gate. |

## Commands

- Fresh disposable PostgreSQL: `pnpm --filter @notted/api db:migrate` — all migrations applied successfully.
- Isolated PostgreSQL + Meilisearch + Redis: `pnpm --filter @notted/api exec vitest run test/search-reindex.integration.test.ts` — passed; deliberate create/edit/tag/move/delete/attachment drift converged without changing the control tenant.
- Same disposable PostgreSQL + Meilisearch: `pnpm --filter @notted/api search:reindex -- --all` — completed through the dedicated CLI context and closed cleanly.
- Focused search, Meilisearch, and database-readiness suite — 39 passed; the separately gated live test was then run and passed.
- `pnpm test` — passed all six repository tasks; API: 1,285 passed and 74 infrastructure-gated tests skipped. The Part 51 gated integration was run separately above.
- `pnpm format:check`, `rtk lint`, `pnpm type-check`, `pnpm --filter @notted/api db:check`, and `pnpm --filter @notted/api build` — passed.
- Independent quality review, bounded remediation, and fresh second review — completed; remaining findings were resolved by the lead before the final gate.
