# Part 59 — Presence and collaboration UI

## Status

- **State:** Complete
- **Completed on:** 2026-08-15
- **Implemented by:** `frontend-editor-engineer`, with two independent `quality-reviewer` passes and a fix pass
- **Plan reference:** `Plan.md`, Part 59
- **Related records:** [Part 57](part-57-authenticated-socket-io-infrastructure.md), [Part 58](part-58-yjs-collaborative-editing.md), [Part 60](part-60-inline-comments-mentions.md)

## Objective

Make collaborators visible: named coloured carets in the document, a viewer list beside the save status, and an honest connection state. Part 58 made two people's edits converge; this part makes it apparent that someone else is there.

## Implemented Work

- Presence rides Part 58's socket on three new events — `realtime:presence:announce` (client to server, acked), `realtime:presence:joined` and `realtime:presence:left` (server to room).
- **Awareness carries no identity.** Client awareness state is a cursor. `userId`, `colorIndex`, and `awarenessClientId` are server-issued on the authenticated announce, and the gateway binds `presenceId → (socket.id, userId, awarenessClientId)` at announce time.
- **The gateway refuses to relay an awareness frame whose encoded Yjs client identifier is not the one bound to the sending socket.** Decoding just the client identifiers takes about ten lines with `lib0/decoding`, a dependency Yjs already pins. This is why the awareness relay is a gateway handler that sees the raw frame rather than an opaque broadcast, and why it refuses when *no* presence row is bound rather than only when a bound one mismatches — the first version was bypassable by simply never announcing.
- **The roster is derived, not stored.** `server.in(room).fetchSockets()` returns it, `@socket.io/redis-adapter` already implements that across instances, and `RemoteSocket.data` carries the presence blob. There is no Redis key to expire, no table, no sweep job, and no row that can outlive a process restart — ADR 0004's "presence expires and is never restored as business data" satisfied structurally.
- Colour is `sha256(userId)[0] % 8`, computed server-side, so a person keeps their colour across reloads *and* across notes. The palette is eight CSS custom properties in `globals.css`, so contrast against paper white is auditable in one place.
- Stale entries are removed by four independent layers: the client clears local state and leaves on unmount and `pagehide`; the gateway's single `cleanup()` teardown point broadcasts a leave for every joined room (capturing the room set **before** `state.rooms.clear()`); the existing sweep interval force-disconnects a stale socket into that same path; and `y-protocols/awareness` independently expires entries after roughly 30 s, so even a dropped leave frame clears the caret.
- `PresenceBar` shows the viewer list and the connection state together, mounted next to `SaveStatusIndicator` and outside the transformed paper, so it needs no portal.

## Important Decisions

- **No presence store on the server.** The alternative — a Redis hash per room with a TTL and a sweep job — has a failure mode this design cannot have: a row that survives the process that created it. Deriving the roster from live sockets makes staleness unrepresentable.
- **No display name on the wire.** `AuthenticatedPrincipal` has no name field, so the browser resolves `userId` to a name from the member directory it already caches under `noteQueryKeys.members(workspaceId)`. Unresolvable ids render unnamed, the precedent `data-mention-state="unknown"` already set.
- **Typing indicator: deliberately skipped.** With character-level sync and a live coloured caret, "X is typing" restates what the caret already shows. `Plan.md` says "where useful"; the honest answer is nowhere in this surface. It becomes useful when there is a surface with no shared caret — a comment composer, for instance.
- **The viewer list is `aria-live="off"`.** Announcing every join and leave in a ten-person session is unusable. The count lives in the dialog heading and the trigger's label instead.
- Above 12 concurrent cursors, name labels are dropped and carets render alone; names stay reachable in the viewer list. The roster is hard-capped at 50, beyond which the announce acks `{ok: false, error: "limited"}`.
- Zero new npm packages.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/realtime/presence-color.ts` | Deterministic server-side colour index |
| `apps/api/src/realtime/awareness-client-ids.ts` | Decodes the client identifiers out of a raw awareness frame |
| `apps/api/src/realtime/realtime.gateway.ts` | `presence()` handler, `relayAwareness` binding check, leave broadcast in `cleanup()` |
| `apps/api/src/realtime/realtime.contracts.ts` | The three presence events and their schemas |
| `apps/api/src/config/realtime.config.ts` | `REALTIME_MAX_PRESENCE_PER_ROOM` (50), `REALTIME_PRESENCE_ANNOUNCES_PER_MINUTE` (30) |
| `apps/web/src/lib/realtime/presence-store.ts` | Module-level observable keyed by note id, read through `useSyncExternalStore` |
| `apps/web/src/lib/realtime/presence-client.ts` | Event wiring into the store; consumes Part 58's socket and owns none |
| `apps/web/src/components/notes/PresenceBar.tsx` | Viewer list and connection state |
| `apps/web/src/styles/globals.css` | The eight `--notted-presence-*` custom properties |

## Database and Data Changes

None. Presence is structurally ephemeral; there is nothing to migrate, retain, or purge.

## API, Configuration, and Operational Changes

Three new realtime events, two new bounded configuration values with safe development and production defaults, and no new REST or tRPC surface. Presence is inert when collaboration is disabled, because it rides the same socket and the same room membership.

## Security and Tenant-Isolation Notes

Rooms remain Part 57's: private, versioned, hashed, and joined only after `workspace.read` and `note.read` are proven. The announce is rate-limited on its own tier. The client-identifier binding is the anti-forgery control and is enforced on every relayed frame.

Residual, documented with a `ponytail:` comment at the binding site: **a member can present another member's display name.** The identifier and colour are server-issued and cannot be forged, but the name is resolved client-side from the directory, so a determined member could render a misleading label in their own peer's view. Closing it means putting the display name on the wire and therefore in the principal, which is a wider change than the risk warrants inside one authorized workspace.

## Verification Evidence

Verified as one gate with Parts 58 and 60 — see [Part 58's evidence table](part-58-yjs-collaborative-editing.md#verification-evidence). Every listed check passed: `format:check`, `lint`, `type-check`, `test`, `build`, `db:check`, `test:ci`, `audit:prod`, the gated realtime integration 4/4, and both Playwright specs.

Presence-specific coverage: `presence-color.test.ts`, `awareness-client-ids.test.ts`, `presence-store.test.ts`, `presence-bar.test.tsx`, and gateway tests proving that `cleanup()` broadcasts a leave for every joined room and that an awareness frame with an unbound client identifier is refused rather than relayed. The realtime integration suite proves roster convergence across cross-instance join, graceful leave, and abrupt `disconnect(true)`.

## Known Limitations and Follow-up Work

- Display-name spoofing within a workspace, as described above.
- The viewer list is not announced to assistive technology on change, by design; the count is reachable on demand.
- No typing indicator, by design. Revisit alongside a comment composer.

## Handoff Notes

- `RealtimeGateway#cleanup()` is the single teardown point for both graceful and forced paths. It calls `state.rooms.clear()`; **capture the room set before that line** or the leave broadcast goes to nobody.
- The awareness relay must keep seeing raw frames. Replacing it with a generic broadcast removes the only anti-forgery control in the part.
- `binding.awareness` is read fresh on every render in `NoteEditorSurface` on purpose: an epoch reset replaces the document *and* its awareness together, so a client identifier captured once names a torn-down instance.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-15 | Part 59 delivery | Initial record after two review passes and the final fix pass |
