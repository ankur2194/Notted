# Part 25 — Build the dashboard shell

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-07-31
- **Implemented by:** Phase 4 Part 25 implementation agent
- **Plan reference:** `Plan.md`, Part 25
- **Related records:** Parts 21–24; ADRs 0002, 0003, 0007–0010

Implementation and required verification are complete. Historical statements below describing
checks as not run reflect the initial implementation-only session and are superseded by the
completion update near the end of this record.

## Objective and implemented work

Part 25 replaces the authenticated Part 4 demo with the canonical responsive application shell
and pulls forward only the smallest durable server behavior needed for a genuine workspace
switcher and notification center.

- Added canonical `DashboardShell`, `Sidebar`, `TopBar`, `WorkspaceSwitcher`, and `Breadcrumb`
  components under `apps/web/src/components/layout/`, plus a bounded notification client island.
- Added desktop/tablet sidebar behavior, a focus-trapped mobile drawer with Escape/focus return,
  breadcrumbs, user security/logout menu, Ctrl/Command-K accessible search placeholder, shell
  skeleton, fail-closed error/retry state, and honest note-tree/search/content placeholders.
- Added skip targets, landmarks, visible focus, minimum touch targets, reduced-motion support,
  high-zoom/reflow styles, polite state announcements, and keyboard-operable controls.
- Workspace choices come only from the shell bootstrap. A same-origin Next adapter forwards the
  session to NestJS, validates the selected UUID against current membership, and writes only an
  HTTP-only selector cookie. Zero/one/many, loading, denied/error/retry, and disabled states are
  represented without invented tenants.
- Only the validated sidebar expanded/collapsed preference uses `localStorage`; unavailable
  storage is tolerated. Tenant lists, notification data/read state, permissions, and sessions are
  never persisted in browser storage.
- Added shared Zod inputs/outputs and secret-free TypeScript contracts for shell bootstrap,
  notification pages, read mutations, safe kinds, and safe target references.
- Added `ShellService` and a thin authenticated `GET /api/v1/shell/bootstrap` controller. The
  service loads the current user and live memberships, rejects a requested non-membership,
  derives display-only permissions through the Part 24 policy, establishes tenant context through
  the Part 24 entry service, and returns the unread count.
- Added tenant-scoped `NotificationService` and thin REST endpoints for bounded current-recipient
  list, mark-one read/unread, and atomic mark-all-read. Every endpoint proves current membership
  through Part 24, uses `TenantContext`, scopes by workspace and authenticated recipient, checks
  trusted mutation origin, and conceals guessed/cross-tenant IDs.
- Authored shared-schema, API controller, schema, PostgreSQL integration, Testing Library, and
  Playwright coverage. None was executed.

## Database and migration

Generated forward migration `apps/api/src/database/migrations/0009_bizarre_red_hulk.sql` after
immutable migration `0008`. It adds `notification_kind`, `notification_target_type`, and the
`notifications` table with workspace, recipient, optional actor, safe target reference, bounded
summary/label, created/read timestamps, and recipient/workspace/unread/recent indexes. Foreign-key
deletion is workspace/recipient cascade and optional actor set-null.

No body, editor content, rendered HTML, token, credential, secret, signed URL, provider payload,
or object key is stored. There is no backfill or seed change. Generation reported 35 tables and
created the SQL, `0009_snapshot.json`, and journal entry. The migration was not reviewed or
executed in this implementation-only session. Rollout is migration then API then web; rollback
stops the consumers and requires a separately reviewed forward migration for schema removal.

## API and security boundaries

- `GET /api/v1/shell/bootstrap?workspaceId=<uuid>`
- `GET /api/v1/workspaces/:workspaceId/notifications?page=1&limit=20&unreadOnly=false`
- `PATCH /api/v1/workspaces/:workspaceId/notifications/:notificationId` with `{ isRead }`
- `POST /api/v1/workspaces/:workspaceId/notifications/read-all`
- Same-origin web adapter: `POST /api/shell/workspace`

Client workspace IDs are selectors only. Bootstrap membership filtering is tied to the
authenticated user; notification queries include active workspace and recipient identity. The
same Part 24 workspace policy and authorization entry establish tenant scope for transports and
services. Cross-tenant, revoked-membership, other-recipient, missing, and guessed IDs are denied
without existence disclosure. Mutations are PostgreSQL-persistent and origin protected; mark-all
is transactional. Presentation permission flags never authorize backend work.

## Authored verification (not run)

| Artifact | Intended coverage | State |
|---|---|---|
| Shared schema tests | bounded pagination, strict inputs, invalid selectors/forged fields | Not run |
| API controller/schema tests | authenticated recipient projection, origin checks, safe columns/enums/indexes/redaction | Not run |
| Live PostgreSQL integration | membership filtering/current validation, pagination, unread count, ownership, guessed IDs, read/unread persistence, atomic mark-all, revocation | Not run |
| Vitest/Testing Library | shell landmarks/states, mobile focus return, keyboard command/menu, permissions, storage validation, workspace states, notification read/all behavior | Not run |
| Playwright | phone/tablet/desktop, skip link/landmarks, keyboard drawer, switching, persistence/reload, mark-all/errors/logout, reduced motion, 200% zoom | Not run |
| Lint/format/type-check/build/audit/migration review/check/execution/final diff | Required completion gates | Not run by instruction |

The only implementation command was `pnpm --filter "@notted/api" db:generate`, which generated
migration artifacts. It is artifact generation, not verification.

## Known limitations and ownership handoff

- Parts 21–25 are unverified and may contain compile, DI, migration, runtime, cookie-topology,
  browser, responsive, or accessibility defects. Verify prerequisites first, then focused Part 25
  suites, migration empty/upgrade paths, and broad gates.
- Shared package `dist/` outputs were not regenerated because builds were prohibited.
- Fixture-dependent shell Playwright journeys require a dedicated login user with two memberships
  and safe notification rows through uncommitted environment values. Seed identities remain
  deliberately non-authenticating.
- Part 26 owns workspace create/read/update/delete lifecycle APIs. Part 25 must not grow lifecycle
  mutations.
- Parts 31–32 replace note-tree placeholders and own note data. Parts 50–52 replace the command
  placeholder and own search. Part 60 creates comment/mention notifications and extends this
  storage/service rather than introducing duplicate notification tables or list APIs.

## Completion Verification Update

- Two independent review rounds completed; tenant-scoping, notification, responsive, focus, and
  accessibility findings were remediated before the lead completion review.
- Migration `0009_bizarre_red_hulk.sql` passed Drizzle consistency and applied successfully with
  all prior migrations to a freshly recreated disposable database.
- Shared/API/web tests, live tenant-notification integration, repository gates, and production
  build passed.
- A disposable non-seed user with two memberships and safe notification rows enabled all eight
  Chromium shell journeys. Phone/tablet/desktop reflow, keyboard navigation, landmarks, workspace
  switching, notification persistence/errors, logout, reduced motion, and 200% zoom passed.
- Firefox/WebKit broad validation remains Part 76. Track the reviewed transitive advisories in
  Part 21.

## Revision history

| Date | Author | Change |
|---|---|---|
| 2026-07-30 | Phase 4 Part 25 implementation agent | Authored shell, minimal backend/data API, generated migration, tests, docs, and pending-verification record. |
| 2026-07-31 | Lead part engineer | Completed review remediation, migration/live tenant/browser/repository gates, and marked Complete with follow-up. |
