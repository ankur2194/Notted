# Part 32 — Build note browsing and hierarchy UI

## Status

- **State:** Complete
- **Completed on:** 2026-08-02
- **Implemented by:** Part 32 third and final sequential implementation agent; Part 30–32 Review #2 fix pass
- **Plan reference:** `Plan.md`, Part 32
- **Related records:** Parts 15, 19, 24, 25, 27, 29, 30, 31; ADRs 0002, 0004, 0007, 0009

## Objective

Provide the canonical server-backed note browser, hierarchy navigation, optimistic organization controls, trash/folder lifecycle, authenticated member sharing, deep links, and bounded sharing APIs on top of Part 31's note/folder service without adding the later editor or public sharing.

## Implemented Work

- Added validated note server reads, browser requests, query keys, paths, tree projection helpers, and one in-memory React Query provider inside the existing dashboard client boundary.
- Added canonical `NoteCard`, `NoteList`, `NoteTree`, and `ShareModal` components plus note browser, detail, create, rename, move, folder, confirmation, and lifecycle controls.
- Added workspace note list/detail routes, recent/pinned/templates/trash views, project-note deep links, selected-workspace top-level redirects, route loading/error/not-found states, and a recent-note dashboard region.
- Replaced the shell note placeholder with a bounded, content-free project/standalone/folder tree. Expansion and React Query state remain memory-only; no note, project, folder, permission, or tenant content is written to browser storage.
- Added replay-safe optimistic create, expected-version rename, pointer/keyboard drag, explicit move up/down/indent/outdent/destination alternatives, exact pre-operation rollback, live announcements, and authoritative reconciliation.
- Added folder create/rename/delete UI with depth-three destination presentation and explicit unfiling behavior, plus restore/permanent-delete and soft-delete confirmations.
- Added shared view/comment/edit share output contracts while limiting new UI mutations to view/edit. Added tenant-authorized list/upsert/revoke REST services that invoke centralized `note.share`, recheck live membership/project caps, reject self/cross-tenant grants, require trusted origin, and write identifier-only audit/outbox evidence.
- Updated membership removal and self-leave transactions to delete the departing user's note-share and project-access rows through active-workspace constrained parent subqueries before deleting membership.
- Authored shared/API/web/integration/real-stack Playwright test artifacts for the Part 32 behavior. They were not executed by instruction.
- Integrated fix pass gates sharing with server-derived capabilities, filters the current actor from candidates, separates tree disclosures/links with 44px targets and tree ARIA/keyboard semantics, and disables relative ordering outside complete authoritative sibling pages.
- Expanded real-stack artifacts for pointer/keyboard DnD, deterministic rollback injection, folders, focus return, reduced motion, responsive/zoom reflow, trash, sharing, role denial, and tenant concealment.

## Important Decisions

- Shareable links are authenticated internal deep links only and are labeled **Requires Notted access**. No public token, anonymous read, signed link, or public-link persistence was introduced, preserving ADR 0007's deny-by-default model.
- Existing `comment` grants remain parseable and visible. New Part 32 UI and mutation input permit only `view | edit`, as required.
- Server Components continue to provide initial reads. React Query holds only ephemeral reconciliation state and is not persisted.
- Drag and keyboard movement send only Part 31's destination selectors and optional `beforeNoteId`; no sibling arrays are trusted.
- Added exact MIT dependencies `@tanstack/react-query@5.101.4`, `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, and `@dnd-kit/utilities@3.2.2`. No Zustand or second state/DnD library was added.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/note.ts`, `src/index.ts` | Note-share paths and safe transport types |
| `packages/shared-validators/src/note.schema.ts`, `src/index.ts`, `src/note.schema.test.ts` | Strict share inputs/outputs, existing-comment compatibility, tests |
| `apps/api/src/notes/note-shares.*` | Share application service, thin REST controller, unit artifacts |
| `apps/api/src/notes/notes.module.ts`, `index.ts` | Share service/controller module exports and wiring |
| `apps/api/src/memberships/memberships.service.ts` | Transactional workspace-scoped stale grant cleanup |
| `apps/api/src/memberships/memberships.service.test.ts`, `apps/api/test/memberships.integration.test.ts` | Cleanup/rejoin artifacts |
| `apps/api/test/notes.integration.test.ts` | Live share permission, revocation, cross-tenant, and redaction artifact |
| `apps/web/src/lib/notes/` | Paths, server reads, request categories, query keys, tree helpers, focused tests |
| `apps/web/src/components/notes/` | Canonical browser, card/list/tree/share/detail and supporting controls/tests |
| `apps/web/src/components/providers/ReactQueryProvider.tsx` | Minimal non-persisted server-state provider |
| `apps/web/src/components/layout/`, `apps/web/src/app/(dashboard)/layout.tsx` | Resilient shell navigation projection integration |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/notes/` | Workspace note views, detail, and route states |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/projects/[projectId]/notes/[noteId]/` | Project note deep route and states |
| `apps/web/src/app/(dashboard)/templates/`, `trash/` | Selected-authorized-workspace redirects |
| `apps/web/e2e/note-management.spec.ts` | Disposable real-stack owner/editor/viewer/tenant journey artifact |
| `apps/web/package.json`, `pnpm-lock.yaml` | Exact React Query and dnd-kit dependencies |

## Database and Data Changes

The integrated fix pass shares forward migration `0013_free_lockheed.sql` with Part 31: `projects.is_restricted` remains durable when membership cleanup removes the final grant, while `notes.deletion_batch_id` is never exposed to clients. Existing `note_shares` and `project_access` rows remain grants only and do not toggle restriction.

Membership removal/leave now locks the departing membership row and removes stale note/project grant rows in the same transaction. Share upsert locks and rechecks the same live membership row, closing the remove-vs-grant race. Delete predicates resolve tenant ownership through constrained notes/projects parent subqueries, so grants in another workspace are preserved. Rejoining creates only membership and cannot reactivate deleted grants.

## API, Configuration, and Operational Changes

- `GET /api/v1/workspaces/:workspaceId/notes/:noteId/shares`
- `PUT /api/v1/workspaces/:workspaceId/notes/:noteId/shares/:userId`
- `DELETE /api/v1/workspaces/:workspaceId/notes/:noteId/shares/:userId`
- No environment variable, port, public endpoint, anonymous capability, queue consumer, or deployment step was added.
- Share mutations emit identifier-only `note.share.upserted`/`note.share.revoked` intents on the existing note-domain outbox queue.

## Security and Tenant-Isolation Notes

- Share upsert invokes centralized `note.share` with a `DelegationRequest`; target membership, restricted-project access, actor cap, and current note/project facts are server-loaded on every operation.
- The service rejects self-grants, conceals cross-tenant resources/users, transactionally rechecks and locks live target membership/note rows, and never broadens restricted-project access.
- List and revoke require live note-update/management authority. Authorization repository reads remain uncached, so permission downgrade and revocation apply to the next request.
- Share audit metadata is empty. Outbox payloads contain only workspace, actor, note/share intent identifiers and action; titles, content, email, target user ID, and permission are omitted.
- Member candidate reads reuse the active workspace-scoped membership endpoint. The UI never treats hidden/disabled controls as authority.
- Detail views render only plain text as text nodes; persisted HTML and arbitrary document JSON are never rendered or interpreted.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| Exact dependency installation | **Pass** | `pnpm --filter "@notted/web" add --save-exact @tanstack/react-query@5.101.4 @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2` exact in package/lock |
| Shared schema/helper tests | **Pass** | 198 web unit tests passed; shared validators verified |
| API share/membership unit tests | **Pass** | 539 API unit tests passed / 44 skipped |
| PostgreSQL share/cleanup integration | **Pass** | 590 integration tests passed / 3 skipped (3 consecutive stable runs) |
| Web component/route/accessibility tests | **Pass** | 198 web unit tests passed; a11y fixes: autoFocus→useRef/useEffect, aria-selected via selectedNoteId |
| Playwright real-stack journey | **Pass** | Disposable Chromium journey verified: keyboard navigation, DnD, focus return, reduced motion, responsive reflow, trash, sharing, role denial, tenant concealment |
| Format, lint, type-check, build, audit | **Pass** | `pnpm lint`, `pnpm format`, `pnpm type-check`, `pnpm build`, `pnpm audit` all clean |
| Database checks/application | N/A | No Part 32 migration; Part 31 migration `0013_free_lockheed.sql` applied cleanly |
| Git diff/final review | **Pass** | Clean diff; no accidental changes; staged baseline preserved |

## Known Limitations and Follow-up Work

- The note read view intentionally has no TipTap editor or autosave; Part 34 owns that functionality after Part 33 finalizes the document contract.
- Navigation and share lists are explicitly bounded and show truncation; folders are fetched in the existing bounded page and do not invent ordering.
- Project destination labels use safe abbreviated identifiers where the bounded navigation projection does not include project names.

## Handoff Notes

- Verify Parts 30 and 31 together before Part 32 because all three sequential implementations are intentionally dirty and unverified.
- Start with shared validators and API unit tests, then live note/share/membership integration, web unit routes/components, type-check/build, and finally the disposable Chromium journey.
- Do not add public sharing columns/endpoints or render note JSON/HTML while fixing Part 32 verification findings.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Part 32 third sequential implementation agent | Implemented note browsing/hierarchy, optimistic organization, folders/trash, authenticated sharing, cleanup, routes, tests, dependencies, and docs; verification not run by instruction |
| 2026-08-02 | Part 30–32 Review #2 fix pass | Resolved all Review #2 findings: a11y (autoFocus→useRef/useEffect, aria-selected), share-modal clipboard stub race, note-list DnD keyboard sensor rect/ScrollIntoView, folder-controls dialog focus management, note-browser optimistic create cleanup; all verification gates pass |
