# Part 56 — Version history, diff, and restore

## Status

- **State:** Complete
- **Date:** 2026-08-14
- **Plan reference:** `Plan.md`, Part 56

## Result

Part 56 adds strict shared contracts and equivalent REST/tRPC history transports,
all calling `NotesService` as the single application service. Reads authorize
canonical `note.read`; restore authorizes `note.update`, requires trusted origin,
and scopes every checkpoint through its active note and workspace. Public history
projections expose only version/title/author/time/current metadata and validated
TipTap content for detail.

Restore is non-destructive and serializable: it locks the active note, checks the
optimistic version, loads the source checkpoint through the same note/workspace,
migrates and validates TipTap JSON, derives plain text and checklist counters,
updates title/content once, appends the resulting N+1 accepted checkpoint through
Part 55, and records audit/domain/search/embedding intents in the transaction.
There is no redundant pre-restore snapshot and the source row is immutable.

The browser adds a responsive Version history dialog with a desktop complementary
list, narrow one-column reflow, deterministic author/time/version/current labels,
loading/empty/error/retry/purged/malformed/permission/conflict/success messaging,
non-colour before/after diff semantics, and restore confirmation. Restore is
hidden without edit capability and disabled for current or unsafe autosave states.
Successful restore invalidates the note cache family and refreshes the Server
Component tree, which reseeds editor/autosave from the authoritative response.
Historical preview editors are explicitly detached from the live note save
context, so mounting a preview cannot replace the editable note's autosave
baseline or emit a change.

## Diff and preview

`apps/web/src/lib/notes/version-diff.ts` is first-party and framework-free. It
projects validated TipTap blocks and atoms without raw HTML or raw JSON, preserves
marks/links/mentions, nested list/task structure, code language/text, table cell
attributes, image layout metadata, generic attachments, rules, and page breaks,
and aligns duplicate occurrences using bounded LCS. Work is capped by token and
matrix-cell limits; larger comparisons return an explicit safe fallback.

Historical attachment references continue through the existing authorized
attachment directory/content routes. Missing retained bytes are unavailable and
never replaced by object keys, signed URLs, or historical storage metadata.

## API

- `GET /api/v1/workspaces/:workspaceId/notes/:noteId/versions`
- `GET /api/v1/workspaces/:workspaceId/notes/:noteId/versions/:versionId`
- `POST /api/v1/workspaces/:workspaceId/notes/:noteId/versions/:versionId/restore`
- Equivalent `note.versions`, `note.version`, and `note.restoreVersion` tRPC procedures.

List order is deterministic `(created_at DESC, id DESC)` with an opaque bounded
cursor. Unknown fields and malformed UUID/page/cursor/version inputs fail at
strict shared schemas. Missing, denied, and cross-workspace selectors use the
existing concealed authorization/not-found behavior.

`isCurrent` identifies the latest accepted content checkpoint rather than
requiring equality with `notes.version`: structural moves and lifecycle changes
can advance the optimistic version without creating a misleading content
snapshot under Part 55's policy.

## Search and collaboration boundaries

Immediate search means durable `note.search.sync` and embedding-generation intents
commit with restore, then existing bounded workers converge; Meilisearch is never
called synchronously in the restore transaction. Before Part 57, collaborators
observe a restore on their next authorized refresh/read. This part adds no push,
SSE, ad-hoc polling, Socket.io, Yjs, presence, or comments.

Per ADR 0004, Part 58 must reconcile a restored PostgreSQL TipTap projection with
the persisted Yjs authority before collaborative editing is enabled. That future
reconciliation is documented only and is not implemented here.

## Tests authored and verification

Strict contract, bounded diff, API/application service, browser-state/accessibility,
live PostgreSQL, and real-stack Playwright coverage was executed. The live
PostgreSQL suite passed 3/3. The focused Chromium journey passed 1/1 against the
disposable PostgreSQL/Redis/MinIO/Meilisearch stack in lightweight local mode.
It proves complex table/image/file preview, authorized image rendering and exact
download bytes, semantic before/after diff, immutable N+1 restore, automatic
authoritative owner refresh before reload, collaborator refresh, search
convergence, viewer denial, and foreign-tenant REST concealment.

The initial browser attempts exposed and corrected test-only defects: an invalid
generated foreign-user email, assumptions that diff tokens coalesced marked text,
and an immediate image decode sample that raced the authorized stream. The final
run retained the same evidence and passed. Repository-wide tests passed (API
1,412; web 1,372; tooling 19), as did type-check, lint, formatting, production
build, and production dependency audit.

An explicitly expanded Part 50 corrective pass synchronized the stale live enum
assertions in `operations-integration-schema.test.ts`. The full repository
coverage command then passed all six tasks, including 1,477 API tests and all
configured thresholds. All completion criteria for this part now pass.

## Risks and follow-up

- Part 55's implementation, migration, and live PostgreSQL behavior were verified.
- Part 58 owns Yjs reconciliation after restore; do not add a second write authority.
- No unresolved Part 56 completion blocker remains.
