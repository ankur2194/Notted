---
name: notted-backend-data
description: Build and review Notted's NestJS services, tRPC and REST transports, Drizzle and PostgreSQL schema, authentication, authorization, BullMQ, Redis, MinIO, Meilisearch, email, exports, AI adapters, webhooks, and Socket.io or Yjs infrastructure. Use for backend, persistence, integration, or realtime changes.
---

# Build Notted Backend and Data Features

Read `AGENTS.md`, relevant requirements and the selected `Plan.md` part, plus applicable backend, database, API, security, testing, and observability standards. Inspect schemas, migrations, services, and contracts first.

If delegating any bounded subtask, follow the `AGENTS.md` Synchronous Delegation Protocol recursively. Remain blocked on the supported finite wait until all started subagents are terminal, do no other work while waiting, handle failure/block/timeout explicitly, and return the required completion payload only after all descendants finish.

## Architecture and safety

- Preserve NestJS structure from `Notted.md`.
- Keep transports/processors thin and reuse application services and policies.
- Put transactions/invariants in services and provider details in adapters.
- Require workspace context for tenant repositories and test denial.
- Treat PostgreSQL as authoritative, indexes as rebuildable, Redis as ephemeral, and MinIO as private.
- Generate new migrations and review SQL, locks, backfill, compatibility, and rollback.
- Dispatch idempotent jobs/events after commit with bounded retry.
- Authorize room joins, files, exports, and background actions; apply resource limits and redaction.

## Verify

Run service/policy unit tests, realistic integration tests, migration checks, both transport contracts, and negative tenant/authorization tests. Verify readiness and integration failure behavior.
