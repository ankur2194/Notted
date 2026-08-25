# ADR 0014 — Workspace branding and custom domains

## Status

Accepted (2026-08-25, Part 73).

Part 72 decided and shipped half of this record — the accent colour, the
contrast policy, the tokenised logo route, and the deliberate absence of custom
CSS — and left it `Proposed` because the other half, custom domains, was scoped
but not designed. **Part 73 designed and shipped it, and filled `## Custom
domains` in place**, which is the condition Part 72 named for acceptance. Both
halves are now implemented, and the record is `Accepted`.

## Context

`Notted.md` asks a workspace to be able to look like its owner's organisation:
a logo, an accent colour, and — eventually — a custom domain. Part 72 is where
the first two land, and where the shape of the third has to be decided far
enough to avoid painting Part 73 into a corner.

Three facts constrained the design more than anything in the brief:

- **`workspaces.logo_url` and `workspaces.settings` already existed.** Both have
  been columns since Part 18/Part 26. `logo_url` had never held a first-party
  value — it was "a URL the branding renderers may use", and nothing could put
  one there. `settings` had been persisting (and seeding) an `accentColor` key
  since Part 26 that no contract described and that `normalizeStoredSettings`
  actively *stripped* on the way out. So the branding data model is not new; it
  is a pair of columns that were finally given a writer and a reader.
- **The most important consumer of a workspace logo is an `<img src>` inside an
  email client.** That consumer has no session cookie, cannot follow a login
  redirect, and cannot be taught to. Every design that authorizes the logo like
  workspace *content* fails this consumer.
- **An accent colour is an accessibility surface, not a preference.** It paints
  buttons, focus rings, and chips. A workspace that saves `#f5f5f5` has not
  chosen a bad-looking accent; it has shipped an invisible focus ring to every
  member, and the members cannot fix it themselves.

## Decision

### Accent color in the settings jsonb

The accent lives at `workspaces.settings.accentColor` as a `#rrggbb` string. No
column, no table.

- `workspaceSettingsSchema` (`packages/shared-validators/src/workspace.schema.ts`)
  gained `accentColor: hexColorSchema.nullable().optional()`. Six-digit hex only:
  accepting `#rgb` shorthand or 8-digit alpha would let a workspace pick a
  transparent accent whose contrast no ratio can honestly describe.
- **`null` and `undefined` are different instructions and both are load-bearing.**
  `null` means *reset to the platform default*; `undefined` means *leave whatever
  is stored alone*. `WorkspacesService.applyUpdateTransaction` implements the
  reset by **deleting the key** rather than storing `null`, so every reader —
  the detail mapper, the shell bootstrap, the email branding parser — has one
  absence to handle instead of two.
- A partial `settings` write merges over `knownSafePersistedSettings(existing)`,
  which preserves `defaultPageSize`, `accentColor`, and the seed-only `scenario`
  marker. Without that merge, saving a page size would silently erase the accent.
- `normalizeStoredSettings` now **returns** a stored accent instead of stripping
  it, and does not re-check its legibility on read: a stored accent was validated
  on write, and a read that silently discarded a colour would hide the setting
  rather than fix it.
- The shell bootstrap (`shellWorkspaceMembershipSchema`) carries `logoUrl` and
  `accentColor` as **required-and-nullable** fields on the membership the shell
  already fetches. A second request would make every page flash the default mark
  and then swap; an *optional* field would make "no branding" and "the server did
  not say" indistinguishable, and the server always knows which it is.
- Application is two CSS custom properties on the shell root
  (`apps/web/src/lib/shell/accent-style.ts`): `--color-primary` and
  `--color-ring`. Tailwind 4 compiles `bg-primary` / `ring-ring` to
  `var(--color-primary)` / `var(--color-ring)` at the use site, so overriding
  those two re-tints every primary surface below the root without a single
  component knowing branding exists. No theme provider, no class permutations, no
  stylesheet rewrite. `--color-ring` moves with `--color-primary` deliberately: a
  focus ring left slate on a re-tinted button is the accessibility bug this
  feature would otherwise ship.

### Contrast policy

`packages/shared-validators/src/color-contrast.ts` is the single implementation
of WCAG 2.2 relative luminance and the `(L1+0.05)/(L2+0.05)` ratio, shared by the
API and the settings form. Two implementations of the same formula would
eventually disagree, and the one that disagreed would be the one the user saw.

Two thresholds, not one:

| Level | Ratio against white | Behaviour |
|---|---|---|
| `fail` | `< 3:1` (`ACCENT_CONTRAST_MIN_RATIO`) | **Refused** — `422 ACCENT_CONTRAST_TOO_LOW` |
| `warn` | `3:1 ≤ ratio < 4.5:1` (`ACCENT_CONTRAST_TARGET_RATIO`) | Accepted; the ratio is shown to the person choosing it |
| `ok` | `≥ 4.5:1` | Accepted silently |

- **3:1 is the floor** because that is WCAG 2.2 §1.4.11 for non-text contrast, and
  the accent paints surfaces, borders, and rings — not paragraphs.
- **4.5:1 is a warning, not a refusal**, because §1.4.3 AA applies to normal-size
  text and refusing every accent that cannot also carry body text would reject
  most real brand palettes.
- **The reference colour is pure white**, not the theme's
  `--color-primary-foreground` (`#f8fafc`). The accent sits under near-white text
  and beside a white page, so white is the strictest comparison that actually
  occurs; judging against `#f8fafc` would report a kinder ratio than the page has.
- The rule is enforced in `WorkspacesService.validateSettings`, **not** as a Zod
  refinement. A refinement can only say "invalid"; the caller needs the specific
  `ACCENT_CONTRAST_TOO_LOW` code so the settings form can name the remedy ("choose
  a darker shade") and show the measured ratio using the same shared function the
  server used.
- Because the server refuses anything below 3:1 against white,
  `--color-primary-foreground` is deliberately **not** overridden by the accent —
  near-white text stays legible on every accent that can be saved.

### Tokenised public logo GET

`POST` / `DELETE /api/v1/workspaces/{workspaceId}/logo` are `settings.update`
mutations that additionally require a trusted mutation origin.
`GET /api/v1/workspaces/{workspaceId}/logo/{token}` is **public** — no
`AuthGuard`, no `@RequireAuthorization`, no tenant context.

Why a dedicated route rather than an `attachments` row: an attachment belongs to
a note, is authorized as `file.read` against that note, and is served privately
to a signed-in member. A workspace logo is the opposite of all three. Reusing the
attachment pipeline would have meant either an attachment with a null note or a
public hole punched through `file.read`; one small route is smaller than either.

Why the public GET is safe:

- The URL is unguessable. A **128-bit random token** minted at upload time is
  both the object-key suffix and the path segment, and it is compared in
  **constant time** against the token recorded in `workspaces.logo_url`.
- Replacing or deleting the logo mints a new token, so an old URL stops resolving.
- **Every miss answers the same 404** — unknown workspace, no logo, superseded
  token, absent object — so the route cannot be used to probe which workspaces
  exist or which have branding.
- The only thing the URL discloses is the image an administrator deliberately
  published as the workspace's public face: the same bytes every invitation email
  already carries to unauthenticated recipients.
- The stored bytes are always a WebP the API itself re-encoded (200 px, via the
  Part 41 `ImageProcessingService`), so serving it `inline` cannot be a
  content-type attack; `X-Content-Type-Options: nosniff` says so explicitly.
- The response is `public, max-age=31536000, immutable` rather than the
  attachment route's `private`: the token changes on every replacement, so a
  shared cache can never serve a superseded logo, and there is no principal for
  the cache entry to be specific to.

`logoUrl` is persisted and returned as an **app-relative** path
(`/api/v1/workspaces/<id>/logo/<token>`), never an absolute URL. That is what
lets one stored string be resolved against the API origin in a browser
(`apiAssetUrl`) and against `API_URL` in an email (`safeLogoUrl`) without the
database holding a deployment's hostname.

### Custom CSS is shipped disabled

Custom CSS **does not exist**. There is no schema field, no API, no UI, and no
persisted value — it is not "off by default" and there is no flag to turn on.
This is a decision, not an omission: per-tenant CSS is a stored-XSS-adjacent
capability, and the platform does not yet have the controls that would make it
survivable.

Three threats it would open:

1. **Data exfiltration.** `url()` and `@import` inside attribute selectors turn a
   stylesheet into a request generator: `[value^="a"] { background: url(…/a) }`
   leaks a field character by character to an attacker-controlled host, with no
   script involved.
2. **UI spoofing of the trusted chrome.** Tenant CSS that can reach the shell,
   the top bar, or the sign-in surface can repaint a "your session expired,
   sign in again" panel that is pixel-identical to the real one.
3. **Administrator lockout.** CSS that hides or covers the settings page hides
   the very control that would remove the CSS. Whoever pasted it cannot undo it.

Prerequisites before it could exist:

- **A CSP `style-src` allow-list.** Part 74 is where the application CSP arrives;
  today the web app ships no CSP of its own, and the API's `helmet()` default and
  the explicit Bull Board policy both allow `'unsafe-inline'` styles. An inline
  allow-list is not a boundary.
- **A server-side sanitiser** that strips `url()`, `@import`, `expression()`,
  `behavior`, and `-moz-binding` — parsing the declarations, not regexing the
  text.
- **A scoped root** so tenant CSS is confined to workspace content and cannot
  reach the shell chrome or any authentication surface.
- **An administrator safe-mode escape hatch** (a query flag or a settings route
  that renders unstyled) so bad CSS cannot lock an owner out of the page that
  would fix it.
- **Production images and a TLS reverse proxy** (Parts 79/80/82), so the
  stylesheet is served under the same origin and header discipline in production
  that it is reasoned about under here.

Until all five hold, the accent colour is the whole customisation surface, and it
is exactly as expressive as it can be without becoming a code-execution vector.

## Custom domains

Part 73 designs and ships the whole of it: the claim, the proof, the routing,
the trusted-host boundary, and the seam a reverse proxy uses to obtain a
certificate. `docs/custom-domains.md` is the operator guide; this section is
why it is shaped that way. The feature is **off by default**
(`CUSTOM_DOMAINS_ENABLED=false`) and the switch is real rather than cosmetic —
with it false the five routes 404, the host check is inert, and no host but the
configured ones is served.

### A table, not `workspaces.domain`

`workspace_domains` is new (migration `0022`), one row per workspace
(`workspace_id` unique), `hostname` unique **globally**.

Part 72 said the custom-domain half would attach at `workspaces.domain`. It
does not, and the reason is the single most important constraint in this half:
**a claim must be storable while it is still unproven.** `workspaces.domain` is
the column a routing decision would consult; putting an unverified hostname
there means the routing column also contains hostnames nobody has proved they
own, which is precisely the tenant-takeover the feature exists to prevent. A
claim is also not a string — it has an ownership token, a status, a failure
reason, and two timestamps.

So `workspaces.domain` becomes a **mirror of the verified hostname only**,
written in the same transaction as a successful verification and cleared on
removal or on a re-verification that now fails. It is dropped from
`createWorkspaceSchema` and `updateWorkspaceSchema` entirely — a column that
routing consults must not be writable by whoever can `PATCH` a workspace — and
the old `409 workspace domain already in use` mapping goes with it. It survives
only so the workspace detail can show the live hostname without a join.

**One domain per workspace**, because a second would need its own routing
precedence, its own canonical-URL answer, and its own cookie story, and a unique
constraint is a smaller thing to relax later than a multiplicity to take back.
**Globally unique**, because two workspaces claiming one name is not a conflict
to reconcile later — it is two tenants racing for one address, and the database
is the only place that race can be settled. `last_error` is a fixed vocabulary
(`txt_missing`, `txt_mismatch`, `cname_mismatch`, `dns_failure`) rather than a
resolver's message: third-party error text in a tenant-readable column is
uncontrolled, and it changes with the resolver.

`verification_token` is **plaintext on purpose**. Its whole function is to be
published in a TXT record any stranger can read. It is not a credential — it
grants nothing and authenticates nothing — and hashing it would only make it
impossible to tell the administrator what to publish.

### Two DNS records, and both are load-bearing

1. `TXT _notted-verify.<host>` = `notted-verify=<token>` proves **control of
   DNS** for the name.
2. `CNAME <host>` → `CUSTOM_DOMAIN_CNAME_TARGET` proves the name is **delegated
   to this deployment**.

Neither alone is a proof. Without the TXT, anyone could aim a CNAME at us and
"verify" a hostname they merely point at us — the CNAME direction is chosen by
the claimant, so on its own it says nothing about ownership. Without the CNAME,
a workspace could verify a name that resolves somewhere else entirely and hold
it on a globally-unique column forever, denying it to its real owner.

A zone apex cannot legally carry a CNAME (RFC 1034 §3.6.2), so the apex fallback
compares resolved address **sets**: every address the host resolves to must also
be an address the target resolves to. Every, not any — a name that answers both
with us and with somewhere else is not delegated to us, and treating it as
verified would let a claimant keep serving the name elsewhere while holding the
row here. That is the strongest statement address records can make.

Every lookup is bounded at 5 s, and only the first failure is reported: an
administrator fixes them in order, and there is no point naming a missing CNAME
to someone who has not published the ownership record yet. The DNS work happens
**before** the transaction opens — holding a row lock across four network
lookups would pin a connection for as long as a resolver chooses to take.

### Same-origin topology, and why there was no choice

A tenant host must serve the web app, `/api/`, `/api/auth/` and `/socket.io/`
from **one origin**, proxied to the same backends the primary host uses.

This is forced by cookies, not chosen for tidiness. Session cookies are
host-only and `SameSite=Lax`. A browser on `notes.acme.com` does not attach a
cookie set for `api.example.com`, so a page that called the configured API
origin cross-site would render for a signed-in user who can read nothing. And
`NEXT_PUBLIC_*` values are inlined at **build** time, so one bundle serves the
primary host and every tenant host — the answer cannot come from configuration.
`apps/web/src/lib/api/api-origin.ts`, which Part 72 consolidated for exactly
this, now picks the origin **at runtime**: in a browser whose own host is not
the configured primary host, the API and the socket are the page's own origin.
Server code deliberately keeps reading `publicEnvironment` directly — a Server
Component's fetch goes over the internal network, not through the tenant's edge.

The alternative — a separate API hostname per tenant — is rejected below.

### Sessions are per host, and sign-in returns to the primary host

Both are consequences of the same host-only cookie, and both are **accepted
limitations**, not defects to fix later without a design.

A session on `app.example.com` is not sent to `notes.acme.com`. Members sign in
separately on each host, and signing out of one does not sign them out of the
other. That is the correct posture — a tenant's hostname must not receive a
cookie scoped to the platform's, and one tenant's host must never receive
another's — but it is a visible cost.

More sharply: **OAuth, magic link, and passkey always return to the primary
host.** Every flow that leaves the page builds its return URL from
`NEXT_PUBLIC_APP_URL` (`authResultUrl`, the OAuth `callbackURL`), and the
WebAuthn relying party is fixed configuration (`AUTH_PASSKEY_RP_ID`,
`AUTH_PASSKEY_ORIGINS`) naming the primary host. Password sign-in, including the
2FA challenge, works on a custom host because nothing leaves the page.

Making those flows land on the tenant host would mean a per-host callback
allow-list at every provider, a per-host RP ID (which is a *different* passkey,
not a roaming one), and magic links whose host depends on where the request
started. That is a design, and it is not this part's. The limitation is
documented in `docs/custom-domains.md` § 9 so administrators hear it before
their members do.

### The ACME seam, and why `resolve` is public

`GET /api/v1/domains/resolve?host=|domain=` answers `{ workspaceId, slug }` for
a **verified** host and `404` for everything else.

It is unauthenticated because its two callers have nothing to authenticate with.
A reverse proxy answering Caddy's `on_demand_tls ask` is mid-TLS-handshake:
there is no request, no cookie, no header, and no session, and it issues a
certificate only on a 2xx. The web app's proxy asks before it renders anything.
Requiring a credential would mean either shipping one to the edge or shipping no
custom domains.

It is safe because of what it does *not* say. It discloses the mapping between a
hostname that is already public in the global DNS and the workspace the
administrator's own CNAME already announces. It returns identifiers only — no
name, no plan, no member count — answers only for `verified` rows, and gives the
**same 404 for every miss**, including a malformed host: a `422` there would tell
a prober their syntax was at least on the right track. So it cannot enumerate
pending claims or probe which workspaces exist. It lives in its own controller
because every other handler in `DomainsController` carries
`@RequireAuthorization`, and mixing the one deliberate exception in would make
that rule untrue.

Both `?host=` and `?domain=` are accepted. That is not indecision: Caddy appends
`?domain=` and offers no way to rename it, while every other caller naturally
says `host`. One `??` is smaller than an alias route or a documented "and Caddy
needs a rewrite".

**Notted stores no certificate, no private key, and no ACME account**, and has
no code path that speaks ACME. Renewal is entirely the proxy's.

### Trusted hosts and `421`

Once a deployment answers on more than one hostname, the `Host` header stops
being decoration: anything downstream that builds an absolute URL from it — a
reset link, a cache key, a proxy's routing decision — inherits whatever an
attacker sent. The defence is not sanitising the header wherever it is read; it
is refusing the request at the edge unless the host is one this deployment
actually serves.

`TrustedHostMiddleware` runs in `main.ts` immediately after the request-context
middleware — so a refusal is still correlatable — and **before** helmet, CORS,
the Better Auth handler, and every route, none of which are Nest routes and so
none of which can be ordered against from `configure()`. It reads Express's
`request.hostname`, which derives from `X-Forwarded-Host` only when `trust proxy`
is configured, which is exactly the wanted behaviour in both directions.

**`421 Misdirected Request`, not `404`**: 421 is the status that means "this
connection reached the right server but the wrong authority". A proxy that sees
it re-resolves instead of caching a negative, and it does not pretend a resource
is missing. Health probes are exempt, because orchestrators dial the container's
own address with whatever `Host` they like and a readiness probe failing on a
header would take a healthy deployment out of rotation.

`VerifiedHostsService` lives in `common/` rather than `domains/` because
`AuthService` is one of its three callers and `DomainsModule` already imports
`AuthModule`; putting it in `DomainsModule` would make the arrow circular. It
splits its answer deliberately: **static** configured hosts are answered
synchronously with no I/O — which is what lets the CORS callback and the Better
Auth CSRF pre-check behave identically when custom domains are off or the
database is unreachable — while **verified** tenant hosts are an async lookup
with a 60 s positive / 10 s negative per-process cache. A cache miss in the
synchronous path is a "no", never a blocking read on a request thread with no
`await` to give. Every failure resolves to "not trusted": a database blip must
not become a 500 on the primary host, and it must not be *cached* either, or a
transient fault would pin a real tenant host to "untrusted" for ten seconds.

Better Auth's `trustedOrigins` becomes an async function returning the static
list **plus** verified origins. Supplying a function *replaces* the array rather
than extending it, so returning only the verified origins would silently
un-trust `APP_URL` — the failure mode is total and silent, which is why it is
called out here.

### The flag is a 404, not a 403

With `CUSTOM_DOMAINS_ENABLED=false` the capability does not exist on this
deployment. A `403` would say "you are not allowed", which invites the caller to
go find someone who is. The settings card therefore shows one message covering
both "switched off" and "not an admin", because a 404 genuinely cannot
distinguish them and guessing would tell an admin they lack a permission they
hold.

## Alternatives considered

- **A `workspace_branding` table.** Rejected: two columns already existed and one
  of them (`settings`) is the jsonb bag this exact kind of value belongs in. A
  table for a colour and a URL is a join every shell bootstrap would pay for.
- **A first-class `accent_color` column.** Rejected for the same reason plus a
  migration: `settings` was *already persisting and seeding* `accentColor`; the
  work was to stop stripping it, not to relocate it.
- **Reusing the attachments pipeline for the logo.** Rejected: it would need an
  attachment row with no note, and a public exception carved out of `file.read`.
  See the logo route decision above.
- **A signed, expiring URL for the logo (the export/attachment pattern).**
  Rejected: an email lives longer than any sane expiry, and a recipient opening a
  three-week-old invitation would see a broken image. An unguessable, revocable,
  non-expiring token matches the actual lifetime of the asset.
- **A Zod refinement for the contrast rule.** Rejected: a refinement can only
  produce a generic validation failure, and the remedy here is specific enough to
  deserve its own code and its own measured number.
- **One contrast threshold at 4.5:1.** Rejected: it would refuse most real brand
  palettes for a rule that governs body text the accent never carries.
- **Overriding the whole colour palette from the accent** (secondary, destructive,
  muted, chart colours, derived shades). Rejected for this part: deriving a
  consistent, contrast-safe palette from one hex value is a design system project,
  and two custom properties deliver the visible result at a fraction of the risk.
- **Shipping custom CSS behind a feature flag.** Rejected: a flag is not one of
  the five missing controls, and shipping the parser and storage "disabled" is
  most of the attack surface with none of the safeguards.
- **Keeping the custom domain in `workspaces.domain`** (the seam Part 72
  expected). Rejected: a claim must be storable while unproven, and the column
  routing consults must never hold a hostname nobody has proved they own. The
  column survives as a mirror of the verified value and is no longer writable
  through the workspace update.
- **CNAME-only verification** (no ownership TXT). Rejected: the CNAME's direction
  is chosen by the claimant, so pointing a name at us proves only that they can
  point a name at us. Anyone could claim a hostname they merely aim here, and the
  hostname column is globally unique, so the first claimant would win a name they
  do not own.
- **TXT-only verification** (no delegation check). Rejected for the mirror-image
  reason: a workspace could prove it owns `notes.acme.com`, never delegate it
  here, and hold the globally-unique row forever while the name serves somewhere
  else. Both records answer different questions and neither substitutes.
- **A resolver's own error string in `last_error`.** Rejected: uncontrolled
  third-party text in a tenant-readable column, and it changes with the resolver.
  Four fixed codes, and the browser owns the remedy wording.
- **A separate API hostname per tenant** (`api.notes.acme.com` beside
  `notes.acme.com`). Rejected: it doubles the DNS an administrator publishes and
  the certificates the edge obtains, and it buys nothing — the session cookie is
  host-only either way, so the two hosts would still be cross-site to each other
  and the page still could not authenticate. One origin per tenant is both less
  work for the administrator and the only shape cookies actually permit.
- **Storing certificates (or an ACME account) in Notted.** Rejected outright.
  Notted would become a private-key custodian with a renewal scheduler, an ACME
  client, a rate-limit budget, and a new class of outage — for a job every
  serious reverse proxy already does better. The seam is one public read-only
  route; the proxy owns issuance, storage, and renewal.
- **A list endpoint of verified hosts** for a Traefik-style controller to poll.
  Rejected: a public route that enumerates every tenant hostname is a customer
  list, and an authenticated one would need a credential at the edge. A
  controller confirms hostnames one at a time against `resolve`, which is the
  same answer an issuer gets.
- **A second, web-side custom-domain flag.** Rejected: `CUSTOM_DOMAINS_ENABLED`
  already makes `resolve` refuse every host, so the web proxy already 404s every
  non-primary hostname. A second flag could only ever disagree with the first.
- **Answering an untrusted host with `404`.** Rejected: `421 Misdirected Request`
  is the status that exists for "right server, wrong authority". A proxy that
  sees it re-resolves rather than caching a negative, and it does not claim a
  resource is missing.
- **Redis-backed invalidation for the verified-host cache.** Rejected for now:
  the cache is a latency optimisation over one indexed equality lookup, not a
  correctness mechanism. Every entry re-reads within a minute, and the worst case
  is one extra query per host per process per minute. The upgrade path — a
  `domain.verified` message over the pub/sub the realtime adapter already runs —
  is noted in the code where it would go.

  **The direction that actually costs something is the stale POSITIVE, and it is
  the one to weigh when this is revisited.** `VerifiedHostsService.invalidate()`
  is process-local, so after `DELETE …/domain` — or after a re-verification that
  fails and moves the row out of `verified` — every *other* API process keeps
  answering "trusted" for that hostname for up to the 60 s positive TTL. In that
  window the removed host still passes `TrustedHostMiddleware` (no 421), still
  gets a CORS allow, and still satisfies `assertTrustedMutationOrigin`. It grants
  no data on its own: the request must still authenticate and pass workspace
  authorization, so what is delayed is a *routing* decision, not an *access* one.
  It is nonetheless why the pub/sub upgrade is scheduled for the first
  multi-replica deployment (Part 80) rather than left open-ended, and why a
  hostname removed because it was compromised should be treated as trusted for a
  further minute. The web proxy carries the same shape: a bounded 60 s
  per-process memo of hosts the API definitively refused (a timeout or 5xx is
  never memoized), invalidated by the same message when it lands.

## Consequences

- Branding is **free at read time**: the accent rides the shell bootstrap the app
  already fetches, and the logo is one `<img>` against an immutable, publicly
  cacheable URL.
- `workspaces.settings` is now a **contracted** object rather than an opaque bag.
  Anything added to it in future must be added to `workspaceSettingsSchema` *and*
  to `knownSafePersistedSettings`, or a partial settings save will erase it.
- The API gained its **first deliberately unauthenticated resource route**. It is
  narrow (one GET, one content type, one 404 for every miss), but the
  "every route is authorized" statement now needs the word *except*, and
  `docs/API.md` says so explicitly. Part 73 added the second; see below.
- Because the public GET carries **no authorization specification**, the
  default-deny `ApiKeyRouteGuard` refuses it to API-key callers: a route with no
  `@RequireAuthorization` metadata is refused outright when an API-key actor is
  present. Anonymous and session callers succeed; an API key gets `403`. That is
  the guard behaving correctly, and it is a documented wart rather than a design
  intent.
- Superseded logo objects are removed **best-effort, after commit**. A failure is
  swallowed; the row is already correct and the object is unreachable because its
  token is gone. Part 45's orphaned-object sweep is what collects the remainder.
- Email branding gained a real dependency on `API_URL`: `safeLogoUrl` resolves an
  app-relative `logoUrl` against the API origin. A deployment with a wrong or
  missing `API_URL` renders emails with no logo rather than a broken one.
- Every accent that can be saved is legible against white, so no downstream
  surface has to re-check one. `--color-primary-foreground` stays fixed.
- The API now has **two** deliberately unauthenticated routes, not one: the logo
  `GET` and `GET /api/v1/domains/resolve`. `docs/API.md` names both and says why
  each exists. Both are also refused to API-key callers by the default-deny
  `ApiKeyRouteGuard` for the same reason — no `@RequireAuthorization` metadata —
  so the same wart applies twice.
- **Custom domains cannot be enabled without an operator decision about the
  edge.** `CUSTOM_DOMAINS_ENABLED=true` on a deployment whose proxy cannot obtain
  a certificate for an arbitrary hostname produces verified claims that no
  browser can reach. The flag defaults to `false`, and Parts 79/80/82 are where
  the supported edge arrives.
- **Sessions are per host and always will be** under this design, and OAuth,
  magic-link and passkey sign-in return to the primary host. Password sign-in
  (with 2FA) is the supported flow on a tenant host. This is user-visible and
  belongs in whatever an administrator hands their members.
- `workspaces.domain` is now **read-only through every API contract**. An
  integration that set it through `POST`/`PATCH /workspaces` breaks and must move
  to `PUT /api/v1/workspaces/{workspaceId}/domain` — which will not take effect
  until DNS proves the claim. That is a deliberate breaking change to a field
  nothing read.
- **Verification runs on the request thread and performs outbound DNS.** It is on
  the `sensitive` rate-limit tier for that reason, as is claiming — which writes
  to a globally-unique column and would otherwise let a caller walk a wordlist
  and squat names. `resolve` is on the same tier because it is unauthenticated;
  behind a proxy every `ask` arrives from one IP, so a deployment onboarding many
  hostnames at once may have to raise `RATE_LIMIT_SENSITIVE_PER_MINUTE`.
- **Cache TTLs are now part of the operator's mental model.** A newly verified
  host answers within about ten seconds; a removed one can keep answering for up
  to a minute (60 s positive in the API, 60 s for the web proxy's resolve
  lookup). Nothing is cached on a database error.
- **Better Auth's `trustedOrigins` is now a function**, so any future change
  there must remember to return the static list as well — supplying a function
  replaces the array rather than extending it, and forgetting silently un-trusts
  `APP_URL`.

## Migration and rollback

**Part 72: no migration.** `workspaces.logo_url` and `workspaces.settings` both
predate it; Part 72 is simply the first writer of a first-party value into
either. No column, no index, no backfill, no table rewrite, no lock, and no
rollback SQL.

Rollback of that half is **code-only**: reverting restores the previous
behaviour (`normalizeStoredSettings` strips `accentColor` again, and the three
logo routes disappear). Stored values are inert afterwards — an `accentColor`
key nothing reads, and a `logo_url` path nothing serves. Objects already written
to the `attachments` bucket under `workspaces/<id>/logo/` are left for Part 45's
orphan sweep.

**Part 73 adds migration `0022`**: the `workspace_domain_status` enum
(`pending` / `verified` / `error`), the `workspace_domains` table, its two
unique constraints (`workspace_id`, `hostname`), its two foreign keys
(`workspace_id` cascade, `created_by_id` set null), and one composite
`(hostname, status)` index. It is **purely additive** — a `CREATE TYPE`, a
`CREATE TABLE`, and constraints on that new table. It rewrites nothing, takes no
lock on an existing table, needs no backfill, and touches `workspaces` not at
all: `workspaces.domain` and its `workspaces_domain_unique` index already
existed since Part 18.

Rollback is `DROP TABLE workspace_domains;` followed by
`DROP TYPE workspace_domain_status;`, plus reverting the code. **Existing
`workspaces.domain` values become inert** — exactly what they were before Part
73, a stored string nothing reads and nothing routes on. No tenant loses access
to anything, because a custom hostname was never the only way to reach a
workspace: the primary host and the workspace URL keep working throughout. What
is lost is the claims themselves, so administrators would have to re-claim and
re-verify (the DNS records they published stay valid only if the token is the
same, which after a drop it is not). Certificates already issued by the proxy
are unaffected by the rollback and should be cleaned up at the edge, because the
API will begin refusing those hosts.

Turning the feature **off** without dropping anything is the softer path and is
the one to reach for first: set `CUSTOM_DOMAINS_ENABLED=false` and every route
404s, the host check goes inert, and the rows sit untouched until it is turned
back on.

## Related plan parts

- **Part 18** — created `workspaces.logo_url` and `workspaces.domain`.
- **Part 26** — workspace lifecycle; introduced `workspaces.settings` and began
  seeding an `accentColor` this part finally contracts.
- **Parts 40/41** — the multipart upload parser and the image pipeline the logo
  upload reuses (`parseSingleFileUpload`, `sniffImageMediaType`,
  `ImageProcessingService`).
- **Part 45** — the orphaned-object sweep that collects superseded logo objects.
- **Part 61** — email branding; `resolveBranding` / `safeLogoUrl`.
- **Part 71** — `recordAudit`, which the two logo mutations use.
- **Part 72** — this part: accent colour, logo, contrast policy, no custom CSS.
- **Part 73** — custom domains: the `workspace_domains` table (migration `0022`),
  two-record DNS verification, the trusted-host boundary and `421`, the public
  `resolve` seam, and the runtime API-origin switch. It wrote `## Custom domains`
  above and moved this record to `Accepted`. Operator guide:
  [`custom-domains.md`](../custom-domains.md).
- **Part 74** — the application CSP, the first of the five custom-CSS
  prerequisites.
- **Parts 79/80/82** — production images, the production Compose stack, and the
  TLS reverse proxy. Part 82 is where the edge that custom domains require
  actually ships, including the staging renewal check documented (not executed)
  in [`custom-domains.md`](../custom-domains.md) § 8.

Related records: ADR 0005 (private object storage and the sniffed-type rule),
ADR 0006 (dispatch after commit), ADR 0009 (tenant protection),
ADR 0013 (bare REST success payloads).
