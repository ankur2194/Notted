# ADR 0010: Persist Better Auth sessions and encrypted authentication-email intent

- **Status:** Accepted
- **Date:** 2026-07-29
- **Related plan parts:** 21-25, 50, 61, 65

## Context

Part 21 must integrate Better Auth 1.6.24 without creating another credential or
session authority, use Redis for accelerated session access, and deliver token-bearing
authentication email through BullMQ. Redis is ephemeral and SMTP has no portable
exactly-once/idempotency key. Persisting tokenized links in `job_outbox`, BullMQ, or email
delivery rows would turn operational stores into credential stores.

## Decision

Better Auth remains the sole credential and session authority. Notted uses opaque,
HTTP-only cookie sessions; JWT and bearer plugins and local/OAuth/JWT Passport strategies
are not enabled. The Drizzle adapter mounts the existing plural `users` model and retains
database-generated UUIDs. Session rows are always persisted in PostgreSQL. A dedicated
Better Auth secondary-storage adapter prefixes Redis keys, converts Better Auth seconds to
Redis milliseconds, and supplies atomic GET-and-delete and fixed-window increment
operations.

Better Auth 1.6.24 always reads sessions from secondary storage when it is configured.
Consequently, Redis loss, eviction, or outage fails closed: existing cookies cannot be
validated, readiness is down, and users may need to authenticate again after Redis
recovers. PostgreSQL remains durable truth, but this version does not transparently
rehydrate a missing Redis session from its database row. We accept that availability
tradeoff rather than bypassing the mandated cache or accepting unverifiable sessions.

Authentication email uses a narrow Part 21 bridge:

1. The request callback generates no SMTP traffic. It creates `email_deliveries`, an
   `auth_email_intents` row, and identifier-only `job_outbox` intent in one PostgreSQL
   transaction.
2. Tokenized action URLs exist at rest only inside AES-256-GCM ciphertext. The row records
   the `DATA_ENCRYPTION_KEYS` version, independent random 96-bit nonce, authentication tag,
   expiry, and consumed/terminal lifecycle. AAD binds intent ID, purpose, expiry, and key
   version. Plain tokens, tokenized URLs, rendered bodies, passwords, cookies, and sessions
   are never persisted in the bridge.
3. Dispatch starts only after commit and BullMQ receives only `{ intentId }`. Publishing
   and worker claims are idempotent. The worker decrypts and renders only in memory,
   delivers through the existing SMTP adapter, and terminally consumes the context.
4. A `processing` row left across an ambiguous SMTP/process crash is not automatically
   replayed. This prevents duplicate mail at the cost of possible operator reconciliation.
   Ordinary definitive SMTP failures retry three times with bounded exponential backoff.

The Better Auth core password-reset endpoints are disabled because 1.6.24 stores reset
tokens in plaintext verification identifiers. A small Better Auth plugin implements the
same credential update through Better Auth's internal adapter/password hasher while
persisting only an HMAC-SHA256 token lookup value. This is part of the Better Auth
integration, not an independent credential authority.

Non-remembered sessions are exactly 24 hours because that duration is hard-coded by
Better Auth 1.6.24. `SESSION_SHORT_LIVED_HOURS` therefore accepts only `24`.
`SESSION_REMEMBER_ME_DAYS` remains configurable and supplies the compatible remembered
session duration that Part 23 will expose.

## Alternatives considered

- **Custom JWT/access/refresh layer:** rejected by ADR 0003; it duplicates authority and
  weakens revocation.
- **Redis-only sessions:** rejected because Redis is ephemeral.
- **Database fallback on every Redis miss:** rejected because Better Auth 1.6.24 does not
  offer that behavior with secondary storage and an application fallback would diverge
  from provider revocation semantics.
- **Plain token URLs in an outbox or queue:** rejected because operational payloads and
  dashboards are broader exposure surfaces.
- **Synchronous SMTP:** rejected because dependency latency/failure must not hold auth
  request state hostage.
- **Mark before SMTP and always retry ambiguous crashes:** rejected because one choice
  loses messages and the other duplicates security-sensitive mail. The explicit
  reconciliation state is safer until Part 50/61 generalizes provider behavior.

## Consequences

- Authentication availability depends on PostgreSQL and Redis; email-request availability
  also depends on PostgreSQL, while delivery readiness depends on Redis and SMTP.
- `auth_email_intents` is global identity infrastructure, not tenant-owned data. A valid
  session still grants no workspace membership or resource access.
- Key rotation retains old `DATA_ENCRYPTION_KEYS` entries until all unexpired intents under
  those versions are terminal or expired.
- Part 22 consumes unversioned Better Auth routes plus `/api/v1/auth/session`; Part 23 adds
  additional methods/session controls without changing the authority; Parts 50/61 may
  replace the bounded dispatcher while preserving durable intent.

## Migration and rollback impact

Forward migration `0008_sour_queen_noir.sql` adds two enums and the
`auth_email_intents` table. It has no backfill and does not alter existing authentication
rows. Rollout order is migration, API/dispatcher, then worker. Rollback stops producers,
dispatcher, and worker but does not delete pending encrypted intent; a separately reviewed
forward migration is required to remove persisted structures. Existing migrations remain
immutable.
