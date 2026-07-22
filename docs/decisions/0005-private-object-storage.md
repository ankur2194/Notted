# ADR 0005: Store private binaries in MinIO with PostgreSQL metadata

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 16, 18, 40-45, 54-58, 63, 80, 83

## Context

Notted stores user uploads, processed image variants, and generated exports. PostgreSQL and S3-compatible object storage cannot participate in one atomic transaction, while filenames, signed URLs, and tenant-derived paths can create disclosure, traversal, overwrite, and cleanup risks.

## Decision

PostgreSQL is authoritative for attachment/export identity, ownership, workspace scope, object state, metadata, quota accounting, and retention intent. MinIO stores binary bytes only. Buckets are private, infrastructure endpoints are not public, and no anonymous object URL is persisted as application data.

Object keys are generated server-side, normalized, opaque, and immutable. They include a workspace partition for operations but authorization never relies on the path alone. Keys use stable resource IDs and random values rather than raw user filenames or timestamps as uniqueness guarantees. Original filenames are sanitized metadata used only for display and an encoded download disposition.

All upload, read, download, transform, delete, and export operations authenticate the actor and authorize the database record within its workspace before issuing storage access. Downloads use authorized streaming or narrowly scoped, short-lived signed URLs. Signed URLs are bearer secrets and are excluded from logs, analytics, caches, and persisted document content.

Uploads enforce configured byte limits before and during transfer, quota reservations, MIME sniffing, permitted decoder/archive behavior, and safe filenames. Untrusted active content is not served inline without sanitization or rasterization and a restrictive content disposition. Processing produces new immutable variant keys and records state transitions in PostgreSQL.

Cross-system workflows use explicit states and compensating cleanup:

1. Reserve quota and create a pending database record in a transaction.
2. Upload to a temporary or final opaque key with bounded expiry/cleanup.
3. Validate/process the object, then atomically mark metadata ready and commit quota usage.
4. On failure, mark the record failed/release the reservation and enqueue idempotent object cleanup after commit.

Deletion first makes the database record unavailable, records deletion intent transactionally, and performs idempotent object deletion asynchronously. Reconciliation detects missing, abandoned, or unreferenced objects without treating object-store listings as authorization data. Database and MinIO backups use coordinated recovery points; search indexes remain rebuildable.

## Alternatives considered

- **Public buckets or permanent public URLs:** rejected because they bypass authorization and revocation.
- **Store binaries in PostgreSQL:** rejected due to database growth and operational cost for large files.
- **Use object paths as the ownership model:** rejected because paths are not an authorization boundary.
- **Attempt immediate database/object atomicity:** rejected because no shared transaction exists; explicit states and compensation are observable and recoverable.

## Consequences

- Every binary has a tenant-scoped database record; possession of an object key is insufficient for access.
- Upload and deletion flows are eventually consistent and need visible pending/failed states plus reconciliation jobs.
- Quota calculations and lifecycle policy remain application-controlled and testable.
- Tests must cover cross-workspace denial, guessed keys, expired URLs, spoofed MIME, oversize/partial uploads, duplicate cleanup, and restore consistency.

## Migration and rollback impact

No existing objects require migration. Key formats and bucket policies must be introduced through configuration and code, not by making buckets public. A future key-layout change requires copy-and-verify migration with dual-read compatibility before old keys are removed. Rollback retains private buckets and old metadata until references and backups are verified; object deletion is never the first rollback step.
