# Part 27 — Build workspace screens

## Status

- **State:** Complete
- **Completed on:** 2026-08-01
- **Implemented by:** Phase 5 Parts 26–29 coordinated delivery session
- **Plan reference:** `Plan.md`, Part 27
- **Related records:** Parts 22, 25, 26, 28

## Objective

Provide accessible workspace list/create, overview, and settings screens that show only authorized server-derived workspaces and support create, switch, rename, page defaults, and safe deletion.

## Implemented Work

- Added `/workspaces`, `/workspaces/[workspaceId]`, and `/workspaces/[workspaceId]/settings` App Router screens.
- Added responsive workspace cards, avatar/logo placeholders, create dialog, overview summaries, quota presentation, and settings controls.
- Added loading, empty, error/retry, not-found, validation, conflict, disabled, and role-based permission states.
- Kept Server Components responsible for reads and small client components responsible for mutations/dialog focus.
- Integrated newly created and selected workspaces into the dashboard shell and workspace switcher without fabricating tenant data.
- Added an invitation acceptance route used by the Part 28 email journey.

## Important Decisions

- Billing and plan-managed quota are display-only; settings explicitly state that billing/storage controls are read-only.
- Client request helpers validate inputs and responses with shared schemas and return safe error categories rather than exposing API details.
- Workspace create sends a stable per-submission idempotency key so a retry cannot create a duplicate workspace.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/src/app/(dashboard)/workspaces/` | List, overview, settings, loading, error, and not-found routes |
| `apps/web/src/components/workspaces/` | Cards, avatar, creation, settings, quota, and invitation UI |
| `apps/web/src/lib/workspaces/` | Typed server reads, client mutations, and route helpers |
| `apps/web/src/components/layout/` | Workspace navigation and switcher integration |
| `apps/web/e2e/workspace-management.spec.ts` | Disposable real-stack lifecycle, isolation, and invitation journey |

## Database and Data Changes

None. Screens use the Part 26/28 APIs and server-validated shell selection.

## API, Configuration, and Operational Changes

- Uses `NEXT_PUBLIC_API_URL` for typed REST mutations and the existing server API URL for Server Component reads.
- Disposable browser runs now require explicit `DATABASE_URL`, `PLAYWRIGHT_MAILPIT_URL`, and `PLAYWRIGHT_DISPOSABLE_TEST_RUN=true`.
- Playwright starts the compiled API and a clean Next.js development server with finite timeouts.

## Security and Tenant-Isolation Notes

- The UI never treats hidden or disabled controls as authorization; the backend remains authoritative.
- Server reads forward the authenticated session, use no-store caching, and map concealed 404 responses to safe not-found UI.
- Cross-tenant workspace IDs are not rendered in list/switcher data and direct guesses show the same not-found state.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Focused web component/route/request suites | Pass | 34 tests passed |
| `pnpm format:check` / `pnpm lint` / `pnpm type-check` | Pass | Repository-wide static gates passed |
| `pnpm build` | Pass | Next.js production build passed |
| Chromium `workspace-management.spec.ts` | Pass | 3/3 passed with serial disposable PostgreSQL, Redis, Mailpit, compiled NestJS, and real Next.js |
| Responsive/keyboard browser assertions | Pass | Phone and desktop reflow, dialog focus/return, create/switch/rename/refresh/delete, and permission states passed |

## Known Limitations and Follow-up Work

- Billing mutations remain intentionally unavailable.
- Project list/detail UI belongs to Part 30.

## Handoff Notes

- Preserve Server Components for reads and keep mutation client boundaries narrow.
- The workspace browser suite is destructive and intentionally refuses to run unless disposable mode and infrastructure URLs are explicit.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Coordinated delivery session | Implemented and verified workspace screens and real-stack journeys |
