# Part 58 — Integrate Yjs collaborative editing

## Status

- **State:** Complete
- **Completed on:** 2026-08-15
- **Implemented by:** `backend-platform-engineer`, with two independent `quality-reviewer` passes and a fix pass
- **Plan reference:** `Plan.md`, Part 58
- **Related records:** [Part 55](part-55-note-version-snapshots-retention.md), [Part 56](part-56-version-history-diff-restore.md), [Part 57](part-57-authenticated-socket-io-infrastructure.md), [Part 59](part-59-presence-collaboration-ui.md), [Part 60](part-60-inline-comments-mentions.md)

## Objective

Make Yjs the in-session document authority over the Part 57 Socket.IO transport, so two people editing one note converge instead of clobbering each other on the last write. Before this part, concurrent editing lost data silently: both writers ran the Part 39 autosave against the same `notes.version`, and the loser's text disappeared with no notice.

## Implemented Work

- Two new tables carry the collaborative state. `note_collaboration_states` is one row per note holding the epoch, the last and projected revisions, the `notes.version` the state corresponds to, the schema version, a byte counter, and a compacted snapshot. `note_collaboration_updates` is the append-only log: one row per accepted client update or snapshot, with its epoch, monotonic revision, `bytea` payload, and byte count.
- Three new gateway handlers — `realtime:note:sync`, `realtime:note:update`, `realtime:note:awareness` — each routed through Part 57's existing `authorizeMessage` seam, and three server-to-room frames: `realtime:note:remote`, `realtime:note:reset`, `realtime:note:projected`.
- The handshake **joins the Socket.IO room before it reads state**. Reading first would drop any update committed during the read: the socket is not in the room yet, so the relay goes nowhere and Yjs never learns there is a gap to heal. The client holds frames that arrive in that window and applies them once the ack establishes the epoch.
- Updates are **persisted before they are acknowledged**: validate, allocate a revision, insert, commit, ack, and only then relay. Nothing a crash could erase is ever announced to a room.
- A per-note trailing debounce projects the Yjs state into `notes.content` — 2 s, with a 30 s maximum wait — under the `projected_note_version` compare-and-set. It derives `content_plain` and the checklist counters through the same projection helper every other writer uses, schedules the search-sync and embedding intents in the same transaction, and delegates the checkpoint decision to Part 55's `decideCollaborativeCheckpoint`, discharging the seam that part left uncalled.
- `NotesService.restoreVersion` gains one call to `resetToDocument` inside its existing serializable transaction. A restore bumps the epoch, writes one snapshot from the restored document, prunes the prior epoch, and realigns `projected_note_version`; live collaborators are reset onto the restored text rather than clobbering it back. This discharges the obligation Part 56 recorded.
- On the browser side, `NoteCollaborationProvider` owns the `Y.Doc`, its `Awareness`, the handshake, ~200 ms outbound batching, reconnection, and epoch resets, with no React in it. `useNoteCollaboration` adapts it; `NoteEditorSurface` decides the mode and binds the Part 39 autosave only in solo mode; `CollaborationStatus` is the inline `role="status"` region.
- Editor integration is four surgical edits in `TiptapEditor` plus an optional `collaboration` entry in `createNoteEditorExtensions`. When it is absent the extension array is byte-identical to before, so no existing editor test changed behavior.

## Important Decisions

- **`projected_note_version` is the single-writer rule.** It records the `notes.version` the Yjs state corresponds to, and every projection writes `UPDATE notes … WHERE id = $1 AND version = $projected_note_version` — the same optimistic lock the autosave already uses. Zero rows means a non-collaborative writer committed first, so the projection aborts, bumps the epoch, and rebuilds from `notes.content`. Autosave and the projection contend for one column and exactly one wins. No distributed lock, no change to `NotesService.update`.
- **The server holds no long-lived `Y.Doc`.** One is materialised for a handshake and for projection/compaction, then discarded. Live updates are validated, persisted, and relayed — never applied server-side — so two API instances cannot diverge, because neither holds state to diverge with.
- **First-party Yjs↔TipTap converters on the API.** `y-prosemirror` was evaluated and rejected there: `prosemirrorJSONToYDoc` needs a ProseMirror `Schema` the API does not have and would have to duplicate from the editor extension list, and the package pulls `prosemirror-view` and DOM assumptions into a Nest process. `src/realtime/yjs/note-yjs-document.ts` converts both directions and its output passes `safeParseNoteDocument` before anything is persisted. `y-prosemirror` stays in `apps/web`, where a real schema and DOM exist.
- **Recovery is one path with three cases** — no state row, `notes.version` disagreeing with `projected_note_version`, or an epoch's records failing to decode — and every one of them rebuilds from `notes.content`, never from client JSON. Rebuilds are compare-and-set, so racing instances produce exactly one new epoch.
- **The projection is not a BullMQ job.** A `job_outbox` row per keystroke burst buys nothing the compare-and-set does not already give. ADR 0006's durable-intent rule governs side effects that must survive a crash; this one is idempotent and re-derivable from a log that is already in PostgreSQL.
- **The editor's remount key is the provider's generation, not its epoch.** The two reset paths disagree about epochs: a server reset raises the epoch before rebuilding, but a `stale` update ack rebuilds while the epoch is still the old one. Keying on the epoch left the editor mounted over a destroyed `Y.Doc` for the length of the re-handshake, and everything typed in that window reached neither the wire nor the new document.
- ADR 0004 is amended by this part — see its "Part 58 amendment" section. ADR 0008 gains a dedicated collaborative-editing row.
- **Naming deviations, recorded here rather than by editing `Notted.md`.** `apps/api/src/realtime/yjs/note-collaboration.service.ts` fills the role `Notted.md` names `realtime.service.ts`; the `yjs/` directory it sits in *is* named there, and one service per concern beat one file named after a transport. On the browser side, `apps/web/src/lib/collaboration/` and `src/lib/realtime/` follow the house convention because `apps/web/src/hooks/` does not exist in this tree.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/database/schema/note-collaboration.ts` | `note_collaboration_states` and `note_collaboration_updates`, exported through `schema/index.ts` |
| `apps/api/src/realtime/yjs/note-yjs-document.ts` | Pure `noteDocumentToYDoc` / `yDocToNoteDocument`; the highest-risk file in the part |
| `apps/api/src/realtime/yjs/note-collaboration.policy.ts` | Compaction thresholds and debounce constants |
| `apps/api/src/realtime/yjs/note-collaboration.repository.ts` | The two tables' SQL, including atomic revision allocation |
| `apps/api/src/realtime/yjs/note-collaboration.service.ts` | `sync`, `applyUpdate`, `project`, `resetToDocument`, and the load-or-rebuild recovery |
| `apps/api/src/realtime/yjs/note-collaboration.projection.ts` | Per-note trailing debounce scheduler |
| `apps/api/src/realtime/realtime.contracts.ts` | New events, schema factories bounded by `REALTIME_CONFIG`, widened ack union |
| `apps/api/src/realtime/realtime.gateway.ts` | The three note handlers, each consulting `authorizeMessage` |
| `apps/api/src/notes/notes.service.ts` | `restoreVersion` resets the collaborative state in-transaction |
| `apps/web/src/lib/collaboration/note-collaboration-provider.ts` | The client protocol: handshake, batching, reconnect, epoch reset, in-window buffering |
| `apps/web/src/lib/collaboration/useNoteCollaboration.ts` | React adapter returning `{mode, binding, epoch, generation, status}` |
| `apps/web/src/lib/collaboration/realtime-socket.ts` | One lazy WebSocket-only `socket.io-client` instance |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Mode decision, autosave binding, editor remount key |
| `apps/web/src/components/notes/CollaborationStatus.tsx` | Inline `role="status"` region |
| `apps/web/e2e/collaboration.spec.ts` | Two-context real-stack journey |

## Database and Data Changes

One generated migration, `0019_empty_the_phantom.sql`, with its `meta/0019_snapshot.json`. It creates the `note_collaboration_kind` enum and both tables, with a unique `(note_id, revision)` and an index on `(note_id, epoch, revision)`. Both cascade from `notes`; `created_by_id` is `ON DELETE SET NULL`, because these rows are ephemeral and durable authorship lives in `note_versions`. No backfill: a note with no state row is seeded from `notes.content` on its first sync. Neither table carries `workspace_id`, following the `note_versions` precedent — tenant scope is proven by joining the parent note inside the same transaction.

Rollback is destructive: dropping the tables discards unprojected in-session state, so any rollback must be preceded by a forced projection.

## API, Configuration, and Operational Changes

- New realtime events as listed above; no new REST or tRPC route.
- New environment variables, all in `apps/api/.env.example`: `REALTIME_UPDATES_PER_MINUTE` (900), `REALTIME_AWARENESS_PER_MINUTE` (900), `REALTIME_MAX_UPDATE_BYTES` (131072), `REALTIME_MAX_AWARENESS_BYTES` (8192), `COLLABORATION_MAX_STATE_BYTES` (4 MiB). The config parser cross-validates the byte caps against Socket.IO's `maxHttpBufferSize`.
- `FEATURE_COLLABORATION_ENABLED` defaults to whatever `FEATURE_REALTIME_ENABLED` resolves to, and throws if enabled without it. Defaulting it to a bare `true` broke `app.e2e.test.ts`, which boots without realtime. The server is the only flag holder; there is no new `NEXT_PUBLIC_*`.
- Any handshake failure degrades silently to the Part 39 autosave. The note is still saved, which is why every failure path resolves to solo rather than retrying forever.
- Structured pino events carry identifiers and counters only — never payloads, document JSON, plain text, or awareness bodies: `collaboration.session.opened`, `collaboration.state.rebuilt`, `collaboration.update.rejected`, `collaboration.projection.committed`, `collaboration.projection.failed`, `collaboration.projection.superseded`, `collaboration.compaction`, `collaboration.checkpoint.boundary`.

## Security and Tenant-Isolation Notes

Every handler proves the note is in the active workspace inside the same transaction that touches the collaboration tables, using the same "wrong workspace" and "does not exist" error so neither leaks the other's existence. `assertActiveWorkspace` runs first. Room joins remain Part 57's: authenticated, authorized, and re-checked on a bounded interval. Update and sync are both rate-limited — `sync` reuses the join tier, which was missing on the first pass and is now enforced. Update payloads are size-capped before they are decoded, and a malformed buffer is rejected rather than applied, because feeding one to `Y.applyUpdate` corrupts the document for everyone in the room. The tenant-isolation matrix in `apps/api/test/tenant-isolation.test.ts` covers both new tables as indirect tenant entities with real insert fixtures.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `pnpm format:check` | Pass | `All matched files use Prettier code style!` |
| `pnpm lint` | Pass | 4 tasks, `--max-warnings 0` |
| `pnpm type-check` | Pass | 6 tasks |
| `pnpm test` | Pass | 6 tasks; API 154 files, web 126, validators 12, types 3 |
| `pnpm build` (with the three `NEXT_PUBLIC_*` prefixes) | Pass | 4 tasks |
| `pnpm --filter @notted/api db:check` | Pass | `Everything's fine 🐶🔥` |
| `pnpm test:ci` | Pass | 6 tasks; API 82.05 / 73.62 / 83.39 / 84.41, web 79.47 / 72.45 / 80.90 / 81.80 |
| `pnpm audit:prod` | Pass | `No new vulnerabilities were ignored` |
| Gated realtime integration (`REALTIME_INTEGRATION=true`) | Pass | 4/4 against live PostgreSQL + Redis, two independent Nest listeners |
| `pnpm e2e:test apps/web/e2e/collaboration.spec.ts` | Pass | 5/5, run twice on the disposable stack |

`pnpm test:ci` requires `DATABASE_URL` exported and the dev stack up. Without it 17 API suites skip and branch coverage lands near 62%, which reads as a regression and is not one.

## Known Limitations and Follow-up Work

- **≤2 s degraded-solo clobber window.** If realtime fails for one user only, that user is a solo writer and their save can win the compare-and-set before the next projection. Collaborators are then reset onto the winning text — told, never silently clobbered. Closing it fully means putting Redis on the core note-save path.
- **≤25 s authorization memo window** on the per-update `authorizeMessage`, bounded by the gateway's existing revalidation interval.
- **No offline durability across a page reload.** `y-indexeddb` is deliberately not shipped; unsent edits live in the tab's `Y.Doc` and in the Part 39 autosave, so a reload before reconnecting loses only the realtime copy.
- **A projection still inside its debounce window when the process stops is dropped, not flushed.** Nothing durable is lost — the log is in PostgreSQL — but `notes.content` stays stale until the note is next opened and left. Flushing at `onApplicationShutdown` was tried and reverted: Nest closes the database pool in `onModuleDestroy`, which runs first, so the awaited projections only fail against a dead pool.
- Unsent local edits are deliberately discarded on an epoch reset, and the status region says so. Keeping them would mean diffing two unrelated documents and asking the writer to merge them.

## Handoff Notes

- **`ySyncPlugin` must stay registered under the default `ySyncPluginKey` and the binding must not be wrapped behind a private abstraction.** Part 60's comment anchors read it directly.
- The handshake's join-before-sync ordering and the client's in-window frame buffer are a matched pair. Changing either without the other reintroduces silent divergence that no test outside `note-collaboration-provider.test.ts` will catch.
- The editor remount key is the generation, not the epoch. Do not "simplify" it back.
- `loadOrRebuild` reads, rebuilds, and then reads again, up to two rebuilds. Every rebuild is followed by a read; a shape that ends on a rebuild throws away the repair it just made.
- The gated realtime integration suite is not repeatable back-to-back on a warm Redis: auth rate limits accumulate and produce 429s. Do not flush the shared dev Redis to clear them — it wipes dev sessions and BullMQ queue state. Recycle the stack instead.
- `pnpm e2e:down` un-publishes the dev data-service ports; re-run `pnpm infra:up:ports` afterwards.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-15 | Part 58 delivery | Initial record after two review passes and the final fix pass |
