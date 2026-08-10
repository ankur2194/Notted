# Part 46 — Implement tags and templates

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-08-10
- **Implemented by:** Claude Code session (implementation subagent, one fix pass, two independent review passes, orchestrator-applied final fixes)
- **Plan reference:** `Plan.md`, Part 46
- **Related records:** [Part 16](part-16-tags-attachments-comments-versions.md) (tag and note-tag schema), [Part 31](part-31-core-note-apis.md) (note services this extends), [Part 32](part-32-note-browsing-hierarchy-ui.md) (note browsing UI this extends), [Part 47](part-47-standalone-tasks.md) (consumes the shared extractions made here), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

## Objective

Turn the tag and template *schema* delivered structurally in Parts 15–16 into working features: workspace tag CRUD with colour validation, assignment and removal, usage counts, and sidebar filtering; plus template creation from a note and note creation from a template, copying content rather than retaining a live link between the two. Part 47 depends on the shared contracts, HTTP client, and tag picker introduced here.

## Implemented Work

### Shared contracts

- `packages/shared-types/src/tag.ts` — `TAG_API_PATHS` (function style, matching `NOTE_API_PATHS`, because the web client calls these rather than pattern-matching them), `TagSortField`, `TagSummary`, `TagPage`, `TagListQuery`, and the create/update/delete result types. `TagSummary` carries **two separate counts**, `noteCount` and `taskCount`, not one blended `usageCount`.
- `packages/shared-validators/src/tag.schema.ts` — `TAG_DEFAULT_COLOR`, `TAG_COLOR_PATTERN` (`/^#[0-9a-f]{6}$/u`), `tagColorSchema` (trimmed and **lowercased** before the pattern test), `tagNameSchema` (trimmed, 1–50), `createTagSchema`, `updateTagSchema`, `tagListQuerySchema`, and the response schemas used as tRPC outputs and web-side parsers.
- `tagIdsSchema` moved from `note.schema.ts` into `common.schema.ts` and exported from the barrel, with a back-compatible re-export so no existing import changed. Part 47 reuses it for `task_tags`.
- `copyNoteSchema` and `NOTE_API_PATHS.copy` added to the note contracts.

### Backend

- New `apps/api/src/tags/` — `tags.service.ts`, `tags.controller.ts`, `tags.trpc.ts`, `tags.constants.ts`, `tags.module.ts`, `index.ts`. Structure and mutation pipeline copied from `apps/api/src/notes/`: trusted-origin assertion, idempotency key, `authorizeUser` before any SQL, then a transaction using `lockApiIdempotency` / `loadApiIdempotency` / `storeApiIdempotency`, `assertWorkspaceInsertValues`, `whereWorkspace`, and `recordMutation` (audit row plus `job_outbox`).
- `TagsService.list` computes usage in one statement with two correlated `count(*)` subqueries — `note_tags ⋈ notes` filtered on `is_deleted = false`, and `task_tags ⋈ tasks` — both under `whereWorkspace`. `create` maps SQLSTATE 23505 on `tags_workspace_name_unique` to `409 TAG_NAME_TAKEN` and enforces `TAG_MAX_PER_WORKSPACE = 200` with `409 TAG_LIMIT_REACHED`. `remove` counts both junctions for the result payload before deleting.
- Authorization: `tag.read | tag.create | tag.update | tag.delete` actions, a `"tag"` resource kind, a `ResourceLocator` variant, `RESOURCE_KINDS_BY_ACTION` entries, a `loadTag` repository case, and one `editorAllowed` line covering create and update. `tag.read` needed no branch — the existing `action.endsWith(".read")` arm already reaches `resourceCanRead`.
- Templates: new `NotesService.copy`. One method serves both directions — `asTemplate: true` is "Save as template", `asTemplate: false` on a template row is "Create from template". It authorizes `note.read` on the source and then `note.create` on the destination, both before any SQL, then copies `content`, `contentPlain`, `noteType`, and `pageSize` by value into a new row with `version: 1`, `isPinned: false`, `isArchived: false`, and the requested `isTemplate`. `POST /api/v1/workspaces/:workspaceId/notes/:noteId/copy` and a `copy` tRPC mutation expose it.

### Frontend

- `apps/web/src/lib/api/request-json.ts` and `server-read.ts` — the shared HTTP client extracted out of `lib/notes/requests.ts` and `lib/notes/server-notes.ts`, with re-exports from the original modules so no existing import changed. Part 47 and everything after build on these.
- `apps/web/src/lib/tags/` — `requests.ts` (client) and `server-tags.ts` (Server Component read).
- `apps/web/src/components/tags/` — `TagManager` (CRUD, native `<input type="color">` paired with a labelled hex field, delete confirmation naming both usage counts), `TagFilterList` (the sidebar tag cloud), and `TagPicker` (fully controlled: `{ tags, value, onChange, disabled?, legend?, idPrefix }`, reused by Part 47's task rows).
- `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/tags/page.tsx` — the tag management page.
- `tagId` threaded through `parseNoteSearchParams`, `noteSearch`, and `listSearch`; all three silently dropped it before, which would have made the sidebar tag link inert.
- `NoteBrowser` gained "Save as template", "Create from template", tag assignment through `TagPicker`, and an active-tag-filter chip, all on the file's existing manual snapshot → `setQueryData` → rollback → `reconcile()` pattern. `NoteCard` renders tag chips.

## Important Decisions

- **No migration, in either direction.** Every requirement is satisfied by the Part 16 schema. Explicitly rejected: `tags.updated_at` (no consumer), `tags.created_by_id` (Part 16 recorded the omission deliberately — tags are a workspace-level vocabulary, not an authored entity), `color NOT NULL` (the column already has a `DEFAULT`, Zod guarantees a value on input and the service coalesces on output, so `SET NOT NULL` would need a full validation scan to close a hole the application cannot open), a colour `CHECK` (format is a trust-boundary rule that belongs in Zod, and a CHECK freezes the palette rule behind a migration), and any partial unique index (tags have no soft-delete).
- **Template copying uses no link column, by construction.** The absence of a source reference *is* the guarantee the Plan asks for. A `templateId` column would be the exact "accidental live link" the bullet forbids.
- **Template permissions and separate template listings needed no new server concept.** Templates are ordinary notes reusing the `note.*` actions; `view=templates`, the `isTemplate` filter, and the `tagId` filter already existed in `listConditions`. The one genuinely new rule — instantiating requires read on the template *and* create on the destination — is enforced by `copy`'s two authorization calls, so a viewer cannot instantiate and a template inside a restricted project stays concealed by the existing `projectVisibility` predicate. `Notted.md` specifies no template permission model, so inventing a template library would have been unrequested scope.
- **Editors may create and update tags but not delete them.** Deleting a tag strips it from every note and task in the workspace — a workspace-wide destructive effect. This matches `editorAllowed` already having no `note.delete` or `folder.delete` branch.
- **Two usage counts rather than one.** A delete confirmation reading "used on 12 notes" while silently detaching 30 tasks is a data-loss surprise. The sidebar cloud shows `noteCount` because it filters notes; the manager shows both.
- **`copyAs` sends the source's container rather than defaulting to the workspace root.** Omitting it would lift a template out of the restricted project that was protecting it.
- **Tag colour is rendered as a dot or ring, never as a text background.** A user-chosen colour behind text would silently break the 4.5:1 contrast requirement. The tag name is always visible text, so colour never carries meaning alone.
- **`tagQueryKeys` is a separate frozen object**, not a member of `noteQueryKeys`, so prefix invalidation stays intact for both.
- **The usage-count `ORDER BY` repeats its subqueries.** PostgreSQL cannot reference a select alias inside an ordering expression. Marked with a `ponytail:` comment and bounded by `TAG_MAX_PER_WORKSPACE`.
- **No per-edge tag assignment routes.** `PATCH /notes/:id { expectedVersion, tagIds }` already performs full-replace assignment through the existing `NotesService.replaceTags`; a `POST /notes/:id/tags/:tagId` pair would duplicate an authorized path for no new capability.
- **A tRPC subrouter ships even though the web app is REST-only.** Confirmed with the user: `docs/standards/api.md` makes tRPC the mandated first-party interface and every existing module has one. It is pure delegation over the same service and the same shared Zod.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/tag.ts` | Tag contracts and `TAG_API_PATHS` |
| `packages/shared-validators/src/tag.schema.ts` | Tag Zod schemas, colour and name validation |
| `packages/shared-validators/src/common.schema.ts` | Now the canonical home of `tagIdsSchema` |
| `packages/shared-validators/src/note.schema.ts` | `copyNoteSchema`; re-exports `tagIdsSchema` |
| `packages/shared-types/src/note.ts` | `NOTE_API_PATHS.copy` |
| `packages/shared-types/src/api.ts` | `TAG_NAME_TAKEN`, `TAG_LIMIT_REACHED` error codes |
| `apps/api/src/tags/tags.service.ts` | Tag policy, SQL, usage counts, conflict mapping |
| `apps/api/src/tags/tags.controller.ts` | REST `/api/v1/workspaces/:workspaceId/tags` |
| `apps/api/src/tags/tags.trpc.ts` | tRPC `tag` subrouter |
| `apps/api/src/tags/tags.constants.ts` | Audit entity, domain events, per-workspace limit |
| `apps/api/src/notes/notes.service.ts` | `copy` — template creation and instantiation |
| `apps/api/src/notes/notes.controller.ts` | `POST /notes/:noteId/copy` |
| `apps/api/src/authorization/authorization.contracts.ts` | `tag.*` actions, `"tag"` resource kind and locator |
| `apps/api/src/authorization/authorization-policy.service.ts` | Tag role matrix |
| `apps/api/src/authorization/authorization.repository.ts` | `loadTag` — workspace-scoped, conceals as 404 |
| `apps/web/src/lib/api/request-json.ts` | Shared client fetch, failure mapping, error `code` |
| `apps/web/src/lib/api/server-read.ts` | Shared Server Component read |
| `apps/web/src/lib/tags/requests.ts` | Tag client requests |
| `apps/web/src/lib/tags/server-tags.ts` | Server-side tag listing |
| `apps/web/src/components/tags/TagManager.tsx` | Tag CRUD surface |
| `apps/web/src/components/tags/TagFilterList.tsx` | Sidebar tag cloud and filter links |
| `apps/web/src/components/tags/TagPicker.tsx` | Controlled tag checkbox group, reused by Part 47 |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/tags/page.tsx` | Tag management page |
| `apps/web/src/components/notes/NoteBrowser.tsx` | Template actions, tag assignment, filter chip |
| `apps/web/src/components/notes/NoteCard.tsx` | Tag chips |
| `apps/web/src/components/layout/Sidebar.tsx` | Tags section |
| `apps/web/src/lib/notes/server-notes.ts`, `requests.ts` | `tagId` threaded through search params |
| `apps/web/e2e/tags-templates.spec.ts` | Real-stack coverage for all four Verify bullets |

## Database and Data Changes

**None.** No migration was generated and no schema file was modified. `pnpm --filter @notted/api db:check` reports `Everything's fine`. `tags`, `note_tags`, `notes.is_template`, and the two template indexes all pre-date this part. No backfill, no retention change, no seed change. Rollback is a code revert.

## API, Configuration, and Operational Changes

New REST routes, all under the existing `/api/v1` prefix and the existing authenticated rate-limit tier:

| Method | Path |
|---|---|
| `GET` | `/api/v1/workspaces/:workspaceId/tags` |
| `POST` | `/api/v1/workspaces/:workspaceId/tags` (201, `Idempotency-Key` required) |
| `PATCH` | `/api/v1/workspaces/:workspaceId/tags/:tagId` |
| `DELETE` | `/api/v1/workspaces/:workspaceId/tags/:tagId` |
| `POST` | `/api/v1/workspaces/:workspaceId/notes/:noteId/copy` (201, `Idempotency-Key` required) |

New tRPC procedures: `tag.list`, `tag.create`, `tag.update`, `tag.delete`, and `note.copy`.

New `ApiErrorCode` values: `TAG_NAME_TAKEN`, `TAG_LIMIT_REACHED`. `ApiRequestFailure` on the web side now carries an optional `code` echoed from the 409 envelope, so surfaces can separate conflicts whose remedies differ.

**No new environment variables, ports, feature flags, or deployment steps.** `TAG_MAX_PER_WORKSPACE = 200` is a compiled constant. Defaults are safe for development and production alike.

## Security and Tenant-Isolation Notes

- Every tag query is scoped with `whereWorkspace`; inserts go through `assertWorkspaceInsertValues`. `note_tags` has no `workspace_id` column by design, so cross-workspace assignment is prevented by the service's two-hop join, which the usage-count and filter queries both use.
- `loadTag` returns `null` for an id outside the active workspace, so a foreign tag id **404s rather than 403s** on read, update, and delete — no existence leak. Proven end to end against a real database in `tags-templates.spec.ts`.
- Role matrix, enforced in the policy layer and not merely hidden in the UI: `tag.read` for all four roles; `tag.create` and `tag.update` for owner, admin, and editor; `tag.delete` for owner and admin only.
- Template instantiation requires read on the source *and* create on the destination, both evaluated before any SQL runs, so a viewer cannot instantiate and a template in a restricted project stays invisible.
- Colour and name are validated at the trust boundary by shared Zod, with colour lowercased so `#FFF000` and `#fff000` cannot become two rows.
- `recordMutation` writes workspace, entity, and actor ids with an empty metadata object — no tag names, note titles, content, cookies, or signed URLs reach the audit log or the application log.

## Verification Evidence

Every command below was executed in this session. Gates were run one at a time.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | Both shared packages emit clean |
| `pnpm format:check` | Pass | All matched files Prettier-clean |
| `pnpm lint` | Pass | `--max-warnings 0`, 4/4 packages |
| `pnpm type-check` | Pass | 6/6 tasks |
| `pnpm test` | Pass | 2 + 9 + 88 + 100 test files; 11 API files skipped on the host (DB/MinIO-gated) |
| `pnpm --filter @notted/api build` | Pass | API compiles standalone |
| `pnpm build` | **Fail (known environment)** | `NEXT_PUBLIC_APP_URL must use a secure protocol in production` — `apps/web/.env.local` present. Recorded in [Part 45](part-45-storage-quotas-cleanup.md); not a code defect and not a pass |
| `pnpm --filter @notted/api db:check` | Pass | `Everything's fine` — no drift, no migration |
| `pnpm e2e:up` + `pnpm e2e:test apps/web/e2e/tags-templates.spec.ts apps/web/e2e/task-list.spec.ts` | Pass | **13/13** on a freshly reset `notted_e2e_test`; 5 are this part's |
| `docker compose exec api pnpm test:ci` | Pass | 97 files passed, 2 skipped; 83.15% statements / 75.91% branches / 87.11% functions — the decisive coverage gate |
| `pnpm e2e:down`, `node scripts/dev-tooling.mjs infra:down` | Pass | `docker ps` empty afterwards; no volume destroyed |

Plan Verify bullets, with the covering test:

| Bullet | Coverage | Where |
|---|---|---|
| Duplicate tag rules — API | Covered | `tags.service.test.ts` (23505 → 409 on create and update; unrelated errors rethrown) |
| Duplicate tag rules — UI | Covered | `tag-manager.test.tsx`; `tags-templates.spec.ts:218` leaves exactly one tag behind |
| Filtering | Covered | `tag-filter-list.test.tsx`, `note-browser.test.tsx`; `tags-templates.spec.ts:244` narrows and clears against the real API |
| Template copying | Covered for text | `notes.service.test.ts`; `tags-templates.spec.ts:281` edits the copy and asserts the template is untouched — the proof there is no live link. **Attachments are the exception; see limitations** |
| Workspace isolation | Covered | `tags.service.test.ts` (recorded predicates asserted through `PgDialect.sqlToQuery`); `tags-templates.spec.ts:346` proves 404-not-403 on a real database |

Two independent review passes ran. The first returned `failed` with eight blockers, all fixed and re-verified. The second returned `completed` with one major and four minor findings, resolved or recorded below.

## Known Limitations and Follow-up Work

- **A copied note shares the source note's attachment rows.** `NotesService.copy` duplicates the document JSON verbatim, and image and file nodes carry an `attachmentId`; no `attachments` row is duplicated for the copy. Two consequences: permanently deleting the source note cascades its attachment rows and the storage objects, so every note instantiated from that template loses its images with no recovery; and attachment read authorization resolves through the *source* note, so a template copied into a project the reader cannot see renders broken images. Text, formatting, structure, and tags copy correctly and are unaffected. The remedy is to duplicate the source's `attachments` rows for the new note and rewrite each `attachmentId` in the copied document, which requires a `copyObject` on `ObjectStore` (the interface has none today), per-variant key generation, quota reservation through the existing `StorageQuotaService`, and compensating cleanup on partial failure — a change spanning Parts 40, 44, and 45. It was deliberately not attempted at the end of this session with no review pass remaining. **Owner: a follow-up part before templates are advertised as attachment-safe.**
- **Case-only duplicate tag names coexist.** `Roadmap` and `roadmap` are two tags. `Notted.md` L679-701 specifies `unique(workspace_id, name)` and `tags_workspace_name_unique` enforces exactly that; no ADR settles whether case-insensitivity is intended. The cheapest remedy needing no migration is a case-insensitive existence check inside `TagsService.create`'s transaction, keeping the 23505 catch as the race backstop. **Owner: an ADR deciding intent first.**
- **The note browser fetches tags client-side on mount with no `initialData`.** `getServerTags` exists for a server prefetch when that latency matters.

## Handoff Notes

- `tagIdsSchema` is canonical in `packages/shared-validators/src/common.schema.ts`. Import it from `@notted/shared-validators`, not from `note.schema.ts`.
- `@/lib/api/request-json` and `@/lib/api/server-read` are the shared HTTP layer for every module after this one. `ApiRequestFailure.code` carries the envelope's `ApiErrorCode` on a 409; switch on `kind` first and consult `code` only where the remedy differs.
- `TagPicker` is fully controlled and carries no note-specific plumbing — Part 47 mounts it directly in a task row.
- The tag role matrix lives entirely in `authorization-policy.service.ts`. `tag.read` deliberately has no explicit branch; it is caught by the shared `.read` arm. Adding one would be redundant, and adding a `tag.delete` branch to `editorAllowed` would silently widen a destructive workspace-wide action.
- Anyone extending `NotesService.copy` should read the attachment limitation above first — it is the one place where the "copy, do not link" guarantee is currently incomplete.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-10 | Claude Code session | Initial record after implementation, one fix pass, two review passes, and final orchestrator fixes |
