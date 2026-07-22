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
- Exact snapshot cadence, compaction thresholds, and projection latency remain for Parts 33, 39, 55, and 58, with data-loss-safe defaults taking precedence over throughput.

## Alternatives considered

- Operational transformation: rejected because Yjs directly supplies CRDT merging and offline update support required by the brief.
- Socket.io events as the document model: rejected because transport ordering and reconnect behavior do not constitute durable conflict resolution.
- TipTap JSON as the only collaborative source: rejected because merging independently edited JSON documents is unsafe.

## Consequences

Editor extensions and Yjs persisted updates are versioned contracts. Search/export consume projections and may be briefly behind only if a later ADR explicitly permits asynchronous projection. Presence can disappear during Redis or process failure without losing content.

## Migration and rollback

There is no existing document data. Disabling collaboration later can materialize the latest verified TipTap projection, but removing persisted Yjs state is irreversible and requires a migration plus backup.
