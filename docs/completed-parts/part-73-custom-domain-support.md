# Part 73 — Custom-domain support

## Status

- **State:** Complete
- **Completed on:** 2026-08-25
- **Implemented by:** Claude Code session (lead part engineer + backend/frontend specialists)
- **Plan reference:** `Plan.md`, Part 73
- **Related records:** [Part 18](part-18-operations-integration-tables.md) (the `workspaces.domain` column this part demotes to a mirror), [Part 21](part-21-authentication-backend.md) (Better Auth, its cookie attributes, and the `trustedOrigins` list this part makes dynamic), [Part 24](part-24-centralized-authorization.md) (`settings.read` / `settings.update`, reused unchanged), [Part 65](part-65-public-rest-api-api-keys.md) (`ApiKeyRouteGuard`, the default-deny guard that decides where the public route may live), [Part 71](part-71-audit-logging-admin-views.md) (`recordAudit`, the only sanctioned audit writer), [Part 72](part-72-branding-and-customization.md) (the first deliberately unauthenticated route, `apiAssetUrl`, and the settings surface this one sits beside)
- **Related decision:** [ADR 0014](../decisions/0014-workspace-branding-and-custom-domains.md) — its `## Custom domains` section is being filled from this implementation in the same session (see *Known Limitations*).

## Objective

Let a workspace be reached at its own hostname — `notes.acme.com` instead of a path under
the platform's host — without letting a hostname become a way to take over a tenant, to
squat a name a tenant does not own, or to render one workspace's content under another
workspace's certificate.

The governing verification from `Plan.md` is that **an unverified domain never routes** and
that **a verified domain resolves to exactly the workspace that proved it**.

## Implemented Work

- **`workspace_domains` (`database/schema/workspace-domains.ts`, migration
  `0022_fresh_maddog`).** One claim per workspace (`workspace_id` unique), one owner per
  hostname (`hostname` unique, globally), a `pending`/`verified`/`error` status enum, a
  plaintext `verification_token`, a fixed-vocabulary `last_error`, and
  `last_checked_at`/`verified_at`. `workspace_id` CASCADEs; `created_by_id` SET NULLs.
- **`workspaces.domain` became a read-only mirror.** The column keeps its shape but loses
  its input: `domain` was deleted from `createWorkspaceSchema` and `updateWorkspaceSchema`,
  from `WorkspacesController.create`/`update`, and from both tRPC mutations. `DomainsService`
  is now its only writer — it sets it on a successful verification and clears it on removal
  or a failed re-verification, in the same transaction as the `workspace_domains` write and
  the audit row (ADR 0006).
- **`DomainVerifier` (`domains/domain-verifier.ts`).** Two checks, both required: a TXT
  record at `_notted-verify.<host>` carrying `notted-verify=<token>`, then a CNAME from
  `<host>` to `CUSTOM_DOMAIN_CNAME_TARGET`, with an apex address fallback. Every lookup is
  bounded at `DNS_TIMEOUT_MS` (5 s) through a `Promise.race`; a multi-chunk TXT value is
  rejoined before comparison; the first failure is returned, because an administrator fixes
  them in order. The resolver is an injected `DomainDnsResolver`, so no test touches the
  network.
- **`DomainsService` (`domains/domains.service.ts`).** `read` (`settings.read`), `set` /
  `verify` / `remove` (`settings.update`), and the public `resolve`. `set` always lands
  `pending`; re-claiming the *same* hostname is idempotent and keeps the existing token;
  claiming a different one replaces the row wholesale and clears the mirror. `verify` runs
  the DNS work **before** the transaction opens. `remove` is idempotent. Every unique
  violation on either constraint becomes one indistinguishable `409 DOMAIN_TAKEN`.
- **Two controllers, deliberately.** `DomainsController`
  (`workspaces/:workspaceId/domain`, `GET`/`PUT`/`POST verify`/`DELETE`) carries
  `@RequireAuthorization` on every handler and `assertTrustedMutationOrigin` on every
  mutation; `PUT` and `POST verify` are on the `sensitive` rate-limit tier.
  `DomainResolveController` (`GET /domains/resolve`) is the one deliberately unauthorized
  route, in its own class so "every handler in this controller is authorized" stays true.
- **`VerifiedHostsService` (`common/verified-hosts.service.ts`).** The single answer to "may
  this host reach this API?", over two sets: STATIC hosts built at boot from `APP_URL`,
  `API_URL`, `WS_URL`, the Better Auth base URL, the CNAME target and the configured trusted
  origins (plus loopback outside production), answered synchronously with no I/O; and
  VERIFIED tenant hostnames read from `workspace_domains` behind a per-process TTL cache.
  `isTrustedHost` (async), `isTrustedOriginSync` (cache-only, never blocking),
  `verifiedOriginsFor` (a direct read for Better Auth), and `invalidate`. Every database
  path fails **closed**, and a failure is not cached.
- **`TrustedHostMiddleware` (`domains/trusted-host.middleware.ts`).** Installed in `main.ts`
  with `app.use` immediately after the request-id middleware and **before** helmet, CORS and
  the Better Auth handler. Refuses an unknown host with `421 UNTRUSTED_HOST` in the standard
  error envelope. Health probes are exempt. It is a no-op unless `CUSTOM_DOMAINS_ENABLED`.
  It reads `request.hostname`, not `request.headers.host`, so `X-Forwarded-Host` is honoured
  exactly when `TRUST_PROXY_HOPS` says a proxy is in front.
- **CORS and CSRF widened, primary answer unchanged.** `main.ts` builds
  `isTrustedOrigin = corsOrigins.has(origin) || verifiedHosts.isTrustedOriginSync(origin)`
  and uses it in both the CORS callback and the Better Auth origin pre-check;
  `AuthService.assertTrustedMutationOrigin` does the same. The configured `Set` is still
  consulted first and answers without I/O.
- **Better Auth `trustedOrigins` became a function.** `setupBetterAuth` now passes an async
  callback that returns `[...authConfig.trustedOrigins, ...verifiedOrigins]` — the static
  list is returned *by the function* because supplying a function **replaces** the array
  rather than extending it. A resolution failure degrades to the static list.
- **Configuration.** `CUSTOM_DOMAINS_ENABLED` (boolean, default `false`) and
  `CUSTOM_DOMAIN_CNAME_TARGET` (hostname, defaults to the `APP_URL` host). The target is
  lowercased, length- and pattern-checked, and refused in production when it is loopback,
  `*.localhost`, or an IPv4 literal.
- **Shared contracts.** `packages/shared-validators/src/domain.schema.ts` owns
  `normalizeHostname` — the one normaliser both sides use — plus
  `customDomainHostnameSchema`, the status/error enums, `workspaceDomainSchema`,
  `setWorkspaceDomainSchema`, `domainResolveQuerySchema` and `domainResolveResultSchema`.
  `packages/shared-types/src/domain.ts` carries the matching types and
  `DOMAIN_API_PATHS.resolve`; `WORKSPACE_API_PATHS` gained `domain` and `domainVerify`.
- **Three new error codes** in `ApiErrorCode`: `DOMAIN_TAKEN` (409), `DOMAIN_RESERVED` (422),
  `UNTRUSTED_HOST` (421).
- **`apps/web/src/proxy.ts`** (Next 16's `proxy` convention, the successor to
  `middleware.ts`). Reads `x-forwarded-host`/`host`, short-circuits the primary host with no
  I/O at all, otherwise calls the public `resolve` route server-side with a 3 s abort and a
  60 s revalidate, and hands the answer to a pure decision function. On `allow` it pins the
  host-only workspace-selection cookie; everything else is a plain-text 404.
- **`apps/web/src/lib/domains/custom-host.ts`.** The decision, pure and unit-testable:
  primary/loopback hosts pass through; an unresolved host is a 404; `/workspaces/<other-id>/…`
  is a 404 on this host; `POST /api/shell/workspace` (the workspace switcher) is a 404 on
  this host; everything else renders with the selection cookie pinned.
- **`apps/web/src/lib/shell/constants.ts`.** `WORKSPACE_SELECTION_COOKIE` extracted into its
  own module because `proxy.ts` needs the name and `server-shell.ts` is `import "server-only"`
  with a `next/headers` dependency.
- **`CustomDomainSettings.tsx` + `lib/workspaces/domain-requests.ts`.** The four calls, each
  `safeParse`d against the shared result schema, and a surface that renders the two DNS
  records, the status, and an exhaustive `Record<WorkspaceDomainError, string>` of remedies —
  exhaustive so a new failure code in the shared contract is a type error rather than a blank
  space.
- **Audit.** `domain.set`, `domain.verify` and `domain.remove` through `recordAudit`, entity
  type `workspace_domain`, carrying the hostname and status only.

## Important Decisions

- **A table, not `workspaces.domain`.** A claim is not a string: it has a token, a status, a
  failure reason and two timestamps, and — the decisive property — **it must be storable
  while it is still unproven**. Putting an unproven hostname in the column that routing
  consults is exactly the tenant-takeover this part exists to prevent.
- **`workspaces.domain` is a mirror and lost its API input field.** It exists so the
  workspace detail can show the live hostname without a join. Leaving it writable through
  `PATCH /workspaces/{id}` would have meant two writers with different rules, one of which
  requires no proof at all — so the field was removed from the create and update schemas, the
  REST controller, and both tRPC mutations rather than deprecated.
- **`hostname` is globally unique, in the database.** Two workspaces claiming the same name
  is not a conflict to reconcile later; it is two tenants racing for one address, and the
  database is the only place that race can be settled atomically. The unique index is the
  mechanism; `DOMAIN_TAKEN` is what the loser sees.
- **The verification token is stored in plaintext, on purpose.** Its entire function is to be
  **published in a TXT record anyone on the internet can read**. Hashing it would make it
  impossible to tell the administrator what to publish, and it grants nothing on its own — it
  proves control of DNS for one name and is useless anywhere else. It is deliberately kept
  out of the audit metadata all the same, because `audit_logs` is CSV-exportable and an
  auditor learns nothing from it.
- **BOTH records are required, and each covers the other's gap.** The CNAME direction is
  chosen by the claimant, so a CNAME alone proves only that someone aimed a name at us — not
  that they own it. The TXT record alone proves ownership but not delegation, which would let
  a workspace hold a globally-unique row for a hostname that resolves somewhere else
  entirely, denying it to its real owner. Ownership **and** delegation, or nothing.
- **The apex fallback compares full address SETS, not any overlap.** A zone apex cannot carry
  a CNAME (RFC 1034 §3.6.2), so an apex using ALIAS/ANAME is checked by address instead:
  *every* address the host resolves to must also be an address the target resolves to. "Any
  overlap" would verify a host that resolves to us **and** to somewhere else — a claimant who
  keeps serving the name elsewhere while holding our unique row.
- **The `resolve` route is public, and that is safe.** Two callers need it before any session
  exists: a reverse proxy answering `on_demand_tls ask` during a TLS handshake, and
  `proxy.ts` deciding whether an incoming host is ours at all. What it discloses is the
  mapping between a hostname **already public in the global DNS** and the workspace the
  administrator's own CNAME already points at. It returns identifiers only, answers only for
  `verified` rows, and every miss — unknown host, pending claim, failed claim, malformed
  syntax — is the same 404, so it cannot enumerate claims or probe for workspaces. It is
  deliberately on the DEFAULT UNAUTHENTICATED tier rather than the `sensitive` one: every
  caller arrives through the same reverse proxy and so shares one IP bucket, and a refused
  `on_demand_tls ask` is a failed TLS handshake that never reaches the application logs.
  Throttling certificate issuance into silent breakage is worse than the enumeration a
  tighter tier would slow down — especially as the caller must already know a verified
  hostname to get anything but a 404.
- **`?host=` and `?domain=` are both accepted.** Caddy's `on_demand_tls ask` appends
  `?domain=<name>` with no way to rename it; every other caller naturally says `host`.
  Supporting one spelling would mean either an alias route or a documented "and Caddy needs a
  rewrite", both larger than one `??`.
- **The trusted-host refusal is `421`, not `404`.** `421 Misdirected Request` is the status
  that means "this connection reached the right server but the wrong authority". A proxy that
  sees it knows to re-resolve rather than cache a negative, and it does not lie about a
  resource being missing.
- **Health probes are exempt from the host check.** Orchestrator probes dial the container's
  own address with whatever `Host` they please. A readiness probe failing on a header would
  take a healthy deployment out of rotation, and the health routes disclose nothing the check
  is protecting.
- **`request.hostname`, not `request.headers.host`.** Express derives it from
  `X-Forwarded-Host` only when `trust proxy` is configured, which is exactly the behaviour
  wanted: authoritative behind a configured proxy, ignored otherwise.
- **`VerifiedHostsService` lives in `common/`, not `domains/`.** `AuthService` is one of its
  three callers, and `DomainsModule` imports `AuthModule` (the domain controller authorizes
  like every other admin surface). Putting it in `DomainsModule` would make the module arrow
  circular and force a `forwardRef`. `CommonModule` is `@Global()` and imports nothing, so it
  is the only place the arrow points one way from.
- **Two answers, sync and async, and the difference is load-bearing.** The CORS callback and
  the CSRF pre-check have no `await` to give, so `isTrustedOriginSync` answers static hosts
  from a boot-time set and tenant hosts **only from what the cache already holds** — a miss is
  a "no", never a blocking read. That is safe because the trusted-host middleware runs first
  on every request and populates the cache.
- **The flag makes the routes 404, not 403.** With `CUSTOM_DOMAINS_ENABLED=false` the
  capability does not *exist* on this deployment. A 403 says "you are not allowed", which
  invites the caller to go find someone who is; a 404 is the truth.
- **The flag also gates the middleware itself.** With custom domains off, `TrustedHostMiddleware`
  calls `next()` unconditionally, so this part does not newly reject deployments that have
  always been reached on an address the configuration does not name (a container IP, a service
  mesh name).
- **There is no separate web-side feature flag.** With the API's flag off, `resolve` 404s for
  every host, so `proxy.ts` already refuses every non-primary hostname. A second flag could
  only ever disagree with the first.
- **The proxy is a coherence boundary, not an authorization boundary.** Every API route
  re-authorizes workspace membership server-side. What the proxy prevents is a member of two
  workspaces landing on Acme's branded host and navigating into someone else's workspace —
  another tenant's content under Acme's hostname and Acme's certificate.
- **Reserved suffixes are refused at the contract.** `.local`, `.internal`, `.localhost`,
  `.test`, `.invalid`, `.home.arpa`, bare `localhost`, IP literals and wildcards cannot be
  claimed: a TXT lookup for any of them resolves through mDNS or a split-horizon resolver
  that answers differently per client, so the "proof" would prove nothing.
- **A hostname the deployment already answers on is never claimable.**
  `assertClaimable` checks `VerifiedHostsService.staticHosts` and refuses with
  `422 DOMAIN_RESERVED`.
- **`new URL("http://" + value).hostname` is the whole normaliser.** It lowercases, applies
  IDNA/punycode, and rejects byte sequences a hand-written regex gets wrong. Everything
  around it is refusal rather than transformation — URL punctuation is rejected *before*
  parsing, because `new URL("http://notes.acme.com/private")` parses happily and would
  silently discard the part that made the input wrong.
- **The DNS work happens outside the transaction.** Holding a row lock across up to four
  network lookups would pin a connection for as long as a resolver chooses to take, and
  nothing in the verdict depends on the row staying unchanged: a concurrent `set` makes the
  id-scoped update touch nothing, which is the correct outcome.
- **`last_error` is a fixed vocabulary, never a resolver's message.** A third-party error
  string in a tenant-readable column is uncontrolled text that changes with the resolver. The
  browser owns the plain-English remedy.
- **REST only, no tRPC subrouter.** `apps/web` reaches these from workspace settings through
  the same REST client the sibling admin surfaces use; a second transport with no caller is a
  second thing to keep authorized.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/database/schema/workspace-domains.ts` | The claim table, its status enum, relations, and the reasoning for every column |
| `apps/api/src/database/migrations/0022_fresh_maddog.sql` | `workspace_domain_status` enum, the table, two unique constraints, two foreign keys, the `(hostname, status)` index |
| `apps/api/src/domains/domain-verifier.ts` | `verifyDomain`, the injectable `DomainDnsResolver`, bounded lookups, the apex address fallback, `DOMAIN_DNS_RESOLVER` |
| `apps/api/src/domains/domains.service.ts` | `read` / `set` / `verify` / `remove` / `resolve`; the mirror writes; the conflict mapping; the feature-flag 404 |
| `apps/api/src/domains/domains.controller.ts` | The four authorized routes, trusted-origin checks, the `sensitive` tiers |
| `apps/api/src/domains/domain-resolve.controller.ts` | The public `GET /domains/resolve`, alone in its own class on purpose |
| `apps/api/src/domains/domains.module.ts` | Registers both controllers, binds the real resolver, exports the middleware for `main.ts` |
| `apps/api/src/domains/domains.constants.ts` | `DOMAIN_AUDIT_ACTIONS`, the entity type, the two constraint names, the token size |
| `apps/api/src/domains/trusted-host.middleware.ts` | `421 UNTRUSTED_HOST`, the health exemptions, `isHostCheckExempt` |
| `apps/api/src/common/verified-hosts.service.ts` | `staticHosts`, `isTrustedHost`, `isTrustedOriginSync`, `verifiedOriginsFor`, `invalidate`, `canonicalHost` |
| `apps/api/src/common/common.module.ts` | Provides and exports `VerifiedHostsService` from the `@Global()` module |
| `apps/api/src/main.ts` | Installs the middleware ahead of the Nest pipeline; `isTrustedOrigin` for CORS and the Better Auth pre-check |
| `apps/api/src/auth/auth.service.ts` | `assertTrustedMutationOrigin` accepts a verified tenant origin |
| `apps/api/src/auth/better-auth.setup.ts` | `trustedOrigins` as an async function that still returns the static list |
| `apps/api/src/auth/auth.module.ts` | Injects `VerifiedHostsService` into the Better Auth factory |
| `apps/api/src/config/app.config.ts` | `customDomainsEnabled`, `customDomainCnameTarget`, and the production refusals |
| `apps/api/src/app.module.ts` | Registers `DomainsModule` |
| `apps/api/src/database/schema/workspaces.ts` | `domain` re-documented as a read-only mirror |
| `apps/api/src/workspaces/workspaces.service.ts` | `DetailFields.domain` marked read-only; no write path remains |
| `apps/api/src/workspaces/workspaces.controller.ts` / `workspaces.trpc.ts` | `domain` removed from create and update |
| `apps/api/src/openapi/openapi.routes.ts` | Documentation entries for the five routes |
| `packages/shared-validators/src/domain.schema.ts` | `normalizeHostname` and every custom-domain contract |
| `packages/shared-types/src/domain.ts` | The domain types, the TXT constants, `DOMAIN_API_PATHS` |
| `packages/shared-types/src/workspace.ts` | `WORKSPACE_API_PATHS.domain` / `.domainVerify` |
| `packages/shared-types/src/api.ts` | `DOMAIN_TAKEN`, `DOMAIN_RESERVED`, `UNTRUSTED_HOST` |
| `packages/shared-validators/src/workspace.schema.ts` | `workspaceDomainSchema` input deleted from create/update |
| `apps/web/src/proxy.ts` | The custom-host entry point: header read, bounded resolve, cookie pin, 404 |
| `apps/web/src/lib/domains/custom-host.ts` | `isPrimaryHost`, `decideCustomHostRoute` — the pure decision |
| `apps/web/src/lib/shell/constants.ts` | `WORKSPACE_SELECTION_COOKIE`, extracted so the proxy can import it |
| `apps/web/src/lib/workspaces/domain-requests.ts` | The four browser calls, each validated against the shared schema |
| `apps/web/src/lib/workspaces/paths.ts` | `workspaceDomainPath`, `workspaceDomainVerifyPath` |
| `apps/web/src/components/workspaces/CustomDomainSettings.tsx` | The claim/verify/remove surface and the exhaustive remedy map |
| `apps/api/src/domains/domain-verifier.test.ts` | Both records, case/root-dot folding, split TXT values, each failure reason, the apex subset and superset cases, the hanging resolver |
| `apps/api/src/domains/domains.service.test.ts` | Flag 404s, both mirror directions, claim idempotence, the reserved refusal, one 409 from either constraint, cache invalidation |
| `apps/api/src/domains/trusted-host.middleware.test.ts` | Flag pass-through, admission, the 421 envelope, health exemption, refusal on a rejected lookup |
| `apps/api/src/common/verified-hosts.service.test.ts` | Static set contents, loopback by environment, caching, invalidation, fail-closed-without-caching, sync answers |
| `apps/api/test/domains.integration.test.ts` | Database-gated: the full claim→verify→resolve→release cycle, global hostname uniqueness, cross-tenant denial, workspace-cascade removal |
| `apps/api/test/tenant-isolation.test.ts` | `workspace_domains` added to the isolation matrix with a verified and a pending fixture |
| `apps/web/src/lib/domains/custom-host.test.ts` | Every branch of the routing decision |
| `apps/web/src/lib/workspaces/domain-requests.test.ts` | Method/path per call, off-contract bodies, `DOMAIN_TAKEN`, fail-closed on bad input |
| `packages/shared-validators/src/domain.schema.test.ts` | Part 73 cases appended to the pre-existing file of that name (which covers the domain-model schemas generally) |
| `apps/api/src/config/environment-contract.test.ts` | Defaults, lowercasing, the malformed-target refusals, the production loopback refusal |

## Database and Data Changes

- **Migration `0022_fresh_maddog.sql`** (generated by `drizzle-kit generate`, journal entry
  `idx 22`, snapshot `meta/0022_snapshot.json`). It creates the
  `public.workspace_domain_status` enum and the `workspace_domains` table with
  `workspace_domains_workspace_id_unique`, `workspace_domains_hostname_unique`, a CASCADE
  foreign key to `workspaces`, a SET NULL foreign key to `users`, and
  `workspace_domains_hostname_status_idx` on `(hostname, status)`.
- **A new table only.** No column is added to an existing table, there is no backfill, no
  table rewrite, and no lock on any table that carries data. `workspaces` is untouched at the
  DDL level — only its Drizzle comment changed.
- **The index exists for the request-path lookup.** `VerifiedHostsService.isTrustedHost` runs
  `where hostname = $1 and status = 'verified'` on every request that arrives on a
  non-primary host. The unique index on `hostname` already serves the equality; the composite
  keeps the status filter on the same index.
- **Rollback:** `DROP TABLE "workspace_domains";` then
  `DROP TYPE "public"."workspace_domain_status";`, plus removing the journal entry and
  snapshot. Any `workspaces.domain` values written by a verification survive the drop as
  inert strings that nothing reads — which is exactly what they were before this part.
- **Seed:** unchanged. No workspace_domains row is seeded, deliberately — a seeded hostname
  would occupy a globally unique name in every developer's database and could not be
  verified, since the DNS it names does not exist.
- **Retention:** none. A claim lives until its workspace is deleted or an administrator
  removes it; there is no sweep and nothing expires.
- **Tenant isolation:** `workspace_domains` is workspace-scoped and proves it —
  `DomainsService.load` uses `whereWorkspace(workspaceDomains, tenantContext)`, and the table
  is in the `apps/api/test/tenant-isolation.test.ts` matrix. `resolve` is the one query that
  runs without a tenant context, by design, and it selects only `{ workspaceId, slug }`.

## API, Configuration, and Operational Changes

- **New routes:** `GET`, `PUT`, `DELETE /api/v1/workspaces/{workspaceId}/domain`,
  `POST /api/v1/workspaces/{workspaceId}/domain/verify`, and the public
  `GET /api/v1/domains/resolve`. All five are present in `docs/openapi.json`. No tRPC
  counterpart.
- **No new authorization action.** The three mutations reuse `settings.update` and the read
  reuses `settings.read`, both over the `settings` resource, so an existing workspace admin
  already holds the permission and no policy row changed.
- **New audit actions:** `domain.set`, `domain.verify`, `domain.remove`, entity type
  `workspace_domain`. Metadata carries `{ hostname, status }` (and `lastError` on a verify)
  and never the token.
- **New error codes:** `DOMAIN_TAKEN` (409), `DOMAIN_RESERVED` (422), `UNTRUSTED_HOST` (421).
- **New environment variables:** `CUSTOM_DOMAINS_ENABLED` (default `false`) and
  `CUSTOM_DOMAIN_CNAME_TARGET` (default: the `APP_URL` hostname). Both are read in
  `parseAppConfig`, so a malformed value fails the boot preflight rather than the first
  request. **No new dependency** — verification uses `node:dns`.
- **Defaults are safe:** with the flag off, the four workspace routes and `resolve` answer
  404, the trusted-host middleware passes every request through unchanged,
  `isTrustedHost`/`isTrustedOriginSync` refuse every non-static host without a database read,
  and `verifiedOriginsFor` returns an empty list. A deployment that does nothing sees no
  behaviour change at all.
- **Rate limiting:** `PUT /domain` and `POST /domain/verify` are on the `sensitive` tier
  (the first writes to a globally unique column, the second makes this server perform
  outbound DNS lookups). `GET /domains/resolve` is on the default UNAUTHENTICATED tier —
  see the resolve-route note above for why the sensitive tier would break certificate
  issuance. `GET`/`DELETE /domain` use the standard authenticated tiers.
- **New behaviour at the edge:** with the flag on, every request whose host is neither
  configured nor a verified tenant hostname is refused with `421` before helmet, CORS, or any
  route runs. Health probes are exempt.
- **`apps/web` gained a `proxy.ts`.** Its matcher excludes `_next/static`, `_next/image`,
  `favicon.ico` and `robots.txt`, so no static asset pays a resolve lookup.

## Security and Tenant-Isolation Notes

- **Nothing routes without proof.** `set` can only produce a `pending` row; only `verify`
  writes `verified`, and only after both DNS checks pass. `isTrustedHost`, `resolve`, and the
  `workspaces.domain` mirror all filter on `status = 'verified'`.
- **The globally unique hostname is the anti-squatting control**, and the database enforces
  it. The 409 is deliberately identical for "another workspace holds this" and "you already
  have a claim" — naming the other workspace would leak that a foreign tenant holds the name.
- **Host-header injection is closed at the edge**, not sanitised at each read site. Anything
  downstream that builds an absolute URL from the host — a reset link, a cache key, a proxy
  decision — now inherits a host this deployment has already vouched for.
- **`X-Forwarded-Host` is trusted only when `TRUST_PROXY_HOPS` says a proxy is in front.**
  With no proxy configured, a forged header is ignored.
- **Every fail path fails closed.** A database error in `isTrustedHost` resolves to "not
  trusted" and is **not cached**, so a transient fault cannot pin a real tenant host to
  untrusted for the negative TTL. A rejected lookup in the middleware still refuses. A failed
  or slow `resolve` in `proxy.ts` renders a 404 rather than a page.
- **The public route is not an oracle.** Only `verified` rows answer; unknown, pending,
  failed and malformed inputs all produce the same 404, and the response carries identifiers
  only — no name, plan, or member count.
- **CSRF and CORS were widened by exactly one term.** The configured origin `Set` is still
  checked first and still answers with no I/O; a tenant origin passes only through
  `isTrustedOriginSync`, which requires the trusted-host middleware to have already admitted
  that host in the last minute.
- **The Better Auth `trustedOrigins` function returns the static list too.** Returning only
  the verified origins would have silently un-trusted `APP_URL` — the failure mode is a
  total sign-in outage on the primary host, and it is called out in the code.
- **The verification token is not a credential, and is still kept out of the audit trail.**
  It is published in DNS by design; it is excluded from `audit_logs` because that table is
  CSV-exportable to every workspace admin and the token adds nothing an auditor needs.
- **Reserved and platform hostnames cannot be claimed** — the contract refuses local-only
  suffixes, IP literals and wildcards; the service refuses anything in `staticHosts`.
- **The proxy decision is not relied upon for authorization.** It is stated in both the
  proxy and the pure module that every API route re-authorizes membership server-side; the
  proxy exists to stop one tenant's hostname rendering another tenant's workspace.
- **The workspace-switch endpoint is refused on a tenant host**, because rewriting the
  selection cookie is precisely the operation a single-tenant host must not offer.
- **Cookies stay host-only.** `betterAuthCookieAttributes` sets no `domain`, and the
  selection cookie the proxy writes is host-only, `Lax`, `httpOnly`, and `secure` on HTTPS —
  so a tenant host's selection cannot travel to the primary host or to another tenant's host.

## Verification Evidence

Gates were run serially by two independent review rounds and a final main-thread pass on 2026-08-25 (dev stack on the alternate-port root `.env`; the e2e stack was never started). Results below are from the final pass unless a note says otherwise.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Pass** | Repo root, 2026-08-25 final run: `Tasks: 4 successful, 4 total`, `--max-warnings 0`, no problems |
| `pnpm format:check` | **Pass** | `All matched files use Prettier code style!` |
| `pnpm type-check` | **Pass** | `Tasks: 6 successful, 6 total` |
| `pnpm test` | **Pass** | api `204 passed \| 27 skipped (231)`, web `155 passed (155)`, shared-validators `16 passed`, shared-types `4 passed`; `node --test scripts/*.test.mjs` `# pass 21 / # fail 0` |
| `pnpm test:ci` | **Pass** | `DATABASE_URL` (postgres 5433) and `REDIS_URL` (6380) exported, dev stack on the alternate-port `.env`: api `224 passed \| 7 skipped`, coverage `85.57 / 77.07 / 86.73 / 87.81`; web `155 passed`, `79.9 / 72.82 / 81.42 / 82.35`; shared-validators branch `77.17`; shared-types branch `95.69` — every threshold ≥ 70 met. The 7 skipped API suites are MinIO/Meilisearch/Chromium/`AUTH_E2E`-gated |
| `pnpm build` | **Pass** | Prefixed with the three `NEXT_PUBLIC_*` values: `Tasks: 4 successful, 4 total` |
| `pnpm --filter @notted/api db:check` | **Pass** | `Everything's fine 🐶🔥` with migrations `0021`–`0023` in the journal |
| `apps/api/test/domains.integration.test.ts` (focused) | **Pass** | Ran inside `pnpm test:ci` and in reviewer round 2's focused run (`6 files / 53 tests passed`) |
| Live claim → publish DNS → verify → route behaviour on a real hostname | Not run | Requires public DNS and a wildcard-capable reverse proxy; see limitations |
| Browser verification of a request arriving on a custom host | Not run | No Playwright journey exists (see limitations); `proxy.test.ts` and `custom-host.test.ts` cover the decision in isolation |

## Known Limitations and Follow-up Work

- **Sessions are per host.** Every auth cookie is host-only and `Lax` (no `domain`
  attribute), so signing in on `app.notted.example` does not sign the user in on
  `notes.acme.com` and vice versa. This is a deliberate isolation property, not an oversight:
  a cookie shared across tenant hostnames would be a cookie one tenant's host could influence
  for another's. The cost is a second sign-in per hostname.
- **OAuth, magic-link and passkey sign-in always complete on the primary application host.**
  Provider redirect URIs, magic-link URLs, and WebAuthn relying-party identity are all bound
  to the configured `APP_URL`/`BETTER_AUTH_URL`; a passkey registered on the primary host is
  scoped to that origin and cannot be asserted on a tenant hostname. Making any of these work
  per-tenant means per-tenant OAuth client registration and a per-host RP id, neither of which
  is in scope here.
- **Certificate issuance and renewal are the reverse proxy's job.** This part ships the
  `ask` seam (`GET /domains/resolve`) and nothing else: no ACME client, no certificate store,
  no renewal schedule. The Caddy/Traefik configuration that consumes the seam lands in
  **Parts 79/80/82** (production images, Compose, reverse proxy and TLS), and the staging
  renewal procedure is executed there.
- **The verified-host cache is per process, with a 60 s positive and a 10 s negative TTL.**
  `VerifiedHostsService.invalidate()` clears only the process that handled the call, and this
  cuts **both ways**:
  - *Stale negative (the ergonomics one).* A freshly verified host answers immediately on the
    process that verified it, but **every other API process can take up to a minute** — so on
    a multi-process deployment an administrator may see the new hostname work intermittently
    for the first minute.
  - *Stale positive (the security-relevant one).* After `DELETE /workspaces/{id}/domain`, or
    after a re-verification that fails and flips the row out of `verified`, **every other
    process keeps trusting the removed hostname for up to 60 s** — it still passes
    `TrustedHostMiddleware` (no 421), still gets a CORS allow, and still satisfies
    `assertTrustedMutationOrigin`. It is bounded, short, and grants no data by itself: the
    request must still authenticate and pass workspace authorization, so the window is a
    delayed removal of a *routing* decision, not of an *access* decision. It does mean a
    removal is not effective fleet-wide the instant the call returns, which matters if a
    hostname is ever removed because it was compromised.
  - Both are marked with a `ponytail:` comment on the cache constants. The upgrade path is one
    change for both: publish `domain.verified` / `domain.removed` over the Redis pub/sub the
    realtime adapter already runs on, invalidate on receipt in every process, and drop the TTL
    to plain invalidation. Do it when the deployment first runs more than one API replica
    (**Part 80**).
- **`verifiedOriginsFor()` scans every verified row per Better Auth request.** It is
  uncached by design — a stale answer there is a sign-in that fails on a just-verified host —
  and `workspace_domains` holds at most one row per workspace, so it is a few dozen rows off
  an index today. Marked with a `ponytail:` ceiling note; cache it behind the same TTL (and
  the same invalidation) once the verified-domain count reaches the low thousands.
- **The web proxy remembers refused hosts for 60 s in a bounded per-process map.** `next:
  { revalidate }` does nothing in the proxy runtime, so without it every request on an unknown
  hostname was its own `resolve` round trip. Only a definitive 404 from the API is remembered;
  a timeout or 5xx is not, so a transient API fault cannot pin a real tenant host to 404. Same
  per-process ceiling and same Redis upgrade path as above.
- **`docs/custom-domains.md`, the `docs/API.md` custom-domain section, ADR 0014's
  `## Custom domains` section, and `apps/web/src/proxy.test.ts` were being written by sibling
  agents concurrently with this record and are not present in the tree it was written
  against.** ADR 0014 still carries its Part 72 placeholder text (which describes
  `workspaces.domain` as writable through the workspace update — no longer true), `docs/API.md`
  contains no domain section, and `docs/environment.md` does not yet document
  `CUSTOM_DOMAINS_ENABLED` / `CUSTOM_DOMAIN_CNAME_TARGET`. The reviewer should confirm all
  four landed.
- **`CustomDomainSettings` is not yet mounted.** `apps/web/src/components/workspaces/WorkspaceSettings.tsx`
  does not import it in the tree this record was written against; its own test file does. The
  component, its requests module and its tests are complete — only the mount point is
  outstanding, and it is a sibling agent's edit.
- **No Playwright journey** covers a request arriving on a custom host. Browser coverage is
  deferred as it was for Parts 67–72; it additionally needs a resolvable hostname and a proxy
  in front, which the disposable e2e stack does not currently provide.
- **Verification is manual and on demand.** There is no background re-check: a domain whose
  DNS is later removed stays `verified` and keeps routing until an administrator presses
  verify again. A periodic re-verification sweep on the maintenance lane is the obvious
  addition and was not built, because a sweep that flips a live tenant hostname to `error`
  on a transient resolver failure is worse than the problem.
- **One domain per workspace.** `workspace_domains.workspace_id` is unique. A second hostname
  would need routing precedence, a canonical-URL answer and its own cookie story; a unique
  constraint is a smaller thing to relax later than a multiplicity to take back.
- **`resolve` is unreachable to API-key callers**, for the same reason Part 72's public logo
  GET is: it carries no authorization specification and `ApiKeyRouteGuard` is default-deny.
  The route succeeds anonymously and 403s for a key. That is the guard working correctly.
- **The apex fallback trusts `dns.lookup`**, which consults the host's resolver configuration
  (including `/etc/hosts`) rather than querying authoritative nameservers. On a normal
  container this is the right answer; on a host with unusual resolver configuration it could
  differ from what the public internet sees.
- **`domain` was removed from the strict workspace create/update bodies — a breaking `/api/v1`
  change.** `createWorkspaceSchema` and `updateWorkspaceSchema` are `.strict()`, so a client
  that still sends `domain` now gets a `VALIDATION_ERROR` instead of having the field accepted
  and ignored. The field never had verification behind it; a hostname is claimed through
  `PUT /workspaces/{id}/domain`, which checks DNS before the host serves anything. Recorded in
  the `docs/API.md` "Breaking changes in `v1`" table.
- **No `workspaces.domain` backfill or reconciliation job.** The mirror is only ever written
  by `DomainsService`. If a row were edited out of band, nothing detects or repairs the
  divergence — `workspace_domains` remains the source of truth for every decision that
  matters, and the mirror is presentation only.

## Handoff Notes

- **`workspace_domains` is the source of truth; `workspaces.domain` is a mirror.** Never
  route, authorize, or verify from the mirror, and never add a write path to it outside
  `DomainsService`. It has no API input schema on purpose.
- **`normalizeHostname` in `@notted/shared-validators` is the ONLY normaliser.** A second
  spelling of a hostname is a second row that should have collided with the first, and a
  hostname normalised differently on either side of the wire verifies on one host and 404s on
  the other.
- **Never make `resolve` authenticated.** A certificate issuer answering a TLS handshake has
  no session to present. If it needs hardening, the lever is the rate-limit tier or a proxy
  allow-list — not a guard.
- **Never give `resolve` a distinct error for a pending or malformed host.** One 404 for
  every miss is what stops it enumerating claims.
- **`isTrustedOriginSync` is cache-only and must stay that way.** It is called from a CORS
  callback and a CSRF pre-check that have no `await` to give; turning it into a read would
  put a database round trip on every preflight.
- **Part 74 (CSP + auth CSRF middleware) reuses `isTrustedOriginSync`.** Any CSP
  `frame-ancestors`/`form-action` allow-list and any new CSRF middleware must consult it
  rather than `authConfig.trustedOrigins` alone, or every verified tenant host will be
  refused by the new control while passing the old one.
- **`TrustedHostMiddleware` must stay installed in `main.ts` with `app.use`, ahead of the
  Nest pipeline.** It has to run before helmet, before CORS, and before the Better Auth
  handler — none of which is a Nest route, so `configure()` is too late.
- **After changing a claim's status, call `verifiedHosts.invalidate(hostname)`** in the
  process that made the change. Forgetting it leaves the local process serving (or refusing)
  the host for up to the TTL.
- **Adding a failure reason means touching four places:** the `last_error` vocabulary in the
  schema comment, `workspaceDomainErrorSchema`, `WORKSPACE_DOMAIN_ERRORS`, and
  `ERROR_REMEDIES` in `CustomDomainSettings.tsx`. The last one is exhaustively typed, so the
  compiler will find it.
- **Do not edit `0022_fresh_maddog.sql`.** It is migration history; a change to the table is
  a new migration.
- **Parts 79/80/82 own the edge.** The reverse proxy must (a) terminate TLS for tenant
  hostnames, (b) point `on_demand_tls ask` at `GET /api/v1/domains/resolve`, (c) forward
  `X-Forwarded-Host`, and (d) be matched by a `TRUST_PROXY_HOPS` that counts it. Enabling
  `CUSTOM_DOMAINS_ENABLED` without all four means telling administrators to point DNS at an
  address that answers with the wrong certificate.
- **`CUSTOM_DOMAIN_CNAME_TARGET` is what tenants publish.** Changing it after workspaces have
  verified invalidates every existing CNAME; the next `verify` on each will fail with
  `cname_mismatch`. Treat it as a stable, published address.
- **The web proxy's resolve call must keep going to `NEXT_PUBLIC_API_URL`**, never to the
  tenant's own edge, and must keep sending no credentials.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-25 | Claude Code session | Initial record — implementation complete, quality gates deferred to the session reviewer |
| 2026-08-25 | Claude Code session | Review round 1 fixes. **M2:** documented the *stale positive* direction of the per-process verified-host cache (a removed hostname keeps being trusted elsewhere for up to 60 s) here, in the service `ponytail:` comment, in ADR 0014 and in `docs/custom-domains.md`; pub/sub deliberately not implemented. **L3:** recorded the `domain` removal from the strict create/update bodies as a breaking `v1` change, here and in `docs/API.md`. **L4:** `apps/web/src/proxy.ts` gained a bounded (500-entry, 60 s) negative-host memo so a bogus-`Host` flood no longer buys one `resolve` round trip per request; `resolveHost` now distinguishes "the API said no" from "the API did not answer" so only the former is remembered. **L5:** the unbracketed `"::1"` static loopback entry was dead (`canonicalHost("::1")` folds to `""`); dropped, with unit cases for both the fold and the set. **L6:** added the `verifiedOriginsFor()` ceiling note. **M4:** helmet now mounts before `TrustedHostMiddleware` in `main.ts`, so a 421 carries the security headers. **H6:** `test/domains.integration.test.ts` asserted `getStatus()` on a service-level denial, which throws `AuthorizationDeniedError`, not `ApiHttpException`; a `rejectionStatus` helper now reads `decision.httpStatus` for that shape and `getStatus()` for the transport shape. |
| 2026-08-25 | Claude Code session | Review round 2 and final gates. Round 2 raised no findings against this part; the round-1 closures (M2, M4, L3–L6, H6) were verified, and the hydration mismatch it found on a custom host was fixed in Part 72's `WorkspaceAvatar` (see that record). Final serial gates all pass, including `test/domains.integration.test.ts` against the live database — table updated. Status moved to Complete. |
