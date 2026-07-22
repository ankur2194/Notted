# ADR 0003: Make Better Auth the authentication and session authority

- **Status:** Accepted
- **Date:** 2026-07-22
- **Related plan parts:** 1, 8, 13, 21-24, 61, 74

## Context

The brief selects self-hosted Better Auth, but also prescribes a custom JWT access-token and refresh-token design and lists local/OAuth/JWT strategies. Those overlapping authorities could duplicate credentials and session state, weaken revocation, and make authentication inconsistent across tRPC, REST, WebSockets, and jobs.

Authentication (proving identity) is also distinct from Notted authorization (deciding what that identity may do in a workspace).

## Decision

Better Auth is the sole owner of end-user credentials, accounts, verification data, authenticators/passkeys, two-factor state, sessions, and any tokens its selected plugins require. Notted will use the schema and session mechanism supported by the pinned Better Auth adapter version. It will not add parallel password, refresh-token, session, or JWT tables and will not mint a custom JWT layer without a separately justified ADR.

PostgreSQL is the durable source of truth for identity and session records. Redis may accelerate supported session lookups, rate limiting, and revocation propagation, but is ephemeral; losing Redis must not lose accounts or create valid sessions. Cookies use secure, HTTP-only, appropriate SameSite settings and narrowly scoped trusted origins. State-changing cookie-authenticated endpoints receive CSRF/origin protection. OAuth redirects are allow-listed, and high-risk account changes require recent authentication.

NestJS owns the integration boundary:

1. A thin auth adapter invokes Better Auth and validates the incoming credential or session.
2. It produces a minimal internal principal containing the user ID, session ID, authentication method/assurance, and expiry where applicable.
3. Shared backend policies load current workspace membership and resource grants from PostgreSQL and deny by default.
4. tRPC, REST, Socket.io handshakes and file endpoints use that same principal and policy layer. A valid session never implies workspace access.

Public API keys are a separate machine-credential type owned by Notted, stored only as hashes and bound to one workspace and explicit scopes. They produce the same internal actor/workspace context but are not Better Auth user sessions. Background jobs do not carry reusable browser credentials; they carry minimal actor/resource/workspace identifiers and reapply the service's authorization or recorded system authority appropriate to the job.

Logs and telemetry exclude passwords, codes, cookies, authorization headers, raw API keys, token values, and sensitive identity data. Authentication responses avoid account-enumeration leaks.

## Alternatives considered

- **Custom JWT access and refresh tokens alongside Better Auth:** rejected because it creates two session authorities and ambiguous revocation.
- **Redis as the session source of truth:** rejected because Redis is operationally ephemeral.
- **Authorization inside Better Auth callbacks:** rejected because workspace and resource policy is an application concern shared by every transport.
- **Trusting authenticated workspace IDs from clients:** rejected because authentication does not prove tenant membership.

## Consequences

- Better Auth upgrades require adapter/schema review and generated migrations matching the pinned version.
- Revocation and session management remain consistent across password, magic-link, OAuth, 2FA, and passkey flows.
- Notted policies remain testable independently from the auth provider and must include role/action and cross-workspace denial cases.
- The `jwt.strategy.ts` path shown in the canonical structure is optional infrastructure, not a mandate to issue Notted JWTs; it is implemented only if the selected Better Auth integration actually requires it.

## Migration and rollback impact

There is no existing identity data to migrate. Parts 13 and 21 must generate and review Better Auth-compatible schema changes rather than inventing overlapping tables. Changing provider or session mode later requires a superseding ADR, a staged session migration or deliberate global sign-out, and verified rollback. Authentication rollback must fail closed rather than accepting unverifiable sessions.
