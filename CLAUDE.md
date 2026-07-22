# Notted Coding Conventions

Follow [`AGENTS.md`](AGENTS.md). `Notted.md` owns product requirements and canonical structure; `Plan.md` owns delivery order and completion criteria.

All nested delegation follows the recursive Synchronous Delegation Protocol in `AGENTS.md`: block on the supported finite wait until every started subagent is terminal, do no other work while waiting, require the standard completion payload, and explicitly report failed, blocked, or timed-out work.

- Strict TypeScript and validated boundary data.
- Next.js Server Components by default; minimal client boundaries and accessible reusable UI.
- Thin NestJS transports; application services own use cases, policies, and transactions.
- tRPC serves the first-party web client; `/api/v1` REST serves integrations; both reuse services.
- Every tenant-owned database operation is workspace-scoped.
- Server state uses tRPC/TanStack Query; use Zustand only for genuinely shared client-only state.
- Errors have stable codes and safe messages; logs are structured and redacted.
- Tests accompany behavior; schema changes include reviewed migrations.
- Every completed plan part has a record under `docs/completed-parts/`.

Detailed conventions live in `docs/standards/`.
