# ADR 0006: Use durable job intent with idempotent BullMQ workers

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 18, 21, 26, 39-41, 45, 50-51, 53, 54-60, 63, 65, 78-81

## Context

Email, indexing, embeddings, exports, AI work, webhooks, and cleanup must run outside request latency. BullMQ and Redis provide delivery and scheduling, but Redis is ephemeral and job delivery is at least once. Enqueuing during a database transaction can expose uncommitted state, while enqueuing afterward without durable intent can lose work between commit and publish.

## Decision

PostgreSQL owns durable business state and durable side-effect intent. A service records an outbox/job-intent row in the same transaction as the state change. After commit, a dispatcher publishes it to BullMQ and records the enqueue outcome. Publishing and workers are idempotent, so retrying either stage is safe. Redis/BullMQ is execution infrastructure, not the authoritative record of business completion.

Queues are separated by operational behavior: high-priority/default, export, AI, and maintenance. Export concurrency defaults to two; AI queues apply provider-aware limits. Each typed, versioned payload is minimal and contains a job/intent ID, idempotency key, workspace ID, resource IDs, action, schema version, correlation ID, and only the actor/system-authority reference needed by the service. Payloads never contain document bodies, credentials, signed URLs, provider secrets, or reusable user sessions.

Processors are thin: validate and narrow the payload, load authoritative records through tenant-scoped repositories, invoke the same application services/policies used by synchronous transports, and record an idempotent outcome. User-requested work rechecks that the resource still belongs to the workspace and that the recorded actor or grant remains appropriate; explicitly modeled system maintenance runs under narrow system authority. A payload's workspace ID is never trusted without proving the resource relationship.

Workers use bounded execution time, exponential backoff with jitter, capped attempts, and graceful shutdown. Permanent failures move to a dead-letter state with a safe reason and operator remediation path. Side effects use provider idempotency where available or a PostgreSQL uniqueness/result record before sending. Replays, worker restarts, delayed delivery, and duplicate messages must not repeat emails, webhook effects, exports, quota charges, deletions, or index mutations incorrectly.

Bull Board is mounted behind backend authentication and an explicit platform-operator permission, not ordinary workspace-admin status. It redacts payloads and return values, is unavailable from public infrastructure networks by default, and records administrative retry/cleanup actions. Logs and metrics carry job and correlation IDs but exclude sensitive payload data.

## Alternatives considered

- **Publish directly inside a transaction:** rejected because workers may observe uncommitted or rolled-back state.
- **Publish only after commit without durable intent:** rejected because a process crash can silently lose required work.
- **Treat BullMQ retention as the audit/source of truth:** rejected because Redis is ephemeral and queue retention is operational.
- **Put business rules in processors:** rejected because synchronous and asynchronous behavior and authorization would drift.
- **Assume exactly-once delivery:** rejected because retries and crashes make at-least-once processing unavoidable.

## Consequences

- Part 18 must add outbox/job-intent and idempotency records with retention and useful uniqueness constraints.
- Queue delays do not roll back committed user state; status fields expose pending, running, succeeded, and failed work where users need feedback.
- Dispatchers, workers, and provider adapters require failure metrics, backlog alerts, replay tooling, and correlation.
- Tests must cover commit-before-dispatch, dispatcher restart, duplicates, stale/revoked access, cross-workspace payload tampering, retry exhaustion, dead letters, and graceful restart.

## Migration and rollback impact

No queue data exists yet. Rollout order is database records, dispatcher, then workers; producers can safely accumulate durable intent before workers start. Payload schema changes use explicit versions and compatible consumers during deployment. Rollback stops publishers/workers without deleting intent rows, allowing later replay; destructive queue cleanup never substitutes for reconciling PostgreSQL state.
