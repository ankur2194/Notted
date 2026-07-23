# Completed Parts

This directory is the durable implementation history for the numbered parts in the root [`Plan.md`](../../Plan.md). Its purpose is to let another developer, agent, or later session understand what has actually been built without reconstructing decisions from source code or conversation history.

## Required Workflow

1. Before starting a plan part, read the completion records for all prerequisite parts and inspect any open risks they identify.
2. Implement and verify the selected `Plan.md` part according to its stated requirements and completion criteria.
3. Copy `TEMPLATE.md` to `part-NN-short-name.md`, where `NN` is the zero-padded part number.
4. Replace every placeholder with factual information. Do not claim tests or commands that were not run.
5. If verification was skipped or failed, mark it clearly and do not describe the part as complete.
6. Add later corrections or discoveries to the existing record instead of creating a competing summary.

## Naming and Scope

- Use one primary record per numbered part: `part-01-architecture-decisions.md`, `part-02-monorepo-initialization.md`, and so on through `part-88-post-mvp-delivery.md`.
- Keep the record focused on the implemented part. Link related records rather than copying their content.
- Use repository-relative paths and include migration names, configuration keys, API routes, and important symbols where they help future work.
- Never include passwords, tokens, private keys, connection strings with credentials, personal data, or other secrets.
- A record may be prepared while work is ongoing, but its status must remain `In progress` until every required completion criterion passes.

## Status Values

- `Complete`: all stated completion criteria passed.
- `Complete with follow-up`: the part is usable and verified, but explicitly listed non-blocking work remains.
- `In progress`: implementation or required verification remains.
- `Blocked`: work cannot continue; the blocker and required resolution are recorded.
- `Superseded`: a later decision or implementation replaced this work; link the replacement record.

## Index

Add one row after creating each record. Keep rows ordered by part number.

| Part | Status | Completed | Summary |
|---:|---|---|---|
| 1 | Complete | 2026-07-22 | Architecture boundaries, safe schema defaults, and a strictly resolved compatibility baseline. |
| 2 | Complete | 2026-07-22 | pnpm + Turborepo monorepo scaffolding, four canonical workspaces, root task scripts, and strict runtime/package pins. |
| 3 | Complete | 2026-07-23 | App-scoped Next.js/NestJS + repo-wide TypeScript/a11y/import ESLint, Prettier, fail-on-warning scripts, and optional commit gates. |
| 4 | In progress | — | Next.js 16 App Router scaffold remediated for strict React 19 peers, default Turbopack, minimal client islands, safe logging, and expanded accessibility tests; high-severity transitive audit findings and manual browser checks remain. |
| 9 | Complete | 2026-07-23 | Dev Compose stack with pgvector, Redis, Meilisearch, private MinIO buckets, and Mailpit. |

When adding the first real record, remove the placeholder row.
