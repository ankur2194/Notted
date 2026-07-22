# Notted Coding Conventions

Follow [`AGENTS.md`](AGENTS.md). `Notted.md` owns product requirements and canonical structure; `Plan.md` owns delivery order and completion criteria. Detailed rules live in [`docs/standards/`](docs/standards/) and durable decisions in [`docs/decisions/`](docs/decisions/) — this file is a quick reference and never overrides them.

All nested delegation follows the recursive Synchronous Delegation Protocol in `AGENTS.md`: block on the supported finite wait until every started subagent is terminal, do no other work while waiting, require the standard completion payload, and explicitly report failed, blocked, or timed-out work.

## Quality gates (run before every push)

- `pnpm lint` (ESLint, fails on any warning via `--max-warnings 0`), `pnpm format:check` (Prettier), `pnpm type-check`, `pnpm test`, `pnpm build`.
- `pnpm lint:fix` / `pnpm format` autofix and rewrite. A pre-commit hook (husky + lint-staged) runs the same ESLint/Prettier fixes on staged files; skip with `git commit --no-verify`, disable in CI with `HUSKY=0`. Hooks are optional and always reproducible through the pnpm commands above.

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
