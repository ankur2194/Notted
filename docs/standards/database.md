# Database Standard

- Use UUID keys, timezone-aware timestamps, explicit deletion behavior, and evidence-based indexes.
- Every tenant-owned table carries or derives a workspace boundary; every operation proves it.
- Enforce invariants with database constraints plus service rules where needed.
- Use transactions, optimistic concurrency where appropriate, and specified soft deletion.
- Generate and review a migration for every schema change; never edit a deployed migration.
- Record backfill, locking, compatibility, rollback, retention, and seed impact.
- Test empty and upgrade migrations, constraints, cascades, and cross-tenant denial.
