# Part 26 — Implement workspace lifecycle APIs

## Status

- **State:** Complete
- **Completed on:** 2026-08-01
- **Implemented by:** Phase 5 Parts 26–29 coordinated delivery session
- **Plan reference:** `Plan.md`, Part 26
- **Related records:** Parts 14, 18, 19, 24, 25; ADRs 0003, 0006, 0007, 0009

## Objective

Provide authenticated workspace create, list, read, update, and safe-delete application services through REST and tRPC, with atomic owner membership, collision-safe slugs, tenant authorization, audit evidence, and durable cleanup scheduling.

## Implemented Work

- Added shared strict Zod contracts and framework-neutral workspace lifecycle types.
- Added `WorkspacesService` and thin REST endpoints for create/list/read/update/delete.
- Added workspace tRPC procedures at `/api/v1/trpc` that reuse the same service and schemas.
- Made creation replay-safe with required transport `Idempotency-Key` values and durable hash-only records.
- Creates the workspace, owner membership, audit row, and idempotency record atomically; slug conflicts retry with bounded numeric suffixes.
- Applies centralized authorization and tenant context to read/update/delete while list remains scoped to the authenticated user's memberships.
- Requires literal deletion confirmation and an optional exact-name check. Deletion writes an identifier-only cleanup outbox intent and a durable deletion tombstone before removing the workspace.

## Important Decisions

- REST and tRPC are both thin transports over `WorkspacesService`; neither transport owns SQL or policy.
- Idempotency stores only SHA-256 key/payload hashes. Reusing a key with a different payload is rejected.
- A standalone `workspace_deletion_audits` tombstone survives workspace cascade deletion without retaining workspace content or personal data.
- Stored-object and search cleanup remain asynchronous contracts for their later owning parts.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/workspaces/` | Workspace service, REST/tRPC transports, constants, module, and tests |
| `apps/api/src/common/idempotency/` | Shared durable API idempotency helpers and tests |
| `apps/api/src/database/schema/api-idempotency.ts` | Hash-only replay records |
| `apps/api/src/database/schema/workspace-deletion-audits.ts` | Durable deletion tombstones |
| `packages/shared-validators/src/workspace.schema.ts` | Workspace request/response validation |
| `packages/shared-types/src/workspace.ts` | Workspace contracts and REST path constants |

## Database and Data Changes

- `0010_swift_korg.sql` creates `workspace_deletion_audits` and lookup indexes.
- `0011_hot_natasha_romanoff.sql` creates `api_idempotency_records`, its actor foreign key, uniqueness constraint, and expiry index.
- The complete migration chain applied successfully to fresh disposable PostgreSQL; 12 migration journal rows were present.

## API, Configuration, and Operational Changes

- REST: `POST/GET /api/v1/workspaces` and `GET/PATCH/DELETE /api/v1/workspaces/:id`.
- tRPC: `workspace.create`, `workspace.list`, `workspace.read`, `workspace.update`, and `workspace.delete` under `/api/v1/trpc`.
- REST/tRPC creation requires `Idempotency-Key`; CORS now permits that header.
- Added `@trpc/server` 11.18.0 and shared rate limiting on the direct Express tRPC mount.
- Deletion emits `workspace.deleted` to `workspace-cleanup` with an identifier-only payload.

## Security and Tenant-Isolation Notes

- Authentication is resolved before either transport. Mutations enforce trusted origins.
- Workspace-scoped operations authorize before tenant-filtered SQL; unknown and cross-tenant selectors are concealed.
- List queries join only memberships owned by the authenticated user.
- Request keys, invitation data, workspace content, and signed URLs are not written to audit/outbox/tombstone logs.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Focused shared-validator suites | Pass | 32 tests passed across workspace, membership, project, and common contracts |
| Focused Parts 26/28/29 API suites | Pass | 49 tests passed; the initially gated database suite was rerun live |
| Disposable PostgreSQL focused integration | Pass | 12 tests passed, including slug collision, owner atomicity, authorization, concealment, replay, and deletion scheduling |
| `DATABASE_URL=<disposable> pnpm test` | Pass | Repository suites passed; API reported 562 passed with 3 unrelated infrastructure-dependent skips |
| `pnpm format:check` / `pnpm lint` / `pnpm type-check` | Pass | Repository-wide static gates passed |
| `pnpm db:check` and fresh migration application | Pass | Drizzle consistency and full migration chain passed |
| `pnpm build` | Pass | Production API/web build passed |
| `pnpm audit:prod` | Pass | No new production vulnerability was reported |
| Chromium disposable-stack workspace journey | Pass | 3 tests passed against real Next.js, compiled NestJS, PostgreSQL, Redis, and Mailpit |

## Known Limitations and Follow-up Work

- Cleanup consumers for stored objects and search indexes are owned by Parts 40 and 51; this part provides their durable intent only.
- Expired API idempotency-record pruning is an operational maintenance concern for a later job/operations part.

## Handoff Notes

- Preserve `WorkspacesService` as the policy/transaction authority for future transports.
- Keep cleanup and idempotency payloads identifier-only and dispatch work only after the originating transaction commits.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Part 26 backend implementation agent | Authored the initial implementation record with verification pending |
| 2026-08-01 | Coordinated delivery session | Added tRPC, idempotency, durable deletion audit, completed verification, and corrected the record |
