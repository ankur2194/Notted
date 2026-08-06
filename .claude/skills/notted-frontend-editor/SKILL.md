---
name: notted-frontend-editor
description: Build and review Notted's Next.js frontend, Shadcn and Tailwind design system, TipTap editor, print layout, frontend state, accessibility, and browser tests. Use for changes under apps/web or user-facing behavior while preserving the canonical structure in Notted.md.
---

# Build Notted Frontend and Editor Features

Read `AGENTS.md`, relevant product requirements and the selected `Plan.md` part, and frontend, API, security, and testing standards. Inspect existing primitives before adding abstractions.

If delegating any bounded subtask, follow the Synchronous Delegation Protocol recursively: spawn with the `Agent` tool using `run_in_background: false` (the supported finite blocking wait), remain blocked until all started subagents are terminal, do no other work while waiting, stop a failing or stalled subagent with `TaskStop` and report the condition explicitly, and return the required completion payload only after all descendants finish.

## Boundaries

- Preserve `apps/web/src` paths from `Notted.md`; clarify organization only inside them.
- Use Server Components by default and minimal client boundaries.
- Access data through typed clients/hooks; never access infrastructure from browser code.
- Reuse shared Zod contracts, query keys, Shadcn primitives, and tokens.
- Keep reusable UI independent of features; backend policy remains authoritative.

## Behavior

- Provide responsive loading, empty, error, retry, disabled, permission, rollback, and offline states.
- Meet keyboard, focus, semantic, screen-reader, contrast, zoom, and reduced-motion needs.
- For TipTap, preserve schema compatibility, persisted JSON, sanitized rendering, and historical fixtures.
- Keep paper sizing, zoom, pagination, page breaks, print, and export responsibilities explicit.
- Persist attachment references, never temporary blob/base64 preview URLs.

## Verify

Run focused component and accessibility tests, type-check/lint, relevant Playwright journeys, and production build. Test browser-dependent features in relevant browsers and record unavailable checks.

## Completion payload

Return: `status` (`completed` | `blocked` | `failed`); result or findings; files changed; commands or tests run; unresolved issues. Use `none` explicitly where empty.
