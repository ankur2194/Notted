# Notted Coding Conventions

Follow [`AGENTS.md`](AGENTS.md). `Notted.md` owns product requirements and canonical structure; `Plan.md` owns delivery order and completion criteria. Detailed rules live in [`docs/standards/`](docs/standards/) and durable decisions in [`docs/decisions/`](docs/decisions/) — this file is a quick reference and never overrides them.

All nested delegation follows the recursive Synchronous Delegation Protocol in `AGENTS.md`: block on the supported finite wait until every started subagent is terminal, do no other work while waiting, require the standard completion payload, and explicitly report failed, blocked, or timed-out work.

## Quality gates (run before every push)

- `pnpm lint` (ESLint, fails on any warning via `--max-warnings 0`), `pnpm format:check` (Prettier), `pnpm type-check`, `pnpm test`, `pnpm build`.
- `pnpm build` validates the web environment as production and rejects the loopback `http://`/`ws://` values in `apps/web/.env.local`. Prefix the command with `NEXT_PUBLIC_APP_URL=https://app.local.notted.invalid NEXT_PUBLIC_API_URL=https://api.local.notted.invalid NEXT_PUBLIC_WS_URL=wss://api.local.notted.invalid`. See `docs/README.md` → Quality commands.
- `pnpm test:ci` (coverage thresholds) needs `DATABASE_URL` exported and the dev stack up (`pnpm infra:up:ports`). Without it 17 API suites skip silently and branch coverage lands around 62%, which reads as a real regression but is not one. `turbo.json` documents the passthrough.
- **In the container, run the package script, not the root one.** `docker compose -p notted-dev exec -T --workdir /workspace/apps/api api env CI=true AUTH_E2E=true REALTIME_INTEGRATION=true pnpm run test:ci`. `/workspace` is mounted read-only, so the root `turbo run test:ci` dies writing its per-package `.turbo/*.log` before a single test runs. Pass condition is exit 0 with **237 passed / 1 skipped**; the one skip is `test/search-reindex.integration.test.ts`, which is gated on `MEILISEARCH_INDEX_PREFIX === "notted_e2e_"` because it wipes indexes.
- `pnpm lint:fix` / `pnpm format` autofix and rewrite. A pre-commit hook (husky + lint-staged) runs the same ESLint/Prettier fixes on staged files; skip with `git commit --no-verify`, disable with `HUSKY=0`. Hooks are optional and always reproducible through the pnpm commands above.

## End-to-end runs (local resource budget)

Full rules in [`docs/standards/testing.md`](docs/standards/testing.md) → Running the browser and Chromium suites efficiently, and → Local resource budget. On a memory-capped host (WSL2 defaults to about half of host RAM) an e2e run can exhaust the VM and freeze every terminal, not only Docker.

- **Never run both stacks at once.** `e2e` is a profile inside the *same* Compose project, so `pnpm e2e:up` starts `api-e2e`/`web-e2e` alongside a running development `api`/`web` instead of replacing them. `pnpm infra:down` before `pnpm e2e:up`; `pnpm e2e:down` before returning to development.
- **Pre-build the Chromium image as its own foreground step:** `docker compose --profile e2e build api-e2e`, finished before `pnpm e2e:up`. `api-e2e` extends `api`, which builds the `workspace-chromium` target (~1.45 GB vs ~493 MB lean), so the build must not race Playwright for memory — and a long silent `apt-get` must not sit inside an automated runner's no-output stall watchdog.
- **Playwright stays at one worker.** `apps/web/playwright.config.ts` pins `workers: 1` / `fullyParallel: false` and only the `chromium` project runs. Each extra worker is another browser process; this is a standing invariant, not a default to tune.
- **The Chromium PDF suite needs no e2e stack.** `apps/api/test/export-pdf.integration.test.ts` is gated only on the binary and touches no database, and the development `api` container already carries Chromium — so run it there, in seconds, instead of starting a second stack: `docker compose -p notted-dev exec -T --workdir /workspace/apps/api api pnpm exec vitest run test/export-pdf.integration.test.ts`. `5 passed` is the pass condition; `skipped` is unproven, not passed.
- **Stage the browser run:** focused spec first, whole suite second. A full serial run is 7–13 minutes, so finding a broken new spec at minute 9 is avoidable.
- **Re-run a failing spec alone before calling it a defect.** The suite is load-sensitive here — a test that passes in isolation and fails only under a full run is contention. Fix a cause you can name, or leave it and say so; never a bare retry, sleep, or weakened assertion.
- **Docker reclaim is by name only.** Other projects share this daemon, so `docker system prune -a` / `image prune -a` would destroy their images. Remove Notted's own leftovers explicitly.

## Architecture

- Monorepo (pnpm + Turborepo): `apps/web` (Next.js App Router), `apps/api` (NestJS), `packages/shared-types`, `packages/shared-validators`. See ADR 0001 for the dependency direction (apps → packages, never the reverse).
- Backend: NestJS modular architecture; thin transports call application services that own use cases, policies, and transactions. Database schemas live under `apps/api/src/database/schema/`.
- API: tRPC is the typed first-party web client; `/api/v1` REST is the public integration surface. Both reuse the same NestJS services and policies (ADR 0002).
- Database: PostgreSQL with Drizzle ORM and UUID keys. The pinned, compatibility-tested package matrix is ADR 0008 — consult it (not this file) for exact versions.

## Naming conventions (reconciled with the `Notted.md` structure)

The brief contained a contradiction ("kebab-case for components" vs `NoteCard.tsx`). The canonical `Notted.md` structure resolves it: **React components are PascalCase; all other source files are kebab-case.**

- **React component files** (`.tsx`): PascalCase, matching the default export — `NoteCard.tsx`, `TiptapEditor.tsx`, `EditorToolbar.tsx`, `PageContainer.tsx`.
- **Non-component source files** (`.ts`): kebab-case — `workspaces.service.ts`, `workspaces.controller.ts`, `queue.processor.ts`, `email.job.ts`, `auth.schema.ts`, utility files like `format-date.ts`.
- **React hook files**: camelCase prefixed with `use` — `useWorkspace.ts`.
- **TypeScript types/interfaces**: PascalCase, descriptive — `WorkspaceMember`, `NoteTreeNode`.
- **Database tables and columns**: snake_case — `workspace_members`, `created_at`.
- **Environment variables**: UPPER_SNAKE_CASE — `DATABASE_URL`, `REDIS_URL`.
- **Constants**: UPPER_SNAKE_CASE for true exported constants (`APP_NAME`); camelCase for local variables.

## Code style

- Strict TypeScript everywhere; validate external input with shared Zod schemas at trust boundaries (no `any`).
- Prefer explicit types on function parameters; rely on inference for locals.
- Use `async`/`await`; avoid raw callbacks.
- Backend errors use stable codes and a consistent envelope (NestJS filters); the frontend surfaces user-friendly messages from those codes. Logs are structured and redacted.

## Database

- Every schema change generates a reviewed migration; never edit a deployed migration.
- Use transactions for multi-table invariants; dispatch jobs/events only after commit (ADR 0006).
- Always include `created_at`/`updated_at`; soft-delete via `is_deleted`/`deleted_at` where specified.
- UUID primary keys; every tenant-owned table is workspace-scoped and proves it (ADR 0001, security standard).

## Frontend

- Server Components by default; isolate client components (`"use client"`) to the smallest interactive boundary.
- Reuse Shadcn primitives, design tokens, and shared Zod contracts; provide loading, empty, error, retry, permission, and offline states.
- Server state via tRPC + TanStack Query; Zustand only for genuinely shared client-only state.
- Meet WCAG 2.2 AA (keyboard, focus, semantics, contrast, reduced motion).

## API design

- tRPC for the first-party client; versioned `/api/v1` REST for integrations (OpenAPI-documented).
- Stable error codes, request IDs, bounded pagination, and explicit filters/sorts. No cross-workspace existence leaks; authorize before returning resources.
- Apply idempotency to retryable side-effecting mutations and risk-based rate limits.

## Security

- Deny by default: enforce authentication, resource authorization, and workspace scope in reusable backend policies.
- Validate type, size, shape, ownership, and allowed values at trust boundaries.
- Never expose secrets in frontend code; keep object storage private; redact credentials, cookies, content, and signed URLs from logs.

## Testing

- Unit tests with Vitest; API tests with NestJS testing utilities; E2E with Playwright.
- Add a test with each behavior; include negative-authorization and cross-tenant cases where relevant.
- Minimum 70% coverage, prioritizing critical-path branch coverage over superficial totals.

## Docker and operations

- Multi-stage, reproducible, non-root images with health checks and pinned base versions.
- Keep data services private; expose web/API through a TLS reverse proxy.
- Validate configuration and run migrations through an explicit release step; encrypt off-host backups and test restore.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
