# Part 55 — Version snapshots and retention

## Status

- **State:** Complete
- **Date:** 2026-08-13
- **Plan reference:** `Plan.md`, Part 55

## Result

Accepted post-save snapshots now persist atomically for create/copy v1 and each
successful `NotesService.update`. Failed optimistic concurrency and structural
move/trash/delete/folder mutations do not write history. The persistence seam
proves the note parent belongs to the active workspace in the caller's
transaction because `note_versions` has no direct `workspace_id`.

Collaborative cadence is a pure Part 58 seam: five minutes by default, with
forced checkpoints at durable persistence/compaction and orderly final-room
shutdown boundaries. No Yjs, Socket.io, presence, comments, or UI was added.

Plan-aware retention runs through a durable PostgreSQL outbox intent and the
existing maintenance BullMQ lane. Each run is bounded and oldest-first, retains
the minimum version, maximum version, and checkpoint matching `notes.version`,
purges only finite plan windows, and rechecks cutoff/plan/protections atomically
in the DELETE. Pro and Enterprise default to unlimited.

## Files and architecture

- `apps/api/src/notes/note-version-checkpoint.policy.ts`: collaborative cadence
  and non-collaborative eligibility policy.
- `apps/api/src/notes/note-versions.service.ts`: narrow transaction-scoped,
  tenant-safe append seam.
- `apps/api/src/notes/notes.service.ts`: create/copy/update transaction wiring.
- `apps/api/src/maintenance/note-version-retention*.ts`: bounded purge,
  durable scheduler, and maintenance handler.
- `apps/api/src/queue/{job-identifiers,job-registry}.ts`: strict unscoped system
  job contract on `notted-maintenance`.
- `apps/api/test/note-versions.integration.test.ts`: DATABASE_URL-gated live
  coverage source.

## Migration

Generated forward migration `0018_quick_purifiers.sql` adds the non-unique
`note_versions_retention_scan_idx(created_at,id)` index used by the stable global
retention scan. It changes no rows or constraints. Index creation scans and may
briefly lock the table; schedule production application appropriately. Rollback
is a reviewed forward migration dropping only that index after retention scans
are disabled or accepted without it. No deployed migration was edited and the
migration was applied successfully to disposable PostgreSQL during verification; it was not applied
to any persistent or production database.

## Tests authored and verification

Policy, persistence, NotesService, retention, scheduler/handler, job-contract,
and DATABASE_URL-gated integration coverage now passes. The live PostgreSQL
suite passed 3/3 and proves transactional snapshot visibility, protected
retention boundaries, immutable history, and restore behavior. Repository-wide
tests passed (API 1,412; web 1,372; tooling 19), as did type-check, lint,
formatting, production build, and production dependency audit.

The stale Part 50 live enum assertions in
`operations-integration-schema.test.ts` were corrected in an explicitly expanded
corrective pass. The full repository coverage command then passed all six tasks,
including 1,477 API tests and all configured thresholds. All completion criteria
for this part now pass.

## Limits and follow-up

- Part 58 owns Yjs state, projection/version mapping, and invocation of the
  collaborative checkpoint seam.
- Part 56 owns history reads, diff, restore, and UI; no convenience read API was
  exposed early here.
- Retention logs contain only reason/count/batches/duration; no workspace IDs,
  note IDs, titles, content, or personal data.
- Reviewer #1's retention SQL-inspection and live transaction-visibility findings were remediated and verified: tests render Drizzle SQL through `PgDialect` and bind retention to the fixture transaction.
- No unresolved Part 55 completion blocker remains.
