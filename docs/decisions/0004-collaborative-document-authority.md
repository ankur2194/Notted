# ADR 0004: Yjs collaborative document authority over Socket.io transport

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 33, 39, 55, 57, 58, 59, 60

## Context

The specification calls for character-level editing, offline changes, presence, comments, reconnection, and version history, but leaves conflict resolution open between operational transformation and Yjs. It also names Socket.io without distinguishing document state from connection events.

## Decision

Yjs is the source of truth for concurrent in-session document state and conflict resolution. Socket.io is the authenticated transport for Yjs updates plus ephemeral presence, heartbeat, typing, and non-document events. Socket.io event history is not document authority.

The persisted collaborative representation is a versioned Yjs binary update or snapshot associated with one note. A deterministic TipTap JSON projection is stored for normal reads, search, export, and version snapshots. On collaborative load, the server reconstructs the Yjs document from the persisted Yjs state; it never rebuilds authoritative collaborative state from stale client JSON. A server-side projection pipeline updates PostgreSQL transactionally or with an idempotent, revision-checked follow-up job. PostgreSQL remains the durable authority; Redis pub/sub may fan out updates but is disposable.

Every room is keyed by workspace and note, joined only after session validation and note-level authorization. The server rejects a note/workspace mismatch rather than trusting room names from clients. Updates carry document identity, schema version, and monotonic persisted revision metadata. Presence expires and is never restored as business data.

## Safe defaults and unresolved details

- Deny room joins until authentication and current view/edit permission are proven.
- Keep offline updates client-side until the authorized reconnect handshake; reject rather than redirect updates when access was revoked.
- Use a single server-supported document schema version initially; incompatible extension changes require migration planning.
- Persist updates before acknowledging durable save. Apply bounded update sizes and compaction limits.
- Keep comments as PostgreSQL entities anchored to stable document-relative positions; comments are not embedded as the sole copy in Yjs.
- Exact snapshot cadence, compaction thresholds, and projection latency remain for Parts 33, 39, 55, and 58, with data-loss-safe defaults taking precedence over throughput. **Settled by Part 58 — see "Part 58 amendment" below.**

## Part 58 amendment — asynchronous projection, cadence, and presence identity

- **Date:** 2026-08-15
- **Settles:** the "unresolved details" bullet above, and the Consequences clause reading "may be briefly behind only if a later ADR explicitly permits asynchronous projection".

**Asynchronous projection is permitted, with a bound.** The Yjs update log in PostgreSQL is durable the moment an update is acknowledged; the TipTap projection in `notes.content` trails it. Search, export, print, version snapshots, and every REST/tRPC read consume the projection and are therefore permitted to be behind by at most the debounce window below. Nothing that is acknowledged can be lost by the delay: the projection is re-derivable from the log at any later time, and the log is what a reconnecting or newly joining client is served from.

**Cadence.** Projection is an in-process per-note trailing debounce of **2 s**, with a **30 s** maximum wait so a continuously typing room still lands a projection. It is not a BullMQ job: a `job_outbox` row per keystroke burst buys nothing the compare-and-set below does not already give, and ADR 0006's durable-intent rule is about side effects that must survive a crash — this one is idempotent and re-derivable. Compaction rewrites an epoch's log to a single snapshot at **64 updates or 131 072 bytes**, whichever comes first. Checkpoint cadence stays Part 55's `decideCollaborativeCheckpoint`, called by the projection with `forcedBoundary` set when the room compacted or the last collaborator left; a forced boundary that loses the note-version compare-and-set is settled afterwards rather than dropped. A pending projection is flushed on graceful shutdown rather than discarded, because a note nobody reopens would otherwise keep a stale projection indefinitely.

**Single writer, by compare-and-set.** `note_collaboration_states.projected_note_version` records the `notes.version` the Yjs state corresponds to. Every projection writes `UPDATE notes … WHERE id = $1 AND version = $projected_note_version` — the same optimistic lock the Part 39 autosave uses. Zero rows means a non-collaborative writer committed first; the projection aborts, the epoch is bumped, and the Yjs document is rebuilt from `notes.content`. **This is the rule that makes "no second write authority" enforceable rather than aspirational**: autosave and the projection contend for one version column and exactly one of them wins. It also discharges Part 56's restore obligation — `NotesService.restoreVersion` resets the collaborative state inside its own serializable transaction, so a restore is a rebuild rather than a race.

**The server holds no long-lived `Y.Doc`.** One is materialised for a sync handshake and for projection/compaction, then discarded. Live updates are validated, persisted, and relayed — never applied server-side. Two API instances therefore cannot diverge, because neither holds state to diverge with; convergence remains the clients' CRDT property. Updates are persisted **before** they are acknowledged and only relayed after, so nothing a crash could erase is ever announced to a room.

**Presence identity is server-authored.** Awareness frames carry no user identity: client awareness state is a cursor. `userId`, presence colour, and roster membership are issued by the server on an authenticated event, and **the gateway refuses to relay an awareness frame whose encoded Yjs client identifier is not the one bound to the sending socket**. The roster is derived from the room's live sockets rather than stored, so it expires with the process and no stale row can outlive a restart — the "presence expires and is never restored as business data" rule above, satisfied structurally rather than by a sweep job.

## Alternatives considered

- Operational transformation: rejected because Yjs directly supplies CRDT merging and offline update support required by the brief.
- Socket.io events as the document model: rejected because transport ordering and reconnect behavior do not constitute durable conflict resolution.
- TipTap JSON as the only collaborative source: rejected because merging independently edited JSON documents is unsafe.

## Consequences

Editor extensions and Yjs persisted updates are versioned contracts. Search/export consume projections and may be briefly behind; the Part 58 amendment above is the permission this clause required, and it bounds the lag at the 2 s / 30 s debounce. Presence can disappear during Redis or process failure without losing content.

## Migration and rollback

There is no existing document data. Disabling collaboration later can materialize the latest verified TipTap projection, but removing persisted Yjs state is irreversible and requires a migration plus backup.
