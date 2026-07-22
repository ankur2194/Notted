---
name: notted-quality-operations
description: Independently review and verify Notted changes for architecture, quality, testing, accessibility, tenant isolation, security, dependency risk, observability, containers, deployment, backups, and release readiness. Use for reviews, verification, CI or operations work, and before completing high-risk plan parts.
---

# Assure Notted Quality and Operations

Read `AGENTS.md`, the selected `Plan.md` part, diff, completion record, requirements, ADRs, and standards. Review against acceptance criteria, not personal preference. Stay read-only for review-only requests.

If delegating any bounded review subtask, follow the `AGENTS.md` Synchronous Delegation Protocol recursively. Remain blocked on the supported finite wait until all started subagents are terminal, do no other work while waiting, handle failure/block/timeout explicitly, and return the required completion payload only after all descendants finish.

## Review order

1. Correctness/data loss: invariants, concurrency, transactions, migrations, retry, recovery.
2. Security/tenancy: auth, workspace scope, validation, secrets, web threats, limits, logs.
3. Architecture: canonical structure, dependency direction, contracts, ownership, ADRs.
4. Quality: tests, states, accessibility, browsers, performance, maintainability.
5. Operations: health, observability, shutdown, privilege, deployment, rollback, restore.
6. Dependencies: necessity, maintenance, license, vulnerabilities, runtime/bundle cost.

## Evidence and reporting

Run focused checks before broad checks. An unavailable dependency is a limitation, not a pass. Inspect migration SQL and production configuration. Report findings by severity with file/line evidence, impact, and remedy, followed by executed checks and residual risk. Critical/high findings block completion.
