# Part 60 — Inline comments, mentions, and notifications

## Status

- **State:** Complete
- **Completed on:** 2026-08-15
- **Implemented by:** `backend-platform-engineer`, with two independent `quality-reviewer` passes and a fix pass
- **Plan reference:** `Plan.md`, Part 60
- **Related records:** [Part 58](part-58-yjs-collaborative-editing.md), [Part 59](part-59-presence-collaboration-ui.md)

## Objective

Give notes real comment threads anchored to text, and make an `@mention` produce exactly one notification for each person mentioned. Before this part the `comments` table existed with nothing writing to it, and `notifications` rows came only from the seed.

## Implemented Work

- A new `apps/api/src/comments/` module with equivalent REST and tRPC transports over one application service: list, create, update, delete, and a single resolution route taking `{isResolved}` rather than two mirror-image routes.
- Comment highlights are **ProseMirror decorations, not a document mark**. A mark would require changing `packages/shared-validators/src/document.schema.ts`, bumping the document schema version, and migrating stored documents — and `TiptapEditor.handleUpdate` runs `safeParseNoteDocument` on every transaction, so an unknown mark would halt autosave outright.
- Anchors need no migration: the four `anchor_*` columns already existed. `anchor_key` holds `"yrel:1"` as an encoding-scheme discriminator so a future scheme is a new value rather than a new column, `NULL` keeps its existing meaning of a whole-note comment. `anchor_from`/`anchor_to` hold creation-time absolute positions as a fallback for non-collaborative readers, and `anchor_metadata` holds the Yjs relative positions plus a short quote.
- Remapping uses `y-prosemirror`'s `absolutePositionToRelativePosition` and `relativePositionToAbsolutePosition`, which consult the binding's mapping. Raw `Y.createRelativePositionFromTypeIndex` takes a Yjs *type index*, not a ProseMirror position, and must not be used here.
- When `relativePositionToAbsolutePosition` returns `null` the anchored text was deleted, and the comment moves to an "Orphaned" section showing its stored quote with no decoration. It is never deleted and never re-guessed.
- **The server never remaps.** It stores what the client sends. Re-deriving anchors server-side would be a second implementation of the same algorithm for no benefit.
- Mentions notify through `mention-notification.producer.ts`, called inside `NotesService`'s update transaction beside the search-sync intent, and a `notification.mention` worker that writes the row after commit.
- A new server-to-client-only `realtime:comment:changed` frame carries identifiers and a change kind — no content, no author name. Clients re-fetch through the authorized `GET`. It is deliberately not client-relayed: a relay would let an author push arbitrary content into a room and would bypass `comment.read` for anyone who joined earlier and lost permission since. It is not routed through the outbox either, because a lost frame costs a stale sidebar until the next fetch. **There is no new client-to-server event here, so `authorizeMessage` is not involved** — worth saying out loud, because its absence reads as an omission.

## Important Decisions

- **Nothing was added to the authorization layer.** `authorization-policy.service.ts` already mapped the five comment actions; the policy rows for `noteCanComment` (create), creator-only (update and delete), and `noteCanEdit` (resolve) already existed; and `authorization.repository.ts` already loaded comment facts through the `notes` join with workspace scoping and parent-thread validation.
- **The list route authorizes `note.read`, not `comment.read`.** `comment.read` is declared over a `comment` resource, so it cannot authorize a listing that has no comment id yet. That is the honest reading of the existing contract rather than a shortcut.
- **Mentions come from note-document mention nodes only.** `comments.content` is plain text and the composer has no mention node; parsing `@name` out of free text would mean name-to-user resolution, ambiguity, and a fresh forging surface `Plan.md` does not ask for. The upgrade path is an explicit `mentionUserIds[]` on the create-comment payload, validated identically.
- **Dedup is true by construction, not by retry suppression.** The producer computes `added = mentions(next) \ mentions(previous)`; the previous document is already loaded for optimistic locking, so a re-save yields an empty set and returns before touching the database. Two pre-existing unique indexes back it up: `job_outbox_idempotency_key_unique` collapses concurrent or retried transactions atomically with the note update, and `job_idempotency_key_unique` with `claimExecution` makes execution exactly-once. **No partial unique index was added to `notifications`** — a third layer guarding nothing, costing a migration.
- **The Yjs projection writes `notes.content` directly and never passes through `NotesService.update`.** This was not in the original design and was found during implementation: without wiring the producer onto that path too, a mention typed in a live collaborative session would have notified nobody. It is now called from both writers.
- **The notification row is written in the worker, not the request transaction.** Up to 20 recipients each need a display-name join, and that is not work for the autosave hot path; ADR 0006 mandates durable intent with the side effect after commit. The worker re-checks membership, because a recipient may have left between commit and run.
- **Resolution audit is the existing columns.** `is_resolved`, `resolved_at`, and `resolved_by_id` are already durable, tenant-scoped, and queryable — that *is* the record of who resolved what and when. This part surfaces it (`resolvedAt` and `resolvedBy` on the summary, rendered as "Resolved by X on 14 Aug") and logs it with identifiers only. No `audit_logs` table was invented; Part 71 owns that. No unconsumed outbox row was emitted "for Part 71" either.
- **Part 61 boundary:** the worker writes the row and stops. No email, no delivery column, no coupled handler.
- Zero new npm packages. Zero migrations.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/comment.schema.ts` | Anchor, create, update, resolution, summary, thread, page, and list-query schemas |
| `packages/shared-types/src/comment.ts` | The matching public types |
| `packages/shared-validators/src/document.schema.ts` | `collectNoteDocumentMentionIds`, one walker used by both sides |
| `apps/api/src/comments/comments.service.ts` | The application service; every statement joins `notes` and applies workspace scope |
| `apps/api/src/comments/comments.controller.ts` / `comments.trpc.ts` | The two thin transports |
| `apps/api/src/notifications/mention-notification.producer.ts` | Diff gate, actor drop, membership gate, cap, one outbox row per recipient |
| `apps/api/src/notifications/mention-notification.worker.service.ts` | Writes the notification row under tenant context after re-authorizing |
| `apps/api/src/queue/job-identifiers.ts` / `job-registry.ts` | `notification.mention` and its definition |
| `apps/web/src/components/editor/comment-anchors.ts` | Pure create and resolve helpers, unit-testable with no network |
| `apps/web/src/components/editor/extensions/comment-decorations.ts` | Rebuilds the decoration set from the anchor list on document change |
| `apps/web/src/components/notes/NoteComments.tsx` | Thread sidebar |
| `apps/web/src/components/layout/NotificationCenter.tsx` | Refetch on every open; count refresh on `visibilitychange` |
| `apps/web/e2e/note-comments.spec.ts` | Single-context real-stack journey |

## Database and Data Changes

None. The `comments` table and its four `anchor_*` columns already existed; both unique indexes the dedup relies on already existed.

## API, Configuration, and Operational Changes

- `GET|POST /api/v1/workspaces/:workspaceId/notes/:noteId/comments`, `PATCH|DELETE …/comments/:commentId`, `POST …/comments/:commentId/resolution`, with equivalent tRPC procedures. `apps/web` calls REST; the tRPC surface exists for ADR 0002 parity.
- Create requires a trusted mutation origin and an idempotency key, matching every other side-effecting mutation.
- One new server-to-client realtime frame, `realtime:comment:changed`.
- One new queue job, `notification.mention`, on the existing `default` physical queue with `authority: "actor"` and an identifier-only payload.
- No new environment variable, feature flag, or port.

## Security and Tenant-Isolation Notes

- Every `CommentsService` statement — including `readReplies` and the open-count aggregate — joins `notes` and applies the workspace predicate. A foreign comment id returns **404, not 403**, so cross-workspace existence never leaks.
- The mention producer runs `assertActiveWorkspace` first, then a single `workspace_members` query scoped to the active workspace. An id outside the workspace yields zero rows: no error, no existence leak, no notification.
- Recipients are capped at 20 per save, with the overflow logged and dropped.
- **The worker re-authorizes before it writes.** The first implementation leaked restricted-project note titles into notifications: a mention could name someone who is a workspace member but has no access to that note's project. It now calls `AuthorizationEntryService.authorizeUserJob("note.read")` and treats a denial as "nothing to deliver". The regression test uses a viewer who genuinely lacks project access, because owners and admins can read every note in the workspace and asserting against one of those would prove nothing.
- `setResolution` logs identifiers only — never comment content.

## Verification Evidence

Verified as one gate with Parts 58 and 59 — see [Part 58's evidence table](part-58-yjs-collaborative-editing.md#verification-evidence). Every listed check passed.

Comment-specific coverage: `comment.schema.test.ts`, `comments.service.test.ts`, `mention-notification.producer.test.ts` (a re-save yields zero rows; self-mention excluded; non-member dropped; key deterministic per triple and distinct per recipient; a second call is a no-op), `comment-anchors.test.ts` against a real `Y.Doc` (insert before shifts, delete after leaves it alone, deleting the range yields `null`), and `note-comments.test.tsx`.

`apps/api/test/comments.integration.test.ts` runs against live PostgreSQL: a cross-tenant comment id returns 404 rather than 403; a viewer can post a comment but is denied resolution; a non-creator can neither patch nor delete; a note saved twice with the same mention produces exactly one notification row and a second mentioned user produces exactly one more; and a mention naming a user in another workspace produces zero rows and no error. The duplicate-mention case settles the first save before asserting and exercises a real `ON CONFLICT` rather than asserting on a stub.

`pnpm e2e:test apps/web/e2e/note-comments.spec.ts` passed 1/1: select text, comment, reply, resolve, reload, assert persistence and the resolved-by label, then mention a member and assert the notification center shows exactly one row with the correct unread state.

## Known Limitations and Follow-up Work

- **`anchor_from`/`anchor_to` are not written back** as the document evolves, so non-collaborative readers — print, export, server-rendered views — see creation-time offsets. The relative positions stay correct for anyone in a collaborative session.
- **A mention never re-notifies** for the same `(workspace, note, recipient)` while the outbox row survives retention. Removing and re-adding a mention produces no second notification.
- The notification bell is request-driven: no realtime push, so the ceiling is one visibility-change of staleness. The upgrade path is a count-only workspace-room event, roughly fifteen lines.
- Comment composers have no mention support, by design. See the decision above for the upgrade path.

## Handoff Notes

- The binding comes from `ySyncPluginKey.getState(editor.state).binding`. **Part 58 must keep `ySyncPlugin` registered under the default key and must not wrap the binding behind a private abstraction** — this part reads it directly.
- Use `absolutePositionToRelativePosition` / `relativePositionToAbsolutePosition`, never the raw `Y.createRelativePositionFromTypeIndex`, which takes a different coordinate system entirely.
- Both writers of `notes.content` must call the mention producer. There are two: `NotesService.update` and the Yjs projection.
- If the decoration rebuild ever measures badly, map through `tr.mapping` instead of rebuilding from the anchor list.
- Part 61 owns delivery. Do not add an email call or a delivery column to the worker.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-15 | Part 60 delivery | Initial record after two review passes and the final fix pass |
