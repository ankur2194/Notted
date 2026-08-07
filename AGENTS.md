# Notted Agent Instructions

These instructions apply to every agent and file in this repository.

## Authority

Follow the current user request, then `Notted.md`, the selected numbered part in `Plan.md`, accepted records in `docs/decisions/`, standards in `docs/standards/`, and prerequisite records in `docs/completed-parts/`. `Notted.md` is primary for product requirements and directory structure. Do not silently override it; record conflicts and use an ADR for a material architectural deviation.

## Required Part Workflow

1. Work on one numbered `Plan.md` part per session unless explicitly authorized otherwise.
2. Read the selected `Plan.md` part, relevant specification, standards, ADRs, and prerequisite completion records.
3. Inspect existing code and uncommitted changes; preserve unrelated work.
4. State scope, affected layers, risks, and verification before implementation.
5. Implement the smallest complete change; do not implement later parts opportunistically.
6. Add tests with behavior, including authorization and tenant-isolation cases where relevant.
7. Run focused checks followed by the broadest safe relevant checks.
8. Review the diff for correctness, security, consistency, accidental scope, and documentation.
9. Create/update `docs/completed-parts/part-NN-short-name.md` and its index.
10. Use `Complete` only when all required criteria pass; report failed or skipped checks honestly.

## Project-Wide Rules

- Use strict TypeScript; avoid `any` and narrow `unknown` at boundaries.
- Validate external input with shared Zod schemas where contracts are shared.
- Enforce authentication, authorization, and workspace scope on the backend across tRPC, REST, jobs, WebSockets, and files.
- Keep transports thin. tRPC and REST call shared NestJS application services and policies.
- Use transactions for multi-table invariants and dispatch jobs/events only after commit.
- Use Server Components by default and minimal client boundaries in Next.js.
- Reuse UI primitives and provide loading, empty, error, disabled, permission, and retry states.
- Treat TipTap JSON as versioned persisted data; plan migrations for incompatible schema changes.
- Generate reviewed migrations for database changes; do not edit deployed migrations.
- Keep object storage private and use authorized streaming or expiring signed URLs.
- Keep secrets, tokens, content, personal data, and signed URLs out of logs.
- Review significant dependencies for need, maintenance, license, security, and cost.
- Never claim a check passed unless it was run.

## Skills and Codex Agents

- `$notted-part-delivery`: every numbered plan part.
- `$notted-frontend-editor`: Next.js, UI, TipTap, print, or browser work.
- `$notted-backend-data`: NestJS, API, database, queues, storage, search, or realtime work.
- `$notted-quality-operations`: review, security, testing, CI/CD, Docker, observability, and release work.
- `$notted-playwright-integration`: Playwright authoring, live browser integration, fixture setup, failure diagnosis, and browser verification.

Codex custom agents are configured in `.codex/agents/*.toml`, with concurrency settings in `.codex/config.toml`. Apply `.agents/checklists/part-completion.md` before handoff.

## opencode Support

This repository also runs on opencode. Project config is `opencode.json`, which loads this file as instructions.

- Skills: opencode natively discovers `.agents/skills/<name>/SKILL.md`, so the five Notted skills above load with no duplication. Do not also place them under `.opencode/skills/`; skill names must be unique across discovery locations.
- Agents: opencode agents live in `.opencode/agent/*.md` and mirror the Codex roles: `lead-part-engineer` (primary, coordinator), `backend-platform-engineer` and `frontend-editor-engineer` (subagents, workspace-write), and `quality-reviewer` (subagent, read-only via `permission.edit: deny`).
- Commands: opencode has no `$skill` invocation, so `.opencode/command/` provides slash commands that route to the matching agent and load the corresponding skill:
  - `/notted-part-delivery Part <number> <plan|implement|resume|handoff>`
  - `/notted-quality-operations Review Part <number>`
  - `/notted-quality-operations Verify Part <number> <focused|full>`
  - `/notted-playwright-integration <author|diagnose|verify> [test or Plan part]`
- Concurrency: `.codex/config.toml` caps (`max_threads`, `max_depth`) have no opencode config equivalent. The Synchronous Delegation Protocol below is encoded in every opencode agent prompt and still applies; only the numeric scheduler caps cannot be expressed.

## Synchronous Delegation Protocol

These rules govern every delegation, including delegation performed by a subagent:

1. Delegate only bounded tasks with explicit ownership and an expected completion payload.
2. After spawning one or more subagents, invoke the supported wait mechanism and remain blocked until every spawned subagent reaches a terminal state. This requirement applies recursively to all levels of delegation. Do not replace blocking waits with polling, periodic file reads, unrelated commands, duplicate investigation, speculative work, or additional work unless the user explicitly instructs it.
3. An agent may continue only after every subagent it started has returned a final result. Each subagent must wait for all of its own subagents before returning, so no agent returns while descendants are still active.
4. Every subagent final result must use a clear completion payload containing: `status` (`completed`, `blocked`, or `failed`); result or findings; files changed; commands or tests run; and unresolved issues. Use `none` explicitly where an item is empty.
5. Use one supported blocking wait with a finite platform-supported timeout. If a subagent fails, reports `blocked`, or does not finish before that timeout, stop or interrupt it with the supported mechanism so it reaches a terminal state, then report the condition and its partial payload. Do not wait indefinitely or repeatedly poll.
6. After all started subagents are terminal, the parent reviews each returned payload once, reconciles and merges the results, and only then resumes its own workflow. A failed, blocked, or timed-out delegation cannot be represented as successful or silently redone by the parent.

Platform concurrency settings permit nested delegation but cannot themselves guarantee scheduler-level synchronous blocking; agents must enforce this protocol with the supported spawn, wait, and interrupt mechanisms.

## Automatic Skill and Agent Routing

Codex does not load project commands from `.agents/prompts/`. Use the project skills directly:

- `$notted-part-delivery Part <number> implement` implements a part; replace `implement` with `plan`, `resume`, or `handoff` when needed.
- `$notted-quality-operations Review Part <number>` performs an independent review.
- `$notted-quality-operations Verify Part <number> focused` runs focused verification; replace `focused` with `full` for the complete applicable gate.

Route work automatically as follows:

- Every part implementation and handoff uses `lead_part_engineer` and `$notted-part-delivery`.
- Frontend, UI, editor, browser, print, accessibility, or `apps/web` scope adds `frontend_editor_engineer` with `$notted-frontend-editor`.
- API, NestJS, database, auth, queue, storage, search, email, AI, realtime, Docker, deployment, or `apps/api` scope adds `backend_platform_engineer` with `$notted-backend-data`.
- Every review and verification, and every high-risk completion gate, adds `quality_reviewer` with `$notted-quality-operations`.
- Playwright integration authoring or diagnosis adds `frontend_editor_engineer` with `$notted-playwright-integration`; add `backend_platform_engineer` when the journey uses API, database, Redis, queues, SMTP, auth, or tenant fixtures.
- Cross-layer parts use `lead_part_engineer` to coordinate both specialists and integrate the final result.

Determine scope from the selected numbered implementation part and actual affected files, not from the user's familiarity with the codebase. If specialist agents are available, delegate bounded independent work or review; otherwise assume the same roles sequentially. The lead remains responsible for integration, verification, and handoff.

On opencode the same roles and skills apply. Invoke the slash commands in `.opencode/command/` (`/notted-part-delivery`, `/notted-quality-operations`) instead of the `$skill` syntax, and map the Codex agent names to their opencode equivalents in `.opencode/agent/` (`lead_part_engineer` → `lead-part-engineer`, `backend_platform_engineer` → `backend-platform-engineer`, `frontend_editor_engineer` → `frontend-editor-engineer`, `quality_reviewer` → `quality-reviewer`).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
