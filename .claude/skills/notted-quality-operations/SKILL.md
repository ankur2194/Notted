---
name: notted-quality-operations
description: Independently review and verify Notted changes for architecture, quality, testing, accessibility, tenant isolation, security, dependency risk, observability, containers, deployment, backups, and release readiness. Use for reviews, verification, CI or operations work, and before completing high-risk plan parts.
---

# Assure Notted Quality and Operations

Read `AGENTS.md`, the selected `Plan.md` part, diff, completion record, requirements, ADRs, and standards. Review against acceptance criteria, not personal preference. Stay read-only for review-only requests: use `Read`, `Grep`, `Glob`, and read-only `Bash` verification commands, and do not use `Edit` or `Write`. Report a fix as a remedy instead of applying it.

If delegating any bounded review subtask, follow the Synchronous Delegation Protocol recursively: spawn with the `Agent` tool using `run_in_background: false` (the supported finite blocking wait), delegate only to read-only agents, remain blocked until all started subagents are terminal, do no other work while waiting, stop a failing or stalled subagent with `TaskStop` and report the condition explicitly, and return the required completion payload only after all descendants finish.

## Review order

1. Correctness/data loss: invariants, concurrency, transactions, migrations, retry, recovery.
2. Security/tenancy: auth, workspace scope, validation, secrets, web threats, limits, logs.
3. Architecture: canonical structure, dependency direction, contracts, ownership, ADRs.
4. Quality: tests, states, accessibility, browsers, performance, maintainability.
5. Operations: health, observability, shutdown, privilege, deployment, rollback, restore.
6. Dependencies: necessity, maintenance, license, vulnerabilities, runtime/bundle cost.

## Evidence and reporting

Run focused checks before broad checks. An unavailable dependency is a limitation, not a pass. Inspect migration SQL and production configuration. Report findings by severity with file/line evidence, impact, and remedy, followed by executed checks and residual risk. Critical/high findings block completion.

The repository quality gates are `pnpm lint`, `pnpm format:check`, `pnpm type-check`, `pnpm test`, and `pnpm build`. Do not run the rewriting variants (`pnpm lint:fix`, `pnpm format`) during a read-only review. Run them one at a time, never in parallel: concurrent lint/build runs are slower and less accurate in this Turborepo.

Before any end-to-end verification, observe the local resource budget in `docs/standards/testing.md`. Never run the development and `e2e` Compose stacks at the same time (`e2e` is a profile in the same project, so `pnpm e2e:up` adds to a running dev stack rather than replacing it — `pnpm infra:down` first). Pre-build the Chromium image as its own foreground step (`docker compose --profile e2e build api-e2e`) before `pnpm e2e:up`, so the ~1.45 GB build neither competes with Playwright for memory nor sits inside a subagent's no-output stall watchdog. Keep Playwright at one worker, as `apps/web/playwright.config.ts` already pins. On a memory-capped host, ignoring these can freeze the whole machine mid-review and leave the working tree in an unknown state.

## Completion payload

Return: `status` (`completed` | `blocked` | `failed`); result or findings; files changed (`none` for a review); commands or tests run; unresolved issues. Use `none` explicitly where empty.
